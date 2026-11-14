// Debug aid for hands-free drops: the first few words of speech Echo decided wasn't for her
// (`not_for_echo`), so a wrong drop can be explained later. Off by default (the
// `debugDroppedWords` setting), because it writes down what people near the mic said. Kept in
// its own file (data/dropped-words.jsonl) and nothing older than a week is kept.
import fs from 'node:fs';
import path from 'node:path';

export const DROPPED_WORDS_FILE = 'dropped-words.jsonl';
export const DROPPED_WORDS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_WORDS = 5;

/** The first few words of a sentence, each cut short, so a long one is never kept whole. */
export function firstWords(text, n = FIRST_WORDS) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, n).map((w) => w.slice(0, 24)).join(' ') + (words.length > n ? ' …' : '');
}

/**
 * Drops entries older than a week (and unreadable lines). Deletes the file when nothing is left.
 * Never throws.
 * @param {string} dataDir
 * @param {number} [now]
 */
export function pruneDroppedWords(dataDir, now = Date.now()) {
  const file = path.join(dataDir, DROPPED_WORDS_FILE);
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }
  const keep = lines.filter((l) => {
    try {
      return now - Date.parse(JSON.parse(l).at) < DROPPED_WORDS_MAX_AGE_MS;
    } catch {
      return false;
    }
  });
  if (keep.length === lines.length) return;
  try {
    if (keep.length) fs.writeFileSync(file, keep.join('\n') + '\n');
    else fs.rmSync(file, { force: true });
  } catch {}
}

/**
 * Notes a `not_for_echo` drop's first words, if the debug setting is on. Never throws.
 * @param {{ dataDir: string, enabled: boolean, text: string, meta?: object, now?: number }} o
 */
export function logDroppedWords({ dataDir, enabled, text, meta = {}, now = Date.now() }) {
  if (!enabled) return false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(path.join(dataDir, DROPPED_WORDS_FILE), JSON.stringify({ at: new Date(now).toISOString(), ...meta, firstWords: firstWords(text) }) + '\n');
    pruneDroppedWords(dataDir, now);
    return true;
  } catch {
    return false;
  }
}
