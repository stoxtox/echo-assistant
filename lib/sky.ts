// The Sky: every day you talk with Echo becomes a constellation. Each star is one thing you said
// or typed; it sits further right the later it was, and higher the more Echo had to say back.
// Stars where Echo did something for you are bigger, and the main ones are joined in the order
// they happened, so a day can be traced, and played as a tune (its height is its pitch).
//
// Built from the timeline (lib/timeline.ts), which holds times and counts and never words. A
// finished day is kept as numbers in data/sky/<day>.json, so the sky outlives the timeline's two
// weeks. What you said at a star is looked up in the conversation log when the window asks, and
// only there (lib/server/routes.js GET /api/sky).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { when, type Row } from './timeline.ts';

export type Star = { t: number; x: number; y: number; size: number; kind: 'said' | 'typed'; acted: boolean; tools: number; chars: number; main: boolean; trace: string };
export type Night = {
  day: string;
  label: string;
  name: string;
  why: string;
  stars: Star[];
  /** Pairs of star indexes joined by a line, in the order the day went. */
  links: Array<[number, number]>;
  /** The tune's home note (MIDI) and whether it is in a minor mood. */
  root: number;
  minor: boolean;
  stats: { stars: number; said: number; typed: number; acted: number; late: number };
};
type Turn = { t: number; trace: string; kind: 'said' | 'typed'; chars: number; tools: number; acted: boolean };

/** A day in the sky runs from 5 in the morning to 5 the next: a late night belongs to the day it began in. */
export const DAY_STARTS_HOUR = 5;
/** Stars closer in time than this are one conversation: their main stars are joined. */
export const SAME_TALK_MS = 6 * 60 * 1000;
/** At most this many stars of a day are joined and played. */
export const MAX_MAIN = 36;
export const skyDir = (dataDir: string = config.dataDir): string => path.join(dataDir, 'sky');

const parts = (ms: number, tz: string): { day: string; hour: number } => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};
/** Which day of the sky a moment belongs to. */
export const skyDay = (ms: number, tz: string = config.timezone): string => parts(ms - DAY_STARTS_HOUR * 3_600_000, tz).day;
const hourOf = (ms: number, tz: string): number => parts(ms, tz).hour;

/** A small repeatable random source, so a day always draws the same sky. */
export function seeded(text: string): () => number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The user's turns in these rows: when, spoken or typed, how much Echo answered, and whether it acted. */
export function turnsOf(rows: Row[]): Turn[] {
  const by = new Map<string, Turn & { started: boolean }>();
  for (const r of rows) {
    if (!r.trace) continue;
    let t = by.get(r.trace);
    if (!t) by.set(r.trace, (t = { t: when(r), trace: r.trace, kind: 'said', chars: 0, tools: 0, acted: false, started: false }));
    if (r.type === 'turn.start' && (r.f.source === 'speech' || r.f.source === 'typed')) {
      t.started = true;
      t.t = when(r);
      t.kind = r.f.source === 'typed' ? 'typed' : 'said';
    } else if (r.type === 'turn.end') t.chars = Math.max(t.chars, Number(r.f.textChars) || Number(r.f.spokenChars) || 0);
    else if (r.type === 'turn.tool_start') t.tools++;
    else if (r.type === 'mac.action' && r.f.ok !== false) t.acted = true;
  }
  return [...by.values()].filter((t) => t.started).map(({ started: _s, ...t }) => t).sort((a, b) => a.t - b.t);
}

const NAMES = ['The Wanderer', 'The Lantern', 'The Kite', 'The Harbour', 'The Bridge', 'The Garden', 'The Compass', 'The Lighthouse', 'The Orchard', 'The Ferry'];

/** What a day is called, and the line under it that says why. */
export function nameOf(turns: Turn[], day: string, tz: string = config.timezone): { name: string; why: string } {
  const n = turns.length, share = (k: number): number => (n ? k / n : 0);
  const late = turns.filter((t) => hourOf(t.t, tz) < DAY_STARTS_HOUR).length;
  const early = turns.filter((t) => hourOf(t.t, tz) >= DAY_STARTS_HOUR && hourOf(t.t, tz) < 10).length;
  const acted = turns.filter((t) => t.acted).length, typed = turns.filter((t) => t.kind === 'typed').length;
  const gaps = turns.slice(1).map((t, i) => t.t - (turns[i] as Turn).t).sort((a, b) => a - b);
  const mid = gaps.length ? (gaps[Math.floor(gaps.length / 2)] as number) : Infinity;
  if (n <= 3) return { name: 'The Quiet One', why: n === 1 ? 'one star, all by itself' : `only ${n} stars` };
  if (share(late) >= 0.5) return { name: 'The Night Owl', why: 'most of it after midnight' };
  if (share(acted) >= 0.4) return { name: 'The Maker', why: "Echo's hands were busy" };
  if (share(typed) >= 0.6) return { name: 'The Whisper', why: 'more typed than spoken' };
  if (n >= 20 && mid < 15_000) return { name: 'The Rally', why: 'quick, back and forth' };
  if (n >= 100) return { name: 'The Long Talk', why: 'a full day of it' };
  if (share(early) >= 0.5) return { name: 'The Early Bird', why: 'most of it before ten' };
  return { name: NAMES[Math.floor(seeded(day)() * NAMES.length)] as string, why: `${n} stars` };
}

