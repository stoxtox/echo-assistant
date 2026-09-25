// Self-improve bookkeeping: stopped tasks stop saying "working", and a confirmation that's
// waiting survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('selfstate');
const { TaskManager } = await import('../lib/tasks.js');
const { SelfImprove } = await import('../lib/selfimprove.js');
const { selfState } = await import('../lib/dispatcher.js');

const app = path.join(dirs.root, 'app');
fs.mkdirSync(app);
// A worker that keeps going until it's stopped.
const hang = ({ options }) => (async function* () {
  yield { type: 'system', subtype: 'init', session_id: 'hang' };
  await new Promise((_, reject) => options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted'))));
})();
const requestFile = path.join(dirs.data, 'self', 'pending-request.json');
const selfTask = (tasks, extra = {}) => tasks.create({ kind: 'self', project: 'Echo (self)', cwd: app, instruction: 'Polish the header', self: { branch: 'self/x', worktree: app, base: 'abc', review: null, state: 'working' }, ...extra });

test('stopping a self task marks it stopped, not working', async () => {
  const tasks = new TaskManager({ queryFn: hang });
  new SelfImprove(tasks, { appDir: app });
  const t = selfTask(tasks);
  await until(() => tasks.isLive(t.id), 3000, 'running');
  assert.equal(selfState(t, tasks), 'working');
  await tasks.stop(t.id);
  assert.equal(t.status, 'stopped');
  assert.equal(t.self.state, 'stopped');
  assert.equal(selfState(t, tasks), 'stopped');
  tasks.saveNow();
});

test('after a restart, stale "working" self tasks are cleaned up', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(dirs.data, 'tasks.json'), 'utf8'));
  // Like task 24: stopped by the user while an older Echo never updated its state.
  saved[0].self.state = 'working';
  saved.push({ ...saved[0], id: 99, status: 'interrupted', resumeAfterRestart: true, self: { ...saved[0].self, state: 'working' } });
  fs.writeFileSync(path.join(dirs.data, 'tasks.json'), JSON.stringify(saved));
  const tasks = new TaskManager({ queryFn: hang });
  new SelfImprove(tasks, { appDir: app });
  assert.equal(tasks.get(saved[0].id).self.state, 'stopped');
  assert.equal(tasks.get(99).self.state, 'working', 'one about to resume is left alone');
  for (const t of tasks.list()) if (tasks.isLive(t.id)) tasks.stop(t.id);
});

test('a finished self task whose review is still being prepared is not reported as stopped', () => {
  const tasks = /** @type {any} */ ({ isLive: () => false });
  assert.equal(selfState({ status: 'done', self: { state: 'working' } }, tasks), 'preparing_review');
  assert.equal(selfState({ status: 'stopped', self: { state: 'working' } }, tasks), 'stopped');
  assert.equal(selfState({ status: 'done', self: { state: 'merged' } }, tasks), 'merged');
});

test('a confirmation request waiting in the window survives a restart, with a fresh code', () => {
  let clock = Date.now();
  const tasks = new TaskManager({ queryFn: hang });
  const before = new SelfImprove(tasks, { appDir: app, now: () => clock });
  const req = before.requestUnlock('Make the header premium');
  const saved = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  assert.equal(saved.instruction, 'Make the header premium');
  assert.ok(!('code' in saved) && !JSON.stringify(saved).includes(req.code), 'the code is never written to disk');

  clock += 60 * 1000; // Echo restarts a minute later
  const after = new SelfImprove(new TaskManager({ queryFn: hang }), { appDir: app, now: () => clock });
  const restored = after.status().pendingRequest;
  assert.ok(restored, 'still waiting after the restart');
  assert.equal(restored.instruction, 'Make the header premium');
  assert.match(restored.code, /^[A-Z2-9]{5}$/);
  assert.equal(Date.parse(restored.expiresAt), clock + 5 * 60 * 1000, 'a full five minutes to answer');

  after.cancelRequest();
  assert.ok(!fs.existsSync(requestFile), 'cancelling forgets it');
});

test('an expired request is not brought back', () => {
  let clock = Date.now();
  const s1 = new SelfImprove(new TaskManager({ queryFn: hang }), { appDir: app, now: () => clock });
  s1.requestUnlock('Old idea');
  clock += 6 * 60 * 1000;
  const s2 = new SelfImprove(new TaskManager({ queryFn: hang }), { appDir: app, now: () => clock });
  assert.equal(s2.status().pendingRequest, null);
  assert.ok(!fs.existsSync(requestFile));
});
