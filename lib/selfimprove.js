// Self-improve mode: Echo edits its own code, safely.
//
// 1. The assistant can only *request* an unlock. You confirm it in the Echo window by
//    typing the code it shows (plus your PIN, if you set one). Speech alone can never unlock.
// 2. An unlock lasts 30 minutes or one task, whichever comes first.
// 3. The worker edits a separate git worktree on its own branch, never the live folder.
//    Follow-ups continue on that same branch and worktree (recreated if it was merged).
//    The rules are in SELF_IMPROVE.md.
// 4. When it's done you get a diff and test results. Nothing is merged until you click Merge.
// 5. Merging triggers a graceful restart; the supervisor health-checks the new version and
//    rolls back automatically if it fails. Every step is written to data/self/audit.log.
// 6. Only the developer's own copy of Echo offers any of this (lib/devcopy.js decides). Elsewhere
//    nothing can request, unlock, start, continue or merge a self-improvement.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { config, APP_DIR } from './config.js';
import { getSettings } from './settings.js';
import { slugify } from './text.js';
import { selfImproveAccess, SELF_IMPROVE_UNAVAILABLE } from './devcopy.js';
import { writeJson } from './atomic.js';

const run = promisify(execFile);
const selfDir = () => path.join(config.dataDir, 'self');
const GIT_ID = ['-c', 'user.name=Echo', '-c', 'user.email=echo@localhost'];
const REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const newCode = () => Array.from({ length: 5 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[randomInt(31)]).join('');

export function audit(event, data = {}) {
  fs.mkdirSync(selfDir(), { recursive: true });
  fs.appendFileSync(path.join(selfDir(), 'audit.log'), JSON.stringify({ at: new Date().toISOString(), event, ...data }) + '\n');
}

export async function git(cwd, ...args) {
  const { stdout } = await run('git', [...GIT_ID, ...args], { cwd, maxBuffer: 20 * 1024 * 1024 });
  return stdout.trim();
}

/** Synchronous git, for the few steps that must finish before a worker starts. */
function gitSync(cwd, ...args) {
  return execFileSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 }).trim();
}

/**
 * Give a worktree its own copy of the live node_modules (an APFS clone: instant, and writes
 * don't reach the live copy). Marks the copy as current so the checks don't reinstall for nothing.
 */
function cloneModules(appDir, worktree) {
  const modules = path.join(appDir, 'node_modules');
  const target = path.join(worktree, 'node_modules');
  if (!fs.existsSync(modules) || fs.existsSync(target)) return;
  try {
    execFileSync('cp', ['-Rc', modules, target], { stdio: 'ignore' });
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
    execFileSync('cp', ['-R', modules, target], { stdio: 'ignore' });
  }
  const hidden = path.join(target, '.package-lock.json');
  if (fs.existsSync(hidden) && fs.existsSync(path.join(worktree, 'package-lock.json'))) {
    const now = new Date();
    fs.utimesSync(hidden, now, now);
  }
}

// Env vars a clean `npm test` must not inherit: Echo's own settings (ECHO_SUPERVISED, its
// port, its data folder…), node's test-runner plumbing, and the npm script context we run from.
const INHERITED = /^(ECHO_|VOICEOPS_|NODE_TEST_CONTEXT$|npm_package_|npm_lifecycle_|INIT_CWD$)/;

/**
 * The review checks run like a clean `npm test` on a fresh machine: a throwaway data and log
 * folder, a free port that is neither the live one nor any fixed test port, and none of the
 * live Echo's own settings.
 * @param {string} dataDir
 * @param {number | string} port
 */
export function checkEnv(dataDir, port) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !INHERITED.test(k)));
  // (No second listen in the checks: a Mac with the Whisper model would transcribe every test sentence for real.)
  return { ...env, ECHO_DATA_DIR: dataDir, ECHO_LOG_DIR: path.join(dataDir, 'logs'), ECHO_PORT: String(port), ECHO_SECOND_LISTEN: 'off' };
}