/** One day's constellation from its turns. */
export function buildNight(day: string, turns: Turn[], tz: string = config.timezone): Night {
  const rnd = seeded(day), n = turns.length;
  // Across: in the order they happened, with a wider step after a longer silence (never to scale:
  // a night's sleep would squash everything else into a corner).
  const steps = turns.map((t, i) => (i ? 0.7 + Math.min(3.6, Math.log2(1 + (t.t - (turns[i - 1] as Turn).t) / 60_000)) : 0));
  const total = steps.reduce((a, b) => a + b, 0) || 1;
  let across = 0;
  // Up: the more Echo answered, the higher (half by the amount itself, half by its rank that day,
  // so a day of short answers still has a shape), with a little wander.
  const ranked = [...turns].sort((a, b) => a.chars - b.chars);
  const rank = new Map(ranked.map((t, i) => [t.trace, n > 1 ? i / (n - 1) : 0.5]));
  const stars: Star[] = turns.map((t, i) => {
    across += steps[i] as number;
    const amount = Math.min(1, Math.log10(1 + t.chars) / Math.log10(1 + 1500));
    const h = 0.5 * amount + 0.5 * (rank.get(t.trace) as number);
    return {
      t: t.t,
      x: n > 1 ? 0.05 + 0.9 * (across / total) : 0.5,
      y: Math.min(0.93, Math.max(0.07, 0.86 - 0.72 * h + (rnd() - 0.5) * 0.12)),
      size: Math.round((1 + Math.min(2.4, t.tools * 0.5) + (t.acted ? 0.8 : 0)) * 100) / 100,
      kind: t.kind,
      acted: t.acted,
      tools: t.tools,
      chars: t.chars,
      main: false,
      trace: t.trace,
    };
  });
  // The main stars: where Echo did something, and the longest answers; all of them on a small day.
  const want = Math.min(MAX_MAIN, n <= 9 ? n : Math.max(7, Math.round(n * 0.34)));
  const order = stars.map((s, i) => ({ i, score: s.size * 2 + (rank.get(s.trace) as number) + (i === 0 || i === n - 1 ? 3 : 0) })).sort((a, b) => b.score - a.score);
  for (const o of order.slice(0, want)) (stars[o.i] as Star).main = true;
  const mains = stars.map((s, i) => (s.main ? i : -1)).filter((i) => i >= 0);
  const links: Array<[number, number]> = [];
  for (let k = 1; k < mains.length; k++) {
    const a = mains[k - 1] as number, b = mains[k] as number;
    if ((stars[b] as Star).t - (stars[a] as Star).t <= SAME_TALK_MS * 3) links.push([a, b]);
  }
  const { name, why } = nameOf(turns, day, tz);
  const late = turns.filter((t) => hourOf(t.t, tz) < DAY_STARTS_HOUR).length;
  const noon = Date.parse(`${day}T12:00:00Z`);
  return {
    day,
    label: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(noon),
    name,
    why,
    stars,
    links,
    root: [57, 59, 60, 62, 64, 55][Math.floor(rnd() * 6)] as number,
    minor: name === 'The Night Owl' || name === 'The Whisper' || rnd() < 0.25,
    stats: { stars: n, said: turns.filter((t) => t.kind === 'said').length, typed: turns.filter((t) => t.kind === 'typed').length, acted: turns.filter((t) => t.acted).length, late },
  };
}

/** The nights in these rows, oldest first; days with nothing said are left out. */
export function buildSky(rows: Row[], tz: string = config.timezone): Night[] {
  const days = new Map<string, Turn[]>();
  for (const t of turnsOf(rows)) {
    const d = skyDay(t.t, tz);
    days.set(d, [...(days.get(d) || []), t]);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, turns]) => buildNight(d, turns, tz));
}

const DAY_OK = /^\d{4}-\d{2}-\d{2}$/;

/** The nights kept from earlier (numbers only), oldest first. */
export function keptNights(dataDir: string = config.dataDir): Night[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(skyDir(dataDir)).filter((f) => f.endsWith('.json') && DAY_OK.test(f.slice(0, -5))).sort();
  } catch {}
  const out: Night[] = [];
  for (const f of names) {
    try {
      const n = JSON.parse(fs.readFileSync(path.join(skyDir(dataDir), f), 'utf8'));
      if (n && n.day === f.slice(0, -5) && Array.isArray(n.stars)) out.push(n);
    } catch {}
  }
  return out;
}

/**
 * The whole sky: the nights kept from before, and those the timeline still holds (which win, and
 * are kept once their day is over). At most `max` nights, the latest ones, oldest first.
 */
export function sky(rows: Row[], o: { dataDir?: string; now?: number; tz?: string; max?: number } = {}): Night[] {
  const dataDir = o.dataDir ?? config.dataDir, tz = o.tz ?? config.timezone, today = skyDay(o.now ?? Date.now(), tz);
  const fresh = buildSky(rows, tz), have = new Map(keptNights(dataDir).map((n) => [n.day, n]));
  // The oldest day the timeline still holds may be cut off at its start: an earlier, fuller copy stands.
  const oldest = fresh[0]?.day;
  for (const n of fresh) {
    const kept = have.get(n.day);
    if (kept && n.day === oldest && kept.stars.length > n.stars.length) continue;
    have.set(n.day, n);
    if (n.day < today) {
      try {
        fs.mkdirSync(skyDir(dataDir), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(skyDir(dataDir), `${n.day}.json`), JSON.stringify(n), { mode: 0o600 });
      } catch {}
    }
  }
  return [...have.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-(o.max ?? 60));
}
