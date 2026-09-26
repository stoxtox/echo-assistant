// Publishes a prepared release to GitHub Releases with the gh command line tool.
// It asks first (type "publish"), unless you pass --yes.
//
//   npm run release:publish              the version in package.json (prepare it first with
//                                        npm run release -- --current, or bump with npm run release)
//   npm run release:publish -- 1.2.0     another prepared version
//   npm run release:publish -- --yes     publish without the typed confirmation
//   options: --dry-run   only show what it would do
//            --yes       confirm publishing without asking
//
// The confirmation can also be piped in:  echo publish | npm run release:publish
// Run `npm run publish-repo` first, so the public repo has this version's files and tag.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR } from '../lib/config.js';
import { releaseRepo, ghStatus, verifyChecksum, parseChecksum } from '../lib/release.js';
import { confirm, closeInput, releaseDir } from './release.js';

/** `npm run release:publish` arguments. @param {string[]} argv */
export function parsePublishReleaseArgs(argv) {
  const version = argv.find((a) => !a.startsWith('-'));
  return { version: version ? version.replace(/^v/, '') : undefined, dry: argv.includes('--dry-run'), yes: argv.includes('--yes') || argv.includes('-y') };
}

/**
 * `run` and `gh` stand in for the gh command and its sign-in check in tests.
 * @param {{ version?: string, dry?: boolean, yes?: boolean, appDir?: string,
 *   run?: (cmd: string, args: string[], opts?: object) => any, gh?: typeof ghStatus }} [opts]
 * @returns {Promise<{ published: boolean, version: string, args: string[] }>}
 */
export async function publishRelease({ version, dry = false, yes = false, appDir = APP_DIR, run = execFileSync, gh = ghStatus } = {}) {
  const current = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  version = (version || current).replace(/^v/, '');
  const dir = releaseDir(version, appDir);
  const manifestFile = path.join(dir, 'release.json');
  if (!fs.existsSync(manifestFile)) {
    const how =
      version === current
        ? `To publish ${version} as it is, prepare it first with:  npm run release -- --current\n(or npm run release [patch|minor|major] to bump to a new version).`
        : `Prepare it with npm run release, or check the version (package.json says ${current}).`;
    throw new Error(`There's no prepared release for ${version} (no ${path.relative(appDir, manifestFile)}).\n${how}`);
  }
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const zip = path.join(dir, m.zip);
  const sums = path.join(dir, m.checksumFile);
  verifyChecksum(zip, parseChecksum(fs.readFileSync(sums, 'utf8'), m.zip));
  const repo = releaseRepo(appDir);
  if (!repo.configured) throw new Error('Set your GitHub username in echo-release.json first.');
  const target = `${repo.owner}/${repo.repo}`;
  const args = ['release', 'create', m.tag, zip, sums, '--repo', target, '--title', `Echo ${version}`, '--notes-file', path.join(dir, 'notes.md'), '--target', 'main', '--latest'];
  console.log(`About to publish Echo ${version} to https://github.com/${target}/releases`);
  console.log(`  ${m.zip} (SHA-256 ${m.sha256.slice(0, 16)}…) and ${m.checksumFile}`);
  console.log(`  gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (dry) {
    console.log(`\n--dry-run: nothing was published.${yes ? ' (--yes would publish without asking.)' : ''}`);
    return { published: false, version, args };
  }

  const status = gh();
  if (!status.authed) throw new Error(`The GitHub command line tool isn't ready:\n  ${status.help.join('\n  ')}`);
  const ok = await confirm({ question: '\nThis is public and everyone who installs Echo gets it. Type "publish" to go ahead: ', word: 'publish', yes, what: `publish Echo ${version}` });
  if (!ok) {
    console.log('Not published.');
    return { published: false, version, args };
  }
  run('gh', args, { stdio: 'inherit' });
  console.log(`\nPublished. Installs and in-app updates now get Echo ${version}.`);
  return { published: true, version, args };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(() => publishRelease(parsePublishReleaseArgs(process.argv.slice(2))))
    .then(() => (closeInput(), process.exit(0)))
    .catch((e) => {
      console.error(`\nNot published: ${e.message}`);
      process.exit(1);
    });
}
