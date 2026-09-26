// Prepares a release of Echo. Nothing is published: that's `npm run release:publish`.
//
//   npm run release [patch|minor|major]      (default patch)
//   npm run release -- --current             prepare the version already in package.json (no bump)
//   options: --yes           don't stop to let you edit the changelog notes
//            --no-git        don't commit the version bump or tag it (for trying it out)
//            --data-dir DIR  your Echo data folder, for the privacy check's personal words
//
// Steps: the working tree must be clean -> bump the version (package.json and the lockfile) ->
// add a CHANGELOG.md entry (your "Unreleased" notes, then the commit messages since the last tag)
// -> build the clean package -> the privacy check must pass -> dist/release/v<version>/ gets
// Echo-<version>.zip, its .sha256 file, notes.md and release.json -> commit "Release v<version>"
// and tag it v<version> (locally; nothing is pushed).
//
// With --current (or "current" as the kind) there's no bump and no new changelog entry: the
// existing "## [<version>]" section of CHANGELOG.md is the notes, the tag is added only if it's
// missing, and there's a commit only if something changed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import tty from 'node:tty';
import { execFileSync } from 'node:child_process';
import { APP_DIR, config } from '../lib/config.js';
import { bumpVersion, addChangelogEntry, changelogSection, sha256File, checksumLine, zipName, checksumName, releaseRepo, ghStatus } from '../lib/release.js';
import { buildPackage } from './package.js';

const git = (args, cwd = APP_DIR) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* ---------- typed answers ---------- */

/**
 * Where answers come from. A terminal on stdin: ask there. Piped stdin (a pipe, a file or a
 * socket, e.g. `printf 'create\npush\n' | npm run publish-repo`): each question takes the next
 * line. Only when stdin is neither (e.g. /dev/null from a launcher) does it fall back to /dev/tty.
 * @returns {'tty' | 'piped' | 'devtty'}
 */
export function inputKind() {
  if (process.stdin.isTTY) return 'tty';
  try {
    const st = fs.fstatSync(0);
    if (st.isFIFO() || st.isFile() || st.isSocket()) return 'piped';
  } catch {}
  return 'devtty';
}

/**
 * Keep the process alive for stdin only while a question is waiting for its answer. (Pausing
 * alone isn't enough: a paused stream still reads ahead, which keeps a pipe's handle active.)
 * @param {boolean} on
 */
function holdStdin(on) {
  const s = /** @type {any} */ (process.stdin);
  if (on) {
    if (typeof s.ref === 'function') s.ref();
  } else if (typeof s.unref === 'function') s.unref();
}

/** One shared line reader over piped stdin, so consecutive questions each get the next line. */
let piped = null;
function pipedReader() {
  if (piped) return piped;
  const state = { lines: /** @type {string[]} */ ([]), waiters: /** @type {Array<(l: string) => void>} */ ([]), closed: false, rl: null };
  const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
  state.rl = rl;
  rl.on('line', (line) => {
    const w = state.waiters.shift();
    if (w) w(line);
    else state.lines.push(line);
    // Nobody else is asking: stop reading, and don't let stdin keep the process alive.
    if (!state.waiters.length) {
      rl.pause();
      holdStdin(false);
    }
  });
  rl.on('close', () => {
    state.closed = true;
    for (const w of state.waiters.splice(0)) w('');
  });
  process.stdin.on('error', () => rl.close());
  piped = state;
  return state;
}

/** @returns {Promise<string>} the next piped line ('' at the end of the input). */
function nextPipedLine() {
  const r = pipedReader();
  if (r.lines.length) return Promise.resolve(r.lines.shift());
  if (r.closed) return Promise.resolve('');
  return new Promise((resolve) => {
    r.waiters.push(resolve);
    holdStdin(true);
    r.rl.resume();
  });
}

/** Stop reading piped answers (later questions get ''). Harmless if nothing was read. */
export function closeInput() {
  if (piped && !piped.closed) piped.rl.close();
  if (piped) holdStdin(false);
}

/** Ask one question on a terminal stream with its own readline, then let go of it. */
function askOn(input, question, done = () => {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output: process.stdout });
    let answered = false;
    const finish = (a) => {
      if (answered) return;
      answered = true;
      rl.close();
      done();
      resolve(a.trim());
    };
    rl.on('error', () => finish(''));
    rl.on('close', () => finish(''));
    rl.question(question, (a) => finish(a));
  });
}

