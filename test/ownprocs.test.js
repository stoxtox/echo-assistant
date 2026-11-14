import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('ownprocs');
const { killTargets, ownKill, etimeSeconds } = await import('../lib/ownprocs.js');
const { classifyCommand } = await import('../lib/safety.js');
const { DEFAULT_PORT } = await import('../lib/config.js');

const WT = '/Users/me/.echo-worktrees/self-1';
const NOW = Date.parse('2026-09-29T15:30:00Z');
const SINCE = NOW - 20 * 60 * 1000; // the task started 20 minutes ago

// A pretend process table: this Echo (100, under supervisor 90), the live Echo's app, and the task's own processes.
function fakeProcs() {
  const rows = [
    { pid: 90, ppid: 1, age: 86400, command: 'node supervisor.js' },
    { pid: 100, ppid: 90, age: 3600, command: 'node server.js' },
    { pid: 200, ppid: 1, age: 3600, command: '/Users/me/Applications/Echo.app/Contents/MacOS/Echo' },
    { pid: 300, ppid: 1, age: 60, command: 'node server.js' }, // the task's smoke server, run from its worktree
    { pid: 301, ppid: 1, age: 60, command: '/tmp/echo-verify-118/Echo.app/Contents/MacOS/Echo' },
    { pid: 302, ppid: 1, age: 60, command: 'python3 -m http.server' }, // new, but not from the task
    { pid: 303, ppid: 1, age: 7200, command: '/tmp/old/thing' }, // from a temp folder, but older than the task
  ];
  return {
    table: () => new Map(rows.map((r) => [r.pid, r])),
    listeners: (port) => (port === DEFAULT_PORT ? [100] : port === 4799 ? [300] : []),
    users: (port) => (port === DEFAULT_PORT ? [100, 200] : port === 4799 ? [300] : []),
    match: (pattern) => rows.filter((r) => r.command.includes(pattern)).map((r) => r.pid),
    cwd: (pid) => (pid === 300 ? WT : '/'),
  };
}
const own = (command) => ownKill(command, { worktree: WT, since: SINCE, now: NOW, procs: fakeProcs(), livePids: [100] });

test('reads which processes a kill command targets', () => {
  assert.deepEqual(killTargets('kill 301'), [{ pids: [301] }]);
  assert.deepEqual(killTargets('kill -9 300 301; sleep 1; ps -p 300'), [{ pids: [300, 301] }]);
  assert.deepEqual(killTargets('lsof -ti:4799 | xargs kill'), [{ port: 4799 }]);
  assert.deepEqual(killTargets('lsof -tiTCP:4799 -sTCP:LISTEN | xargs kill -9'), [{ port: 4799 }]);
  assert.deepEqual(killTargets('kill $(lsof -ti:4799)'), [{ port: 4799 }]);
  assert.deepEqual(killTargets("pkill -f 'echo-verify-118'"), [{ pattern: 'echo-verify-118', full: true, exact: false }]);
  // Anything else in the command, or anything unreadable, means asking as usual.
  assert.equal(killTargets('kill 301 && rm -rf /tmp/x'), null);
  assert.equal(killTargets('kill $PID'), null);
  assert.equal(killTargets('kill %1'), null);
  assert.equal(killTargets('pkill -f no'), null, 'too broad a pattern');
  assert.equal(killTargets('killall node'), null);
  assert.equal(killTargets('ls'), null);
});

test("a self task may stop its own test processes without asking", () => {
  assert.equal(own('kill 301').ok, true, 'a test build in a temp folder');
  assert.equal(own('kill 300').ok, true, 'a smoke server from its worktree');
  assert.equal(own('lsof -ti:4799 | xargs kill').ok, true, 'whatever it runs on the test port');
  assert.equal(own("pkill -f 'echo-verify-118'").ok, true);
  assert.equal(own('kill 999').ok, true, 'a process that is already gone');
});

test('the live Echo and anything else still need approval', () => {
  assert.equal(own('kill 100').ok, false, 'this Echo');
  assert.equal(own('kill 90').ok, false, 'its supervisor');
  assert.equal(own('kill 200').ok, false, 'the Echo app');
  assert.equal(own('kill 302').ok, false, 'not from the task folder, a temp folder or the test port');
  assert.equal(own('kill 303').ok, false, 'running before the task started');
  assert.equal(own(`lsof -ti:${DEFAULT_PORT} | xargs kill`).ok, false, 'the live port');
  assert.equal(own(`kill $(lsof -ti:${DEFAULT_PORT})`).ok, false);
  assert.equal(own("pkill -f 'server.js'").ok, false, 'a pattern that also matches the live Echo');
  assert.equal(own('kill 301 100').ok, false, 'one bad target is enough');
});

test('kills stay risky in the static classifier (the exception is checked per process)', () => {
  assert.equal(classifyCommand('kill 301', { selfTask: true }).level, 'risky');
  assert.equal(classifyCommand('lsof -ti:4799 | xargs kill', { selfTask: true }).level, 'risky');
});

test('ps elapsed times', () => {
  assert.equal(etimeSeconds('05:07'), 307);
  assert.equal(etimeSeconds('01:00:00'), 3600);
  assert.equal(etimeSeconds('2-00:00:01'), 172801);
});
