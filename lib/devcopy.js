// Is this Echo the developer's own copy? Only that copy may use self-improve.
//
// Self-improve lets Echo rewrite its own code. The decision (Sept 30, 2026): installed,
// packaged or cloned copies must never be able to do that; only the developer's own checkout
// (the repo Echo is developed in) offers it. This is the one place that decides, and it fails closed:
// anything it can't confirm, or any error while checking, means self-improve is off.
//
// A developer copy must be all of:
//   1. not a packaged copy (no .echo-package marker from `npm run package` or a release),
//   2. the main git checkout of its folder (not a linked worktree, not a folder inside another repo),
//   3. not a clone of the public release repo (echo-release.json names it),
//   4. explicitly marked: ECHO_DEV_COPY=1, or a .echo-dev file in the Echo folder (git ignores
//      it, so it never reaches a package, a release or the public repo).
// ECHO_DEV_COPY=0 always turns self-improve off.
//
// The checkout that already merged self-improvements before this check existed (its audit log
// says so) is the developer's own: it gets the .echo-dev marker once, so nothing changes there.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR, config } from './config.js';
import { releaseRepo } from './release.js';

export const DEV_MARKER = '.echo-dev';
export const SELF_IMPROVE_UNAVAILABLE = 'Self-improve is only available in the developer copy of Echo.';

/** @typedef {{ allowed: boolean, reason: string, marked?: boolean }} SelfImproveAccess */

const gitOut = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
const real = (p) => fs.realpathSync(path.resolve(p));

/**
 * @param {{ appDir?: string, dataDir?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {SelfImproveAccess}
 */
export function selfImproveAccess({ appDir = APP_DIR, dataDir = config.dataDir, env = process.env } = {}) {
  try {
    return decide(appDir, dataDir, env);
  } catch (e) {
    return { allowed: false, reason: `couldn't tell whether this is the developer copy (${e.message})` };
  }
}

/** @returns {SelfImproveAccess} */
function decide(appDir, dataDir, env) {
  const flag = env.ECHO_DEV_COPY;
  if (flag === '0') return { allowed: false, reason: 'turned off by ECHO_DEV_COPY=0' };
  if (fs.existsSync(path.join(appDir, '.echo-package'))) return { allowed: false, reason: 'a packaged copy' };
  if (!fs.existsSync(path.join(appDir, '.git'))) return { allowed: false, reason: 'not a git checkout' };
  if (real(gitOut(appDir, 'rev-parse', '--show-toplevel')) !== real(appDir)) return { allowed: false, reason: 'not the top of a git checkout' };
  const gitDir = real(path.resolve(appDir, gitOut(appDir, 'rev-parse', '--git-dir')));
  const commonDir = real(path.resolve(appDir, gitOut(appDir, 'rev-parse', '--git-common-dir')));
  if (gitDir !== commonDir) return { allowed: false, reason: 'a git worktree, not the main checkout' };
  let origin = '';
  try {
    origin = gitOut(appDir, 'remote', 'get-url', 'origin');
  } catch {} // no origin remote
  const pub = releaseRepo(appDir);
  if (origin && pub.configured && new RegExp(`[/:]${esc(pub.owner)}/${esc(pub.repo)}(\\.git)?/?$`, 'i').test(origin)) {
    return { allowed: false, reason: 'a clone of the public Echo repo' };
  }
  if (flag === '1') return { allowed: true, reason: 'ECHO_DEV_COPY=1' };
  const marker = path.join(appDir, DEV_MARKER);
  if (fs.existsSync(marker)) return { allowed: true, reason: `${DEV_MARKER} marker` };
  // The developer's existing checkout: has its own remote and has merged self-improvements before.
  if (origin && hasMerged(dataDir)) {
    try {
      fs.writeFileSync(marker, JSON.stringify({ devCopy: true, markedAt: new Date().toISOString(), why: 'already merged self-improvements' }, null, 2) + '\n');
    } catch {}
    return { allowed: true, reason: 'already merged self-improvements', marked: true };
  }
  return { allowed: false, reason: `not marked as the developer copy (set ECHO_DEV_COPY=1 or add ${DEV_MARKER})` };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hasMerged(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, 'self', 'audit.log'), 'utf8').includes('"event":"merged"');
  } catch {
    return false;
  }
}
