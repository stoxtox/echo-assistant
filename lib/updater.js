// Keeps an installed Echo up to date from its GitHub Releases.
//
// Check: once a day (and on "Check for updates"), ask the Releases API for the latest release
// and compare versions. Apply: download the zip, verify its SHA-256, unpack it into a staging
// folder, install packages there if they changed, then swap the product files in. The user's
// data, logs, models, .env and port settings are never touched. The old version is kept in
// .echo-update/previous for a manual rollback. Echo then restarts (running tasks pause and
// resume), the supervisor health-checks the new version and swaps the old one back if it fails.
//
// A developer copy (a git checkout that wasn't installed from a package) never updates itself.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { APP_DIR, config } from './config.js';
import { releaseRepo, isNewer, parseVersion, zipName, checksumName, parseChecksum, verifyChecksum } from './release.js';

const DAY = 24 * 3600 * 1000;

/** Top-level names that belong to the user or this Mac, never to a release. */
export const PRESERVE = new Set(['data', 'logs', 'models', 'node_modules', '.env', '.echo-port', '.echo-node', '.echo-update', '.git', 'dist', '.DS_Store']);
const isPreserved = (name) => PRESERVE.has(name) || /^\.env(\..+)?$/.test(name);

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

export const versionOf = (dir) => readJson(path.join(dir, 'package.json'))?.version || '0.0.0';

/** A git checkout that wasn't installed from a package (Echo's own development copy). */
export function isDeveloperCopy(appDir = APP_DIR) {
  const env = process.env.ECHO_DEVELOPER_COPY;
  if (env === '1' || env === '0') return env === '1';
  return fs.existsSync(path.join(appDir, '.git')) && !fs.existsSync(path.join(appDir, '.echo-package'));
}

/** Where the updater keeps downloads, staging and the previous version. */
export const updateDirs = (appDir = APP_DIR) => {
  const root = path.join(appDir, '.echo-update');
  return { root, downloads: path.join(root, 'downloads'), staging: path.join(root, 'staging'), previous: path.join(root, 'previous') };
};
/** Where the update's bookkeeping lives (in the data folder, so it survives any swap). */
export const updateFiles = (dataDir = config.dataDir) => {
  const dir = path.join(dataDir, 'update');
  return { dir, state: path.join(dir, 'state.json'), pending: path.join(dir, 'pending-update.json'), notice: path.join(dir, 'update-notice.json') };
};

/** The top-level names to leave alone: PRESERVE, plus the data and log folders if they live inside Echo. */
function keepNames(appDir, extra = []) {
  const names = new Set();
  for (const dir of [config.dataDir, config.logDir, ...extra]) {
    const rel = path.relative(appDir, dir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) names.add(rel.split(path.sep)[0]);
  }
  return names;
}

/**
 * Swap the product files in `sourceDir` into `appDir`, moving the ones they replace into
 * `prevDir`. Data, logs, models, .env and the like are never moved. node_modules is only swapped
 * when the source brings its own (the packages changed). If anything fails, it's all put back.
 * @returns {{ moved: string[], added: string[] }}
 */
export function swapIn(appDir, sourceDir, prevDir, { keep = keepNames(appDir) } = {}) {
  const skip = (n) => (isPreserved(n) && !(n === 'node_modules' && fs.existsSync(path.join(sourceDir, 'node_modules')))) || keep.has(n);
  const incoming = fs.readdirSync(sourceDir).filter((n) => !skip(n) && n !== '.echo-previous.json');
  if (!incoming.includes('package.json') || !incoming.includes('server.js')) throw new Error("That doesn't look like a copy of Echo, so nothing was changed.");
  const current = fs.readdirSync(appDir).filter((n) => !skip(n));
  fs.rmSync(prevDir, { recursive: true, force: true });
  fs.mkdirSync(prevDir, { recursive: true });
  const moved = [];
  const added = [];
  try {
    for (const n of current) {
      fs.renameSync(path.join(appDir, n), path.join(prevDir, n));
      moved.push(n);
    }
    for (const n of incoming) {
      fs.renameSync(path.join(sourceDir, n), path.join(appDir, n));
      added.push(n);
    }
  } catch (e) {
    for (const n of added.reverse()) fs.renameSync(path.join(appDir, n), path.join(sourceDir, n));
    for (const n of moved.reverse()) fs.renameSync(path.join(prevDir, n), path.join(appDir, n));
    throw new Error(`Couldn't swap in the new version (${e.message}); the current version was put back.`);
  }
  writeJson(path.join(prevDir, '.echo-previous.json'), { version: readJson(path.join(prevDir, 'package.json'))?.version || null, at: new Date().toISOString() });
  return { moved, added };
}

