import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, fakeQuery, result, until } from './helpers.js';

const dirs = sandbox('self');
const { TaskManager } = await import('../lib/tasks.js');
const { SelfImprove, runChecks, checkOutput, installPlan } = await import('../lib/selfimprove.js');
const { DEFAULT_PORT } = await import('../lib/config.js');

// A tiny stand-in for the Echo folder (not yet a git repo, like the real one today).
const app = path.join(dirs.root, 'app');
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node -e "process.exit(0)"', check: 'node -e "process.exit(0)"' } }));
fs.writeFileSync(path.join(app, 'greeting.js'), 'export const greeting = "hi";\n');
fs.writeFileSync(path.join(app, '.gitignore'), 'data/\n');
const git = (...args) => execFileSync('git', args, { cwd: app, encoding: 'utf8' }).trim();

let clock = Date.now();
let nextGreeting = 'hello there';
const fq = fakeQuery(async (turn, text, options) => {
  // The self-improvement worker edits a file in its worktree.
  fs.writeFileSync(path.join(options.cwd, 'greeting.js'), `export const greeting = "${nextGreeting}";\n`);
  return [result('I made the greeting friendlier. Tests pass.')];
});
const tasks = new TaskManager({ queryFn: fq.queryFn });
const self = new SelfImprove(tasks, { appDir: app, now: () => clock });
const audit = () => fs.readFileSync(path.join(dirs.data, 'self', 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);

test('the assistant can only request an unlock, not grant one', () => {
  assert.equal(self.isUnlocked(), false);
  const req = self.requestUnlock('Make the greeting friendlier');
  assert.match(req.code, /^[A-Z2-9]{5}$/);
  assert.equal(req.firstTime, true);
  assert.equal(self.isUnlocked(), false);
});

test('a wrong code is rejected and logged', async () => {
  const { id } = self.status().pendingRequest;
  await assert.rejects(self.confirmUnlock({ requestId: id, code: 'WRONG' }), /wrong/);
  assert.equal(self.isUnlocked(), false);
  assert.ok(audit().includes('unlock_failed'));
});

test('typing the shown code unlocks, starts the task in a separate worktree, and uses up the unlock', async () => {
  const req = self.status().pendingRequest;
  const task = await self.confirmUnlock({ requestId: req.id, code: req.code.toLowerCase() });
  assert.equal(task.kind, 'self');
  assert.ok(fs.existsSync(path.join(app, '.git')), 'repo initialized on first use');
  assert.notEqual(task.cwd, app, 'never works in the live folder');
  assert.ok(task.cwd.startsWith(dirs.worktrees));
  assert.match(git('branch', '--list', 'self/*'), /self\//);
  assert.equal(self.isUnlocked(), false, 'one task per unlock');
  await until(() => task.self.state === 'review', 20000, 'review');
  assert.deepEqual(task.self.review.files, ['greeting.js']);
  assert.equal(task.self.review.checks.tests.ok, true);
  assert.match(task.self.review.diff, /hello there/);
  assert.equal(fs.readFileSync(path.join(app, 'greeting.js'), 'utf8'), 'export const greeting = "hi";\n', 'live folder untouched before merge');
  assert.equal(git('log', '--oneline').split('\n').length, 1, 'nothing committed before approval');
  globalThis.reviewTask = task;
});

test('merging needs the PIN once one is set, then merges and records the rollback point', async () => {
  const task = globalThis.reviewTask;
  self.setPin('4321');
  await assert.rejects(self.approveMerge(task.id, { pin: '0000' }), /Wrong PIN/);
  const baseline = git('rev-parse', 'HEAD');
  const { lastGood, head } = await self.approveMerge(task.id, { pin: '4321' });
  assert.equal(lastGood, baseline);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(app, 'greeting.js'), 'utf8'), 'export const greeting = "hello there";\n');
  const pending = JSON.parse(fs.readFileSync(path.join(dirs.data, 'self', 'pending-restart.json'), 'utf8'));
  assert.equal(pending.lastGood, baseline);
  assert.ok(!fs.existsSync(task.cwd), 'worktree cleaned up');
  const events = audit();
  for (const e of ['unlock_requested', 'unlock_failed', 'repo_initialized', 'unlocked', 'task_started', 'review_ready', 'pin_set', 'merge_rejected', 'merged']) {
    assert.ok(events.includes(e), `audit log has ${e}`);
  }
});

const branchOf = (dir) => execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

