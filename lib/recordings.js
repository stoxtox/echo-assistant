// Echo's own record of your voice, for measuring how well it listens (scripts/listen-review.js,
// scripts/listen-report.js). Every clip that reaches the server is kept on this Mac with an id,
// whatever happened to it: what got through, what was set aside as not for Echo, what came back
// blank. Every line the server writes about that clip in data/stt-log.jsonl carries the id as
// `rec`, so a recording can be followed to its fate. Nothing here is ever sent anywhere.
//
// Settings → Privacy & safety → "Keep voice recordings on this Mac" (`keepRecordings`): on by
// default only in the developer copy. Kept for 30 days, at most 3,000 clips (about 500 MB).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

export const RECORDINGS_DAYS = 30;
export const RECORDINGS_MAX = 3000;

/** Where the clips are: data/listening/clips/<id>.wav. */
export function recordingsDir(dataDir = config.dataDir) {
  return path.join(dataDir, 'listening', 'clips');
}

/** Your labels (scripts/listen-review.js): data/listening/labels.json. */
export function labelsFile(dataDir = config.dataDir) {
  return path.join(dataDir, 'listening', 'labels.json');
}

/**
 * Is recording on? The setting when you chose one; otherwise on in the developer copy only.
 * @param {boolean | null | undefined} setting @param {boolean} devCopy
 */
export function recordingsOn(setting, devCopy) {
  return setting === null || setting === undefined ? Boolean(devCopy) : Boolean(setting);
}

/** A clip id that sorts by time: 2026-10-02T03-14-15-123Z-a1b2. */
export function recordingId(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
}

let savedSincePrune = 0;

/**
 * Keep a clip. Returns its id, or '' when recording is off or the clip couldn't be written (a
 * recording must never get in the way of hearing you).
 * @param {Buffer} wav
 * @param {{ enabled: boolean, dir?: string, now?: Date, pruneEvery?: number }} opts
 */
export function keepRecording(wav, { enabled, dir = recordingsDir(), now = new Date(), pruneEvery = 50 }) {
  if (!enabled || !wav?.length) return '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const id = recordingId(now);
    fs.writeFileSync(path.join(dir, `${id}.wav`), wav);
    if (++savedSincePrune >= pruneEvery) {
      savedSincePrune = 0;
      pruneRecordings({ dir, now });
    }
    return id;
  } catch {
    return '';
  }
}

/**
 * Drop clips older than `days`, then the oldest beyond `max`. Labels for them stay (they're tiny
 * and already counted). Returns how many were removed.
 * @param {{ dir?: string, now?: Date, days?: number, max?: number }} [opts]
 */
export function pruneRecordings({ dir = recordingsDir(), now = new Date(), days = RECORDINGS_DAYS, max = RECORDINGS_MAX } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  } catch {
    return 0;
  }
  const cutoff = recordingId(new Date(now.getTime() - days * 86400000)).slice(0, 24);
  const old = files.filter((f) => f.slice(0, 24) < cutoff);
  const rest = files.filter((f) => f.slice(0, 24) >= cutoff);
  const drop = [...old, ...rest.slice(0, Math.max(0, rest.length - max))];
  for (const f of drop) fs.rmSync(path.join(dir, f), { force: true });
  return drop.length;
}

/* ---------- what happened to a recording (from its stt-log lines) ---------- */

/** stt-log events that mean the sentence was set aside as not meant for Echo. */
const SET_ASIDE = ['run_ignored', 'not_for_echo'];
/** ...that it reached Echo without the usual entry (instant commands, a held instruction). */
const REACHED = ['run_stop', 'run_pause', 'run_end', 'local', 'run_held'];
/** ...that it produced no text at all. */
const NO_TEXT = ['blank_final', 'no_speech_final', 'invented_final', 'low_confidence_final', 'no_text'];

/**
 * @typedef {{ at?: string, mode: string, fate: string, heard: string, raw?: string, whisper?: string, live?: string,
 *   source?: string, why?: string, confidence?: number, sttMs?: number, fixMs?: number }} Fate
 */

/**
 * One recording's fate from all the stt-log lines that carry its id: `reached` (Echo got it),
 * `set_aside` (judged not for Echo), `no_text` (nothing usable was transcribed), `own_voice`,
 * `heard_twice`, `wake_only`; with what Echo heard and why.
 * @param {any[]} lines this recording's stt-log lines, oldest first
 * @returns {Fate}
 */
export function recordingFate(lines) {
  const ev = (names) => lines.find((l) => names.includes(l.event));
  const main = lines.find((l) => !l.event && l.raw !== undefined);
  const base = { at: lines[0]?.at, mode: main?.audio?.mode || lines.find((l) => l.mode)?.mode || lines.find((l) => l.page?.mode)?.page?.mode || '' };
  const liveUsed = lines.find((l) => /_final$/.test(l.event || '') && l.used === 'live');
  const sttMs = main?.sttMs ?? lines.find((l) => Number.isFinite(l.sttMs))?.sttMs;
  if (main) {
    return { ...base, fate: 'reached', heard: main.text, raw: main.raw, whisper: main.stages?.whisper ?? '', live: main.stages?.live ?? '', source: main.stages?.source || (liveUsed ? 'live' : 'final'), sttMs, fixMs: main.fixMs };
  }
  const r = ev(REACHED);
  if (r) return { ...base, fate: 'reached', heard: r.text || '', why: r.event, sttMs };
  const a = ev(SET_ASIDE);
  if (a) return { ...base, fate: 'set_aside', heard: a.text || '', why: a.why || a.event, confidence: a.confidence, sttMs };
  for (const name of ['own_voice', 'heard_twice', 'wake_only']) {
    const e = ev([name]);
    if (e) return { ...base, fate: name, heard: e.text || '', sttMs };
  }
  const n = ev(NO_TEXT);
  if (n) return { ...base, fate: 'no_text', heard: '', live: n.live || '', why: n.cause || n.event, sttMs };
  return { ...base, fate: 'unknown', heard: '' };
}

/* ---------- words heard right ---------- */

/** Words for comparing: lower case, no punctuation, "I'll" stays one word. */
export function words(s) {
  return String(s || '').toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}']+/gu) || [];
}

/**
 * Word errors between what was said and what was heard: substitutions, insertions and deletions
 * (word-level edit distance), and how many words were said. Word error rate = errors / said.
 * @param {string} said @param {string} heard
 */
export function wordErrors(said, heard) {
  const a = words(said), b = words(heard);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return { errors: prev[b.length], said: a.length };
}