/**
 * Put the previous version back (after a failed update, or when the user asks).
 * The version being replaced becomes the new "previous", unless `discardCurrent`.
 */
export function restorePrevious(appDir = APP_DIR, { discardCurrent = false } = {}) {
  const { previous, root } = updateDirs(appDir);
  if (!fs.existsSync(path.join(previous, 'package.json'))) throw new Error('There is no previous version to go back to.');
  const hold = path.join(root, `swap-${Date.now()}`);
  const from = versionOf(appDir);
  swapIn(appDir, previous, hold);
  fs.rmSync(previous, { recursive: true, force: true });
  if (discardCurrent) fs.rmSync(hold, { recursive: true, force: true });
  else fs.renameSync(hold, previous);
  return { from, to: versionOf(appDir) };
}

const fileHash = (f) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  } catch {
    return '';
  }
};
/** The lockfile without Echo's own version (a release bumps it; the packages stay the same). */
function lockPackages(dir) {
  const lock = readJson(path.join(dir, 'package-lock.json'));
  if (!lock) return fileHash(path.join(dir, 'package-lock.json'));
  delete lock.version;
  if (lock.packages?.['']) delete lock.packages[''].version;
  return JSON.stringify(lock);
}
/** Did the npm packages change between two copies? */
export const depsChanged = (a, b) => {
  const deps = (d) => JSON.stringify(['dependencies', 'devDependencies', 'overrides'].map((k) => readJson(path.join(d, 'package.json'))?.[k] || null));
  return lockPackages(a) !== lockPackages(b) || deps(a) !== deps(b);
};
/** A fingerprint of a folder's files (for "did the Mac app's sources change?"). */
export function treeHash(dir) {
  const h = crypto.createHash('sha256');
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
    } catch {
      return;
    }
    for (const d of entries) {
      const r = path.join(rel, d.name);
      if (d.isDirectory()) walk(r);
      else h.update(r + '\0').update(fs.readFileSync(path.join(dir, r)));
    }
  };
  walk('');
  return h.digest('hex');
}
export const macSourcesChanged = (a, b) => treeHash(path.join(a, 'macos')) !== treeHash(path.join(b, 'macos'));

/** Unpack a release zip into `dest` and return the Echo folder inside it. */
export function unpack(zip, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dest], { stdio: 'ignore' });
  } catch {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dest], { stdio: 'ignore' });
  }
  for (const cand of [path.join(dest, 'Echo'), dest, ...fs.readdirSync(dest).map((n) => path.join(dest, n))]) {
    if (fs.existsSync(path.join(cand, 'package.json')) && fs.existsSync(path.join(cand, 'server.js'))) return cand;
  }
  throw new Error("The download doesn't contain Echo, so it was not installed.");
}

/** npm next to the running Node, so an app started from Finder finds the right one. */
function npmBin() {
  const beside = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(beside) ? beside : 'npm';
}

/** Install a copy's npm packages (in staging, before it goes live). */
export function installDeps(dir) {
  const lock = path.join(dir, 'package-lock.json');
  const args = fs.existsSync(lock) ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
  execFileSync(npmBin(), args, { cwd: dir, stdio: 'ignore', timeout: 10 * 60 * 1000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, npm_config_update_notifier: 'false' } });
  // Same marker the installer writes, so running install.command later skips the reinstall.
  if (fs.existsSync(lock)) {
    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(lock)).digest('hex');
    fs.writeFileSync(path.join(dir, 'node_modules', '.echo-installed'), `${sha1}-node${process.versions.node.split('.')[0]}\n`);
  }
}

