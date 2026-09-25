// A dress rehearsal of the whole release flow, without GitHub:
//
//   npm run release:simulate [-- --data-dir <your data folder>] [--port 4799]
//
// In a temp folder it: copies this Echo into a throwaway git repo and runs `npm run release`
// there (the privacy check uses your data folder's personal words), syncs a fresh "public" clone
// with `npm run publish-repo --no-push`, serves the releases from a local stand-in for GitHub's
// API and raw files, runs the one-line install into a temp HOME, starts that Echo on the test
// port with a temp data folder, publishes a newer version and checks the in-app update applies
// it and keeps the data, then publishes a broken version and checks Echo rolls itself back.
// It never touches your Echo, your data, ~/Applications or GitHub.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { APP_DIR, DEFAULT_PORT, config } from '../lib/config.js';

const argv = process.argv.slice(2);
const opt = (flag, d) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : d);
const LIVE_DATA = path.resolve(opt('--data-dir', config.dataDir));
const PORT = Number(opt('--port', 4799));
if (PORT === DEFAULT_PORT) throw new Error(`Not on ${DEFAULT_PORT}: that's where your everyday Echo runs.`);

const SIM = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-sim-'));
const HOME = path.join(SIM, 'home');
const SRC = path.join(SIM, 'src');
const REL = path.join(SIM, 'github', 'releases');
const PUBLIC = path.join(SIM, 'github', 'public-clone');
const DATA = path.join(SIM, 'data');
const APP = path.join(HOME, 'Applications', 'Echo');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(REL, { recursive: true });
const log = (...a) => console.log(`\n[sim] ${a.join(' ')}`);
/** @type {Array<{ name: string, ok: boolean }>} */
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/* ---------- a stand-in for GitHub: the Releases API, asset downloads and raw files ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  if (url.pathname === '/api/repos/sim/echo/releases/latest') {
    const v = fs.readdirSync(REL).map((d) => d.slice(1)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (!v) return res.writeHead(404).end('{}');
    const assets = [`Echo-${v}.zip`, `Echo-${v}.zip.sha256`].map((name) => ({ name, browser_download_url: `${base}/download/v${v}/${name}` }));
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ tag_name: `v${v}`, name: `Echo ${v}`, body: read(REL, `v${v}`, 'notes.md'), assets }, null, 2));
  }
  let file = '';
  if (url.pathname.startsWith('/download/')) file = path.join(REL, url.pathname.slice('/download/'.length));
  if (url.pathname.startsWith('/raw/sim/echo/main/')) file = path.join(PUBLIC, url.pathname.slice('/raw/sim/echo/main/'.length));
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return res.writeHead(200, { 'Content-Length': fs.statSync(file).size }).end(fs.readFileSync(file));
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
const GH = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;

/** @type {Record<string, string | undefined>} */
const ENV = { ...process.env, ECHO_REPO: 'sim/echo', ECHO_GITHUB_API: `${GH}/api`, VOICEOPS_ROOTS: config.roots.join(':'), npm_config_update_notifier: 'false' };
for (const k of Object.keys(ENV)) if (/^(VOICEOPS_(?!ROOTS)|npm_(?!config_update)|NODE_TEST)/.test(k)) delete ENV[k];
/** @param {string} cmd @param {string[]} args @param {any} [opts] */
const run = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: ENV, ...opts }));
// The stand-in GitHub runs in this process, so anything that downloads from it must not block.
/** @param {string} cmd @param {string[]} args @param {any} [opts] @returns {Promise<string>} */
const runAsync = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: 'utf8', env: ENV, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout))
    )
  );
const git = (/** @type {string[]} */ ...args) => run('git', ['-c', 'user.name=Sim', '-c', 'user.email=sim@example.com', ...args], { cwd: SRC });

/* ---------- 1. npm run release, in a throwaway copy of this repo ---------- */
log('copying Echo into a throwaway git repo:', SRC);
for (const f of run('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: APP_DIR }).split('\0').filter(Boolean)) {
  if (!fs.existsSync(path.join(APP_DIR, f))) continue;
  fs.mkdirSync(path.dirname(path.join(SRC, f)), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, f), path.join(SRC, f));
  fs.chmodSync(path.join(SRC, f), fs.statSync(path.join(APP_DIR, f)).mode & 0o777);
}
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-qm', 'Baseline');
git('tag', '-a', `v${JSON.parse(read(SRC, 'package.json')).version}`, '-m', 'baseline');
fs.writeFileSync(path.join(SRC, 'NOTE.txt'), 'uncommitted');
try {
  run('node', ['scripts/release.js', 'patch', '--yes', '--data-dir', LIVE_DATA], { cwd: SRC });
  check('release refuses a dirty working tree', false);
} catch (e) {
  check('release refuses a dirty working tree', /Commit or put away/.test(String(e.stdout) + String(e.stderr)));
}
fs.rmSync(path.join(SRC, 'NOTE.txt'));
git('commit', '-q', '--allow-empty', '-m', 'Self-improve #1: Add the simulated feature');

