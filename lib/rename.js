// Moves an Echo folder still named VoiceOps (and its .voiceops-worktrees folder) to the Echo
// names, without losing anything. Run by scripts/rename-folder.js while Echo is stopped.
//
// What it does, in order:
//   1. VoiceOps/ -> Echo/, and leaves a VoiceOps link to Echo/ so old paths keep working
//      (the Mac app's baked-in folder, history in conversations and the audit log).
//   2. .voiceops-worktrees/* -> .echo-worktrees/, with a .voiceops-worktrees link left behind.
//   3. `git worktree repair`, so git's own links between the checkout and its worktrees point
//      at the new folders.
//   4. The folder paths saved in Echo's data (a task's cwd, projectPath and worktree) are updated.
//      Each changed file is backed up first as <name>.before-rename.
//   5. Claude Code keeps sessions and memory per folder (~/.claude/projects/<folder with - for
//      every other character>). Those folders are renamed to the new names, with links left
//      behind, so tasks resume their sessions and Claude's memory of the project stays.
//   6. On a Mac, the Echo app's EchoDir preference is pointed at the new folder. The app itself
//      (bundle ID, signature, permissions) isn't touched.
// Every step skips itself if it's already done, so running it twice is harmless.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LEGACY_NAME, LEGACY_WORKTREES, WORKTREES, migrateLegacyLog } from './legacy.js';

export const NEW_NAME = 'Echo';
export const APP_BUNDLE_ID = 'local.echo.app';
/** JSON keys in Echo's data that hold a folder path. Only these are rewritten. */
const PATH_KEYS = new Set(['cwd', 'projectPath', 'worktree', 'appDir', 'dir']);

/** Claude Code's folder name for a working directory. */
export const claudeKey = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

const isRealDir = (p) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** `to` with `from` as its prefix swapped, or null if `p` isn't inside `from`. */
const swapPrefix = (p, from, to) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : null);

/**
 * What the rename would do for the Echo folder at appDir.
 * @param {{ appDir: string, dataDir?: string, home?: string }} o
 */
export function planRename({ appDir, dataDir, home = os.homedir() }) {
  const parent = path.dirname(appDir);
  const oldApp = path.basename(appDir) === LEGACY_NAME ? appDir : path.join(parent, LEGACY_NAME);
  const newApp = path.join(parent, NEW_NAME);
  return {
    parent,
    oldApp,
    newApp,
    oldWorktrees: path.join(parent, LEGACY_WORKTREES),
    newWorktrees: path.join(parent, WORKTREES),
    // A data folder inside the app folder moves with it.
    dataDir: dataDir ? swapPrefix(dataDir, oldApp, newApp) || dataDir : path.join(newApp, 'data'),
    claudeProjects: path.join(home, '.claude', 'projects'),
  };
}

/**
 * Can the rename go ahead? Returns the reason it can't, or ''.
 * @param {ReturnType<typeof planRename>} plan
 */
export function blocker(plan) {
  if (isRealDir(plan.oldApp) && exists(plan.newApp)) return `both ${plan.oldApp} and ${plan.newApp} exist; move one of them out of the way first`;
  if (!isRealDir(plan.oldApp) && !isRealDir(plan.newApp)) return `no Echo folder at ${plan.oldApp} or ${plan.newApp}`;
  return '';
}

/**
 * Do the rename. Echo must not be running.
 * @param {ReturnType<typeof planRename>} plan
 * @param {{ dryRun?: boolean, macPrefs?: boolean, log?: (line: string) => void }} [o]
 * @returns {string[]} what was done (or would be, with dryRun)
 */
