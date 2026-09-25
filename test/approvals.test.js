import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, result, until, wait } from './helpers.js';

const dirs = sandbox('approvals');
const { TaskManager } = await import('../lib/tasks.js');
const { ApprovalRelay } = await import('../lib/approvals.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { InputQueue } = await import('../lib/queue.js');
const project = path.join(dirs.projects, 'Demo');
fs.mkdirSync(project, { recursive: true });

const LOOKUP = `curl -s -X POST 'https://x.wd1.myworkdayjobs.com/wday/cxs/x/Careers/jobs' -d '{}'`;
const DELAY = 80;

/** Each task's worker runs the Bash command given as its instruction through the approval gate. */
function setup() {
  const fq = fakeQuery(async (turn, text, options) => {
    if (turn > 0) return [result('ok')];
    const command = text.split('\n\n').pop();
    const gate = options.hooks.PreToolUse.find((m) => m.matcher === 'Bash').hooks[0];
    await gate({ tool_name: 'Bash', tool_input: { command } }, 'id', { signal: new AbortController().signal });
    return [result('ok')];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const events = [];
  const relay = new ApprovalRelay(tm, (text, opts) => events.push({ text, ...opts }), { delayMs: DELAY, maxDelayMs: 400 });
  const start = (command) => tm.create({ project: 'Demo', cwd: project, instruction: command });
  const cleanup = async () => {
    relay.stop();
    for (const t of tm.list()) if (tm.isLive(t.id)) await tm.stop(t.id);
  };
  return { tm, events, start, cleanup };
}

test('an approval clicked in the window before the relay fires is never relayed', async () => {
  const { tm, events, start, cleanup } = setup();
  const t = start(LOOKUP);
  await until(() => tm.isApprovalPending(t.id), 3000, 'approval');
  assert.ok(t.pendingApproval.createdAt, 'approvals carry createdAt');
  tm.resolveApproval(t.id, true, { approvalId: t.pendingApproval.id, by: 'window' });
  await until(() => t.status === 'done');
  await wait(DELAY * 2);
  assert.deepEqual(events, [], 'nothing to tell the assistant');
  assert.ok(t.log.some((e) => e.kind === 'ok' && /in the window/.test(e.text)), 'who answered is recorded');
  assert.throws(() => tm.resolveApproval(t.id, true), /already answered in the window \(approved\)/);
  await cleanup();
});

test('read-only lookups from several tasks arrive as ONE question and can be answered together', async () => {
  const { tm, events, start, cleanup } = setup();
  const ts = [start(LOOKUP), start(LOOKUP), start(LOOKUP)];
  await until(() => ts.every((t) => tm.isApprovalPending(t.id)), 3000, 'three approvals');
  await until(() => events.length > 0, 2000, 'relay');
  await wait(DELAY * 2);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /^3 tasks want to run read-only web lookups/);
  assert.match(events[0].text, /Ask once/);
  assert.match(events[0].text, new RegExp(`task_ids \\[${ts.map((t) => t.id).join(', ')}\\]`));
  assert.equal(events[0].isStale(), false);

  const r = tm.resolveMany(ts.map((t) => ({ taskId: t.id })), true, { lowRiskOnly: true });
  assert.deepEqual(r.resolved, ts.map((t) => t.id));
  assert.equal(events[0].isStale(), true, 'the event expires once everything in it is answered');
  await until(() => ts.every((t) => t.status === 'done'));
  await cleanup();
});

test('a click with an old approvalId is ignored and the current request stays pending', async () => {
  const { tm, start, cleanup } = setup();
  const t = start(LOOKUP);
  await until(() => tm.isApprovalPending(t.id), 3000, 'approval');
  const id = t.pendingApproval.id;
  assert.throws(
    () => tm.resolveApproval(t.id, true, { approvalId: 'old-one', by: 'window' }),
    (/** @type {any} */ e) => e.code === 'stale' && /already answered/.test(e.message)
  );
  assert.equal(tm.isApprovalPending(t.id, id), true);
  tm.resolveApproval(t.id, false, { approvalId: id, by: 'window' });
  assert.throws(() => tm.resolveApproval(t.id, true, { approvalId: id, by: 'window' }), (/** @type {any} */ e) => e.code === 'stale', 'double click');
  await until(() => t.status === 'done');
  assert.ok(t.log.some((e) => e.kind === 'deny' && /in the window/.test(e.text)));
  await cleanup();
});

test('risky approvals are relayed on their own and never covered by a group answer', async () => {
  const { tm, events, start, cleanup } = setup();
  const a = start(LOOKUP);
  const b = start(LOOKUP);
  const risky = start('git push origin main');
  await until(() => [a, b, risky].every((t) => tm.isApprovalPending(t.id)), 3000, 'approvals');
  await until(() => events.length >= 2, 2000, 'relay');
  await wait(DELAY * 2);
  assert.equal(events.length, 2);
  const group = events.find((e) => /tasks want to run read-only/.test(e.text));
  const alone = events.find((e) => /risky/.test(e.text));
  assert.match(group.text, /^2 tasks/);
  assert.ok(!group.text.includes(`task ${risky.id} `), 'the risky one is not in the group');
  assert.match(alone.text, new RegExp(`^Task ${risky.id} .*git push.*Never group`));

  // "Yes to all" from the assistant covers the lookups only.
  const r = tm.resolveMany(tm.pendingApprovals().map((p) => ({ taskId: p.taskId })), true, { lowRiskOnly: true });
  assert.deepEqual(r.resolved.sort(), [a.id, b.id].sort());
  assert.deepEqual(r.skipped.map((s) => s.taskId), [risky.id]);
  assert.equal(tm.isApprovalPending(risky.id), true, 'still waiting for its own answer');
  assert.equal(alone.isStale(), false);
  await cleanup();
});

test('the assistant never hears about an approval answered while it was busy', async () => {
  const { tm, start, cleanup } = setup();
  const d = new Dispatcher(tm);
  d.input = new InputQueue();
  d.busy = true; // mid-turn
  const t = start(LOOKUP);
  await until(() => tm.isApprovalPending(t.id), 3000, 'approval');
  const approvalId = t.pendingApproval.id;
  d.notify('approval for task', { isStale: () => !tm.isApprovalPending(t.id, approvalId) });
  d.notify('Task 99 finished.');
  d.notify('ancient news', { ttlMs: -1 });
  assert.equal(d.input.size, 0, 'events wait for the turn to end');
  tm.resolveApproval(t.id, true, { by: 'window' });
  d.onMessage({ type: 'result', subtype: 'success', session_id: 's', total_cost_usd: 0 });
  assert.equal(d.input.size, 1);
  const sent = d.input.items[0].msg.message.content;
  assert.match(sent, /\[event\] Task 99 finished\./);
  assert.ok(!/approval for task|ancient news/.test(sent), sent);
  assert.equal(d.busy, true);
  clearTimeout(d.heldTimer);
  await cleanup();
});

test('the input queue drops items that went stale before they were read', async () => {
  const q = new InputQueue();
  let stale = false;
  let dropped = 0;
  q.push('old event', 'next', { isStale: () => stale, onDrop: () => dropped++ });
  q.push('expired', undefined, { expiresAt: Date.now() + 5 });
  q.push('hello');
  stale = true;
  await wait(10);
  const it = q[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.value.message.content, 'hello');
  assert.equal(dropped, 1);
  q.close();
});