const release = (label) => {
  log(`npm run release patch (${label})`);
  const out = run('node', ['scripts/release.js', 'patch', '--yes', '--data-dir', LIVE_DATA], { cwd: SRC });
  console.log(out.split('\n').filter((l) => /Releasing|Passed|FAILED|SHA-256/.test(l)).join('\n'));
  const version = JSON.parse(read(SRC, 'package.json')).version;
  return { version, dir: path.join(SRC, 'dist', 'release', `v${version}`) };
};
// What `npm run release:publish` does on GitHub: attach the zip and checksum, with the notes.
const publish = ({ version, dir }) => {
  fs.mkdirSync(path.join(REL, `v${version}`), { recursive: true });
  for (const f of [`Echo-${version}.zip`, `Echo-${version}.zip.sha256`, 'notes.md']) fs.copyFileSync(path.join(dir, f), path.join(REL, `v${version}`, f));
  log(`published v${version} to the stand-in GitHub`);
};

const r1 = release('first public release');
check(`release ${r1.version} built`, fs.existsSync(path.join(r1.dir, `Echo-${r1.version}.zip`)));
check('the checksum file verifies with shasum -c', run('shasum', ['-a', '256', '-c', `Echo-${r1.version}.zip.sha256`], { cwd: r1.dir }).includes('OK'));
check(`committed and tagged v${r1.version}`, git('tag', '--list', `v${r1.version}`).trim() === `v${r1.version}` && git('log', '-1', '--format=%s').trim() === `Release v${r1.version}`);
check('the release notes come from the commits', /Add the simulated feature/.test(read(r1.dir, 'notes.md')));
const dry = run('node', ['scripts/publish-release.js', '--dry-run'], { cwd: SRC });
check('release:publish --dry-run only shows the gh command', /gh release create v/.test(dry) && /nothing was published/.test(dry));

log('npm run publish-repo --no-push, into a fresh public clone');
run('node', ['scripts/publish-repo.js', '--dir', PUBLIC, '--no-push', '--data-dir', LIVE_DATA], { cwd: SRC });
const pubLog = run('git', ['log', '--format=%an <%ae> | %s'], { cwd: PUBLIC }).trim();
check('the public repo starts a fresh history', pubLog.split('\n').length === 1, pubLog);
check('public commits use the GitHub no-reply address', /sim@users\.noreply\.github\.com/.test(pubLog));
check('no personal folders in the public repo', !['data', 'logs', 'HANDOFF.md', '.echo-package', 'node_modules', 'dist'].some((n) => fs.existsSync(path.join(PUBLIC, n))));
check('the public README is the user-facing one', /## Install \(one line\)/.test(read(PUBLIC, 'README.md')));
check('install-remote.sh names the repo', /ECHO_REPO:-sim\/echo/.test(read(PUBLIC, 'install-remote.sh')));
publish(r1);

/* ---------- 2. the one-line install, into a temp HOME ---------- */
log(`curl -fsSL …/install-remote.sh | bash   (temp HOME, port ${PORT})`);
/** @type {Record<string, string | undefined>} */
const installEnv = { ...ENV, HOME, ECHO_NO_LAUNCH: '1', npm_config_cache: path.join(os.homedir(), '.npm') };
delete installEnv.ECHO_REPO; // must come from the stamped script
const oneLiner = (extra = '') => `curl -fsSL ${GH}/raw/sim/echo/main/install-remote.sh | bash -s -- --skip-claude --skip-whisper --skip-voice --no-app --no-dock --port ${PORT} ${extra}`;
let out = await runAsync('bash', ['-c', oneLiner()], { env: installEnv, timeout: 20 * 60 * 1000 });
console.log(out.split('\n').filter((l) => /Download verified|✓|✗|All set/.test(l)).join('\n'));
check(`installed Echo ${r1.version}`, JSON.parse(read(APP, 'package.json')).version === r1.version);
check('packages installed', fs.existsSync(path.join(APP, 'node_modules', 'ws')));
check('port saved', read(APP, '.echo-port').trim() === String(PORT));
fs.mkdirSync(path.join(APP, 'data'), { recursive: true });
fs.writeFileSync(path.join(APP, 'data', 'keep-me.txt'), 'user data inside the install\n');
out = await runAsync('bash', ['-c', oneLiner()], { env: installEnv, timeout: 20 * 60 * 1000 });
check('running the one-liner again is safe', /already installed/.test(out) && fs.existsSync(path.join(APP, 'data', 'keep-me.txt')));
const zip1 = path.join(REL, `v${r1.version}`, `Echo-${r1.version}.zip`);
const good = fs.readFileSync(zip1);
fs.appendFileSync(zip1, 'tampered');
try {
  await runAsync('bash', ['-c', oneLiner(`--dir ${path.join(SIM, 'tampered')}`)], { env: installEnv });
  check('a tampered download is refused', false);
} catch (e) {
  check('a tampered download is refused', /doesn't match its checksum/.test(String(e.stderr) + String(e.stdout)) && !fs.existsSync(path.join(SIM, 'tampered', 'server.js')));
}
fs.writeFileSync(zip1, good);

/* ---------- 3. the installed Echo, on the test port with a temp data folder ---------- */
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(SIM, 'projects'), { recursive: true });
fs.mkdirSync(path.join(SIM, 'logs'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ userName: 'Sim User', onboarded: true }, null, 2));
fs.writeFileSync(path.join(DATA, 'memory.md'), 'Sim User likes tea.\n');
const serverEnv = { ...ENV, HOME, VOICEOPS_PORT: String(PORT), VOICEOPS_DATA_DIR: DATA, VOICEOPS_LOG_DIR: path.join(SIM, 'logs'), VOICEOPS_ROOTS: path.join(SIM, 'projects'), VOICEOPS_HEALTH_TIMEOUT_MS: '25000', VOICEOPS_TITLES: 'off', ECHO_UPDATE_CHECKS: 'off' };
log('starting the installed Echo on port', String(PORT));
const sup = spawn(read(APP, '.echo-node').trim(), ['supervisor.js'], { cwd: APP, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
let supOut = '';
sup.stdout.on('data', (d) => (supOut += d));
sup.stderr.on('data', (d) => (supOut += d));
const api = async (p, method = 'GET') => (await fetch(`http://127.0.0.1:${PORT}${p}`, { method })).json();
const waitFor = async (fn, ms, label) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(700);
  }
  throw new Error(`timed out waiting for ${label}`);
};
const audit = () => (fs.existsSync(path.join(DATA, 'self', 'audit.log')) ? read(DATA, 'self', 'audit.log') : '');
const dataKept = () => read(DATA, 'memory.md') === 'Sim User likes tea.\n' && JSON.parse(read(DATA, 'settings.json')).userName === 'Sim User' && fs.existsSync(path.join(APP, 'data', 'keep-me.txt')) && read(APP, '.echo-port').trim() === String(PORT);

