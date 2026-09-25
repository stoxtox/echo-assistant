// Keeps Echo running. Restarts it on request (exit code 75), health-checks a new version
// after a self-update, and rolls back to the last good commit if that version fails.
//
//   npm start  ->  node supervisor.js  ->  node server.js
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config, APP_DIR } from './lib/config.js';
import { audit } from './lib/selfimprove.js';
import { pendingUpdate, confirmUpdate, rollbackUpdate } from './lib/updater.js';

export const RESTART_CODE = 75;
// Overridable so the rollback path can be tested against a throwaway repo.
const appDir = process.env.VOICEOPS_APP_DIR || APP_DIR;
const selfDir = path.join(config.dataDir, 'self');
const pendingFile = path.join(selfDir, 'pending-restart.json');
const noticeFile = path.join(selfDir, 'rollback-notice.json');
const HEALTH_TIMEOUT_MS = Number(process.env.VOICEOPS_HEALTH_TIMEOUT_MS || 30000);

let child = null;
let stopping = false;
let rollingBack = false;
let crashes = [];

const log = (...a) => console.log(`[supervisor ${new Date().toLocaleTimeString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

async function waitPortFree(ms = 20000) {
  const deadline = Date.now() + ms;
  while ((await portInUse(config.port)) && Date.now() < deadline) await sleep(300);
}

// With a pid, only that process's answer counts, so a lingering old process holding the port
// can't vouch for the new version.
export async function healthy(port = config.port, ms = HEALTH_TIMEOUT_MS, pid = undefined) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = res.ok ? await res.json() : null;
      if (body?.ok && (pid === undefined || body.pid === undefined || body.pid === pid)) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function start() {
  log('starting Echo');
  child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server.js'], {
    cwd: appDir,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, VOICEOPS_SUPERVISED: '1' },
  });
  const me = child;
  const startedAt = Date.now();
  let restartRequested = false;
  child.on('message', (m) => {
    if (m && /** @type {any} */ (m).type === 'restart') restartRequested = true;
  });
  // A restart message sent just before exiting can be processed after 'exit' fires, so wait
  // for the IPC channel to close (briefly) before deciding whether this was a crash.
  child.on('exit', async (code, signal) => {
    if (me.connected) await Promise.race([new Promise((r) => me.once('disconnect', r)), sleep(1000)]);
    await new Promise((r) => setImmediate(r));
    onExit(me, code, signal, { restartRequested, startedAt });
  });
  verifyIfUpdated(me);
}

async function verifyIfUpdated(me) {
  if (pendingUpdate()) return verifyRelease(me);
  const pending = readJson(pendingFile);
  if (!pending) return;
  log(`verifying new version ${pending.head.slice(0, 8)}…`);
  const ok = await healthy(config.port, HEALTH_TIMEOUT_MS, me.pid);
  if (me !== child || rollingBack) return;
  if (ok) {
    fs.rmSync(pendingFile, { force: true });
    audit('health_ok', { head: pending.head, taskId: pending.taskId });
    log('new version is healthy');
  } else {
    await rollback(pending, 'failed its health check');
  }
}

// A release update (lib/updater.js) swapped in new files: keep them only if the new version answers.
async function verifyRelease(me) {
  const pending = pendingUpdate();
  log(`verifying Echo ${pending.to}…`);
  const ok = await healthy(config.port, HEALTH_TIMEOUT_MS, me.pid);
  if (me !== child || rollingBack) return;
  if (ok) {
    confirmUpdate();
    audit('update_ok', { from: pending.from, to: pending.to, kind: pending.kind });
    log(`Echo ${pending.to} is healthy`);
  } else {
    await rollbackRelease(pending, 'failed its health check');
  }
}

async function stopChild() {
  if (child && child.exitCode === null) {
    const dying = child;
    child = null;
    dying.kill('SIGTERM');
    await Promise.race([new Promise((r) => dying.once('exit', r)), sleep(10000)]);
    if (dying.exitCode === null) dying.kill('SIGKILL');
  }
}

async function rollbackRelease(pending, why) {
  if (rollingBack) return;
  rollingBack = true;
  log(`Echo ${pending.to} ${why}; going back to ${pending.from}`);
  await stopChild();
  try {
    rollbackUpdate({ appDir, why });
    audit('update_rolled_back', { from: pending.to, to: pending.from, why });
  } catch (e) {
    audit('update_rollback_failed', { error: e.message });
    log('rollback failed:', e.message);
  }
  rollingBack = false;
  await waitPortFree();
  start();
}

async function rollback(pending, why) {
  if (rollingBack) return;
  rollingBack = true;
  log(`new version ${why}; rolling back to ${pending.lastGood.slice(0, 8)}`);
  if (child && child.exitCode === null) {
    const dying = child;
    child = null;
    dying.kill('SIGTERM');
    await Promise.race([new Promise((r) => dying.once('exit', r)), sleep(10000)]);
    if (dying.exitCode === null) dying.kill('SIGKILL');
  }
  try {
    // Only undoes the self-update merge: any hand edits in the live folder were committed
    // (or stashed) before merging, so lastGood includes them, and the change stays on its branch.
    execFileSync('git', ['reset', '--hard', pending.lastGood], { cwd: appDir });
    if (pending.depsChanged) execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir });
    fs.writeFileSync(noticeFile, JSON.stringify({ ...pending, why, at: new Date().toISOString() }, null, 2));
    audit('rolled_back', { from: pending.head, to: pending.lastGood, why, taskId: pending.taskId });
  } catch (e) {
    audit('rollback_failed', { error: e.message });
    log('rollback failed:', e.message);
  }
  fs.rmSync(pendingFile, { force: true });
  rollingBack = false;
  await waitPortFree();
  start();
}

// A merge that changed dependencies already ran npm install, but install again if
// node_modules is older than the lockfile (e.g. that install failed or was skipped), so the
// new version never starts against stale native modules.
function ensureDeps(pending) {
  if (!pending?.depsChanged) return;
  const lock = path.join(appDir, 'package-lock.json');
  const installed = path.join(appDir, 'node_modules', '.package-lock.json');
  try {
    if (fs.existsSync(installed) && fs.statSync(installed).mtimeMs >= fs.statSync(lock).mtimeMs) return;
    log('dependencies changed; running npm install');
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir, stdio: 'inherit', timeout: 5 * 60 * 1000 });
  } catch (e) {
    log('npm install failed:', e.message);
  }
}

async function onExit(me, code, signal, { restartRequested = false, startedAt = 0 } = {}) {
  if (me !== child) return; // an old process we already replaced
  child = null;
  if (stopping) return process.exit(0);
  if (rollingBack) return;
  const release = pendingUpdate();
  if (release) {
    const planned = code === RESTART_CODE || restartRequested || Date.parse(release.at) >= startedAt;
    if (!planned) return rollbackRelease(release, `crashed (exit ${code ?? signal})`);
    log(`restarting into Echo ${release.to}`);
    await waitPortFree();
    return start();
  }
  const pending = readJson(pendingFile);
  // The version that exited predates the pending update, so it can't be the new version
  // failing: treat it as the restart that applies the update, whatever its exit status.
  const oldVersion = pending && Date.parse(pending.at) >= startedAt;
  // Planned restarts never count as crashes and never roll back.
  if (code === RESTART_CODE || restartRequested || oldVersion) {
    log(code === RESTART_CODE ? 'restart requested' : `restart requested (exit ${code ?? signal})`);
    ensureDeps(pending);
    await waitPortFree();
    return start();
  }
  if (pending) return rollback(pending, `crashed (exit ${code ?? signal})`);
  crashes = [...crashes.filter((t) => Date.now() - t < 120000), Date.now()];
  if (crashes.length > 5) {
    log('Echo keeps crashing; giving up. Check the log above.');
    return process.exit(1);
  }
  log(`Echo exited (${code ?? signal}); restarting in ${crashes.length}s`);
  await sleep(crashes.length * 1000);
  await waitPortFree();
  start();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(APP_DIR, 'supervisor.js')) {
  fs.mkdirSync(selfDir, { recursive: true });
  await waitPortFree(process.env.VOICEOPS_WAIT_PORT_FREE ? 60000 : 3000);
  if (await portInUse(config.port)) {
    log(`port ${config.port} is already in use. Is Echo already running?`);
    process.exit(1);
  }
  start();
}
