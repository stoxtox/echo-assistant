// Builds a clean, shareable copy of Echo: only the product, never anyone's personal data.
//
//   npm run package                  -> dist/Echo/ and dist/Echo.zip, then the privacy check
//   options: --out <dir>  (default dist)   --no-zip   --data-dir <dir>   --terms-file <f>
//
// What goes in is an allow-list (below). The privacy check (lib/privacy.js) then scans the copy
// for personal files, secrets, home paths, phone numbers, emails and this install's personal
// words; if it finds anything, no zip is made and the command fails.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_DIR, config } from '../lib/config.js';
import { privacyCheck } from './privacy-check.js';
import { releaseRepo } from '../lib/release.js';

/** install-remote.sh with this repository's owner and repo filled in (from echo-release.json). */
export function stampInstaller(text, { owner, repo }) {
  return text
    .replace(/^ECHO_REPO="\$\{ECHO_REPO:-[^}]*\}"/m, `ECHO_REPO="\${ECHO_REPO:-${owner}/${repo}}"`)
    .replace(/raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/main\/install-remote\.sh/, `raw.githubusercontent.com/${owner}/${repo}/main/install-remote.sh`);
}

/** The public README with the repository filled in. */
export const stampReadme = (text, { owner, repo }) => text.replaceAll('YOUR-GITHUB-USERNAME/echo', `${owner}/${repo}`);

/** Top-level files and folders that make up the product. Everything else stays home. */
export const INCLUDE = [
  'lib/', 'public/', 'scripts/', 'test/', 'docs/', 'macos/',
  'server.js', 'supervisor.js', 'package.json', 'package-lock.json', 'jsconfig.json',
  'README.md', 'PUBLIC_README.md', 'GETTING_STARTED.md', 'SELF_IMPROVE.md', 'CHANGELOG.md', '.env.example', '.gitignore',
  'install.command', 'start.command', 'install-remote.sh', 'echo-release.json',
];
/** Never copied, even inside an included folder. */
const EXCLUDE = /(^|\/)(\.DS_Store|\.env(\.(?!example$)[^/]*)?|node_modules|\.git|HANDOFF\.md|[^/]*\.log)(\/|$)/;

/** The product's files, relative to the app folder: git's view if there is one (so ignored files never ship). */
export function productFiles(appDir = APP_DIR) {
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0')
      .filter(Boolean);
  } catch {
    const walk = (rel) =>
      fs.readdirSync(path.join(appDir, rel), { withFileTypes: true }).flatMap((d) => {
        const r = rel ? `${rel}/${d.name}` : d.name;
        return d.isDirectory() ? (EXCLUDE.test(r) ? [] : walk(r)) : [r];
      });
    files = walk('');
  }
  return files
    .filter((f) => INCLUDE.some((inc) => (inc.endsWith('/') ? f.startsWith(inc) : f === inc)))
    .filter((f) => !EXCLUDE.test(f) && fs.existsSync(path.join(appDir, f)))
    .sort();
}

/** @param {{ out?: string, zip?: boolean, dataDir?: string, termsFile?: string, appDir?: string, zipName?: string }} [opts] */
export function buildPackage({ out = path.join(APP_DIR, 'dist'), zip = true, dataDir = config.dataDir, termsFile, appDir = APP_DIR, zipName = 'Echo.zip' } = {}) {
  const dest = path.join(out, 'Echo');
  const zipFile = path.join(out, zipName);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(zipFile, { force: true });
  const files = productFiles(appDir);
  for (const f of files) {
    const target = path.join(dest, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(appDir, f), target);
    fs.chmodSync(target, fs.statSync(path.join(appDir, f)).mode & 0o777);
  }
  // The public README is the package's front page; the full reference moves to docs/.
  const repo = releaseRepo(appDir);
  if (fs.existsSync(path.join(dest, 'PUBLIC_README.md'))) {
    if (fs.existsSync(path.join(dest, 'README.md'))) fs.renameSync(path.join(dest, 'README.md'), path.join(dest, 'docs', 'REFERENCE.md'));
    fs.writeFileSync(path.join(dest, 'README.md'), stampReadme(fs.readFileSync(path.join(dest, 'PUBLIC_README.md'), 'utf8'), repo));
    fs.rmSync(path.join(dest, 'PUBLIC_README.md'));
  }
  const remote = path.join(dest, 'install-remote.sh');
  if (fs.existsSync(remote)) fs.writeFileSync(remote, stampInstaller(fs.readFileSync(remote, 'utf8'), repo));
  const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  // Marks a shared install: its projects default to ~/Echo Projects (lib/config.js).
  fs.writeFileSync(path.join(dest, '.echo-package'), JSON.stringify({ name: 'Echo', version: pkg.version, builtAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
  console.log(`Copied ${files.length} files to ${dest}`);

  const check = privacyCheck({ dir: dest, dataDir, termsFile });
  if (!check.ok) return { ok: false, dest, zipFile: null, files, findings: check.findings };
  if (zip) {
    try {
      execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', dest, zipFile]);
    } catch {
      execFileSync('zip', ['-qry', zipFile, 'Echo'], { cwd: out });
    }
    console.log(`Made ${zipFile} (${(fs.statSync(zipFile).size / 1024).toFixed(0)} KB). Share that file.`);
  }
  return { ok: true, dest, zipFile: zip ? zipFile : null, files, findings: [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const val = (flag) => (argv.includes(flag) ? path.resolve(argv[argv.indexOf(flag) + 1]) : undefined);
  const r = buildPackage({ out: val('--out'), zip: !argv.includes('--no-zip'), dataDir: val('--data-dir'), termsFile: val('--terms-file') });
  if (!r.ok) console.error('\nNot packaged: fix the problems above (or remove those files), then run npm run package again.');
  process.exit(r.ok ? 0 : 1);
}
