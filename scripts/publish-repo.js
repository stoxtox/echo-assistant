// Puts the clean package (dist/Echo) into a separate local clone of the PUBLIC repository and
// commits it there. The public repo is a fresh one: this folder's git history (which may hold
// personal data) never goes into it, only the checked package files.
//
//   npm run publish-repo                   sync this version's release (or dist/Echo), commit and tag, then ask to push
//   npm run publish-repo -- --yes          the same, without the typed "create"/"push" confirmations
//   options: --dir PATH   the public clone (default: "publicClone" in echo-release.json, ~/EchoPublic)
//            --no-push    only commit locally
//            --yes        confirm creating the public GitHub repo (if needed) and pushing, without asking
//            --data-dir   your Echo data folder, for the privacy check
//
// The confirmations can also be piped in, one answer per line:
//   printf 'create\npush\n' | npm run publish-repo
//
// Commits in the public repo use your GitHub no-reply address, not your own email.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR, config } from '../lib/config.js';
import { releaseRepo, ghStatus } from '../lib/release.js';
import { privacyCheck } from './privacy-check.js';
import { confirm, closeInput, releaseDir } from './release.js';

/** Never goes into the public repo, even though it's in the package. */
const SKIP = ['.echo-package'];

/**
 * `run` and `gh` stand in for the gh/git network commands and the gh sign-in check in tests.
 * @param {{ source?: string, clone?: string, dataDir?: string, push?: boolean, version?: string, yes?: boolean,
 *   appDir?: string, run?: (cmd: string, args: string[], opts?: object) => any, gh?: typeof ghStatus }} [opts]
 */
export async function publishRepo({ source, clone, dataDir = config.dataDir, push = true, version, yes = false, appDir = APP_DIR, run = execFileSync, gh = ghStatus } = {}) {
  const repo = releaseRepo(appDir);
  // The prepared release of the current version (npm run release), else the last npm run package.
  const current = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  source ||= [path.join(releaseDir(current, appDir), 'Echo'), path.join(appDir, 'dist', 'Echo')].find((d) => fs.existsSync(path.join(d, 'package.json'))) || path.join(appDir, 'dist', 'Echo');
  clone ||= repo.publicClone;
  if (!fs.existsSync(path.join(source, 'package.json'))) throw new Error(`No package to publish. Run npm run release -- --current (to prepare ${current} as it is) or npm run release (to bump) first.`);
  const appAbs = path.resolve(appDir);
  if (path.resolve(clone) === appAbs || path.resolve(clone).startsWith(appAbs + path.sep)) throw new Error('The public clone must be a separate folder, outside this one.');
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
  const status = gh();
  if (!status.authed) {
    console.log(`\nNot pushed. The GitHub command line tool isn't ready:\n  ${status.help.join('\n  ')}\nThen run npm run publish-repo again.`);
    return { clone, pushed: false };
  }
  let exists = true;
  try {
    run('gh', ['repo', 'view', target], { stdio: 'ignore' });
  } catch {
    exists = false;
  }
  if (!exists) {
    const ok = await confirm({ question: `\nThe repository github.com/${target} doesn't exist yet. Create it as a PUBLIC repo? Type "create" to go ahead: `, word: 'create', yes, what: `create github.com/${target} as a public repo` });
    if (!ok) return console.log('Not created, not pushed.'), { clone, pushed: false };
    run('gh', ['repo', 'create', target, '--public', '--description', 'Echo: a voice assistant for your Mac, powered by Claude'], { stdio: 'inherit' });
  }
  const ok = await confirm({ question: `\nPush ${clone} (branch main and tag ${tag}) to github.com/${target}? This is public. Type "push" to go ahead: `, word: 'push', yes, what: `push to github.com/${target}` });
  if (!ok) return console.log('Not pushed.'), { clone, pushed: false };
  run('git', ['push', '-u', 'origin', 'main', '--follow-tags'], { cwd: clone, stdio: 'inherit' });
  console.log(`\nPushed. Next: npm run release:publish`);
  return { clone, pushed: true };
}

/** `npm run publish-repo` arguments. @param {string[]} argv */
export function parsePublishRepoArgs(argv) {
  const val = (flag) => (argv.includes(flag) && argv[argv.indexOf(flag) + 1] ? path.resolve(argv[argv.indexOf(flag) + 1]) : undefined);
  return { clone: val('--dir'), dataDir: val('--data-dir'), push: !argv.includes('--no-push'), yes: argv.includes('--yes') || argv.includes('-y') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(() => publishRepo(parsePublishRepoArgs(process.argv.slice(2))))
    .then(() => (closeInput(), process.exit(0)))
    .catch((e) => {
      console.error(`\n${e.message}`);
      process.exit(1);
    });
}
