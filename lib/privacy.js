// The personal-data check for shareable packages (`npm run package`, `npm run privacy-check`).
//
// It fails if a folder contains:
//   - personal files: data/, logs/, models/, .env, the PIN, memory, transcripts, vocabulary,
//     contacts favorites, costs, tasks, audit logs, research output, .git…
//   - secrets: API keys, tokens, private keys
//   - hard-coded home folders (/Users/<someone>), real-looking phone numbers and email addresses
//   - personal words: the Mac's user and full name, the git author, and what this install has
//     learned (your name, contacts favorites, vocabulary, project folder names…). These are read
//     at check time from the data folder, so the check itself never contains anything personal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isEnglishWord } from './vocab.js';

/** Files and folders that are personal wherever they appear. */
const PERSONAL_NAMES = new Set([
  '.env', 'pin.json', 'memory.md', 'contact-aliases.json', 'vocabulary.json', 'costs.json', 'stt-log.jsonl',
  'tasks.json', 'state.json', 'quick-actions.log', 'audit.log', 'pending-restart.json', 'rollback-notice.json',
  'pending-request.json', 'settings.local.json', 'HANDOFF.md', '.echo-port', '.echo-node',
  'conversations', '_research', '.voiceops-worktrees', 'attachments', '.claude',
]);
/** Folders that must never ship at the top level. */
const PERSONAL_ROOT_DIRS = new Set(['data', 'logs', 'models', 'node_modules', '.git', 'dist', '.echo-update']);

/** Product words that are fine even if the owner also uses them (they're in the vocabulary, say). */
const PRODUCT_TERMS = new Set(
  [
    'Echo', 'Claude', 'Claude Code', 'VoiceOps', 'Kokoro', 'Whisper', 'Deepgram', 'ElevenLabs', 'Anthropic', 'localhost',
    'Next.js', 'Vercel', 'Firebase', 'Supabase', 'Netlify', 'GitHub', 'Chrome', 'Safari', 'Spotify', 'Excel', 'Numbers',
    'iMessage', 'FaceTime', 'macOS', 'Homebrew', 'Node.js', 'self-improve', 'Hands-free', 'Echo Projects',
  ].map((t) => t.toLowerCase())
);

/** Placeholder home folders used in docs and tests. */
const PLACEHOLDER_USERS = new Set(['me', 'you', 'name', 'user', 'username', 'yourname', 'your-name', 'shared', 'example', 'someone', 'uncle', 'alex', 'sam']);
const SAFE_EMAIL_DOMAINS = /@(example\.(com|org|net)|anthropic\.com|users\.noreply\.github\.com)$/i;

