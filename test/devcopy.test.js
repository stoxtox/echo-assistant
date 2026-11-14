// Self-improve only in the developer's own copy: installed, packaged, cloned or unknown copies
// can't request, unlock, start, continue or merge one (lib/devcopy.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, fakeQuery } from './helpers.js';

const dirs = sandbox('devcopy');
const { selfImproveAccess, DEV_MARKER, SELF_IMPROVE_UNAVAILABLE } = await import('../lib/devcopy.js');
const { SelfImprove } = await import('../lib/selfimprove.js');
const { TaskManager } = await import('../lib/tasks.js');
const { Dispatcher } = await import('../lib/dispatcher.js');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let n = 0;
/** A stand-in Echo folder: optionally a git checkout, with an origin remote, marked, packaged. */
function copy({ repo = true, origin = 'https://github.com/someone/echo-dev.git', marker = false, packaged = false } = {}) {
  const dir = path.join(dirs.root, `copy-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"echo"}\n');
  fs.writeFileSync(path.join(dir, 'echo-release.json'), JSON.stringify({ owner: 'stoxtox', repo: 'echo-assistant' }));
  fs.writeFileSync(path.join(dir, '.gitignore'), `${DEV_MARKER}\ndata/\n`);
  if (repo) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    if (origin) git(dir, 'remote', 'add', 'origin', origin);
  }
  if (marker) fs.writeFileSync(path.join(dir, DEV_MARKER), '{}\n');
  if (packaged) fs.writeFileSync(path.join(dir, '.echo-package'), '{}\n');
  return dir;
}
const data = (merged = false) => {
  const d = path.join(dirs.root, `data-${++n}`);
  fs.mkdirSync(path.join(d, 'self'), { recursive: true });
  if (merged) fs.writeFileSync(path.join(d, 'self', 'audit.log'), JSON.stringify({ at: 'x', event: 'merged', taskId: 1 }) + '\n');
  return d;
};
const access = (appDir, { env = {}, dataDir = data() } = {}) => selfImproveAccess({ appDir, dataDir, env });

test('the developer copy is allowed: a marked git checkout, or ECHO_DEV_COPY=1', () => {
  assert.equal(access(copy({ marker: true })).allowed, true);
  assert.equal(access(copy(), { env: { ECHO_DEV_COPY: '1' } }).allowed, true);
  assert.equal(access(copy({ origin: '' }), { env: { ECHO_DEV_COPY: '1' } }).allowed, true, 'a remote is not required when marked');
});

test("the developer's existing checkout (it already merged self-improvements) keeps working and gets marked once", () => {
  const dir = copy();
  const r = access(dir, { dataDir: data(true) });
  assert.equal(r.allowed, true);
  assert.equal(r.marked, true);
  assert.ok(fs.existsSync(path.join(dir, DEV_MARKER)), 'marked, so the explicit marker decides from now on');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the marker is git-ignored: it never dirties or ships');
  const again = access(dir);
  assert.equal(again.allowed, true);
  assert.equal(again.marked, undefined);
});

test('non-dev copies are blocked: packaged, not a git checkout, public clone, worktree, turned off', () => {
  const blocked = (dir, opts, why) => {
    const r = access(dir, opts);
    assert.equal(r.allowed, false, why);
    assert.ok(r.reason, why);
    return r;
  };
  blocked(copy({ packaged: true, marker: true }), { env: { ECHO_DEV_COPY: '1' } }, 'packaged copies never, even with a flag');
  assert.match(blocked(copy({ repo: false, marker: true }), {}, 'a plain folder (zip, install)').reason, /not a git checkout/);
  blocked(copy({ repo: false }), { env: { ECHO_DEV_COPY: '1' }, dataDir: data(true) }, 'no git, even with a flag and history');
  for (const url of ['https://github.com/stoxtox/echo-assistant.git', ['git', 'github.com:stoxtox/echo-assistant.git'].join('@') /* SSH remote */, 'https://github.com/StoxTox/Echo-Assistant']) {
    assert.match(blocked(copy({ origin: url, marker: true }), { env: { ECHO_DEV_COPY: '1' }, dataDir: data(true) }, url).reason, /public Echo repo/);
  }
  blocked(copy({ marker: true }), { env: { ECHO_DEV_COPY: '0' } }, 'ECHO_DEV_COPY=0 turns it off');
  // A self-improve worktree of the dev copy is not the dev copy.
  const main = copy({ marker: true });
  const wt = path.join(dirs.root, `wt-${++n}`);
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  fs.writeFileSync(path.join(wt, DEV_MARKER), '{}\n');
  assert.match(blocked(wt, { env: { ECHO_DEV_COPY: '1' } }, 'worktree').reason, /worktree/);
  // A folder inside some other repo isn't a checkout of Echo.
  const inner = path.join(main, 'sub');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, DEV_MARKER), '{}\n');
  blocked(inner, { env: { ECHO_DEV_COPY: '1' } }, 'subfolder of a repo');
});

test("when it can't tell, self-improve is off", () => {
  // A git checkout with no marker, no flag and no self-improve history: unknown.
  const dir = copy();
  assert.match(access(dir).reason, /not marked/);
  assert.equal(fs.existsSync(path.join(dir, DEV_MARKER)), false, 'never marks itself without evidence');
  assert.equal(access(copy({ origin: '' }), { dataDir: data(true) }).allowed, false, 'history without its own remote is not enough');
  // Checking fails outright (a broken .git): blocked, never an error.
  const broken = copy({ repo: false });
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nowhere\n');
  const r = access(broken, { env: { ECHO_DEV_COPY: '1' } });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /couldn't tell/);
  assert.equal(access(path.join(dirs.root, 'missing'), { env: { ECHO_DEV_COPY: '1' } }).allowed, false);
});

const hang = async function* () {};
const blockedSelf = () => new SelfImprove(new TaskManager({ queryFn: hang }), { appDir: copy({ repo: false }), access: { allowed: false, reason: 'test' } });

test('a non-dev copy: no unlock box, no start, no merge, no follow-up', async () => {
  const self = blockedSelf();
  const st = self.status();
  assert.equal(st.available, false);
  assert.equal(st.unlocked, false);
  assert.equal(st.pendingRequest, null);
  const msg = /only available in the developer copy of Echo/;
  let shown = 0;
  self.on('unlock_request', () => shown++);
  assert.throws(() => self.requestUnlock('change the colors'), msg);
  assert.equal(shown, 0, 'the unlock box never appears');
  await assert.rejects(self.confirmUnlock({ requestId: 'x', code: 'ABCDE' }), msg);
  self.unlock = { expiresAt: Date.now() + 60000, usesLeft: 1 }; // even if something set it
  assert.equal(self.status().unlocked, false);
  await assert.rejects(self.startTask('change the colors'), msg);
  await assert.rejects(self.ensureRepo(), msg);
  assert.equal(fs.existsSync(path.join(self.appDir, '.git')), false, 'never turns the folder into a repo');
  await assert.rejects(self.approveMerge(1), msg);
  assert.throws(() => self.continueTask(1, 'more'), msg);
  assert.throws(() => self.reopen({ id: 1, self: { state: 'review' } }), msg);
  // The PIN still works: it also protects resetting Echo and going back to an older version.
  self.setPin('2580');
  assert.ok(self.checkPin('2580'));
});

test('a non-dev copy never brings back a saved unlock request after a restart', () => {
  fs.writeFileSync(path.join(dirs.data, 'self', 'pending-request.json'), JSON.stringify({ id: 'old', instruction: 'change it', createdAt: Date.now() }));
  const self = blockedSelf();
  assert.equal(self.request, null);
  assert.equal(self.status().pendingRequest, null);
  assert.equal(fs.existsSync(path.join(dirs.data, 'self', 'pending-request.json')), false);
});

test('start_self_improvement answers plainly on a non-dev copy, and still asks for the unlock on the dev copy', async () => {
  const tools = (self) => Object.fromEntries(new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }), self).toolList().map((t) => [t.name, /** @type {any} */ (t)]));
  const out = await tools(blockedSelf()).start_self_improvement.handler({ instruction: 'make the orb blue' }, {});
  assert.equal(out.content[0].text, SELF_IMPROVE_UNAVAILABLE);
  assert.notEqual(out.isError, true);

  const dev = new SelfImprove(new TaskManager({ queryFn: hang }), { appDir: copy({ marker: true }), access: { allowed: true, reason: 'test' } });
  const asked = await tools(dev).start_self_improvement.handler({ instruction: 'make the orb blue' }, {});
  assert.match(asked.content[0].text, /waitingForUser/);
  assert.ok(dev.status().pendingRequest);
  dev.cancelRequest();
});

test('the real check on this checkout never errors, and the dev marker never ships', async () => {
  const r = selfImproveAccess();
  assert.equal(typeof r.allowed, 'boolean');
  const { productFiles } = await import('../scripts/package.js');
  assert.ok(!productFiles().includes(DEV_MARKER));
  assert.match(fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'), /^\.echo-dev$/m);
});
