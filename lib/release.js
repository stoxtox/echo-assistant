// Releases: versions, checksums, and where Echo's public GitHub repository is.
//
// The owner and repo are set in one place, echo-release.json at the top of the Echo folder
// (ECHO_REPO=owner/repo overrides it, e.g. for a local test server). `npm run release` stamps
// them into install-remote.sh, and the in-app updater reads them from here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { APP_DIR } from './config.js';

export const PLACEHOLDER_OWNER = 'YOUR-GITHUB-USERNAME';

/**
 * @param {string} [appDir]
 * @returns {{ owner: string, repo: string, publicClone: string, api: string, configured: boolean }}
 */
export function releaseRepo(appDir = APP_DIR) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(appDir, 'echo-release.json'), 'utf8'));
  } catch {}
  let owner = String(saved.owner || PLACEHOLDER_OWNER);
  let repo = String(saved.repo || 'echo');
  const env = process.env.ECHO_REPO;
  if (env && /^[\w.-]+\/[\w.-]+$/.test(env)) [owner, repo] = env.split('/');
  const clone = String(saved.publicClone || '~/EchoPublic');
  return {
    owner,
    repo,
    publicClone: clone.startsWith('~/') ? path.join(os.homedir(), clone.slice(2)) : path.resolve(appDir, clone),
    // The GitHub API, or a stand-in that answers the same way (tests, local simulation).
    api: (process.env.ECHO_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''),
    configured: owner !== PLACEHOLDER_OWNER,
  };
}

/* ---------- versions ---------- */

/** @returns {{ major: number, minor: number, patch: number, pre: string } | null} */
export function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' } : null;
}

/** Semver order: -1, 0 or 1. A pre-release sorts before its release (1.2.0-beta.2 < 1.2.0). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xp = x.pre.split('.');
  const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === undefined) return -1;
    if (yp[i] === undefined) return 1;
    const xn = /^\d+$/.test(xp[i]);
    const yn = /^\d+$/.test(yp[i]);
    if (xn && yn && +xp[i] !== +yp[i]) return +xp[i] < +yp[i] ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (xp[i] !== yp[i]) return xp[i] < yp[i] ? -1 : 1;
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;

/** @param {'patch' | 'minor' | 'major'} kind */
export function bumpVersion(v, kind = 'patch') {
  const p = parseVersion(v);
  if (!p) throw new Error(`Not a version: ${v}`);
  if (kind === 'major') return `${p.major + 1}.0.0`;
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`;
  if (kind === 'patch') return p.pre ? `${p.major}.${p.minor}.${p.patch}` : `${p.major}.${p.minor}.${p.patch + 1}`;
  throw new Error(`Say patch, minor or major (not "${kind}").`);
}

/* ---------- release files ---------- */

export const zipName = (version) => `Echo-${version}.zip`;
export const checksumName = (version) => `${zipName(version)}.sha256`;

/** SHA-256 of a file, as hex. */
export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** The checksum file's text, in `shasum -a 256` format so `shasum -c` can check it too. */
export const checksumLine = (hex, fileName) => `${hex}  ${fileName}\n`;

/** The hex digest from a checksum file ("<hex>  <name>" or just "<hex>"). */
export function parseChecksum(text, fileName) {
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^([a-f0-9]{64})(?:\s+\*?(.+))?$/i);
    if (m && (!fileName || !m[2] || m[2].trim() === fileName)) return m[1].toLowerCase();
  }
  return null;
}

/** Throws unless the file's SHA-256 matches. */
export function verifyChecksum(file, expectedHex) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedHex || ''))) throw new Error('The release has no valid checksum, so it was not installed.');
  const actual = sha256File(file);
  if (actual !== expectedHex.toLowerCase()) throw new Error(`The download is damaged or was changed (checksum ${actual.slice(0, 12)}… doesn't match ${expectedHex.slice(0, 12)}…), so it was not installed.`);
  return actual;
}

/* ---------- the changelog ---------- */

/** Notes for one version from CHANGELOG.md ("## [1.2.0] - 2026-09-25" up to the next "## "). */
export function changelogSection(text, version) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** Commit subjects worth telling users about (no merges, saves or release commits). */
export function releaseNotesFromCommits(subjects) {
  const seen = new Set();
  return subjects
    .map((s) => s.trim())
    .filter((s) => s && !/^(Merge\b|Save live edits|Release v?\d|Baseline\b|WIP\b)/i.test(s))
    .map((s) => s.replace(/^Self-improve #\d+:\s*/i, ''))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true)));
}

/**
 * Adds a version to CHANGELOG.md: the hand-written "## Unreleased" notes (if any) come first,
 * then the commit list. The Unreleased heading stays, empty, for next time.
 */
export function addChangelogEntry(text, version, { date = new Date().toISOString().slice(0, 10), commits = [] } = {}) {
  const header = '# Changelog\n\nAll notable changes to Echo. Write notes for the next release under "Unreleased"; `npm run release` moves them under the new version.\n';
  let body = String(text || '').trim() ? String(text) : header;
  if (!/^## Unreleased/m.test(body)) body = body.replace(/(\n## |\s*$)/, '\n\n## Unreleased\n$1');
  const unreleased = changelogSection(body, 'Unreleased').replace(/^## \[?Unreleased\]?.*$/m, '').trim();
  const items = releaseNotesFromCommits(commits).map((c) => `- ${c}`);
  const notes = [unreleased, items.length ? (unreleased ? `### All changes\n\n${items.join('\n')}` : items.join('\n')) : ''].filter(Boolean).join('\n\n') || '- Maintenance and small fixes.';
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^## \[?Unreleased\]?/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  const before = lines.slice(0, start + 1);
  const after = end < 0 ? [] : lines.slice(end);
  return [...before, '', `## [${version}] - ${date}`, '', notes, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* ---------- the gh command line tool ---------- */

/** Is GitHub's `gh` installed and signed in? Never prints or reads the token. */
export function ghStatus() {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
  } catch {
    return { installed: false, authed: false, help: ['Install the GitHub command line tool:  brew install gh', 'Then sign in:  gh auth login   (pick GitHub.com, HTTPS, and "Login with a web browser")'] };
  }
  try {
    execFileSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' });
    return { installed: true, authed: true, help: [] };
  } catch {
    return { installed: true, authed: false, help: ['Sign in to GitHub:  gh auth login   (pick GitHub.com, HTTPS, and "Login with a web browser")'] };
  }
}
