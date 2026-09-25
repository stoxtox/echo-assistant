// Puts the clean package (dist/Echo) into a separate local clone of the PUBLIC repository and
// commits it there. The public repo is a fresh one: this folder's git history (which may hold
// personal data) never goes into it, only the checked package files.
//
//   npm run publish-repo                   sync this version's release (or dist/Echo), commit and tag, then ask to push
//   options: --dir PATH   the public clone (default: "publicClone" in echo-release.json, ~/EchoPublic)
//            --no-push    only commit locally
//            --data-dir   your Echo data folder, for the privacy check
//
// Commits in the public repo use your GitHub no-reply address, not your own email.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR, config } from '../lib/config.js';
import { releaseRepo, ghStatus } from '../lib/release.js';
import { privacyCheck } from './privacy-check.js';
import { askLine, releaseDir } from './release.js';

/** Never goes into the public repo, even though it's in the package. */
const SKIP = ['.echo-package'];

/**
 * @param {{ source?: string, clone?: string, dataDir?: string, push?: boolean, version?: string }} [opts]
 */
export async function publishRepo({ source, clone, dataDir = config.dataDir, push = true, version } = {}) {
  const repo = releaseRepo();
  // The prepared release of the current version (npm run release), else the last npm run package.
  const current = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  source ||= [path.join(releaseDir(current), 'Echo'), path.join(APP_DIR, 'dist', 'Echo')].find((d) => fs.existsSync(path.join(d, 'package.json'))) || path.join(APP_DIR, 'dist', 'Echo');
  clone ||= repo.publicClone;
  if (!fs.existsSync(path.join(source, 'package.json'))) throw new Error('No package to publish. Run npm run release (or npm run package) first.');
  if (path.resolve(clone) === APP_DIR || path.resolve(clone).startsWith(APP_DIR + path.sep)) throw new Error('The public clone must be a separate folder, outside this one.');
  version ||= JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
  if (!privacyCheck({ dir: source, dataDir }).ok) throw new Error('The privacy check failed, so nothing was copied.');

  const git = (args) => execFileSync('git', args, { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  fs.mkdirSync(clone, { recursive: true });
  if (!fs.existsSync(path.join(clone, '.git'))) {
    git(['init', '-q', '-b', 'main']);
    if (repo.configured) git(['remote', 'add', 'origin', `https://github.com/${repo.owner}/${repo.repo}.git`]);
    console.log(`Started a fresh public repo in ${clone}`);
  }
  // Public commits carry the GitHub no-reply address, never the email in your global git config.
  let email = '';
  try {
    email = git(['config', '--local', 'user.email']);
  } catch {}
  if (!email) {
    git(['config', 'user.name', repo.owner]);
    git(['config', 'user.email', `${repo.owner}@users.noreply.github.com`]);
  }
  execFileSync('rsync', ['-a', '--delete', '--exclude', '/.git/', ...SKIP.flatMap((s) => ['--exclude', `/${s}`]), `${source}/`, `${clone}/`]);
  git(['add', '-A']);
  const changed = git(['status', '--porcelain']);
  if (changed) {
    git(['commit', '-q', '-m', `Echo ${version}`]);
    console.log(`Committed Echo ${version} in ${clone}`);
  } else console.log('The public repo already has these files.');
  const tag = `v${version}`;
  if (!git(['tag', '--list', tag])) git(['tag', '-a', tag, '-m', `Echo ${version}`]);
  if (!push) return { clone, pushed: false };

  const target = `${repo.owner}/${repo.repo}`;
  if (!repo.configured) throw new Error('Set your GitHub username in echo-release.json before pushing.');
  const gh = ghStatus();
  if (!gh.authed) {
    console.log(`\nNot pushed. The GitHub command line tool isn't ready:\n  ${gh.help.join('\n  ')}\nThen run npm run publish-repo again.`);
    return { clone, pushed: false };
  }
  let exists = true;
  try {
    execFileSync('gh', ['repo', 'view', target], { stdio: 'ignore' });
  } catch {
    exists = false;
  }
  if (!exists) {
    const a = await askLine(`\nThe repository github.com/${target} doesn't exist yet. Create it as a PUBLIC repo? Type "create" to go ahead: `);
    if (a !== 'create') return console.log('Not created, not pushed.'), { clone, pushed: false };
    execFileSync('gh', ['repo', 'create', target, '--public', '--description', 'Echo: a voice assistant for your Mac, powered by Claude'], { stdio: 'inherit' });
  }
  const a = await askLine(`\nPush ${clone} (branch main and tag ${tag}) to github.com/${target}? This is public. Type "push" to go ahead: `);
  if (a !== 'push') return console.log('Not pushed.'), { clone, pushed: false };
  execFileSync('git', ['push', '-u', 'origin', 'main', '--follow-tags'], { cwd: clone, stdio: 'inherit' });
  console.log(`\nPushed. Next: npm run release:publish`);
  return { clone, pushed: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const val = (flag) => (argv.includes(flag) ? path.resolve(argv[argv.indexOf(flag) + 1]) : undefined);
  publishRepo({ clone: val('--dir'), dataDir: val('--data-dir'), push: !argv.includes('--no-push') })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`\n${e.message}`);
      process.exit(1);
    });
}
