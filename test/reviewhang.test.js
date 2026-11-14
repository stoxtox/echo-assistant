// The self-review never hangs: tasks 61, 65 and 118 finished their work, but their review never
// became ready and they sat at "running" / "working" for good. Two causes, both covered here:
//   1. Follow-ups sent while the worker was busy were answered in the same turn, so the extra
//      result Echo counted on never came and the task never finished.
//   2. A review check that leaves a process holding its output open (a test server, a test build)
//      or never ends kept the review waiting forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, fakeQuery, say, result, until, wait } from './helpers.js';

const dirs = sandbox('reviewhang');
const { TaskManager } = await import('../lib/tasks.js');
const { SelfImprove, runChecks } = await import('../lib/selfimprove.js');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A git repo whose `npm test` runs this script (and whose type check passes). */
function repoWith(name, testScript) {
  const repo = path.join(dirs.root, name);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'test.cjs'), testScript);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name, scripts: { test: 'node test.cjs', check: 'node -e "process.exit(0)"' } }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: repo });
  return repo;
}

// The test leaves a "server" behind that keeps the check's output open, like a smoke-test Echo on 4799.
const LEAVES_SERVER = (pidFile) => `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
child.unref(); // the test ends, its child lives on and keeps the output open
console.log('ok 1 - passes');
`;

test('a check whose tests leave a process running still finishes, and the leftover is cleaned up', async () => {
  const pidFile = path.join(dirs.root, 'leftover.pid');
  const repo = repoWith('leftover', LEAVES_SERVER(pidFile));
  const started = Date.now();
  const checks = await runChecks(repo, { timeoutMs: 60000 });
  assert.ok(Date.now() - started < 30000, 'did not wait for the leftover process');
  assert.equal(checks.tests.ok, true, checks.tests.output);
  assert.match(checks.tests.output, /ok 1 - passes/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await until(() => !alive(pid), 5000, 'leftover process killed');
});

test('a check that never ends is stopped at its time limit and reported as timed out', async () => {
  const repo = repoWith('forever', 'setInterval(() => {}, 1000);');
  const started = Date.now();
  const checks = await runChecks(repo, { timeoutMs: 1500 });
  assert.ok(Date.now() - started < 20000);
  assert.equal(checks.tests.ok, false);
  assert.equal(checks.tests.timedOut, true);
  assert.match(checks.tests.output, /took too long/);
  assert.equal(checks.typecheck.ok, true, 'the other checks still run');
});

test('a follow-up answered in the same turn does not leave the task running forever', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  // Like the real CLI: a follow-up that arrives mid-turn is folded into that turn, with one result for both.
  const fq = fakeQuery(async (turn) => (turn === 0 ? (await gate, [say('Did both.'), result('I fixed both things.')]) : []));
  const tm = new TaskManager({ queryFn: fq.queryFn, settleMs: 300 });
  const t = tm.create({ project: 'Demo', cwd: dirs.projects, instruction: 'fix one thing' });
  await until(() => t.status === 'running');
  tm.followUp(t.id, 'and another thing');
  release();
  await until(() => t.status === 'done', 5000, 'task done');
  assert.equal(t.summary, 'I fixed both things.');
  assert.equal(tm.isLive(t.id), false);
});

test('a follow-up that gets its own turn is still waited for', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const fq = fakeQuery(async (turn) => {
    if (turn === 0) return (await gate, [result('first part')]);
    await wait(100);
    return [say('On it.'), result('second part')];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn, settleMs: 2000 });
  const t = tm.create({ project: 'Demo', cwd: dirs.projects, instruction: 'part one' });
  await until(() => t.status === 'running');
  tm.followUp(t.id, 'part two');
  release();
  await until(() => t.status === 'done', 5000, 'task done');
  assert.equal(t.summary, 'second part', 'done only after the follow-up turn');
});

test("a worker whose session won't close after its final answer is ended, not left running", async () => {
  // The session never ends, even after its input is closed (something it started keeps it open).
  const queryFn = ({ options }) =>
    (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'stuck' };
      yield result('All done.');
      await new Promise((resolve) => options.abortController.signal.addEventListener('abort', resolve));
      await new Promise(() => {}); // and it doesn't even stop when aborted
    })();
  const tm = new TaskManager({ queryFn, exitGraceMs: 200 });
  const finished = [];
  tm.on('finished', (t) => finished.push(t.status));
  const t = tm.create({ project: 'Demo', cwd: dirs.projects, instruction: 'x' });
  await until(() => t.status === 'done', 10000, 'task done');
  assert.equal(t.summary, 'All done.');
  assert.deepEqual(finished, ['done'], 'finished once, as done (so a self task gets its review)');
});

test('when the review checks hang, the task is still marked ready for review, with a note', async () => {
  const app = path.join(dirs.root, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e "setInterval(() => {}, 1000)"', check: 'node -e "process.exit(0)"' } }));
  fs.writeFileSync(path.join(app, 'greeting.js'), 'export const greeting = "hi";\n');
  const fq = fakeQuery(async (turn, text, options) => {
    fs.writeFileSync(path.join(options.cwd, 'greeting.js'), 'export const greeting = "hello";\n');
    return [result('Made the greeting friendlier.')];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const self = new SelfImprove(tm, { access: { allowed: true, reason: 'test dev copy' }, appDir: app, checkTimeoutMs: 60000, reviewTimeoutMs: 1500 });
  const req = self.requestUnlock('Friendlier greeting');
  const task = await self.confirmUnlock({ requestId: req.id, code: req.code });
  await until(() => task.self.state === 'review', 20000, 'ready for review');
  assert.deepEqual(task.self.review.files, ['greeting.js']);
  assert.equal(task.self.review.checks.checks.ok, false);
  assert.match(task.self.review.note, /didn't finish in time/);
  const events = fs.readFileSync(path.join(dirs.data, 'self', 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.event === 'review_ready' && e.taskId === task.id && e.note));
  await self.discard(task.id);
});

test('if preparing the review fails outright, the changes still go up for review with a note', async () => {
  const app = path.join(dirs.root, 'app2');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app2', scripts: { test: 'node -e ""', check: 'node -e ""' } }));
  fs.writeFileSync(path.join(app, 'a.txt'), 'a\n');
  const fq = fakeQuery(async (turn, text, options) => {
    fs.writeFileSync(path.join(options.cwd, 'a.txt'), 'b\n');
    return [result('Changed a.')];
  });
  const tm = new TaskManager({ queryFn: fq.queryFn });
  const self = new SelfImprove(tm, { access: { allowed: true, reason: 'test dev copy' }, appDir: app });
  self.reviewChecks = async () => {
    throw new Error('disk full');
  };
  const req = self.requestUnlock('Change a');
  const task = await self.confirmUnlock({ requestId: req.id, code: req.code });
  await until(() => task.self.state === 'review', 20000, 'ready for review');
  assert.match(task.self.review.note, /disk full/);
  await self.discard(task.id);
});
