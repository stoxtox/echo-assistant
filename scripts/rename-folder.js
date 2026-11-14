#!/usr/bin/env node
// Renames Echo's folder from VoiceOps to Echo (and .voiceops-worktrees to .echo-worktrees),
// keeping settings, memory, logs, tasks, contact aliases and Claude sessions. See lib/rename.js.
//
//   node scripts/rename-folder.js --dry-run     show what it would do
//   node scripts/rename-folder.js               do it (Echo must be stopped)
//   node scripts/rename-folder.js --restart     stop Echo, do it, start Echo again from the new folder.
//                                               Runs in the background, so it can be started from
//                                               inside Echo; progress goes to /tmp/echo-rename.log.
//   --no-app-pref                               leave the Mac app's folder preference alone (tests)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { config, APP_DIR, DEFAULT_PORT } from '../lib/config.js';
import { planRename, runRename, blocker } from '../lib/rename.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const LOG = path.join(os.tmpdir(), 'echo-rename.log');
const log = (line) => {
  console.log(line);
  if (has('--background')) fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
};

const appDir = fs.realpathSync(APP_DIR);
const plan = planRename({ appDir, dataDir: config.dataDir });
const macPrefs = process.platform === 'darwin' && !has('--no-app-pref');
const why = blocker(plan);
if (why) {
  console.error(`Can't rename: ${why}`);
  process.exit(1);
}

// Is this folder's Echo answering? An Echo from another folder on the same port doesn't count;
// if we can't tell which folder it runs from, assume it's this one.
const ourEcho = async (port) => {
  let pid;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    pid = (await r.json()).pid;
  } catch {
    return false;
  }
  try {
    const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000 }).split('\n').find((l) => l.startsWith('n'))?.slice(1);
    return !cwd || fs.realpathSync(cwd) === appDir;
  } catch {
    return true;
  }
};
const echoRunning = async () => (await ourEcho(config.port)) || (config.port !== DEFAULT_PORT && (await ourEcho(DEFAULT_PORT)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (has('--dry-run')) {
  for (const line of runRename(plan, { dryRun: true, macPrefs })) console.log(`would: ${line}`);
  process.exit(0);
}

if (has('--restart') && !has('--background')) {
  // Hand over to a detached copy, so stopping Echo doesn't stop this too.
  fs.writeFileSync(LOG, '');
  spawn(process.execPath, [process.argv[1], ...args, '--background'], { cwd: os.homedir(), detached: true, stdio: 'ignore', env: process.env }).unref();
  console.log(`Renaming in the background: Echo stops, moves to ${plan.newApp}, and starts again. Progress: ${LOG}`);
  process.exit(0);
}

if (has('--restart')) {
  log('Stopping Echo…');
  try {
    execFileSync('/bin/bash', [path.join(appDir, 'scripts', 'launcher.sh'), '--stop', appDir], { stdio: 'ignore', timeout: 30000 });
  } catch {}
  for (let i = 0; i < 60 && (await echoRunning()); i++) await sleep(500);
}
if (await echoRunning()) {
  log('Echo is still running. Quit it first (untick Keep Echo Running After Quit, or run scripts/launcher.sh --stop), then run this again.');
  process.exit(1);
}

try {
  runRename(plan, { log, macPrefs });
} catch (e) {
  log(`Rename stopped: ${e.message}`);
  process.exit(1);
}
log(`Done. Echo now lives in ${plan.newApp}.`);

if (has('--restart')) {
  log('Starting Echo…');
  try {
    execFileSync('/bin/bash', [path.join(plan.newApp, 'scripts', 'launcher.sh'), plan.newApp], { stdio: 'ignore', timeout: 120000, env: { ...process.env, ECHO_NO_BROWSER: '1' } });
    log('Echo is running again.');
  } catch {
    log(`Echo didn't start on its own. Open the Echo app, or run ${path.join(plan.newApp, 'start.command')}.`);
  }
}
