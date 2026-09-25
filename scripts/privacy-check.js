// Fails if a folder that's about to be shared contains personal data or secrets.
//
//   npm run privacy-check                 checks dist/Echo (what `npm run package` builds)
//   npm run privacy-check -- <folder>     checks another folder
//   options: --data-dir <dir>   where this install's personal data is (default: Echo's data folder)
//            --terms-file <f>   extra words to look for, one per line (default ~/.echo-private-terms)
//            --reveal           show matched personal words in full (the report hides them)
import path from 'node:path';
import fs from 'node:fs';
import { config, APP_DIR } from '../lib/config.js';
import { harvestTerms, scanFolder, formatFinding } from '../lib/privacy.js';
import { releaseRepo } from '../lib/release.js';

/** @param {string[]} argv */
export function parseArgs(argv) {
  const opts = { dir: path.join(APP_DIR, 'dist', 'Echo'), dataDir: config.dataDir, termsFile: undefined, reveal: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') opts.dataDir = path.resolve(argv[++i]);
    else if (a === '--terms-file') opts.termsFile = path.resolve(argv[++i]);
    else if (a === '--reveal') opts.reveal = true;
    else if (!a.startsWith('-')) opts.dir = path.resolve(a);
  }
  return opts;
}

/**
 * @param {{ dir: string, dataDir: string, termsFile?: string, reveal?: boolean }} opts
 * @returns {{ ok: boolean, findings: ReturnType<typeof scanFolder>, terms: number }}
 */
export function privacyCheck({ dir, dataDir, termsFile, reveal = false }) {
  if (!fs.existsSync(dir)) throw new Error(`Nothing to check at ${dir}. Run npm run package first.`);
  // The public repository's owner and name (echo-release.json) are meant to be public.
  const repo = releaseRepo(APP_DIR);
  const published = new Set([repo.owner, repo.repo].map((t) => t.toLowerCase()));
  const terms = harvestTerms({ dataDir, roots: config.roots, appDir: APP_DIR, termsFile }).filter((t) => !published.has(t.term.toLowerCase()));
  const findings = scanFolder(dir, { terms });
  console.log(`Privacy check of ${dir}: looked for secrets, personal files, home paths, phone numbers, emails and ${terms.length} personal word(s).`);
  if (findings.length) {
    console.log(`\nFAILED: ${findings.length} problem(s):`);
    for (const f of findings.slice(0, 200)) console.log('  ' + formatFinding(f, { reveal }));
  } else console.log('Passed: no personal data or secrets found.');
  return { ok: findings.length === 0, findings, terms: terms.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(privacyCheck(parseArgs(process.argv.slice(2))).ok ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