test('a follow-up after a merge continues on the same branch, in the same worktree folder', async () => {
  const task = globalThis.reviewTask;
  const { branch, worktree } = task.self;
  assert.equal(task.self.state, 'merged');
  assert.ok(!fs.existsSync(worktree));
  nextGreeting = 'hello again';
  const r = tasks.followUp(task.id, 'Make it warmer');
  assert.equal(r.delivered, 'resumed');
  // The worktree is back before the worker starts, on the same branch, caught up with the live code.
  assert.ok(fs.existsSync(path.join(worktree, 'greeting.js')));
  assert.equal(task.cwd, worktree);
  assert.equal(branchOf(worktree), branch);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim(), git('rev-parse', 'HEAD'));
  assert.equal(task.self.base, git('rev-parse', 'HEAD'));
  assert.equal(task.self.state, 'working');
  await until(() => task.self.state === 'review', 20000, 'second review');
  assert.equal(fq.calls.at(-1).options.cwd, worktree, 'worker resumed in the same folder');
  assert.equal(fq.calls.at(-1).options.resume, 'session-1', 'and the same session');
  assert.deepEqual(task.self.review.files, ['greeting.js']);
  assert.match(task.self.review.diff, /-export const greeting = "hello there";\n\+export const greeting = "hello again";/);
  assert.ok(audit().includes('follow_up'));
});

test('merging saves hand edits in the live folder as a commit first instead of refusing', async () => {
  const task = globalThis.reviewTask;
  fs.writeFileSync(path.join(app, 'notes.md'), 'my hand edit\n');
  fs.appendFileSync(path.join(app, 'package.json'), '\n');
  fs.mkdirSync(path.join(app, 'data'), { recursive: true });
  fs.writeFileSync(path.join(app, 'data', 'private.json'), '{}');
  const { lastGood, savedLiveEdits } = await self.approveMerge(task.id, { pin: '4321' });
  assert.equal(savedLiveEdits.how, 'commit');
  assert.deepEqual(savedLiveEdits.files.sort(), ['notes.md', 'package.json']);
  assert.equal(git('log', '-1', '--format=%s', lastGood), `Save live edits before self-improve #${task.id} merge`);
  assert.equal(git('show', '--name-only', '--format=', lastGood).split('\n').sort().join(','), 'notes.md,package.json', 'ignored files (data/) are not committed');
  assert.equal(fs.readFileSync(path.join(app, 'notes.md'), 'utf8'), 'my hand edit\n');
  assert.match(fs.readFileSync(path.join(app, 'greeting.js'), 'utf8'), /hello again/);
  assert.equal(git('status', '--porcelain'), '');
  assert.ok(audit().includes('live_edits_committed'));
});

