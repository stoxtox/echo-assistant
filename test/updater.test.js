// Releases and self-updates: version order, checksums, the changelog, and applying an update
// from a (mocked) GitHub: data is preserved, a bad download changes nothing, and a failed
// version is rolled back. Everything runs in throwaway folders; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, until } from './helpers.js';

const dirs = sandbox('updater');
process.env.ECHO_REPO = 'example/echo';
process.env.ECHO_GITHUB_API = 'https://api.example.test';
const R = await import('../lib/release.js');
const U = await import('../lib/updater.js');
const { stampInstaller } = await import('../scripts/package.js');
const SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supervisor.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('versions compare the semver way, and bump', () => {
  const cmp = R.compareVersions;
  assert.equal(cmp('1.0.0', '1.0.0'), 0);
  assert.equal(cmp('1.0.10', '1.0.9'), 1, 'numbers, not text');
  assert.equal(cmp('v2.0.0', '1.99.99'), 1, 'a leading v is fine');
  assert.equal(cmp('1.2.0-beta.2', '1.2.0'), -1, 'a pre-release comes before its release');
  assert.equal(cmp('1.2.0-beta.10', '1.2.0-beta.2'), 1);
  assert.equal(cmp('1.2.0-alpha', '1.2.0-beta'), -1);
  assert.ok(R.isNewer('1.1.0', '1.0.9'));
  assert.ok(!R.isNewer('1.0.0', '1.0.0'));
  assert.throws(() => cmp('one', '1.0.0'), /Not a version/);
  assert.equal(R.bumpVersion('1.0.0', 'patch'), '1.0.1');
  assert.equal(R.bumpVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(R.bumpVersion('1.4.2', 'major'), '2.0.0');
  assert.equal(R.bumpVersion('1.5.0-rc.1', 'patch'), '1.5.0');
  assert.throws(() => R.bumpVersion('1.0.0', /** @type {any} */ ('huge')), /patch, minor or major/);
});

test('checksums: the shasum format round-trips, and a changed file is refused', () => {
  const f = path.join(dirs.root, 'blob.bin');
  fs.writeFileSync(f, 'hello echo');
  const hex = crypto.createHash('sha256').update('hello echo').digest('hex');
  assert.equal(R.sha256File(f), hex);
  const line = R.checksumLine(hex, 'Echo-1.0.0.zip');
  assert.equal(line, `${hex}  Echo-1.0.0.zip\n`);
  assert.equal(R.parseChecksum(line, 'Echo-1.0.0.zip'), hex);
  assert.equal(R.parseChecksum(hex.toUpperCase()), hex, 'a bare digest works too');
  assert.equal(R.parseChecksum(line, 'Other.zip'), null, 'a checksum for another file is not used');
  assert.equal(R.verifyChecksum(f, hex), hex);
  assert.throws(() => R.verifyChecksum(f, 'a'.repeat(64)), /damaged or was changed/);
  assert.throws(() => R.verifyChecksum(f, ''), /no valid checksum/);
});

test('the changelog: Unreleased notes and commits go under the new version', () => {
  const start = '# Changelog\n\n## Unreleased\n\n- A hand-written note.\n\n## [1.0.0] - 2026-01-01\n\n- First.\n';
  const commits = ['Self-improve #44: build the Mac app', 'Merge self-improve #44', 'Save live edits before self-improve #45 merge', 'fix the voice', 'fix the voice'];
  const out = R.addChangelogEntry(start, '1.1.0', { commits, date: '2026-09-25' });
  const notes = R.changelogSection(out, '1.1.0');
  assert.match(out, /## Unreleased\n\n## \[1\.1\.0\] - 2026-09-25/, 'Unreleased stays, empty, on top');
  assert.match(notes, /^- A hand-written note\./);
  assert.match(notes, /- Build the Mac app/);
  assert.match(notes, /- Fix the voice/);
  assert.equal(notes.match(/Fix the voice/g).length, 1, 'no duplicates');
  assert.doesNotMatch(notes, /Merge|Save live edits|#44/);
  assert.equal(R.changelogSection(out, '1.0.0'), '- First.');
  assert.match(R.addChangelogEntry('', '1.0.1', { commits: [] }), /## \[1\.0\.1\][^\n]*\n\n- Maintenance/);
});

test('the one-line installer gets the repository from one place', () => {
  const src = fs.readFileSync(path.join(ROOT, 'install-remote.sh'), 'utf8');
  const stamped = stampInstaller(src, { owner: 'someone', repo: 'echo-app' });
  assert.match(stamped, /^ECHO_REPO="\$\{ECHO_REPO:-someone\/echo-app\}"/m);
  assert.match(stamped, /raw\.githubusercontent\.com\/someone\/echo-app\/main\/install-remote\.sh/);
  assert.doesNotMatch(stamped, /ECHO_REPO:-YOUR-GITHUB-USERNAME|githubusercontent.com\/YOUR-GITHUB-USERNAME/);
  assert.deepEqual([R.releaseRepo().owner, R.releaseRepo().repo], ['example', 'echo'], 'ECHO_REPO overrides echo-release.json');
  execFileSync('bash', ['-n', path.join(ROOT, 'install-remote.sh')]);
});

/* ---------- applying an update against a mocked GitHub ---------- */

/** A tiny installed Echo: product files plus the user's own things that must survive. */
function makeInstall(name, version = '1.0.0') {
  const app = path.join(dirs.root, name);
  fs.mkdirSync(path.join(app, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(app, 'data'), { recursive: true });
  fs.mkdirSync(path.join(app, 'node_modules', 'ws'), { recursive: true });
  fs.mkdirSync(path.join(app, 'models'), { recursive: true });
  fs.mkdirSync(path.join(app, 'macos'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'echo', version, dependencies: { ws: '^8' } }));
  fs.writeFileSync(path.join(app, 'package-lock.json'), '{"lock":1}');
  fs.writeFileSync(path.join(app, 'server.js'), `// server ${version}\n`);
  fs.writeFileSync(path.join(app, 'lib', 'old-only.js'), 'gone in the new version\n');
  fs.writeFileSync(path.join(app, 'macos', 'main.swift'), '// app\n');
  fs.writeFileSync(path.join(app, '.echo-package'), '{}');
  fs.writeFileSync(path.join(app, 'data', 'settings.json'), '{"userName":"Sam"}');
  fs.writeFileSync(path.join(app, 'data', 'memory.md'), 'likes pho\n');
  fs.writeFileSync(path.join(app, 'models', 'whisper.bin'), 'model');
  fs.writeFileSync(path.join(app, 'node_modules', 'ws', 'index.js'), 'old ws');
  fs.writeFileSync(path.join(app, '.env'), 'ELEVENLABS_API_KEY=x\n');
  fs.writeFileSync(path.join(app, '.echo-port'), '4799\n');
  return app;
}

/** A release zip (Echo/ inside, like `npm run release` makes). It even carries a data/ folder, which must be ignored. */
function makeRelease(version, { lock = '{"lock":1}', mac = '// app\n', broken = false } = {}) {
  const work = fs.mkdtempSync(path.join(dirs.root, `rel-${version}-`));
  const e = path.join(work, 'Echo');
  fs.mkdirSync(path.join(e, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(e, 'data'), { recursive: true });
  fs.mkdirSync(path.join(e, 'macos'), { recursive: true });
  fs.writeFileSync(path.join(e, 'package.json'), JSON.stringify({ name: 'echo', version, dependencies: { ws: '^8' } }));
  fs.writeFileSync(path.join(e, 'package-lock.json'), lock);
  fs.writeFileSync(path.join(e, 'server.js'), broken ? 'throw new Error("broken")\n' : `// server ${version}\n`);
  fs.writeFileSync(path.join(e, 'lib', 'new-only.js'), 'new\n');
  fs.writeFileSync(path.join(e, 'macos', 'main.swift'), mac);
  fs.writeFileSync(path.join(e, 'data', 'settings.json'), '{"userName":"Someone Else"}');
  const zip = path.join(work, R.zipName(version));
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', e, zip]);
  return { zip, sha: R.sha256File(zip) };
}

/** A stand-in for GitHub: the Releases API plus the asset downloads. */
function fakeGitHub(version, rel, { badSum = false } = {}) {
  const base = 'https://github.example.test/dl';
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url) === 'https://api.example.test/repos/example/echo/releases/latest') {
      return Response.json({
        tag_name: `v${version}`,
        name: `Echo ${version}`,
        body: '- Faster voice.\n- New update card.',
        html_url: `https://github.example.test/example/echo/releases/v${version}`,
        published_at: '2026-09-25T12:00:00Z',
        assets: [
          { name: R.zipName(version), browser_download_url: `${base}/${R.zipName(version)}` },
          { name: R.checksumName(version), browser_download_url: `${base}/${R.checksumName(version)}` },
        ],
      });
    }
    if (String(url) === `${base}/${R.zipName(version)}`) return new Response(fs.readFileSync(rel.zip), { headers: { 'content-length': String(fs.statSync(rel.zip).size) } });
    if (String(url) === `${base}/${R.checksumName(version)}`) return new Response(R.checksumLine(badSum ? 'b'.repeat(64) : rel.sha, R.zipName(version)));
    return new Response('not found', { status: 404 });
  };
  return { fetchFn, calls };
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('update check: a newer release shows up as available; a developer copy never updates', async () => {
  const app = makeInstall('app-check');
  const gh = fakeGitHub('1.1.0', makeRelease('1.1.0'));
  const u = new U.Updater({ appDir: app, dataDir: path.join(app, 'data'), fetchFn: gh.fetchFn, developer: false });
  const st = await u.check();
  assert.equal(st.current, '1.0.0');
  assert.equal(st.available, true);
  assert.equal(st.latest.version, '1.1.0');
  assert.match(st.latest.notes, /Faster voice/);
  assert.ok(st.checkedAt);

  const dev = new U.Updater({ appDir: app, dataDir: path.join(app, 'data'), fetchFn: gh.fetchFn, developer: true });
  const d = await dev.check();
  assert.equal(d.developer, true);
  assert.equal(d.available, false);
  await assert.rejects(dev.apply(), /developer copy/);
  // A git checkout without the package marker is a developer copy.
  const git = path.join(dirs.root, 'git-copy');
  fs.mkdirSync(path.join(git, '.git'), { recursive: true });
  delete process.env.ECHO_DEVELOPER_COPY;
  assert.equal(U.isDeveloperCopy(git), true);
  fs.writeFileSync(path.join(git, '.echo-package'), '{}');
  assert.equal(U.isDeveloperCopy(git), false, 'an installed copy that self-improve made into a git repo still updates');
});

test('applying an update swaps the product files, keeps every bit of user data, and keeps the old version', async () => {
  const app = makeInstall('app-apply');
  const data = path.join(app, 'data');
  const rel = makeRelease('1.1.0', { lock: '{"lock":2}', mac: '// app v2\n' });
  const gh = fakeGitHub('1.1.0', rel);
  const installs = [];
  const rebuilds = [];
  const restarts = [];
  const u = new U.Updater({
    appDir: app, dataDir: data, fetchFn: gh.fetchFn, developer: false,
    installDeps: (dir) => {
      installs.push(dir);
      fs.mkdirSync(path.join(dir, 'node_modules', 'ws'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'ws', 'index.js'), 'new ws');
    },
    rebuildApp: (dir) => rebuilds.push(dir),
    restart: (why) => restarts.push(why),
  });
  const phases = [];
  u.on('status', (s) => phases.push(s.phase));
  const out = await u.apply();
  assert.deepEqual({ updated: out.updated, from: out.from, to: out.to, deps: out.depsChanged, mac: out.macChanged }, { updated: true, from: '1.0.0', to: '1.1.0', deps: true, mac: true });
  for (const p of ['checking', 'downloading', 'verifying', 'installing', 'restarting']) assert.ok(phases.includes(p), p);

  assert.equal(read(app, 'server.js'), '// server 1.1.0\n', 'new code is live');
  assert.ok(fs.existsSync(path.join(app, 'lib', 'new-only.js')));
  assert.ok(!fs.existsSync(path.join(app, 'lib', 'old-only.js')), 'files removed from Echo are gone');
  assert.equal(read(app, 'data', 'settings.json'), '{"userName":"Sam"}', "the release's data/ never replaces yours");
  assert.equal(read(app, 'data', 'memory.md'), 'likes pho\n');
  assert.equal(read(app, '.env'), 'ELEVENLABS_API_KEY=x\n');
  assert.equal(read(app, '.echo-port'), '4799\n');
  assert.equal(read(app, 'models', 'whisper.bin'), 'model');
  assert.equal(read(app, 'node_modules', 'ws', 'index.js'), 'new ws', 'packages changed, so the freshly installed ones went live');
  assert.equal(installs.length, 1);
  assert.ok(installs[0].includes('.echo-update'), 'packages install in staging, before anything goes live');
  assert.deepEqual(rebuilds, [app], 'the Mac app sources changed, so it is rebuilt');
  assert.equal(restarts.length, 1);

  const prev = U.updateDirs(app).previous;
  assert.equal(read(prev, 'server.js'), '// server 1.0.0\n', 'the old version is kept for a manual rollback');
  assert.equal(read(prev, 'node_modules', 'ws', 'index.js'), 'old ws');
  assert.ok(!fs.existsSync(path.join(prev, 'data')), 'data never moves');
  assert.equal(U.pendingUpdate(data).to, '1.1.0', 'the supervisor will health-check it');
  assert.equal(u.status().previous, '1.0.0');
  assert.ok(!fs.existsSync(U.updateDirs(app).staging), 'staging is cleaned up');

  // The supervisor saw the new version answer: confirmed, and Echo mentions it once.
  U.confirmUpdate(data);
  assert.equal(U.pendingUpdate(data), null);
  assert.deepEqual([u.takeNotice()?.kind, u.takeNotice()], ['updated', null]);

  // Nothing newer: nothing happens.
  assert.deepEqual(await u.apply(), { updated: false, current: '1.1.0' });
});

test('packages only reinstall when they changed', async () => {
  const app = makeInstall('app-nodeps');
  fs.writeFileSync(path.join(app, 'package-lock.json'), JSON.stringify({ name: 'echo', version: '1.0.0', packages: { '': { version: '1.0.0' }, 'node_modules/ws': { version: '8.0.0' } } }));
  const gh = fakeGitHub('1.0.1', makeRelease('1.0.1', { lock: JSON.stringify({ name: 'echo', version: '1.0.1', packages: { '': { version: '1.0.1' }, 'node_modules/ws': { version: '8.0.0' } } }) }));
  let installs = 0;
  const u = new U.Updater({ appDir: app, dataDir: path.join(app, 'data'), fetchFn: gh.fetchFn, developer: false, installDeps: () => installs++, rebuildApp: () => assert.fail('the Mac app did not change') });
  const out = await u.apply({ restart: false });
  assert.equal(out.depsChanged, false);
  assert.equal(installs, 0);
  assert.equal(read(app, 'node_modules', 'ws', 'index.js'), 'old ws', 'the installed packages stay');
  assert.ok(!fs.existsSync(path.join(U.updateDirs(app).previous, 'node_modules')));
});

test('a download that fails its checksum changes nothing', async () => {
  const app = makeInstall('app-badsum');
  const gh = fakeGitHub('1.1.0', makeRelease('1.1.0'), { badSum: true });
  const u = new U.Updater({ appDir: app, dataDir: path.join(app, 'data'), fetchFn: gh.fetchFn, developer: false, installDeps: () => assert.fail('no install'), rebuildApp: () => {} });
  await assert.rejects(u.apply({ restart: false }), /damaged or was changed/);
  assert.equal(read(app, 'server.js'), '// server 1.0.0\n');
  assert.equal(U.pendingUpdate(path.join(app, 'data')), null);
  assert.equal(u.status().phase, 'error');
  assert.ok(!fs.existsSync(U.updateDirs(app).staging));
});

test('a failed swap puts every file back', () => {
  const app = makeInstall('app-swapfail');
  const src = path.join(dirs.root, 'swap-src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'package.json'), '{"name":"echo","version":"9.9.9"}');
  fs.writeFileSync(path.join(src, 'server.js'), 'new');
  fs.chmodSync(src, 0o555); // the new files can't be moved out: the swap fails halfway
  try {
    assert.throws(() => U.swapIn(app, src, path.join(dirs.root, 'swap-prev')), /current version was put back/);
  } finally {
    fs.chmodSync(src, 0o755);
  }
  assert.equal(read(app, 'server.js'), '// server 1.0.0\n');
  assert.ok(fs.existsSync(path.join(app, 'lib', 'old-only.js')));
});

test('rolling back restores the old version and data, and the failed version is not retried automatically', async () => {
  const app = makeInstall('app-rollback');
  const data = path.join(app, 'data');
  const gh = fakeGitHub('1.2.0', makeRelease('1.2.0', { lock: '{"lock":3}' }));
  const u = new U.Updater({ appDir: app, dataDir: data, fetchFn: gh.fetchFn, developer: false, installDeps: (dir) => fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }), rebuildApp: () => {} });
  await u.apply({ restart: false });
  fs.writeFileSync(path.join(data, 'memory.md'), 'likes pho\nlearned after the update\n');
  // What the supervisor does when the new version fails its health check:
  const out = U.rollbackUpdate({ appDir: app, dataDir: data, why: 'failed its health check', rebuild: () => {} });
  assert.deepEqual(out, { from: '1.2.0', to: '1.0.0' });
  assert.equal(read(app, 'server.js'), '// server 1.0.0\n');
  assert.ok(fs.existsSync(path.join(app, 'lib', 'old-only.js')));
  assert.equal(read(app, 'node_modules', 'ws', 'index.js'), 'old ws', 'the old packages are back');
  assert.equal(read(data, 'memory.md'), 'likes pho\nlearned after the update\n', 'data written meanwhile is kept');
  assert.equal(read(app, '.env'), 'ELEVENLABS_API_KEY=x\n');
  assert.equal(U.pendingUpdate(data), null);
  const st = u.status();
  assert.equal(st.failedVersion, '1.2.0');
  assert.equal(st.previous, null, 'the broken version is thrown away');
  assert.equal(u.takeNotice()?.kind, 'rolled_back');
});

test('a manual rollback goes back and forth between the two versions', async () => {
  const app = makeInstall('app-manual');
  const data = path.join(app, 'data');
  const gh = fakeGitHub('1.1.0', makeRelease('1.1.0'));
  const u = new U.Updater({ appDir: app, dataDir: data, fetchFn: gh.fetchFn, developer: false, installDeps: () => {}, rebuildApp: () => {} });
  await u.apply({ restart: false });
  U.confirmUpdate(data);
  const back = u.rollback({ restart: false });
  assert.deepEqual(back, { from: '1.1.0', to: '1.0.0' });
  assert.equal(read(app, 'server.js'), '// server 1.0.0\n');
  assert.equal(u.status().previous, '1.1.0');
  assert.equal(U.pendingUpdate(data).kind, 'rollback');
  assert.equal(read(app, 'data', 'settings.json'), '{"userName":"Sam"}');
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (s.address());
      s.close(() => resolve(port));
    });
  });