/** @type {Array<[RegExp, string]>} */
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{12,}/, 'Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{32,}/, 'API secret key'],
  [/\b(ELEVENLABS|DEEPGRAM|ANTHROPIC|OPENAI)_API_KEY\s*=\s*['"]?[A-Za-z0-9_-]{12,}/, 'API key value'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|password)\b\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{20,}['"]/i, 'hard-coded secret'],
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Personal words to look for, gathered from this Mac and this install. Nothing is hard-coded.
 * @param {{ dataDir?: string, roots?: string[], appDir?: string, extra?: string[], termsFile?: string }} [opts]
 * @returns {Array<{ term: string, exact: boolean }>} exact: match case-sensitively (learned words and
 *   project names like "PriceWatch" shouldn't flag the everyday word "pricewatch")
 */
export function harvestTerms({ dataDir, roots = [], appDir, extra = [], termsFile } = {}) {
  const names = new Set(); // people's names: kept even when they're also English words
  const words = new Set(); // learned words: skipped when they're ordinary English
  const add = (set, v) => {
    const t = String(v || '').trim();
    if (t) set.add(t);
  };
  try {
    const u = os.userInfo();
    add(names, u.username);
    add(names, u.homedir);
  } catch {}
  try {
    const full = execFileSync('id', ['-F'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    add(names, full);
    for (const part of full.split(/\s+/)) add(names, part);
  } catch {}
  for (const key of ['user.name', 'user.email']) {
    try {
      const v = execFileSync('git', ['config', key], { cwd: appDir || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      add(names, v);
      if (key === 'user.name') for (const part of v.split(/\s+/)) add(names, part);
    } catch {}
  }
  if (dataDir) {
    const settings = readJson(path.join(dataDir, 'settings.json'));
    add(names, settings?.userName);
    if (settings?.userName) for (const part of String(settings.userName).split(/\s+/)) add(names, part);
    const favorites = readJson(path.join(dataDir, 'contact-aliases.json'));
    for (const [alias, f] of Object.entries(favorites?.aliases || favorites || {})) {
      add(names, alias);
      add(names, /** @type {any} */ (f)?.name);
    }
    const vocab = readJson(path.join(dataDir, 'vocabulary.json'));
    for (const w of vocab?.words || []) add(words, w);
    for (const [heard, meant] of Object.entries(vocab?.corrections || {})) {
      add(words, heard);
      add(words, meant);
    }
    const store = readJson(path.join(dataDir, 'projects.json'));
    for (const [alias, project] of Object.entries(store?.aliases || {})) {
      add(words, alias);
      add(words, project);
    }
  }
  for (const root of roots) {
    try {
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && !/^[._]/.test(d.name) && (!appDir || path.join(root, d.name) !== appDir)) add(words, d.name);
      }
    } catch {}
  }
  const file = termsFile || path.join(os.homedir(), '.echo-private-terms');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim() && !line.startsWith('#')) add(names, line);
  } catch {}
  for (const t of [...extra, ...String(process.env.ECHO_PRIVATE_TERMS || '').split(',')]) add(names, t);

  const ordinary = (t) => t.split(/[\s-]+/).every((w) => /^\d+$/.test(w) || isEnglishWord(w));
  const keep = (t, isName) => {
    if (t.length < 4 || PRODUCT_TERMS.has(t.toLowerCase())) return false;
    if (/^[\d\s:.,-]+$/.test(t)) return false; // times and numbers ("8:30")
    return isName || !ordinary(t);
  };
  /** @type {Map<string, boolean>} */
  const out = new Map();
  for (const t of words) if (keep(t, false)) out.set(t, true);
  for (const t of names) if (keep(t, true)) out.set(t, false); // names win: any case
  return [...out].map(([term, exact]) => ({ term, exact })).sort((a, b) => b.term.length - a.term.length);
}

/** Every file under a folder (relative paths), including dotfiles. */
function walk(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, d.name);
    if (d.isDirectory()) out.push(r + '/', ...walk(dir, r));
    else out.push(r);
  }
  return out;
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);

/**
 * Scan a folder that is about to be shared.
 * @param {string} dir
 * @param {{ terms?: Array<string | { term: string, exact?: boolean }> }} [opts] plain strings match in any case
 * @returns {Array<{ file: string, line?: number, kind: string, detail: string }>}
 */
export function scanFolder(dir, { terms = [] } = {}) {
  /** @type {Array<{ file: string, line?: number, kind: string, detail: string }>} */
  const findings = [];
  const termRes = terms.map((x) => {
    const { term, exact = false } = typeof x === 'string' ? { term: x } : x;
    return { t: term, re: new RegExp(`(^|[^\\p{L}\\p{N}_])${esc(term)}(?=$|[^\\p{L}\\p{N}_])`, exact ? 'u' : 'iu') };
  });
  for (const rel of walk(dir)) {
    const parts = rel.replace(/\/$/, '').split('/');
    const base = parts[parts.length - 1];
    if (PERSONAL_ROOT_DIRS.has(parts[0]) && parts.length === 1) findings.push({ file: rel, kind: 'personal folder', detail: `${parts[0]}/ must not ship` });
    if (PERSONAL_NAMES.has(base) || /^\.env(\.(?!example$).+)?$/.test(base) || /\.log$/.test(base)) findings.push({ file: rel, kind: 'personal file', detail: `${base} holds personal data` });
    if (rel.endsWith('/')) continue;
    for (const { t, re } of termRes) if (re.test(rel)) findings.push({ file: rel, kind: 'personal word in a file name', detail: t });
    const buf = fs.readFileSync(path.join(dir, rel));
    if (isBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      const at = { file: rel, line: i + 1 };
      for (const [re, what] of SECRET_PATTERNS) if (re.test(line)) findings.push({ ...at, kind: 'secret', detail: what });
      for (const m of line.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
        if (!PLACEHOLDER_USERS.has(m[1].toLowerCase()) && !/^[.$<]/.test(m[1])) findings.push({ ...at, kind: 'home folder path', detail: m[0] });
      }
      for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
        // npm package specs like "@types/node@1.2" aren't emails.
        if (!SAFE_EMAIL_DOMAINS.test(m[0]) && !/^\d/.test(m[0].split('@')[1])) findings.push({ ...at, kind: 'email address', detail: m[0] });
      }
      for (const m of line.matchAll(/(?<![\w.-])(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-](\d{3})[\s.-](\d{4})(?![\w-])/g)) {
        if (m[1] !== '555' && m[2] !== '555') findings.push({ ...at, kind: 'phone number', detail: m[0].trim() });
      }
      for (const { t, re } of termRes) if (re.test(line)) findings.push({ ...at, kind: 'personal word', detail: t });
    });
  }
  return findings;
}

/** A finding as one line, with personal words shown only by length (the report may be shared too). */
export function formatFinding(f, { reveal = false } = {}) {
  const detail = f.kind.startsWith('personal word') && !reveal ? `"${f.detail[0]}${'•'.repeat(Math.max(0, f.detail.length - 1))}"` : f.detail;
  return `${f.file}${f.line ? `:${f.line}` : ''}  ${f.kind}: ${detail}`;
}