test('if the hand edits cannot be committed, they are stashed under a unique name and the merge goes ahead', async () => {
  self.unlock = { expiresAt: clock + 60000, usesLeft: 1 };
  nextGreeting = 'good evening';
  const task = await self.startTask('Say good evening');
  await until(() => task.self.state === 'review', 20000, 'review');
  // A follow-up on a task under review continues in the same worktree.
  nextGreeting = 'good evening, friend';
  tasks.followUp(task.id, 'Add "friend"');
  assert.equal(task.self.state, 'working');
  await until(() => task.self.state === 'review', 20000, 'review after follow-up');
  assert.match(task.self.review.diff, /good evening, friend/);

  // Commits in the live folder fail (a pre-commit hook), commits in worktrees don't.
  const hook = path.join(app, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\ncase "$(git rev-parse --git-dir)" in */worktrees/*) exit 0;; esac\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(app, 'notes.md'), 'another hand edit\n');
  try {
    const { savedLiveEdits } = await self.approveMerge(task.id, { pin: '4321' });
    assert.equal(savedLiveEdits.how, 'stash');
    assert.match(savedLiveEdits.message, new RegExp(`^echo-merge-${task.id}-`));
    const stashes = git('stash', 'list', '--format=%H %gs');
    assert.ok(stashes.includes(`${savedLiveEdits.ref} On main: ${savedLiveEdits.message}`), stashes);
    assert.match(fs.readFileSync(path.join(app, 'greeting.js'), 'utf8'), /good evening, friend/);
    const events = fs.readFileSync(path.join(dirs.data, 'self', 'audit.log'), 'utf8');
    assert.match(events, new RegExp(`"live_edits_stashed".*"stash":"${savedLiveEdits.ref}"`));
  } finally {
    fs.rmSync(hook);
  }
});

test('a follow-up after a discard recreates the branch from the live code', async () => {
  self.unlock = { expiresAt: clock + 60000, usesLeft: 1 };
  nextGreeting = 'yo';
  const task = await self.startTask('Say yo');
  await until(() => task.self.state === 'review', 20000, 'review');
  await self.discard(task.id);
  assert.equal(git('branch', '--list', task.self.branch), '', 'branch deleted on discard');
  nextGreeting = 'hey';
  tasks.followUp(task.id, 'Actually, say hey');
  assert.equal(branchOf(task.self.worktree), task.self.branch);
  await until(() => task.self.state === 'review', 20000, 'review');
  assert.deepEqual(task.self.review.files, ['greeting.js']);
  assert.match(task.self.review.diff, /\+export const greeting = "hey";/);
  await self.discard(task.id);
});

test('the unlock expires after its time window', async () => {
  const req = self.requestUnlock('Another change');
  self.unlock = { expiresAt: clock + 1000, usesLeft: 1 };
  clock += 31 * 60 * 1000;
  assert.equal(self.isUnlocked(), false);
  self.cancelRequest();
  assert.ok(req);
});

test('too many wrong confirmations lock self-improve out for a while', async () => {
  const req = self.requestUnlock('Yet another change');
  for (let i = 0; i < 5; i++) await self.confirmUnlock({ requestId: req.id, code: 'NOPE0', pin: '4321' }).catch(() => {});
  assert.equal(self.status().lockedOut, true);
  assert.throws(() => self.requestUnlock('again'), /locked/);
  clock += 16 * 60 * 1000;
  assert.doesNotThrow(() => self.requestUnlock('again'));
});

test('review checks install changed packages first and run outside the live environment', async () => {
  const repo = path.join(dirs.root, 'checks');
  fs.mkdirSync(repo);
  const pkg = (test) => JSON.stringify({ name: 'checks', scripts: { test, check: 'node -e "process.exit(0)"' } });
  // The test only passes if it sees a clean environment and the installed packages.
  fs.writeFileSync(path.join(repo, 'package.json'), pkg('node -e "process.exit(0)"'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base', '--allow-empty'], { cwd: repo });
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    // Clean: no VOICEOPS_* or test-runner settings leak in; a fresh data folder; some free port
    // that isn't the live one (tests must never depend on a particular port).
    pkg(`node -e "const e=process.env; process.exit(!e.VOICEOPS_SUPERVISED && !e.NODE_TEST_CONTEXT && !e.VOICEOPS_ROOTS && Number(e.VOICEOPS_PORT) > 0 && e.VOICEOPS_PORT !== '${DEFAULT_PORT}' && e.VOICEOPS_DATA_DIR !== '${dirs.data}' && require('fs').existsSync('package-lock.json') ? 0 : 1)"`),
  );
  process.env.VOICEOPS_SUPERVISED = '1';
  try {
    const checks = await runChecks(repo);
    assert.equal(checks.install?.ok, true, 'packages installed because package.json changed');
    assert.match(checks.install.output, /^npm install \(package\.json changed\)/);
    assert.equal(checks.tests.ok, true, checks.tests.output);
    assert.equal(checks.typecheck.ok, true);
  } finally {
    delete process.env.VOICEOPS_SUPERVISED;
  }
});

test('review checks install when the packages changed or node_modules is missing or stale', async () => {
  const repo = path.join(dirs.root, 'deps');
  fs.mkdirSync(repo);
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'deps', dependencies: { ws: '^8.0.0' } }));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-qm', 'base');
  assert.equal((await installPlan(repo))?.args[0], 'ci', 'no node_modules and a lockfile: npm ci');
  fs.mkdirSync(path.join(repo, 'node_modules'));
  const hidden = path.join(repo, 'node_modules', '.package-lock.json');
  fs.writeFileSync(hidden, '{}');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(hidden, later, later);
  assert.equal(await installPlan(repo), null, 'up to date: no install');
  fs.utimesSync(path.join(repo, 'package-lock.json'), new Date(Date.now() + 120000), new Date(Date.now() + 120000));
  assert.match((await installPlan(repo))?.why, /older than the lockfile/);
  fs.utimesSync(path.join(repo, 'package-lock.json'), new Date(), new Date());
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'deps', dependencies: { ws: '^8.1.0' } }));
  const plan = await installPlan(repo);
  assert.deepEqual([plan?.args[0], plan?.why], ['install', 'package.json changed']);
});

test('a failed check leads with the failing test, not just the summary', () => {
  const tap = ['ok 1 - fine', 'not ok 2 - Echo itself is off-limits', '  ---', "  error: 'Expected values to be strictly equal'", '  ...', ...Array(300).fill('ok 3 - filler'), '# fail 1'].join('\n');
  const out = checkOutput(tap, false);
  assert.match(out, /^not ok 2 - Echo itself is off-limits/);
  assert.match(out, /strictly equal/);
  assert.match(out, /# fail 1$/);
});