try {
  await waitFor(async () => (await api('/api/health')).pid, 120000, 'Echo to answer');
  let st = await api('/api/update');
  check(`the installed Echo runs on ${PORT} as ${r1.version}`, st.current === r1.version);
  check('an installed copy is not a developer copy', st.developer === false && st.configured === true);
  st = await api('/api/update/check', 'POST');
  check('no update while on the latest', st.available === false);

  /* ---------- 4. a newer release: detected, applied, data kept ---------- */
  fs.writeFileSync(path.join(SRC, 'CHANGELOG.md'), read(SRC, 'CHANGELOG.md').replace('## Unreleased\n', '## Unreleased\n\n- A simulated improvement.\n'));
  git('commit', '-qam', 'Simulated improvement');
  const r2 = release('a newer version');
  publish(r2);
  st = await api('/api/update/check', 'POST');
  check(`the app sees ${r2.version} with its notes`, st.available === true && st.latest.version === r2.version && /A simulated improvement/.test(st.latest.notes));
  const pid1 = (await api('/api/health')).pid;
  const applied = await api('/api/update/apply', 'POST');
  check('Update now: downloaded, verified and swapped in', applied.updated === true && applied.to === r2.version, JSON.stringify(applied));
  await waitFor(async () => {
    const h = await api('/api/health');
    return h.ok && h.pid !== pid1;
  }, 180000, 'the restart');
  await waitFor(async () => /"update_ok"/.test(audit()), 90000, 'the health check');
  st = await api('/api/update');
  check(`now running ${r2.version}, with ${r1.version} kept for a rollback`, st.current === r2.version && st.previous === r1.version);
  check('data and settings kept', dataKept());

  /* ---------- 5. a broken release: applied, fails, rolled back by itself ---------- */
  fs.writeFileSync(path.join(SRC, 'server.js'), "throw new Error('simulated broken release');\n" + read(SRC, 'server.js'));
  git('commit', '-qam', 'Simulated broken change');
  const r3 = release('a broken version');
  publish(r3);
  st = await api('/api/update/check', 'POST');
  check(`the app sees ${r3.version}`, st.available === true && st.latest.version === r3.version);
  const pid2 = (await api('/api/health')).pid;
  const applied3 = await api('/api/update/apply', 'POST');
  check('the broken update is applied', applied3.updated === true);
  await waitFor(async () => /"update_rolled_back"/.test(audit()), 180000, 'the rollback');
  await waitFor(async () => {
    const h = await api('/api/health');
    return h.ok && h.pid !== pid2;
  }, 180000, 'the old version');
  st = await api('/api/update');
  check(`rolled back to ${r2.version} by itself`, st.current === r2.version && st.failedVersion === r3.version, `current ${st.current}, failed ${st.failedVersion}`);
  check('the broken files are gone', !read(APP, 'server.js').includes('simulated broken release'));
  check('data and settings still kept', dataKept());
} catch (e) {
  check('the simulation ran to the end', false, e.message);
  console.log(supOut.slice(-5000));
} finally {
  sup.kill('SIGTERM');
  await new Promise((r) => sup.once('exit', r));
  server.close();
}
fs.writeFileSync(path.join(SIM, 'echo.log'), supOut);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[sim] ${results.length - failed}/${results.length} checks passed. Everything is in ${SIM} (delete it when done).`);
process.exit(failed ? 1 : 0);