export function runRename(plan, { dryRun = false, macPrefs = process.platform === 'darwin', log = () => {} } = {}) {
  const done = [];
  const step = (line, fn) => {
    done.push(line);
    log(line);
    if (!dryRun) fn();
  };
  const why = blocker(plan);
  if (why) throw new Error(why);

  // 1. The Echo folder.
  if (isRealDir(plan.oldApp)) {
    step(`Moved ${plan.oldApp} to ${plan.newApp}`, () => fs.renameSync(plan.oldApp, plan.newApp));
  }
  if (!exists(plan.oldApp) || (dryRun && isRealDir(plan.oldApp))) {
    step(`Linked ${plan.oldApp} to ${NEW_NAME}`, () => fs.symlinkSync(NEW_NAME, plan.oldApp));
  }

  // 2. The worktrees folder.
  /** @type {[string, string][]} old and new path of every moved worktree */
  const moved = [];
  if (isRealDir(plan.oldWorktrees)) {
    if (!exists(plan.newWorktrees)) step(`Made ${plan.newWorktrees}`, () => fs.mkdirSync(plan.newWorktrees));
    for (const name of fs.readdirSync(plan.oldWorktrees)) {
      const from = path.join(plan.oldWorktrees, name);
      const to = path.join(plan.newWorktrees, name);
      if (exists(to)) {
        log(`Left ${from} where it is: ${to} already exists`);
        continue;
      }
      moved.push([from, to]);
      step(`Moved worktree ${name} to ${plan.newWorktrees}`, () => fs.renameSync(from, to));
    }
    const leftover = dryRun ? fs.readdirSync(plan.oldWorktrees).filter((n) => !moved.some(([f]) => path.basename(f) === n)) : fs.readdirSync(plan.oldWorktrees);
    if (!leftover.length) {
      step(`Linked ${plan.oldWorktrees} to ${WORKTREES}`, () => {
        fs.rmdirSync(plan.oldWorktrees);
        fs.symlinkSync(WORKTREES, plan.oldWorktrees);
      });
    }
  }

  // 3. git's links between the checkout and its worktrees: each worktree's .git file names the
  // checkout's .git/worktrees/<id>, whose gitdir file names the worktree back.
  const direct = (p) => swapPrefix(p, plan.oldApp, plan.newApp) ?? swapPrefix(p, plan.oldWorktrees, plan.newWorktrees);
  // A path that reaches the old folder another way (through a link such as /var -> /private/var)
  // is followed through the links the move left behind.
  const swap = (p) => {
    const d = direct(p);
    if (d || dryRun || !oldNamed(p)) return d;
    const r = resolveExisting(p);
    return r && (swapPrefix(r, plan.newApp, plan.newApp) ?? swapPrefix(r, plan.newWorktrees, plan.newWorktrees)) ? r : null;
  };
  const gitLinks = [];
  if (!dryRun && isRealDir(plan.newWorktrees)) {
    for (const n of fs.readdirSync(plan.newWorktrees)) gitLinks.push({ file: path.join(plan.newWorktrees, n, '.git'), prefix: 'gitdir: ' });
  }
  const adminDir = path.join(plan.newApp, '.git', 'worktrees');
  if (!dryRun && isRealDir(adminDir)) {
    for (const n of fs.readdirSync(adminDir)) gitLinks.push({ file: path.join(adminDir, n, 'gitdir'), prefix: '' });
  }
  let relinked = 0;
  for (const { file, prefix } of gitLinks) {
    let text;
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const target = text.trim().slice(prefix.length);
    if (!text.startsWith(prefix) || !path.isAbsolute(target)) continue;
    const to = swap(target);
    if (!to) continue;
    fs.writeFileSync(file, prefix + to + '\n');
    relinked++;
  }
  if (fs.existsSync(path.join(dryRun ? plan.oldApp : plan.newApp, '.git'))) {
    step(`Repaired git's worktree links (${dryRun ? moved.length : relinked} updated)`, () => {
      try {
        execFileSync('git', ['worktree', 'repair'], { cwd: plan.newApp, stdio: 'ignore' });
      } catch {} // the links above are what matter; repair only tidies up
    });
  }

  // 4. Folder paths saved in Echo's data.
  const dataDir = dryRun ? swapPrefix(plan.dataDir, plan.newApp, plan.oldApp) || plan.dataDir : plan.dataDir;
  for (const file of jsonFiles(dataDir)) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const n = rewritePaths(data, swap);
    if (!n) continue;
    step(`Updated ${n} saved folder path${n === 1 ? '' : 's'} in ${path.basename(file)} (backup: ${path.basename(file)}.before-rename)`, () => {
      const backup = file + '.before-rename';
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      const tmp = file + '.tmp-rename';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    });
  }
  if (!dryRun) migrateLegacyLog(path.join(plan.newApp, 'logs'));

  // 5. Claude Code's per-folder sessions and memory.
  const claudePairs = [[plan.oldApp, plan.newApp], [plan.oldWorktrees, plan.newWorktrees], ...moved];
  // Worktrees that were already in the new folder before (or moved on an earlier run).
  if (isRealDir(plan.newWorktrees)) {
    for (const n of fs.readdirSync(plan.newWorktrees)) claudePairs.push([path.join(plan.oldWorktrees, n), path.join(plan.newWorktrees, n)]);
  }
  const seen = new Set();
  for (const [from, to] of claudePairs) {
    const a = path.join(plan.claudeProjects, claudeKey(from));
    const b = path.join(plan.claudeProjects, claudeKey(to));
    if (seen.has(a)) continue;
    seen.add(a);
    if (!isRealDir(a) || exists(b)) continue;
    step(`Moved Claude's sessions for ${path.basename(from)} to the new folder name`, () => {
      fs.renameSync(a, b);
      fs.symlinkSync(path.basename(b), a);
    });
  }

  // 6. The Mac app's folder preference (EchoDir beats the folder baked into the app).
  if (macPrefs) {
    step(`Pointed the Echo app at ${plan.newApp}`, () => {
      execFileSync('/usr/bin/defaults', ['write', APP_BUNDLE_ID, 'EchoDir', plan.newApp], { stdio: 'ignore' });
    });
  }
  return done;
}

const oldNamed = (p) => p.split('/').some((s) => s === LEGACY_NAME || s === LEGACY_WORKTREES);

/** The real path of p, or of its nearest existing parent with the rest added back. */
function resolveExisting(p) {
  let rest = '';
  for (let dir = p; dir !== path.dirname(dir); rest = path.join(path.basename(dir), rest), dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync(dir), rest);
    } catch {}
  }
  return null;
}

/** The JSON files at the top of the data folder and in data/self. */
function jsonFiles(dataDir) {
  const out = [];
  for (const dir of [dataDir, path.join(dataDir, 'self')]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith('.json') && n !== 'pin.json') out.push(path.join(dir, n));
  }
  return out;
}

/**
 * Swap folder paths in place under the keys in PATH_KEYS. Returns how many changed.
 * @param {any} node
 * @param {(p: string) => string | null} swap
 */
export function rewritePaths(node, swap) {
  let n = 0;
  if (Array.isArray(node)) {
    for (const v of node) n += rewritePaths(v, swap);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && PATH_KEYS.has(k) && path.isAbsolute(v)) {
        const to = swap(v);
        if (to && to !== v) {
          node[k] = to;
          n++;
        }
      } else if (v && typeof v === 'object') n += rewritePaths(v, swap);
    }
  }
  return n;
}

