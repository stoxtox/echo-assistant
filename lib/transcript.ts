// The conversation log: what was said and what Echo answered, word for word, with the time of
// each, so a session can be read back afterwards next to the timeline (`npm run transcript`).
//
// The timeline (lib/timeline.ts) never holds words; this file is where they go, and only this
// file. It stays on this Mac in <data>/transcript/YYYY-MM-DD.jsonl, is written only while the
// "Keep a conversation log" setting is on (keepTranscript), and old days are deleted.
//
// One JSON line per thing said:
//   {"ts": ISO ms, "who": "you"|"echo", "kind", "text", "trace"?, ...}
// kinds: you/said (delivered to Echo), you/typed, you/unanswered (heard, not delivered: `reason`),
//        echo/shown (a whole reply as the window showed it), echo/spoke (one line sent to the
//        voice: `id`), echo/step (a line said while working on the Mac).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './settings.js';

export type Line = { ts: string; who: 'you' | 'echo'; kind: 'said' | 'typed' | 'unanswered' | 'shown' | 'spoke' | 'step'; text: string; trace?: string; reason?: string; mode?: string; engine?: string; heard?: string; id?: string }

/** Days kept, and the longest one line's text may be. (An object, so a test can shrink them.) */
export const limits = { days: 30, maxText: 4000 };

export const transcriptDir = (dataDir: string = config.dataDir): string => path.join(dataDir, 'transcript');
const dayOf = (now: number): string => new Date(now).toLocaleDateString('en-CA', { timeZone: config.timezone });
let prunedDay = '';

/** Delete days older than limits.days. @returns how many files went */
export function prune(dataDir: string = config.dataDir, now: number = Date.now()): number {
  let gone = 0;
  try {
    const keepFrom = dayOf(now - limits.days * 86_400_000);
    for (const f of fs.readdirSync(transcriptDir(dataDir))) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < keepFrom) {
        fs.rmSync(path.join(transcriptDir(dataDir), f), { force: true });
        gone += 1;
      }
    }
  } catch {}
  return gone;
}

/**
 * Write one line. Never throws (a full disk must not break a turn), and writes nothing when the
 * setting is off or there are no words.
 */
export function said(who: Line['who'], kind: Line['kind'], text: unknown, extra: Partial<Omit<Line, 'ts' | 'who' | 'kind' | 'text'>> = {}, o: { now?: number; dataDir?: string; on?: boolean } = {}): void {
  try {
    const words = String(text ?? '').trim();
    if (!words) return;
    if (!(o.on ?? getSettings().keepTranscript !== false)) return;
    const now = o.now ?? Date.now();
    const dir = transcriptDir(o.dataDir);
    const day = dayOf(now);
    if (day !== prunedDay) {
      fs.mkdirSync(dir, { recursive: true });
      prune(o.dataDir, now);
      prunedDay = day;
    }
    const line: Line = { ts: new Date(now).toISOString(), who, kind, text: words.slice(0, limits.maxText) };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') (line as any)[k] = String(v).slice(0, 200);
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch {}
}

/** The lines between two moments, oldest first. */
export function readTranscript(dataDir: string = config.dataDir, since: number = 0, until: number = Date.now()): Line[] {
  const out: Line[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(transcriptDir(dataDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {}
  // A day's file holds that local day: one day either side of the range covers every time zone.
  const from = dayOf(since - 86_400_000);
  const to = dayOf(until + 86_400_000);
  for (const f of files) {
    if (f.slice(0, 10) < from || f.slice(0, 10) > to) continue;
    for (const l of fs.readFileSync(path.join(transcriptDir(dataDir), f), 'utf8').split('\n')) {
      if (!l) continue;
      try {
        const row = JSON.parse(l) as Line;
        const t = Date.parse(row.ts);
        if (t >= since && t <= until) out.push(row);
      } catch {}
    }
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/**
 * What goes to the window is what was said: one place sees every message the server sends the
 * page, and writes down the ones that carry words. `replyText` gives the whole reply at its end.
 */
export function fromBroadcast(msg: any, replyText: () => string): void {
  switch (msg?.type) {
    case 'heard':
      return said('you', msg.typed ? 'typed' : 'said', msg.text, { trace: msg.trace, engine: msg.engine, heard: msg.raw || undefined });
    case 'heard_fix':
      return said('you', 'said', msg.text, { trace: msg.trace, heard: msg.was, engine: 'whisper' });
    case 'speak':
      return said('echo', 'spoke', msg.text, { trace: msg.trace, id: msg.id });
    case 'say':
      return said('echo', 'step', msg.speak || msg.text, { trace: msg.trace, id: msg.id });
    case 'say_end':
      return said('echo', 'shown', replyText());
    default:
  }
}