/** Rebuild ~/Applications/Echo.app from the new sources, if this Mac has Echo's native app. */
export function rebuildMacApp(appDir) {
  const app = path.join(os.homedir(), 'Applications', 'Echo.app');
  let id = '';
  try {
    id = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return { rebuilt: false, why: 'no Echo app to rebuild' };
  }
  if (id !== 'local.echo.app') return { rebuilt: false, why: 'the Echo app is the browser launcher' };
  try {
    execFileSync('/bin/bash', [path.join(appDir, 'scripts', 'build-app.sh'), '--check'], { stdio: 'ignore' });
    execFileSync('/bin/bash', [path.join(appDir, 'scripts', 'build-app.sh'), '--out', path.dirname(app), '--echo-dir', appDir], { stdio: 'ignore', timeout: 5 * 60 * 1000 });
    return { rebuilt: true };
  } catch (e) {
    return { rebuilt: false, why: e.message };
  }
}

/**
 * The supervisor's side: the new version failed, so swap the previous one back in.
 * The failed version is thrown away and remembered so it isn't installed again automatically.
 * @param {{ appDir?: string, dataDir?: string, why?: string, rebuild?: (appDir: string) => any }} [opts]
 */
export function rollbackUpdate({ appDir = APP_DIR, dataDir = config.dataDir, why = 'failed', rebuild = rebuildMacApp } = {}) {
  const files = updateFiles(dataDir);
  const pending = readJson(files.pending);
  const out = restorePrevious(appDir, { discardCurrent: true });
  if (pending?.macChanged) rebuild(appDir);
  const state = readJson(files.state) || {};
  writeJson(files.state, { ...state, failedVersion: pending?.to || out.from });
  writeJson(files.notice, { kind: 'rolled_back', from: out.from, to: out.to, why, at: new Date().toISOString() });
  fs.rmSync(files.pending, { force: true });
  return out;
}

/** The supervisor's side: the new version answered its health check. */
export function confirmUpdate(dataDir = config.dataDir) {
  const files = updateFiles(dataDir);
  const pending = readJson(files.pending);
  if (!pending) return null;
  fs.rmSync(files.pending, { force: true });
  writeJson(files.notice, { kind: pending.kind === 'rollback' ? 'went_back' : 'updated', from: pending.from, to: pending.to, at: new Date().toISOString() });
  return pending;
}

export const pendingUpdate = (dataDir = config.dataDir) => readJson(updateFiles(dataDir).pending);

/**
 * Stream a URL to a file, reporting progress (0..1, or null if the size is unknown).
 * @param {typeof fetch} fetchFn @param {string} url @param {string} file
 * @param {(p: number | null) => void} [onProgress]
 */