/**
 * Ask a question; resolves to the trimmed answer ('' when there's no answer to be had).
 * See inputKind() for where the answer comes from.
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function askLine(question) {
  const kind = inputKind();
  if (kind === 'tty') return askOn(process.stdin, question);
  if (kind === 'piped') {
    process.stdout.write(question);
    const a = (await nextPipedLine()).trim();
    process.stdout.write(`${a}\n`);
    return a;
  }
  let fd;
  try {
    fd = fs.openSync('/dev/tty', 'r');
  } catch {
    return '';
  }
  let input;
  try {
    input = new tty.ReadStream(fd);
  } catch {
    fs.closeSync(fd);
    return '';
  }
  return askOn(input, question, () => input.destroy());
}

/**
 * A typed confirmation: true if the answer is exactly `word`, or right away with `yes`
 * (the --yes flag), saying so.
 * @param {{ question: string, word: string, yes?: boolean, what?: string }} opts
 */
export async function confirm({ question, word, yes = false, what = word }) {
  if (yes) {
    console.log(`${question.trim()}\n  --yes: confirmed (${what}) without asking.`);
    return true;
  }
  return (await askLine(question)) === word;
}

export const releaseDir = (version, appDir = APP_DIR) => path.join(appDir, 'dist', 'release', `v${version}`);