/** A port nothing is listening on right now (the OS picks it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });
}

// A failing run's tail is only the summary, so lead with the failed tests themselves.
export function checkOutput(text, ok) {
  if (ok) return text.slice(-3000);
  const failures = [];
  let block = null;
  for (const line of text.split('\n')) {
    if (/^\s*not ok\b/.test(line)) block = [];
    if (!block) continue;
    block.push(line);
    if (/^\s*\.\.\.\s*$/.test(line)) {
      failures.push(block.join('\n'));
      block = null;
    }
  }
  if (block) failures.push(block.join('\n'));
  return failures.length ? `${failures.join('\n').slice(0, 5000)}\n…\n${text.slice(-1500)}` : text.slice(-3000);
}

const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * Should the checks install packages first, and how? Installs when package.json or the
 * lockfile differ from the base commit, or node_modules is missing or older than the lockfile
 * (so the tests never run new code against old packages). `npm ci` when the package files are
 * unchanged, there's a lockfile and no node_modules at all; otherwise `npm install`.
 * @param {string} worktree
 * @param {string} [base] the commit the work started from (default HEAD)
 * @returns {Promise<{ args: string[], why: string } | null>}
 */
export async function installPlan(worktree, base = 'HEAD') {
  const lock = path.join(worktree, 'package-lock.json');
  const modules = path.join(worktree, 'node_modules');
  const hasLock = fs.existsSync(lock);
  const install = ['install', '--no-audit', '--no-fund'];
  const files = ['package.json', 'package-lock.json'];
  const changed = await git(worktree, 'diff', '--name-only', base, '--', ...files).catch(() => '');
  const added = await git(worktree, 'ls-files', '--others', '--exclude-standard', '--', ...files).catch(() => '');
  if (changed || added) return { args: install, why: `${[changed, added].filter(Boolean).join('\n').split('\n').join(', ')} changed` };
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(worktree, 'package.json'), 'utf8'));
  } catch {}
  if (!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies }).length) return null; // nothing to install
  if (!fs.existsSync(modules)) return { args: hasLock ? ['ci', '--no-audit', '--no-fund'] : install, why: 'node_modules is missing' };
  if (hasLock && mtime(path.join(modules, '.package-lock.json')) < mtime(lock)) {
    return { args: install, why: 'node_modules is older than the lockfile' };
  }
  return null;
}

/**
 * The checks shown with every self-improvement review (also `npm run review-checks`), run the
 * way production would: packages installed if needed, then the tests and the type check in a
 * clean environment.
 * @param {string} worktree
 * @param {{ base?: string, timeoutMs?: number, signal?: AbortSignal }} [opts] timeoutMs: limit per step; signal: stop early
 */
export async function runChecks(worktree, { base = 'HEAD', timeoutMs = config.checkTimeoutMs, signal = undefined } = {}) {
  const checks = {};
  const plan = await installPlan(worktree, base);
  if (plan) {
    checks.install = await runCheck(plan.args, worktree, timeoutMs, signal);
    checks.install.output = `npm ${plan.args[0]} (${plan.why})\n${checks.install.output}`;
  }
  if (signal?.aborted) return checks;
  checks.tests = await runCheck(['test'], worktree, timeoutMs, signal);
  if (signal?.aborted) return checks;
  checks.typecheck = await runCheck(['run', 'check'], worktree, timeoutMs, signal);
  return checks;
}

/** Signal a whole process group, ignoring one that's already gone. */
function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

/**
 * Run `npm <args>` in its own process group, with a hard time limit. It's over when npm exits,
 * even if something it started (a test server, a stray watcher) still holds its output open;
 * everything left in the group is then killed, so no check leaves processes behind or hangs.
 * @param {string[]} args @param {string} cwd @param {number} timeoutMs @param {AbortSignal} [signal] stops it early
 */