test('the supervisor rolls a release update back when the new version fails to start', { timeout: 60000 }, async () => {
  const app = path.join(dirs.root, 'app-sup');
  const data = path.join(dirs.root, 'data-sup');
  const prev = U.updateDirs(app).previous;
  fs.mkdirSync(prev, { recursive: true });
  fs.mkdirSync(path.join(data, 'update'), { recursive: true });
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"echo","version":"1.1.0","type":"module"}');
  fs.writeFileSync(path.join(app, 'server.js'), 'throw new Error("broken release")\n');
  fs.writeFileSync(path.join(prev, 'package.json'), '{"name":"echo","version":"1.0.0","type":"module"}');
  fs.writeFileSync(path.join(prev, 'server.js'), `import http from 'node:http';
http.createServer((req, res) => res.end(JSON.stringify({ ok: true, version: 'good', pid: process.pid }))).listen(process.env.VOICEOPS_PORT, '127.0.0.1');\n`);
  fs.writeFileSync(path.join(data, 'update', 'pending-update.json'), JSON.stringify({ kind: 'update', from: '1.0.0', to: '1.1.0', at: new Date(Date.now() - 60000).toISOString() }));
  const port = await freePort();
  const sup = spawn(process.execPath, [SUPERVISOR], {
    env: { ...process.env, VOICEOPS_APP_DIR: app, VOICEOPS_DATA_DIR: data, VOICEOPS_PORT: String(port), VOICEOPS_HEALTH_TIMEOUT_MS: '4000' },
    stdio: 'pipe',
  });
  let output = '';
  sup.stdout.on('data', (d) => (output += d));
  sup.stderr.on('data', (d) => (output += d));
  try {
    await until(() => fs.existsSync(path.join(data, 'update', 'update-notice.json')), 30000, 'rollback');
    const notice = JSON.parse(read(data, 'update', 'update-notice.json'));
    assert.equal(notice.kind, 'rolled_back');
    assert.match(read(app, 'package.json'), /"1\.0\.0"/);
    await until(async () => {
      try {
        return (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).version === 'good';
      } catch {
        return false;
      }
    }, 15000, 'the old version serving');
    assert.ok(!fs.existsSync(path.join(data, 'update', 'pending-update.json')));
    assert.match(read(data, 'self', 'audit.log'), /"update_rolled_back"/);
  } catch (e) {
    console.log(output);
    throw e;
  } finally {
    sup.kill('SIGTERM');
    await new Promise((r) => sup.once('exit', r));
  }
});
