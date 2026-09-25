import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, result, until } from './helpers.js';

const dirs = sandbox('costs');
const { TaskManager } = await import('../lib/tasks.js');
const { addCost, costSummary, backfillWorkerCosts } = await import('../lib/costs.js');

test('the ledger backfills earlier task costs, then adds by day', () => {
  backfillWorkerCosts([{ costUsd: 1.5, createdAt: new Date().toISOString() }, { costUsd: 0 , createdAt: new Date().toISOString() }]);
  assert.equal(costSummary().today.workers, 1.5);
  addCost('assistant', 0.25);
  const s = addCost('workers', 0.5);
  assert.equal(s.today.assistant, 0.25);
  assert.equal(s.today.total, 2.25);
});

test('task costs count only what each turn added, even across resumed sessions', async () => {
  // The SDK reports a running total per session: 0.40 after turn 1, 0.70 after the resumed turn 2.
  const totals = [0.4, 0.7];
  let call = 0;
  const fq = fakeQuery(() => [{ ...result('ok'), total_cost_usd: totals[call++] }]);
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const deltas = [];
  tm.on('cost', (t, usd) => deltas.push(Number(usd.toFixed(2))));
  const project = path.join(dirs.projects, 'P');
  fs.mkdirSync(project, { recursive: true });
  const t = tm.create({ project: 'P', cwd: project, instruction: 'x', title: 'Do x' });
  await until(() => t.status === 'done');
  tm.followUp(t.id, 'more');
  await until(() => t.status === 'done' && deltas.length === 2);
  assert.deepEqual(deltas, [0.4, 0.3]);
  assert.equal(Number(t.costUsd.toFixed(2)), 0.7);
  assert.equal(t.title, 'Do x');
});

test('tiles list the files a task created or edited', async () => {
  const project = path.join(dirs.projects, 'Q');
  fs.mkdirSync(project, { recursive: true });
  const fq = fakeQuery(() => {
    fs.writeFileSync(path.join(project, 'jobs.xlsx'), 'x');
    return [
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'm', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(project, 'jobs.xlsx') } }, { type: 'tool_use', name: 'Edit', input: { file_path: path.join(project, 'gone.md') } }] } },
      result('ok'),
    ];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const t = tm.create({ project: 'Q', cwd: project, instruction: 'y' });
  await until(() => t.status === 'done');
  assert.deepEqual(tm.filesTouched(t).map((f) => [f.name, f.how]), [['jobs.xlsx', 'created']], 'missing files are left out');
});
