// Spending limits: no new worker starts once the day's total reaches the daily limit (Settings →
// You & privacy; off unless set). The limit for one task is no longer a setting (always none);
// its code is still exercised here through setFixedForTest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, result, until, serverSource } from './helpers.js';

const dirs = sandbox('budgets');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, getSettings, setFixedForTest } = await import('../lib/settings.js');

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

test('the daily limit is a setting, off by default and kept in range; one task has no limit', () => {
  assert.equal(getSettings().taskBudgetUsd, 0);
  assert.equal(getSettings().dailyBudgetUsd, 0);
  assert.equal(saveSettings({ taskBudgetUsd: 50 }).taskBudgetUsd, 0, 'a saved value is ignored');
  assert.equal(saveSettings({ dailyBudgetUsd: -3 }).dailyBudgetUsd, 0);
  assert.equal(saveSettings({ dailyBudgetUsd: 99999 }).dailyBudgetUsd, 5000);
  saveSettings({ dailyBudgetUsd: 0 });
});

test("the day's limit: no new worker once today's spending reaches it", () => {
  fs.writeFileSync(path.join(dirs.data, 'costs.json'), JSON.stringify({ days: { [today()]: { assistant: 3, workers: 2.5, dispatcher: 2 } } }));
  const tm = new TaskManager({ queryFn: fakeQuery(() => [result('done')]).queryFn });
  saveSettings({ dailyBudgetUsd: 5 });
  assert.throws(() => tm.create({ project: 'p', cwd: dirs.projects, instruction: 'Build it' }), /reached the \$5 daily limit[\s\S]*Settings → You & privacy/);
  saveSettings({ dailyBudgetUsd: 10 });
  assert.ok(tm.create({ project: 'p', cwd: dirs.projects, instruction: 'Build it' }).id, 'under the limit: starts');
  saveSettings({ dailyBudgetUsd: 0 });
});

test("one task's limit: it stops there, says so, and the user is asked", async () => {
  fs.rmSync(path.join(dirs.data, 'costs.json'), { force: true });
  setFixedForTest({ taskBudgetUsd: 1 });
  // One turn of the worker costs $1.20, past the $1 limit.
  const tm = new TaskManager({ queryFn: fakeQuery(() => [result('half done', 1.2)]).queryFn });
  const told = [];
  tm.on('budget', (t, limit) => told.push({ id: t.id, limit }));
  const t = tm.create({ project: 'p', cwd: dirs.projects, instruction: 'A long job' });
  await until(() => tm.get(t.id)?.overBudget === true && tm.get(t.id)?.status === 'stopped', 9000, 'stopped at the limit');
  assert.equal(told.length, 1);
  assert.equal(told[0].limit, 1);
  assert.ok(tm.get(t.id).log.some((e) => e.kind === 'stop' && /Stopped at the \$1 limit/.test(e.text)), 'the log says why, not "stopped by you"');
  setFixedForTest({ taskBudgetUsd: 0 });
  assert.match(serverSource(), /tasks\.on\('budget', \(t, limit\) => notifyTask\(t, `Task \$\{t\.id\} \(\$\{t\.project\}\) stopped at the \$\$\{limit\} limit/);
});

test('going on after the limit: it counts again from there; a new run respects the day\'s limit', async () => {
  fs.rmSync(path.join(dirs.data, 'costs.json'), { force: true });
  setFixedForTest({ taskBudgetUsd: 1 });
  let runs = 0;
  const tm = new TaskManager({ queryFn: fakeQuery(() => [result('half done', 1.2 * ++runs)]).queryFn });
  const told = [];
  tm.on('budget', (t) => told.push(t.id));
  const t = tm.create({ project: 'p', cwd: dirs.projects, instruction: 'A long job' });
  await until(() => tm.get(t.id)?.status === 'stopped', 9000, 'stopped at the limit');
  tm.followUp(t.id, 'Go on');
  assert.equal(tm.get(t.id).overBudget, false);
  assert.ok(Math.abs(tm.get(t.id).budgetBase - tm.get(t.id).costUsd) < 1e-9, 'the limit counts from what it had spent');
  await until(() => told.length === 2 && tm.get(t.id)?.status === 'stopped', 15000, 'stopped at the next limit, not run on unlimited');
  setFixedForTest({ taskBudgetUsd: 0 });
  fs.writeFileSync(path.join(dirs.data, 'costs.json'), JSON.stringify({ days: { [today()]: { assistant: 3, workers: 2.5, dispatcher: 2 } } }));
  saveSettings({ dailyBudgetUsd: 5 });
  assert.throws(() => tm.followUp(t.id, 'Go on again'), /daily limit/, 'starting it again is a new run');
  saveSettings({ dailyBudgetUsd: 0 });
});