async function download(fetchFn, url, file, onProgress = (_p) => {}) {
  const res = await fetchFn(url, { headers: { 'User-Agent': 'Echo-updater', Accept: 'application/octet-stream' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) for ${path.basename(file)}.`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of /** @type {any} */ (res.body)) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      onProgress(total ? Math.min(1, got / total) : null);
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  return file;
}

export class Updater extends EventEmitter {
  /**
   * @param {{ appDir?: string, dataDir?: string, fetchFn?: typeof fetch, developer?: boolean,
   *   installDeps?: (dir: string) => void, rebuildApp?: (appDir: string) => any,
   *   restart?: (reason: string) => void, getSettings?: () => any, isBusy?: () => boolean }} [opts]
   */
  constructor(opts = {}) {
    super();
    this.appDir = opts.appDir || APP_DIR;
    this.dataDir = opts.dataDir || config.dataDir;
    this.fetchFn = opts.fetchFn || fetch;
    this.developer = opts.developer ?? isDeveloperCopy(this.appDir);
    this.installDeps = opts.installDeps || installDeps;
    this.rebuildApp = opts.rebuildApp || rebuildMacApp;
    this.restart = opts.restart || null;
    this.getSettings = opts.getSettings || (() => ({}));
    this.isBusy = opts.isBusy || (() => false);
    this.files = updateFiles(this.dataDir);
    this.dirs = updateDirs(this.appDir);
    this.phase = 'idle'; // idle | checking | downloading | verifying | installing | restarting | error
    this.progress = null;
    this.error = null;
    this.timer = null;
  }

  get state() {
    return readJson(this.files.state) || {};
  }
  saveState(patch) {
    writeJson(this.files.state, { ...this.state, ...patch });
  }

  status() {
    const repo = releaseRepo(this.appDir);
    const s = this.state;
    const current = versionOf(this.appDir);
    const latest = s.latest || null;
    const available = Boolean(!this.developer && latest && parseVersion(latest.version) && isNewer(latest.version, current));
    const prev = readJson(path.join(this.dirs.previous, '.echo-previous.json'));
    return {
      current,
      developer: this.developer,
      configured: repo.configured,
      repo: `${repo.owner}/${repo.repo}`,
      latest,
      available,
      checkedAt: s.checkedAt || null,
      failedVersion: s.failedVersion || null,
      autoUpdate: Boolean(this.getSettings().autoUpdate),
      phase: this.phase,
      progress: this.progress,
      error: this.error,
      previous: prev?.version && fs.existsSync(path.join(this.dirs.previous, 'package.json')) ? prev.version : null,
    };
  }

  setPhase(phase, progress = null, error = null) {
    this.phase = phase;
    this.progress = progress;
    this.error = error;
    this.emit('status', this.status());
  }

  /** Ask GitHub for the latest release. */
  async check() {
    if (this.developer) return this.status();
    const repo = releaseRepo(this.appDir);
    if (!repo.configured) throw new Error("This copy of Echo doesn't know which GitHub repository its updates come from yet.");
    this.setPhase('checking');
    try {
      const res = await this.fetchFn(`${repo.api}/repos/${repo.owner}/${repo.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Echo-updater' } });
      if (res.status === 404) {
        this.saveState({ checkedAt: new Date().toISOString(), latest: null });
        this.setPhase('idle');
        return this.status();
      }
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`);
      const r = await res.json();
      const version = String(r.tag_name || '').replace(/^v/, '');
      if (!parseVersion(version)) throw new Error(`The latest release has an unexpected tag (${r.tag_name}).`);
      const assets = Array.isArray(r.assets) ? r.assets : [];
      const zip = assets.find((a) => a.name === zipName(version));
      const sum = assets.find((a) => a.name === checksumName(version));
      const latest = {
        version,
        name: r.name || `Echo ${version}`,
        notes: String(r.body || '').slice(0, 8000),
        publishedAt: r.published_at || null,
        url: r.html_url || null,
        zipUrl: zip?.browser_download_url || null,
        checksumUrl: sum?.browser_download_url || null,
        digest: typeof zip?.digest === 'string' && zip.digest.startsWith('sha256:') ? zip.digest.slice(7) : null,
      };
      this.saveState({ checkedAt: new Date().toISOString(), latest });
      this.setPhase('idle');
      return this.status();
    } catch (e) {
      this.setPhase('error', null, `Couldn't check for updates: ${e.message}`);
      throw e;
    }
  }

  /** Download, verify, stage and swap in the latest release, then restart into it. */
  async apply({ restart = true } = {}) {
    if (this.developer) throw new Error('This is a developer copy of Echo (a git checkout), so it updates with git, not from releases.');
    if (this.busy) throw new Error('An update is already being installed.');
    this.busy = true;
    try {
      const st = await this.check();
      if (!st.available) return { updated: false, current: st.current };
      const latest = st.latest;
      if (!latest.zipUrl || !latest.checksumUrl) throw new Error(`The ${latest.version} release is missing its zip or checksum file, so it can't be installed safely.`);
      fs.mkdirSync(this.dirs.downloads, { recursive: true });
      const zip = path.join(this.dirs.downloads, zipName(latest.version));
      this.setPhase('downloading', 0);
      await download(this.fetchFn, latest.zipUrl, zip, (p) => {
        if (p === null || p - (this.progress ?? 0) >= 0.02 || p === 1) this.setPhase('downloading', p);
      });
      this.setPhase('verifying');
      const sumFile = await download(this.fetchFn, latest.checksumUrl, `${zip}.sha256`);
      const expected = parseChecksum(fs.readFileSync(sumFile, 'utf8'), zipName(latest.version));
      if (latest.digest && expected && latest.digest.toLowerCase() !== expected) throw new Error("The release's checksums disagree, so it was not installed.");
      verifyChecksum(zip, expected);
      const staged = unpack(zip, path.join(this.dirs.staging, latest.version));
      if (versionOf(staged) !== latest.version) throw new Error(`The download says it's version ${versionOf(staged)}, not ${latest.version}, so it was not installed.`);
      if (readJson(path.join(staged, 'package.json'))?.name !== 'echo') throw new Error("The download isn't Echo, so it was not installed.");
      for (const n of fs.readdirSync(staged)) if (isPreserved(n) && n !== 'node_modules') fs.rmSync(path.join(staged, n), { recursive: true, force: true });
      this.setPhase('installing');
      const deps = depsChanged(this.appDir, staged);
      if (deps) this.installDeps(staged);
      const mac = macSourcesChanged(this.appDir, staged);
      const from = versionOf(this.appDir);
      swapIn(this.appDir, staged, this.dirs.previous, { keep: keepNames(this.appDir, [this.dataDir]) });
      fs.rmSync(this.dirs.staging, { recursive: true, force: true });
      fs.rmSync(this.dirs.downloads, { recursive: true, force: true });
      writeJson(this.files.pending, { kind: 'update', from, to: latest.version, at: new Date().toISOString(), depsChanged: deps, macChanged: mac });
      if (mac) this.rebuildApp(this.appDir);
      this.setPhase(restart && this.restart ? 'restarting' : 'idle');
      if (restart && this.restart) this.restart(`to install Echo ${latest.version}`);
      return { updated: true, from, to: latest.version, depsChanged: deps, macChanged: mac };
    } catch (e) {
      fs.rmSync(this.dirs.staging, { recursive: true, force: true });
      this.setPhase('error', null, e.message);
      throw e;
    } finally {
      this.busy = false;
    }
  }

  /** Go back to the version kept from the last update (the user asked). */
  rollback({ restart = true } = {}) {
    if (this.developer) throw new Error('This is a developer copy of Echo; use git to go back.');
    const mac = macSourcesChanged(this.appDir, this.dirs.previous);
    const out = restorePrevious(this.appDir);
    this.saveState({ failedVersion: out.from });
    writeJson(this.files.pending, { kind: 'rollback', from: out.from, to: out.to, at: new Date().toISOString(), macChanged: mac });
    if (mac) this.rebuildApp(this.appDir);
    if (restart && this.restart) {
      this.setPhase('restarting');
      this.restart(`to go back to Echo ${out.to}`);
    }
    return out;
  }

  /** What happened at the last restart (updated, or rolled back), once. */
  takeNotice() {
    const n = readJson(this.files.notice);
    if (n) fs.rmSync(this.files.notice, { force: true });
    return n;
  }

  /** Daily checks; installs by itself if the setting is on and nothing is running. */
  startSchedule({ firstDelayMs = 60 * 1000, everyMs = 3600 * 1000 } = {}) {
    if (this.developer || process.env.ECHO_UPDATE_CHECKS === 'off' || !releaseRepo(this.appDir).configured) return;
    const tick = async () => {
      try {
        const last = Date.parse(this.state.checkedAt || '') || 0;
        if (Date.now() - last >= DAY) await this.check();
        const st = this.status();
        if (st.available && st.autoUpdate && st.latest.version !== st.failedVersion && !this.isBusy()) await this.apply();
      } catch {}
    };
    setTimeout(tick, firstDelayMs).unref();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
