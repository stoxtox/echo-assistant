// Prepares a release of Echo. Nothing is published: that's `npm run release:publish`.
//
//   npm run release [patch|minor|major]      (default patch)
//   options: --yes           don't stop to let you edit the changelog notes
//            --no-git        don't commit the version bump or tag it (for trying it out)
//            --data-dir DIR  your Echo data folder, for the privacy check's personal words
//
// Steps: the working tree must be clean -> bump the version (package.json and the lockfile) ->
// add a CHANGELOG.md entry (your "Unreleased" notes, then the commit messages since the last tag)
// -> build the clean package -> the privacy check must pass -> dist/release/v<version>/ gets
// Echo-<version>.zip, its .sha256 file, notes.md and release.json -> commit "Release v<version>"
// and tag it v<version> (locally; nothing is pushed).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { APP_DIR, config } from '../lib/config.js';
import { bumpVersion, addChangelogEntry, changelogSection, sha256File, checksumLine, zipName, checksumName, releaseRepo, ghStatus } from '../lib/release.js';
import { buildPackage } from './package.js';

const git = (args, cwd = APP_DIR) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Ask a question on the terminal; resolves to the answer ('' without a terminal). */
export function askLine(question) {
  let input;
  try {
    input = process.stdin.isTTY ? process.stdin : fs.createReadStream('/dev/tty');
  } catch {
    return Promise.resolve('');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output: process.stdout });
    rl.on('error', () => resolve(''));
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
    rl.on('close', () => resolve(''));
  });
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
 * @param {{ kind?: 'patch' | 'minor' | 'major', appDir?: string, dataDir?: string, useGit?: boolean,
 *   edit?: boolean, date?: string }} [opts]
 */
export async function release({ kind = 'patch', appDir = APP_DIR, dataDir = config.dataDir, useGit = true, edit = true, date } = {}) {
  if (!['patch', 'minor', 'major'].includes(kind)) throw new Error(`Say patch, minor or major (not "${kind}").`);
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
  const restore = () => {
    for (const [f, text] of originals) fs.writeFileSync(f, text);
  };

  const pkg = JSON.parse(originals.get(pkgFile));
  const version = bumpVersion(pkg.version, kind);
  console.log(`Releasing Echo ${version} (was ${pkg.version}).`);
  try {
    fs.writeFileSync(pkgFile, JSON.stringify({ ...pkg, version }, null, 2) + '\n');
    if (originals.has(lockFile)) {
      const lock = JSON.parse(originals.get(lockFile));
      lock.version = version;
      if (lock.packages?.['']) lock.packages[''].version = version;
      fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
    }
    const commits = useGit ? commitsSinceLastTag(appDir) : [];
    fs.writeFileSync(changelogFile, addChangelogEntry(originals.get(changelogFile) || '', version, { commits, date }));
    console.log(`\nRelease notes (CHANGELOG.md):\n\n${changelogSection(fs.readFileSync(changelogFile, 'utf8'), version)}\n`);
    if (edit && process.stdout.isTTY) await askLine('Edit those notes in CHANGELOG.md now if you like (they are what users see), then press Return… ');

    const out = releaseDir(version, appDir);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const built = buildPackage({ out, dataDir, appDir, zipName: zipName(version) });
    if (!built.ok || !built.zipFile) throw new Error('The privacy check failed (see above), so there is no release. Nothing was committed.');
    const hex = sha256File(built.zipFile);
    fs.writeFileSync(path.join(out, checksumName(version)), checksumLine(hex, zipName(version)));
    const notes = changelogSection(fs.readFileSync(changelogFile, 'utf8'), version);
    fs.writeFileSync(path.join(out, 'notes.md'), notes + '\n');
    const manifest = { version, tag: `v${version}`, repo: `${repo.owner}/${repo.repo}`, zip: zipName(version), sha256: hex, checksumFile: checksumName(version), notes: 'notes.md', builtAt: new Date().toISOString() };
    fs.writeFileSync(path.join(out, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');

    if (useGit) {
      git(['add', 'package.json', 'CHANGELOG.md', ...(originals.has(lockFile) ? ['package-lock.json'] : [])], appDir);
      git(['commit', '-m', `Release v${version}`], appDir);
      git(['tag', '-a', `v${version}`, '-m', `Echo ${version}`], appDir);
    }
    console.log(`\nReady: ${path.relative(appDir, out)}/`);
    console.log(`  ${manifest.zip}  (SHA-256 ${hex})`);
    console.log(`  ${manifest.checksumFile}, notes.md, release.json`);
    console.log('\nNext (nothing has been published):');
    console.log('  1. npm run publish-repo       copy the clean package into your public repo clone and push it (asks first)');
    console.log('  2. npm run release:publish    create the GitHub release with the zip and checksum (asks first)');
    const gh = ghStatus();
    if (!gh.authed) console.log(`\nThe GitHub command line tool isn't ready yet:\n  ${gh.help.join('\n  ')}`);
    return { version, dir: out, manifest };
  } catch (e) {
    restore();
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const kind = /** @type {any} */ (argv.find((a) => !a.startsWith('-')) || 'patch');
  const dataDir = argv.includes('--data-dir') ? path.resolve(argv[argv.indexOf('--data-dir') + 1]) : undefined;
  release({ kind, dataDir, useGit: !argv.includes('--no-git'), edit: !argv.includes('--yes') })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`\nNo release: ${e.message}`);
      process.exit(1);
    });
}
