// Release tooling: typed confirmations (piped, --yes), argument parsing, and preparing the
// current version without a bump. No network: gh and git push are stand-ins, git runs in temp repos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.js';

const dirs = sandbox('release-tools');
// Git in temp repos only, with a throwaway identity and none of your own git config.
const gitConfig = path.join(dirs.root, 'gitconfig');
fs.writeFileSync(gitConfig, '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});
delete process.env.ECHO_REPO;

const SCRIPTS = path.join(import.meta.dirname, '..', 'scripts');
const scriptUrl = (name) => pathToFileURL(path.join(SCRIPTS, name)).href;
const Rel = await import('../scripts/release.js');
const PubRel = await import('../scripts/publish-release.js');
const PubRepo = await import('../scripts/publish-repo.js');
const { sha256File, checksumLine, zipName, checksumName } = await import('../lib/release.js');

const authed = () => ({ installed: true, authed: true, help: [] });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Runs a small node script with `input` on stdin. Resolves when it exits (or rejects on a hang). */
function runChild(code, input, { endInput = true, ms = 10000 } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(dirs.root, 'child-')), 'child.mjs');
  fs.writeFileSync(file, code);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child hung\nstdout: ${out}\nstderr: ${err}`));
    }, ms);
    child.on('exit', (status) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ status, out, err });
    });
    child.stdin.write(input);
    if (endInput) child.stdin.end();
  });
}

/** A temp Echo folder with a package.json, echo-release.json and CHANGELOG.md. */
function fakeApp(version = '1.0.1', { changelog = true } = {}) {
  const app = fs.mkdtempSync(path.join(dirs.root, 'app-'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'echo', version }, null, 2) + '\n');
  fs.writeFileSync(path.join(app, 'echo-release.json'), JSON.stringify({ owner: 'example', repo: 'echo', publicClone: path.join(app, '..', `public-${path.basename(app)}`) }) + '\n');
  fs.writeFileSync(
    path.join(app, 'CHANGELOG.md'),
    `# Changelog\n\n## Unreleased\n\n${changelog ? `## [${version}] - 2026-09-25\n\n- The current notes.\n\n` : ''}## [1.0.0] - 2026-09-01\n\n- First.\n`,
  );
  return app;
}

/** Writes a prepared release like `npm run release` does. */
function prepared(app, version) {
  const out = Rel.releaseDir(version, app);
  fs.mkdirSync(out, { recursive: true });
  const zip = path.join(out, zipName(version));
  fs.writeFileSync(zip, 'zip bytes');
  const hex = sha256File(zip);
  fs.writeFileSync(path.join(out, checksumName(version)), checksumLine(hex, zipName(version)));
  fs.writeFileSync(path.join(out, 'notes.md'), '- Notes.\n');
  fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify({ version, tag: `v${version}`, zip: zipName(version), sha256: hex, checksumFile: checksumName(version), notes: 'notes.md' }));
  return out;
}

/** A stand-in for buildPackage: an Echo/ folder and a zip. */
const fakeBuild = ({ out, zipName: name }) => {
  fs.mkdirSync(path.join(out, 'Echo'), { recursive: true });
  fs.writeFileSync(path.join(out, 'Echo', 'package.json'), '{}');
  const zipFile = path.join(out, name);
  fs.writeFileSync(zipFile, 'zip');
  return { ok: true, zipFile };
};

const quiet = async (fn) => {
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const result = await fn();
    return { result, text: lines.join('\n') };
  } finally {
    console.log = log;
  }
};

/* ---------- typed answers ---------- */

test('askLine reads consecutive piped answers, one line each, and exits without hanging', async () => {
  const code = `import { askLine } from ${JSON.stringify(scriptUrl('release.js'))};
const a = await askLine('first? ');
const b = await askLine('second? ');
const c = await askLine('third? ');
console.error(JSON.stringify([a, b, c]));\n`;
  const r = await runChild(code, 'create\npush\n');
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(JSON.parse(r.err.trim()), ['create', 'push', ''], 'the third question gets the end of the input');
  assert.match(r.out, /first\? create\nsecond\? push\n/);
});

test('askLine: with stdin still open, a paused reader does not keep the process alive', async () => {
  const code = `import { askLine } from ${JSON.stringify(scriptUrl('release.js'))};
const a = await askLine('first? ');
const b = await askLine('second? ');
console.error(JSON.stringify([a, b]));\n`;
  // Both answers arrive in one chunk and the pipe is never closed: the child must still exit.
  const r = await runChild(code, '  create \r\npush\nextra\n', { endInput: false });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(JSON.parse(r.err.trim()), ['create', 'push']);
});