/** Commit subjects since the last v* tag. Without a tag yet, none: the whole history isn't release notes. */
function commitsSinceLastTag(appDir) {
  let range;
  try {
    range = `${git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], appDir)}..HEAD`;
  } catch {
    console.log('No earlier release tag, so the notes are just your "Unreleased" section in CHANGELOG.md.');
    return [];
  }
  try {
    return git(['log', '--no-merges', '--format=%s', range], appDir).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `kind: 'current'` prepares the version already in package.json: no bump, no new changelog entry
 * (its existing CHANGELOG.md section is the notes), a v<version> tag only if there isn't one, and
 * a commit only if something changed (e.g. you edited the notes when asked).
 * @param {{ kind?: 'patch' | 'minor' | 'major' | 'current', appDir?: string, dataDir?: string, useGit?: boolean,
 *   edit?: boolean, date?: string, build?: (opts: { out: string, dataDir: string, appDir: string, zipName: string }) => { ok: boolean, zipFile?: string },
 *   gh?: () => { authed: boolean, help: string[] } }} [opts]
 */
export async function release({ kind = 'patch', appDir = APP_DIR, dataDir = config.dataDir, useGit = true, edit = true, date, build = buildPackage, gh = ghStatus } = {}) {
  if (!['patch', 'minor', 'major', 'current'].includes(kind)) throw new Error(`Say patch, minor, major or current (not "${kind}").`);
  const current = kind === 'current';
  const repo = releaseRepo(appDir);
  if (!repo.configured) throw new Error('Set your GitHub username in echo-release.json ("owner") first; the installer and the updater need it.');
  if (useGit) {
    const dirty = git(['status', '--porcelain'], appDir);
    if (dirty) throw new Error(`Commit or put away these changes first, so the release is exactly what's committed:\n${dirty}`);
  }
  const pkgFile = path.join(appDir, 'package.json');
  const lockFile = path.join(appDir, 'package-lock.json');
  const changelogFile = path.join(appDir, 'CHANGELOG.md');
  const originals = new Map([pkgFile, lockFile, changelogFile].filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, 'utf8')]));
  // A bump rolls its own edits back on failure; with --current the files are yours, so they stay.
  const restore = () => {
    if (current) return;
    for (const [f, text] of originals) fs.writeFileSync(f, text);
  };

  const pkg = JSON.parse(originals.get(pkgFile));
  const version = current ? pkg.version : bumpVersion(pkg.version, kind);
  const tag = `v${version}`;
  if (current) {
    if (!changelogSection(originals.get(changelogFile) || '', version))
      throw new Error(`CHANGELOG.md has no notes for ${version}. Add a "## [${version}] - <date>" section with them, or bump instead (npm run release patch).`);
    console.log(`Preparing the current version, Echo ${version} (no version bump, no new changelog entry).`);
  } else console.log(`Releasing Echo ${version} (was ${pkg.version}).`);
  try {
    if (!current) {
      fs.writeFileSync(pkgFile, JSON.stringify({ ...pkg, version }, null, 2) + '\n');
      if (originals.has(lockFile)) {
        const lock = JSON.parse(originals.get(lockFile));
        lock.version = version;
        if (lock.packages?.['']) lock.packages[''].version = version;
        fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
      }
      const commits = useGit ? commitsSinceLastTag(appDir) : [];
      fs.writeFileSync(changelogFile, addChangelogEntry(originals.get(changelogFile) || '', version, { commits, date }));
    }
    console.log(`\nRelease notes (CHANGELOG.md):\n\n${changelogSection(fs.readFileSync(changelogFile, 'utf8'), version)}\n`);
    if (edit && process.stdout.isTTY) await askLine('Edit those notes in CHANGELOG.md now if you like (they are what users see), then press Return… ');
    const notes = changelogSection(fs.readFileSync(changelogFile, 'utf8'), version);
    if (!notes) throw new Error(`CHANGELOG.md no longer has notes for ${version}.`);

    const out = releaseDir(version, appDir);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const built = build({ out, dataDir, appDir, zipName: zipName(version) });
    if (!built.ok || !built.zipFile) throw new Error('The privacy check failed (see above), so there is no release. Nothing was committed.');
    const hex = sha256File(built.zipFile);
    fs.writeFileSync(path.join(out, checksumName(version)), checksumLine(hex, zipName(version)));
    fs.writeFileSync(path.join(out, 'notes.md'), notes + '\n');
    const manifest = { version, tag, repo: `${repo.owner}/${repo.repo}`, zip: zipName(version), sha256: hex, checksumFile: checksumName(version), notes: 'notes.md', builtAt: new Date().toISOString() };
    fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');

    if (useGit) {
      const files = ['package.json', 'CHANGELOG.md', ...(originals.has(lockFile) ? ['package-lock.json'] : [])];
      if (git(['status', '--porcelain', '--', ...files], appDir)) {
        git(['add', '--', ...files], appDir);
        git(['commit', '-q', '-m', current ? `Release notes for v${version}` : `Release v${version}`], appDir);
      } else console.log('Nothing to commit: the release is exactly what is committed.');
      if (!git(['tag', '--list', tag], appDir)) {
        git(['tag', '-a', tag, '-m', `Echo ${version}`], appDir);
        console.log(`Tagged ${tag} (locally).`);
      } else {
        const at = git(['rev-list', '-n', '1', tag], appDir);
        const head = git(['rev-parse', 'HEAD'], appDir);
        console.log(at === head ? `${tag} is already tagged here.` : `${tag} is already tagged (at ${at.slice(0, 7)}; this build is from HEAD ${head.slice(0, 7)}). The tag was left as it is.`);
      }
    }
    console.log(`\nReady: ${path.relative(appDir, out)}/`);
    console.log(`  ${manifest.zip}  (SHA-256 ${hex})`);
    console.log(`  ${manifest.checksumFile}, notes.md, release.json`);
    console.log('\nNext (nothing has been published):');
    console.log('  1. npm run publish-repo       copy the clean package into your public repo clone and push it (asks first; -- --yes to skip asking)');
    console.log('  2. npm run release:publish    create the GitHub release with the zip and checksum (asks first; -- --yes to skip asking)');
    const status = gh();
    if (!status.authed) console.log(`\nThe GitHub command line tool isn't ready yet:\n  ${status.help.join('\n  ')}`);
    return { version, dir: out, manifest };
  } catch (e) {
    restore();
    throw e;
  }
}

/**
 * `npm run release` arguments. `current` or `--current` prepares the version in package.json.
 * @param {string[]} argv
 */
export function parseReleaseArgs(argv) {
  const dataIdx = argv.indexOf('--data-dir');
  const skip = new Set(dataIdx >= 0 ? [dataIdx + 1] : []);
  const positional = argv.filter((a, i) => !a.startsWith('-') && !skip.has(i));
  const kind = /** @type {'patch' | 'minor' | 'major' | 'current'} */ (argv.includes('--current') ? 'current' : positional[0] || 'patch');
  if (argv.includes('--current') && positional[0] && positional[0] !== 'current') throw new Error(`--current prepares the version in package.json; it can't also be "${positional[0]}".`);
  return {
    kind,
    dataDir: dataIdx >= 0 && argv[dataIdx + 1] ? path.resolve(argv[dataIdx + 1]) : undefined,
    useGit: !argv.includes('--no-git'),
    edit: !argv.includes('--yes'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(() => release(parseReleaseArgs(process.argv.slice(2))))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`\nNo release: ${e.message}`);
      process.exit(1);
    });
}