async function runCheck(args, cwd, timeoutMs, signal) {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-check-data-'));
  try {
    const env = checkEnv(tmpData, await freePort());
    const { code, output, timedOut } = await new Promise((resolve) => {
      let out = '';
      let timedOut = false;
      const child = spawn('npm', args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const add = (d) => {
        if (out.length < 10 * 1024 * 1024) out += d;
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const stop = () => {
        timedOut = true;
        killGroup(child.pid, 'SIGTERM');
        setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
      };
      const timer = setTimeout(stop, timeoutMs);
      signal?.addEventListener('abort', stop, { once: true });
      const done = (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        // Leftovers in the group (servers the tests started) must not keep the review waiting.
        killGroup(child.pid, 'SIGTERM');
        setTimeout(() => killGroup(child.pid, 'SIGKILL'), 2000).unref();
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code, output: out, timedOut });
      };
      child.once('error', (e) => {
        add(e.message);
        done(-1);
      });
      child.once('exit', (code, signal) => setTimeout(() => done(code ?? (signal ? 1 : 0)), 200));
    });
    if (timedOut) return { ok: false, timedOut: true, output: `Stopped after ${Math.round(timeoutMs / 1000)}s: npm ${args.join(' ')} took too long.\n${checkOutput(output, false)}` };
    return { ok: code === 0, output: checkOutput(output, code === 0) };
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
}

export class SelfImprove extends EventEmitter {
  /**
   * @param {any} tasks
   * @param {{ appDir?: string, now?: () => number, checkTimeoutMs?: number, reviewTimeoutMs?: number,
   *   access?: import('./devcopy.js').SelfImproveAccess }} [opts] access: stands in for the developer-copy check (tests)
   */
  constructor(tasks, { appDir = APP_DIR, now = () => Date.now(), checkTimeoutMs = config.checkTimeoutMs, reviewTimeoutMs = config.reviewTimeoutMs, access = undefined } = {}) {
    super();
    this.tasks = tasks;
    this.appDir = appDir;
    // Decided once at startup. Fails closed: self-improve is off unless this is the developer copy.
    this.access = access ?? selfImproveAccess({ appDir });
    if (this.access.marked) audit('dev_copy_marked', { reason: this.access.reason });
    this.now = now;
    this.checkTimeoutMs = checkTimeoutMs;
    this.reviewTimeoutMs = reviewTimeoutMs;
    this.unlock = null; // { expiresAt, usesLeft }
    this.request = null; // { id, instruction, code, createdAt }
    this.failures = 0;
    this.lockedUntil = 0;
    this.pinFile = path.join(selfDir(), 'pin.json');
    tasks.on('finished', (t) => t.kind === 'self' && this.prepareReview(t).catch((e) => this.reviewFailed(t, e)));
    // A follow-up continues on the same branch and worktree. This runs before the worker starts.
    tasks.on('follow_up', (t) => t.kind === 'self' && t.self && this.reopen(t));
    // A stopped self task isn't "working" any more; it waits for a follow-up or a discard.
    tasks.on('stopped', (t) => t.kind === 'self' && t.self && this.markStopped(t));
    this.reconcile();
    this.restoreRequest();
  }

  /**
   * After a restart: self tasks that say "working" but aren't running or about to resume (stopped,
   * or interrupted by a crash) are marked stopped, so status reports never list them as working.
   * One that finished while its review was being prepared gets its review.
   */
  reconcile() {
    for (const t of this.tasks.list()) {
      if (t.kind !== 'self' || t.self?.state !== 'working') continue;
      const resuming = t.resumeAfterRestart || t.status === 'queued' || this.tasks.isLive(t.id);
      if (resuming) continue;
      if (['stopped', 'interrupted'].includes(t.status)) this.markStopped(t);
      // Finished, but Echo restarted before its review was ready: prepare it now.
      else if (['done', 'failed'].includes(t.status)) this.prepareReview(t).catch((e) => this.reviewFailed(t, e));
    }
  }

  /** @param {any} task */
  markStopped(task) {
    if (task.self.state !== 'working') return;
    task.self.state = 'stopped';
    this.tasks.update(task, { self: task.self });
    audit('task_stopped', { taskId: task.id, status: task.status });
    this.emit('review', task);
  }

  /** Self-improve exists only in the developer's own copy of Echo (lib/devcopy.js). */
  get available() {
    return this.access.allowed;
  }

  assertAvailable() {
    if (!this.available) throw new Error(SELF_IMPROVE_UNAVAILABLE);
  }

  /* ---------- the pending confirmation survives a restart ---------- */

  requestFile() {
    return path.join(selfDir(), 'pending-request.json');
  }

  /** Remember what's waiting for confirmation (never the code: a new one is shown after a restart). */
  saveRequest() {
    try {
      if (!this.request) return fs.rmSync(this.requestFile(), { force: true });
      const { id, instruction, createdAt } = this.request;
      fs.mkdirSync(selfDir(), { recursive: true });
      writeJson(this.requestFile(), { id, instruction, createdAt }, { backup: false });
    } catch {}
  }

  /** On start: bring back a request that was still waiting, with a fresh code and a full five minutes. */
  restoreRequest() {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.requestFile(), 'utf8'));
    } catch {
      return;
    }
    if (!this.available || !saved?.instruction || !(this.now() - saved.createdAt < REQUEST_TTL_MS) || this.lockedUntil > this.now()) {
      fs.rmSync(this.requestFile(), { force: true });
      return;
    }
    this.request = { id: randomBytes(6).toString('hex'), instruction: saved.instruction, code: newCode(), createdAt: this.now() };
    audit('unlock_request_restored', { requestId: this.request.id, previousId: saved.id });
    this.saveRequest();
  }

  /* ---------- PIN ---------- */

  hasPin() {
    return fs.existsSync(this.pinFile);
  }

  checkPin(pin) {
    if (!this.hasPin()) return true;
    const { salt, hash } = JSON.parse(fs.readFileSync(this.pinFile, 'utf8'));
    const got = scryptSync(String(pin || ''), Buffer.from(salt, 'hex'), 64);
    return timingSafeEqual(got, Buffer.from(hash, 'hex'));
  }

  setPin(newPin, currentPin) {
    if (this.hasPin() && !this.checkPin(currentPin)) {
      audit('pin_change_rejected');
      throw new Error('Current PIN is wrong.');
    }
    if (!/^\d{4,10}$/.test(String(newPin))) throw new Error('Use 4 to 10 digits.');
    const salt = randomBytes(16);
    fs.mkdirSync(selfDir(), { recursive: true });
    writeJson(this.pinFile, { salt: salt.toString('hex'), hash: scryptSync(String(newPin), salt, 64).toString('hex') }, { mode: 0o600, backup: false });
    audit('pin_set');
  }

  /* ---------- unlock ---------- */

  status() {
    const unlocked = this.available && this.isUnlocked();
    return {
      available: this.available,
      unlocked,
      expiresAt: unlocked ? new Date(this.unlock.expiresAt).toISOString() : null,
      usesLeft: unlocked ? this.unlock.usesLeft : 0,
      hasPin: this.hasPin(),
      lockedOut: this.lockedUntil > this.now(),
      pendingRequest: this.available && this.request && this.now() - this.request.createdAt < REQUEST_TTL_MS ? this.publicRequest() : null,
    };
  }

  isUnlocked() {
    if (this.unlock && (this.unlock.expiresAt <= this.now() || this.unlock.usesLeft <= 0)) {
      audit('unlock_expired');
      this.unlock = null;
      this.emit('status');
    }
    return Boolean(this.unlock);
  }

  publicRequest() {
    const r = this.request;
    return { id: r.id, instruction: r.instruction, code: r.code, needsPin: this.hasPin(), firstTime: !fs.existsSync(path.join(this.appDir, '.git')), expiresAt: new Date(r.createdAt + REQUEST_TTL_MS).toISOString() };
  }

  /** Called by the assistant. Only shows a confirmation in the UI; never unlocks by itself. */
  requestUnlock(instruction) {
    this.assertAvailable();
    if (this.lockedUntil > this.now()) throw new Error('Self-improve is locked for a few minutes after too many wrong confirmations.');
    // New users (safe mode) start locked: no self-improve until a PIN protects it.
    if (getSettings().safeMode && !this.hasPin()) throw new Error('Self-improve is locked until a PIN is set. The user can set one in Settings, under Self-improve.');
    this.request = { id: randomBytes(6).toString('hex'), instruction, code: newCode(), createdAt: this.now() };
    audit('unlock_requested', { requestId: this.request.id, instruction });
    this.saveRequest();
    this.emit('unlock_request', this.publicRequest());
    return this.publicRequest();
  }

  /**
   * Called from the Echo window when you type the code (and PIN) and click Confirm.
   * @param {{ requestId: string, code: string, pin?: string }} input
   */
  async confirmUnlock({ requestId, code, pin }) {
    this.assertAvailable();
    if (this.lockedUntil > this.now()) throw new Error('Too many wrong attempts. Try again in a few minutes.');
    const r = this.request;
    const valid = r && r.id === requestId && this.now() - r.createdAt < REQUEST_TTL_MS;
    const codeOk = valid && String(code || '').trim().toUpperCase() === r.code;
    if (!valid || !codeOk || !this.checkPin(pin)) {
      this.failures++;
      audit('unlock_failed', { requestId, reason: !valid ? 'expired or unknown request' : !codeOk ? 'wrong code' : 'wrong PIN', failures: this.failures });
      if (this.failures >= MAX_ATTEMPTS) {
        this.lockedUntil = this.now() + LOCKOUT_MS;
        this.request = null;
        this.saveRequest();
        audit('locked_out', { minutes: LOCKOUT_MS / 60000 });
      }
      this.emit('status');
      throw new Error(!valid ? 'That request expired. Ask again.' : 'Code or PIN is wrong.');
    }
    this.failures = 0;
    this.request = null;
    this.saveRequest();
    this.unlock = { expiresAt: this.now() + config.selfUnlockMinutes * 60000, usesLeft: 1 };
    audit('unlocked', { requestId, minutes: config.selfUnlockMinutes });
    this.emit('status');
    return this.startTask(r.instruction);
  }

  cancelRequest() {
    if (this.request) audit('unlock_cancelled', { requestId: this.request.id });
    this.request = null;
    this.saveRequest();
    this.emit('status');
  }

  lock() {
    if (this.unlock) audit('locked_by_user');
    this.unlock = null;
    this.emit('status');
  }

  /* ---------- the self-improvement task ---------- */

  async ensureRepo() {
    this.assertAvailable();
    if (fs.existsSync(path.join(this.appDir, '.git'))) return false;
    await git(this.appDir, 'init', '-b', 'main');
    await git(this.appDir, 'add', '-A');
    await git(this.appDir, 'commit', '-m', 'Echo baseline (created by self-improve mode)');
    audit('repo_initialized', { head: await git(this.appDir, 'rev-parse', 'HEAD') });
    return true;
  }

  async startTask(instruction) {
    this.assertAvailable();
    if (!this.isUnlocked()) throw new Error('Self-improve mode is locked.');
    this.unlock.usesLeft--;
    await this.ensureRepo();
    const base = await git(this.appDir, 'rev-parse', 'HEAD');
    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const branch = `self/${stamp}-${slugify(instruction).slice(0, 30)}`;
    const worktree = path.join(config.worktreeDir, `self-${stamp}-${randomBytes(2).toString('hex')}`);
    fs.mkdirSync(config.worktreeDir, { recursive: true });
    await git(this.appDir, 'worktree', 'add', '-b', branch, worktree, base);
    cloneModules(this.appDir, worktree);
    const task = this.tasks.create({
      kind: 'self',
      project: 'Echo (self)',
      cwd: worktree,
      instruction,
      self: { branch, worktree, base, review: null, state: 'working' },
    });
    audit('task_started', { taskId: task.id, branch, worktree, base, instruction });
    this.emit('status');
    return task;
  }

  /**
   * Continue a finished self-improvement task: same branch, same worktree folder (so the
   * worker's session resumes), recreated if a merge or discard removed it. Synchronous, so it
   * is done before the worker starts.
   * @param {any} task
   */
  reopen(task) {
    this.assertAvailable(); // throws out of tasks.followUp, before any worker starts
    const s = task.self;
    const wasState = s.state;
    const recreated = !this.worktreeOk(s.worktree);
    if (recreated) {
      gitSync(this.appDir, 'worktree', 'prune');
      fs.rmSync(s.worktree, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(s.worktree), { recursive: true });
      const head = gitSync(this.appDir, 'rev-parse', 'HEAD');
      let hasBranch = true;
      try {
        gitSync(this.appDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${s.branch}`);
      } catch {
        hasBranch = false;
      }
      if (hasBranch) {
        gitSync(this.appDir, 'worktree', 'add', s.worktree, s.branch);
        // Bring the branch up to the live code (after a merge that's a fast-forward).
        try {
          gitSync(s.worktree, 'merge', '--ff-only', head);
        } catch {
          try {
            gitSync(s.worktree, 'merge', '--no-edit', '-m', `Update self-improve #${task.id} to the live code`, head);
          } catch (e) {
            try {
              gitSync(s.worktree, 'merge', '--abort');
            } catch {}
            audit('follow_up_update_failed', { taskId: task.id, branch: s.branch, error: e.message });
          }
        }
      } else {
        gitSync(this.appDir, 'worktree', 'add', '-b', s.branch, s.worktree, head);
      }
      cloneModules(this.appDir, s.worktree);
      s.base = gitSync(s.worktree, 'rev-parse', 'HEAD');
    }
    Object.assign(s, { state: 'working', review: null, error: undefined });
    this.tasks.update(task, { cwd: s.worktree, projectPath: s.worktree, self: s });
    audit('follow_up', { taskId: task.id, branch: s.branch, worktree: s.worktree, previousState: wasState, recreated, base: s.base });
    this.emit('review', task);
    return task;
  }

  /** @param {string} dir */
  worktreeOk(dir) {
    if (!fs.existsSync(path.join(dir, '.git'))) return false;
    try {
      return gitSync(dir, 'rev-parse', '--is-inside-work-tree') === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Send a follow-up to a self-improvement task (what the dispatcher's follow-up does for any
   * task): it continues on the same branch and worktree, and a new review is prepared when it ends.
   * @param {number} taskId
   * @param {string} message
   */
  continueTask(taskId, message) {
    this.assertAvailable();
    const task = this.tasks.get(taskId);
    if (!task || task.kind !== 'self') throw new Error('Not a self-improvement task.');
    return this.tasks.followUp(task.id, message);
  }

  /**
   * The checks for a review, with a hard limit on the whole run: a review never waits forever.
   * @param {any} task
   * @returns {Promise<{ checks: Record<string, any>, note?: string }>}
   */
  async reviewChecks(task) {
    let timer;
    const abort = new AbortController();
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => {
        abort.abort(); // and stop whatever check is still running
        resolve({ timedOut: true });
      }, this.reviewTimeoutMs);
    });
    try {
      const out = await Promise.race([runChecks(task.self.worktree, { base: task.self.base, timeoutMs: this.checkTimeoutMs, signal: abort.signal }), limit]);
      if (!('timedOut' in out && out.timedOut === true)) {
        const slow = Object.entries(out).filter(([, v]) => v.timedOut).map(([k]) => k);
        return { checks: out, note: slow.length ? `The ${slow.join(' and ')} check${slow.length > 1 ? 's' : ''} took too long and ${slow.length > 1 ? 'were' : 'was'} stopped. Check the changes carefully before merging.` : undefined };
      }
    } catch (e) {
      return { checks: { checks: { ok: false, output: e.message } }, note: `The review checks couldn't run (${e.message}). Check the changes carefully before merging.` };
    } finally {
      clearTimeout(timer);
    }
    const minutes = Math.round(this.reviewTimeoutMs / 60000);
    return {
      checks: { checks: { ok: false, timedOut: true, output: `The checks didn't finish within ${minutes || '<1'} minute${minutes === 1 ? '' : 's'}.` } },
      note: `The review checks didn't finish in time, so they were stopped. Run npm run review-checks or check the changes carefully before merging.`,
    };
  }

  async prepareReview(task) {
    const { worktree } = task.self;
    await git(worktree, 'add', '-A'); // staging only; nothing is committed without your approval
    const changed = await git(worktree, 'diff', '--cached', '--name-only');
    const { checks, note } = changed ? await this.reviewChecks(task) : { checks: {}, note: undefined };
    // A follow-up arrived while the checks ran: its own review comes when it finishes.
    if (this.tasks.isLive(task.id) || task.status === 'queued') return;
    await git(worktree, 'add', '-A'); // an install can update the lockfile
    await this.showReview(task, { checks, note });
  }

  /** Put the staged changes in front of you, with the check results and any note about them. */
  async showReview(task, { checks, note }) {
    const { worktree } = task.self;
    const stat = await git(worktree, 'diff', '--cached', '--stat');
    const diff = await git(worktree, 'diff', '--cached');
    const files = (await git(worktree, 'diff', '--cached', '--name-only')).split('\n').filter(Boolean);
    task.self.review = { stat, diff: diff.slice(0, 300000), truncated: diff.length > 300000, files, checks, note, preparedAt: new Date().toISOString() };
    task.self.state = files.length ? 'review' : 'no_changes';
    task.self.error = undefined;
    this.tasks.update(task, { self: task.self });
    audit('review_ready', { taskId: task.id, files, checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.ok])), ...(note ? { note } : {}) });
    this.emit('review', task);
  }

  /** Preparing the review broke: still show the changes for review (with a note), never leave the task "working". */
  async reviewFailed(task, err) {
    audit('review_failed', { taskId: task.id, error: err.message });
    try {
      await git(task.self.worktree, 'add', '-A');
      const note = `Preparing the review hit an error (${err.message}), so the checks didn't run. Check the changes carefully before merging.`;
      await this.showReview(task, { checks: { checks: { ok: false, output: err.message } }, note });
      return;
    } catch {}
    task.self.state = 'error';
    task.self.error = err.message;
    this.tasks.update(task, { self: task.self });
    this.emit('review', task);
  }

  /**
   * Only reachable from the Echo window (click + PIN if set).
   * @param {number} taskId
   * @param {{ pin?: string }} [opts]
   */
  async approveMerge(taskId, { pin } = {}) {
    this.assertAvailable();
    const task = this.tasks.get(taskId);
    if (!task || task.kind !== 'self' || task.self?.state !== 'review') throw new Error('Nothing to merge for that task.');
    if (this.tasks.isLive(task.id)) throw new Error('That task is still working on a follow-up. Wait for its new review.');
    if (!this.checkPin(pin)) {
      audit('merge_rejected', { taskId, reason: 'wrong PIN' });
      throw new Error('Wrong PIN.');
    }
    const { worktree, branch } = task.self;
    const savedLiveEdits = await this.saveLiveEdits(task);
    const lastGood = await git(this.appDir, 'rev-parse', 'HEAD');
    await git(worktree, 'add', '-A');
    await git(worktree, 'commit', '-m', `Self-improve #${task.id}: ${task.title}`, '--allow-empty');
    const depFiles = () => ['package.json', 'package-lock.json'].map((f) => (fs.existsSync(path.join(this.appDir, f)) ? fs.readFileSync(path.join(this.appDir, f), 'utf8') : '')).join('\0');
    const depsBefore = depFiles();
    try {
      await git(this.appDir, 'merge', '--no-ff', '--no-edit', '-m', `Merge self-improve #${task.id}`, branch);
    } catch (e) {
      await git(this.appDir, 'merge', '--abort').catch(() => {});
      audit('merge_failed', { taskId, error: e.message });
      throw new Error('The change conflicts with the current code, so I left everything as it was.');
    }
    const head = await git(this.appDir, 'rev-parse', 'HEAD');
    const depsChanged = depFiles() !== depsBefore;
    if (depsChanged) {
      try {
        await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: this.appDir, timeout: 5 * 60 * 1000 });
      } catch (e) {
        // Don't restart into a version whose dependencies didn't install.
        await git(this.appDir, 'reset', '--hard', lastGood);
        await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: this.appDir, timeout: 5 * 60 * 1000 }).catch(() => {});
        audit('merge_failed', { taskId, error: `npm install failed: ${e.message}` });
        throw new Error("The change needs new packages and installing them failed, so I left everything as it was.");
      }
    }
    writeJson(path.join(selfDir(), 'pending-restart.json'), { lastGood, head, taskId: task.id, depsChanged, at: new Date().toISOString() }, { backup: false });
    task.self.state = 'merged';
    task.self.mergedAs = head;
    this.tasks.update(task, { self: task.self });
    audit('merged', { taskId: task.id, branch, lastGood, head, savedLiveEdits });
    await this.cleanup(task, { keepBranch: true });
    this.emit('merged', task);
    return { lastGood, head, savedLiveEdits };
  }

  /**
   * Hand edits in the live folder are never lost to a merge: commit them first (git ignores
   * data/, logs/, node_modules, .env and models), or if that fails, stash them under a unique
   * name. Either way the audit log says where they went.
   * @returns {Promise<null | { how: 'commit' | 'stash', ref: string, files: string[], message: string }>}
   */
  async saveLiveEdits(task) {
    const dirty = await git(this.appDir, 'status', '--porcelain');
    if (!dirty) return null;
    const files = dirty.split('\n').map((l) => l.replace(/^\s*\S+\s+/, '')).filter(Boolean);
    const message = `Save live edits before self-improve #${task.id} merge`;
    try {
      await git(this.appDir, 'add', '-A');
      await git(this.appDir, 'commit', '-m', message);
      const ref = await git(this.appDir, 'rev-parse', 'HEAD');
      audit('live_edits_committed', { taskId: task.id, commit: ref, files });
      return { how: 'commit', ref, files, message };
    } catch (e) {
      audit('live_edits_commit_failed', { taskId: task.id, error: e.message });
    }
    const tag = `echo-merge-${task.id}-${new Date(this.now()).toISOString().replace(/[-:.]/g, '')}`;
    try {
      await git(this.appDir, 'stash', 'push', '-u', '-m', tag);
      // Find our entry by its unique message; never touch other stashes.
      const entry = (await git(this.appDir, 'stash', 'list', '--format=%H %gs')).split('\n').find((l) => l.endsWith(tag));
      if (!entry || (await git(this.appDir, 'status', '--porcelain'))) throw new Error('the stash did not leave the folder clean');
      const ref = entry.split(' ')[0];
      audit('live_edits_stashed', { taskId: task.id, stash: ref, message: tag, files });
      return { how: 'stash', ref, files, message: tag };
    } catch (e) {
      audit('merge_failed', { taskId: task.id, error: `could not save live edits: ${e.message}` });
      throw new Error("The live Echo folder has edits I couldn't save safely, so I didn't merge. Commit or discard them first.");
    }
  }

  async discard(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.kind !== 'self') throw new Error('Not a self-improvement task.');
    if (this.tasks.isLive(task.id)) await this.tasks.stop(task.id);
    await this.cleanup(task, { keepBranch: false });
    task.self.state = 'discarded';
    this.tasks.update(task, { self: task.self });
    audit('discarded', { taskId: task.id });
    this.emit('review', task);
  }

  async cleanup(task, { keepBranch }) {
    await git(this.appDir, 'worktree', 'remove', '--force', task.self.worktree).catch(() => fs.rmSync(task.self.worktree, { recursive: true, force: true }));
    await git(this.appDir, 'worktree', 'prune').catch(() => {});
    if (!keepBranch) await git(this.appDir, 'branch', '-D', task.self.branch).catch(() => {});
  }
}