test('confirm: --yes confirms without reading, and says so', async () => {
  const { result, text } = await quiet(() => Rel.confirm({ question: 'Type "push": ', word: 'push', yes: true, what: 'push it' }));
  assert.equal(result, true);
  assert.match(text, /--yes: confirmed \(push it\)/);
});

/* ---------- argument parsing ---------- */

test('argument parsers: --yes, --dry-run, versions and --current', () => {
  assert.deepEqual(PubRel.parsePublishReleaseArgs([]), { version: undefined, dry: false, yes: false });
  assert.deepEqual(PubRel.parsePublishReleaseArgs(['v1.2.0', '--yes', '--dry-run']), { version: '1.2.0', dry: true, yes: true });
  const repo = PubRepo.parsePublishRepoArgs(['--yes', '--dir', '/tmp/x', '--no-push']);
  assert.equal(repo.yes, true);
  assert.equal(repo.push, false);
  assert.equal(repo.clone, path.resolve('/tmp/x'));
  assert.equal(PubRepo.parsePublishRepoArgs([]).yes, false);
  assert.equal(Rel.parseReleaseArgs([]).kind, 'patch');
  assert.equal(Rel.parseReleaseArgs(['minor', '--yes']).kind, 'minor');
  assert.equal(Rel.parseReleaseArgs(['minor', '--yes']).edit, false);
  assert.equal(Rel.parseReleaseArgs(['--current']).kind, 'current');
  assert.equal(Rel.parseReleaseArgs(['current', '--no-git']).kind, 'current');
  assert.equal(Rel.parseReleaseArgs(['--data-dir', 'somewhere', '--current']).kind, 'current', "--data-dir's value isn't the kind");
  assert.throws(() => Rel.parseReleaseArgs(['minor', '--current']), /can't also be/);
});

/* ---------- release:publish ---------- */

test('release:publish with no version uses package.json and says how to prepare it when missing', async () => {
  const app = fakeApp('1.4.0');
  await assert.rejects(() => PubRel.publishRelease({ appDir: app, dry: true }), /no prepared release for 1\.4\.0[\s\S]*npm run release -- --current/);
  prepared(app, '1.4.0');
  const { result, text } = await quiet(() => PubRel.publishRelease({ appDir: app, dry: true, yes: true, gh: () => assert.fail('dry-run never checks gh') }));
  assert.equal(result.published, false);
  assert.equal(result.version, '1.4.0');
  assert.match(text, /gh release create v1\.4\.0 .*--repo example\/echo/);
  assert.match(text, /--dry-run: nothing was published/);
});

test('release:publish --yes publishes without asking', async () => {
  const app = fakeApp('1.4.1');
  prepared(app, '1.4.1');
  const calls = [];
  const { result, text } = await quiet(() => PubRel.publishRelease({ appDir: app, yes: true, gh: authed, run: (cmd, args) => calls.push([cmd, ...args]) }));
  assert.equal(result.published, true);
  assert.deepEqual(calls.map((c) => c.slice(0, 4)), [['gh', 'release', 'create', 'v1.4.1']]);
  assert.match(text, /--yes: confirmed/);
});

test('release:publish takes a piped "publish" (and refuses anything else)', async () => {
  const app = fakeApp('1.4.2');
  prepared(app, '1.4.2');
  const code = (ok) => `import { publishRelease } from ${JSON.stringify(scriptUrl('publish-release.js'))};
const calls = [];
const r = await publishRelease({ appDir: ${JSON.stringify(app)}, gh: () => ({ authed: true, help: [] }), run: (cmd, args) => calls.push(cmd) });
console.error(JSON.stringify({ published: r.published, calls }));\n`;
  const yes = await runChild(code(), 'publish\n');
  assert.equal(yes.status, 0, yes.err);
  assert.deepEqual(JSON.parse(yes.err.trim().split('\n').pop()), { published: true, calls: ['gh'] });
  const no = await runChild(code(), 'nope\n');
  assert.deepEqual(JSON.parse(no.err.trim().split('\n').pop()), { published: false, calls: [] });
  const none = await runChild(code(), '');
  assert.deepEqual(JSON.parse(none.err.trim().split('\n').pop()), { published: false, calls: [] }, 'no input: not published');
});

/* ---------- publish-repo ---------- */

test('publish-repo --yes creates the missing repo and pushes without asking', async () => {
  const app = fakeApp('1.5.0');
  const source = path.join(prepared(app, '1.5.0'), 'Echo');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'echo', version: '1.5.0' }));
  fs.writeFileSync(path.join(source, 'README.md'), '# Echo\n');
  const clone = fs.mkdtempSync(path.join(dirs.root, 'public-'));
  const calls = [];
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.slice(0, 2).join(' ')}`);
    if (cmd === 'gh' && args[1] === 'view') throw new Error('not found');
  };
  const { result, text } = await quiet(() => PubRepo.publishRepo({ appDir: app, clone, dataDir: dirs.data, yes: true, gh: authed, run }));
  assert.equal(result.pushed, true);
  assert.deepEqual(calls, ['gh repo view', 'gh repo create', 'git push -u']);
  assert.match(text, /--yes: confirmed \(create github\.com\/example\/echo/);
  assert.match(text, /--yes: confirmed \(push to github\.com\/example\/echo\)/);
  assert.equal(git(clone, 'tag', '--list', 'v1.5.0'), 'v1.5.0');
  assert.ok(fs.existsSync(path.join(clone, 'README.md')));
});

/* ---------- npm run release -- --current ---------- */

function gitApp(version, opts) {
  const app = fakeApp(version, opts);
  fs.writeFileSync(path.join(app, '.gitignore'), 'dist/\n');
  git(app, 'init', '-q', '-b', 'main');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'Start');
  return app;
}

test('release --current prepares the version in package.json: no bump, no new entry, tags once, no empty commit', async () => {
  const app = gitApp('1.0.1');
  const pkgBefore = fs.readFileSync(path.join(app, 'package.json'), 'utf8');
  const changelogBefore = fs.readFileSync(path.join(app, 'CHANGELOG.md'), 'utf8');
  const head = git(app, 'rev-parse', 'HEAD');
  const opts = { kind: /** @type {'current'} */ ('current'), appDir: app, dataDir: dirs.data, edit: false, build: fakeBuild, gh: authed };
  const { result, text } = await quiet(() => Rel.release(opts));
  assert.equal(result.version, '1.0.1');
  assert.equal(fs.readFileSync(path.join(app, 'package.json'), 'utf8'), pkgBefore, 'no bump');
  assert.equal(fs.readFileSync(path.join(app, 'CHANGELOG.md'), 'utf8'), changelogBefore, 'no new changelog entry');
  assert.equal(git(app, 'rev-parse', 'HEAD'), head, 'nothing changed, so no commit');
  assert.equal(git(app, 'rev-list', '-n', '1', 'v1.0.1'), head, 'tagged v1.0.1');
  assert.match(text, /Nothing to commit/);
  const dir = Rel.releaseDir('1.0.1', app);
  assert.equal(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), '- The current notes.\n', "the version's existing CHANGELOG section is the notes");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'release.json'), 'utf8')).tag, 'v1.0.1');
  assert.ok(fs.existsSync(path.join(dir, 'Echo-1.0.1.zip.sha256')));

  // Again, once the tag exists (and HEAD has moved on): the tag is left alone.
  fs.writeFileSync(path.join(app, 'more.txt'), 'x');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'More');
  const again = await quiet(() => Rel.release(opts));
  assert.equal(again.result.version, '1.0.1');
  assert.equal(git(app, 'rev-list', '-n', '1', 'v1.0.1'), head, 'the existing tag is not moved');
  assert.match(again.text, /already tagged/);

  // Then release:publish with no version finds it.
  const dry = await quiet(() => PubRel.publishRelease({ appDir: app, dry: true }));
  assert.equal(dry.result.version, '1.0.1');
});

test('release --current needs CHANGELOG notes for the version; a bump still bumps', async () => {
  const bare = gitApp('2.0.0', { changelog: false });
  await assert.rejects(() => quiet(() => Rel.release({ kind: 'current', appDir: bare, dataDir: dirs.data, edit: false, build: fakeBuild, gh: authed })), /no notes for 2\.0\.0/);
  assert.equal(git(bare, 'status', '--porcelain'), '', 'nothing was changed');

  const app = gitApp('2.0.0');
  const { result } = await quiet(() => Rel.release({ kind: 'patch', appDir: app, dataDir: dirs.data, edit: false, build: fakeBuild, gh: authed, date: '2026-09-25' }));
  assert.equal(result.version, '2.0.1');
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '2.0.1');
  assert.equal(git(app, 'log', '-1', '--format=%s'), 'Release v2.0.1');
  assert.equal(git(app, 'tag', '--list', 'v2.0.1'), 'v2.0.1');
});
