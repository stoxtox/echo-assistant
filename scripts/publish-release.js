// Publishes a prepared release to GitHub Releases with the gh command line tool.
// It ALWAYS asks first (type "publish"), and never runs without someone at the terminal.
//
//   npm run release:publish              the version in package.json
//   npm run release:publish -- 1.2.0     another prepared version
//   options: --dry-run   only show what it would do
//
// Run `npm run publish-repo` first, so the public repo has this version's files and tag.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR } from '../lib/config.js';
import { releaseRepo, ghStatus, verifyChecksum, parseChecksum } from '../lib/release.js';
import { askLine, releaseDir } from './release.js';

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  const version = (argv.find((a) => !a.startsWith('-')) || JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version).replace(/^v/, '');
  const dir = releaseDir(version);
  const manifestFile = path.join(dir, 'release.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`There's no prepared release for ${version}. Run npm run release first.`);
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const zip = path.join(dir, m.zip);
  const sums = path.join(dir, m.checksumFile);
  verifyChecksum(zip, parseChecksum(fs.readFileSync(sums, 'utf8'), m.zip));
  const repo = releaseRepo();
  if (!repo.configured) throw new Error('Set your GitHub username in echo-release.json first.');
  const target = `${repo.owner}/${repo.repo}`;
  const args = ['release', 'create', m.tag, zip, sums, '--repo', target, '--title', `Echo ${version}`, '--notes-file', path.join(dir, 'notes.md'), '--target', 'main', '--latest'];
  console.log(`About to publish Echo ${version} to https://github.com/${target}/releases`);
  console.log(`  ${m.zip} (SHA-256 ${m.sha256.slice(0, 16)}…) and ${m.checksumFile}`);
  console.log(`  gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  if (dry) return console.log('\n--dry-run: nothing was published.');

  const gh = ghStatus();
  if (!gh.authed) throw new Error(`The GitHub command line tool isn't ready:\n  ${gh.help.join('\n  ')}`);
  if (!process.stdin.isTTY && !fs.existsSync('/dev/tty')) throw new Error('Publishing needs someone at the terminal to confirm it.');
  const answer = await askLine('\nThis is public and everyone who installs Echo gets it. Type "publish" to go ahead: ');
  if (answer !== 'publish') return console.log('Not published.');
  execFileSync('gh', args, { stdio: 'inherit' });
  console.log(`\nPublished. Installs and in-app updates now get Echo ${version}.`);
}

main().catch((e) => {
  console.error(`\nNot published: ${e.message}`);
  process.exit(1);
});
