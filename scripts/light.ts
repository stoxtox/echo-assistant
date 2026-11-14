#!/usr/bin/env node
// Reads back what Echo's light did: every trip out from the pearl, each thing it showed, when it
// went home (and whether Echo was still in the middle of a job, so it had to come all the way
// out again), and how far each step's words were from the light landing. The words themselves
// come from the conversation log, when that is kept.
//
//   npm run light -- --since 30m          the last half hour (30s, 10m, 2h, 1d)
//   npm run light -- --json               the numbers only
//   npm run light -- --data DIR           another data folder
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { readTranscript, type Line } from '../lib/transcript.ts';
import { readTimeline, when, type Row } from '../lib/timeline.ts';
import { secs, clock, span } from '../lib/timelineview.ts';

/** Words heard within this long of the landing count as said with it. */
export const TOGETHER_MS = 400;
const NEAR_MS = 60_000;
const hms = (ms: number): string => clock(ms).slice(0, 8);
const pad = ' '.repeat(10);

export type Stop = { id: string; from: string; leftAt: number | null; landedAt: number | null; flightMs: number | null; words: string; gapMs: number | null; unsynced: boolean };
export type Trip = { stops: Stop[]; homeAt: number | null; outMs: number | null; why: string; midJob: boolean };
export type Summary = { trips: number; shown: number; onward: number; turned: number; homeMidJob: number; together: number; late: number; early: number; lateAvgMs: number; unsynced: number };

/** The rows nearest in time to `at` (and not before it by more than a moment), within a minute. */
const nearest = <T>(items: T[], at: number, time: (x: T) => number, slackMs = 2000): T | undefined =>
  items.filter((x) => time(x) >= at - slackMs && time(x) <= at + NEAR_MS).sort((a, b) => Math.abs(time(a) - at) - Math.abs(time(b) - at))[0];

/** The light's trips, in order, each with the things it showed and the words that went with them. */
export function trips(rows: Row[], lines: Line[] = []): Trip[] {
  const out: Trip[] = [];
  let open: Trip | null = null;
  const stopOf = (id: string, from = ''): Stop => {
    if (!open || (from === 'pearl' && open.stops.length)) {
      open = { stops: [], homeAt: null, outMs: null, why: '', midJob: false };
      out.push(open);
    }
    let s = open.stops.find((x) => x.id === id);
    if (!s) {
      s = { id, from: from || (open.stops.length ? 'target' : 'pearl'), leftAt: null, landedAt: null, flightMs: null, words: '', gapMs: null, unsynced: false };
      open.stops.push(s);
    }
    return s;
  };
  const voiceLines = rows.filter((r) => r.type === 'voice.line');
  const steps = lines.filter((l) => l.who === 'echo' && l.kind === 'step');
  const wordsOf = (id: string, at: number): string => (id ? nearest(steps.filter((l) => l.id === id), at, (l) => Date.parse(l.ts))?.text ?? '' : '');
  const spoken: Array<{ s: Stop; line: string; t: number }> = [];
  for (const r of rows) {
    const t = when(r), id = String(r.f.id ?? r.f.light ?? '');
    if (r.type === 'light.departed' && id) {
      const s = stopOf(id, String(r.f.from || ''));
      s.leftAt = t;
    } else if (r.type === 'light.arrived' && id) {
      const s = stopOf(id);
      s.landedAt = t;
      s.flightMs = typeof r.f.ms === 'number' ? r.f.ms : null;
    } else if (r.type === 'speech.unsynced' && id) {
      stopOf(id).unsynced = true;
    } else if (r.type === 'speech.synced' && id) {
      const s = stopOf(id), line = String(r.f.line || ''), lead = String(r.f.lead || '');
      s.words = [wordsOf(lead, t - Number(r.f.ms || 0)), wordsOf(line, t)].filter(Boolean).join(' ');
      // (The words are often asked for as the light leaves, so its landing may not be known yet: the gap is worked out at the end.)
      spoken.push({ s, line, t });
    } else if (r.type === 'light.home') {
      const trip: Trip = open ?? { stops: [], homeAt: null, outMs: null, why: '', midJob: false };
      if (!open) out.push(trip);
      trip.homeAt = t;
      trip.outMs = typeof r.f.ms === 'number' ? r.f.ms : null;
      trip.why = String(r.f.why || '');
      trip.midJob = r.f.working === true;
      open = null;
    }
  }
  // When each step's words were first heard (the line's end, less how long it took, plus its start-up), against the landing.
  for (const { s, line, t } of spoken) {
    const v = nearest(voiceLines.filter((x) => x.f.id === line && typeof x.f.startMs === 'number'), t, when, 0);
    if (v && s.landedAt !== null) s.gapMs = Math.round(when(v) - Number(v.f.ms) + Number(v.f.startMs) - s.landedAt);
  }
  return out;
}

export function summary(all: Trip[]): Summary {
  const stops = all.flatMap((t) => t.stops), gaps = stops.map((s) => s.gapMs).filter((g): g is number => g !== null);
  const late = gaps.filter((g) => g > TOGETHER_MS);
  return {
    trips: all.length,
    shown: stops.length,
    onward: stops.filter((s) => s.from === 'target').length,
    turned: stops.filter((s) => s.from === 'turned').length,
    homeMidJob: all.filter((t) => t.midJob).length,
    together: gaps.filter((g) => Math.abs(g) <= TOGETHER_MS).length,
    late: late.length,
    early: gaps.filter((g) => g < -TOGETHER_MS).length,
    lateAvgMs: late.length ? Math.round(late.reduce((a, b) => a + b, 0) / late.length) : 0,
    unsynced: stops.filter((s) => s.unsynced).length,
  };
}

const many = (n: number, one: string, more: string): string => `${n} ${n === 1 ? one : more}`;

export function render(all: Trip[]): string[] {
  const s = summary(all);
  const out = [
    `${many(s.trips, 'trip', 'trips')} out from the pearl · ${many(s.shown, 'thing', 'things')} shown · ${s.onward} straight on from one thing to the next${s.turned ? ` · ${s.turned} turning round on the way home` : ''}`,
    `Went home in the middle of a job: ${many(s.homeMidJob, 'time', 'times')}`,
    `Words and landing: ${s.together} together (within ${secs(TOGETHER_MS)}) · ${s.late} late${s.late ? ` (${secs(s.lateAvgMs)} on average)` : ''} · ${s.early} early · ${s.unsynced} said without hearing the light land`,
    '',
  ];
  for (const t of all) {
    for (const st of t.stops) {
      const at = st.leftAt ?? st.landedAt;
      const how = st.from === 'target' ? 'On to the next thing' : st.from === 'turned' ? 'Turned round on its way home' : 'Left the pearl';
      const flight = st.landedAt === null ? 'never said it landed' : st.leftAt === null ? 'was already there' : `landed after ${secs(st.landedAt - st.leftAt)}`;
      out.push(`${at === null ? '        ' : hms(at)}  ${how}, ${flight}`);
      if (st.words) out.push(`${pad}said: “${st.words}”`);
      if (st.gapMs !== null) out.push(`${pad}words began ${Math.abs(st.gapMs) <= TOGETHER_MS ? 'with the landing' : `${secs(Math.abs(st.gapMs))} ${st.gapMs > 0 ? 'after' : 'before'} it landed`}${st.gapMs > TOGETHER_MS ? '   << late' : ''}`);
      if (st.unsynced) out.push(`${pad}the words did not wait for the light   !! problem`);
    }
    if (t.homeAt !== null) {
      const why = ({ over: 'the job was over', let_go: 'the step was let go', step: 'no next step came in time', wait: 'nothing more came' } as Record<string, string>)[t.why] ?? '';
      out.push(`${hms(t.homeAt)}  Home${t.outMs !== null ? ` after ${secs(t.outMs)}` : ''}${why ? `: ${why}` : ''}${t.midJob ? '   << in the middle of a job' : ''}`);
    }
    out.push('');
  }
  return out;
}

function main(argv: string[]): void {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npm run light -- --since 30m [--json] [--data DIR]');
    return;
  }
  const since = span(opt('--since') ?? '30m');
  if (!Number.isFinite(since)) {
    console.error('--since takes a time like 30s, 10m, 2h or 1d.');
    process.exitCode = 2;
    return;
  }
  const dataDir = opt('--data') ? path.resolve(opt('--data') as string) : config.dataDir;
  const now = Date.now();
  const all = trips(readTimeline(dataDir, now - since, now), readTranscript(dataDir, now - since - 60_000, now));
  if (argv.includes('--json')) return void console.log(JSON.stringify(summary(all)));
  console.log(all.length ? render(all).join('\n') : `The light did not go out in the last ${opt('--since') ?? '30m'}.`);
}

// Run as a program (not when a test imports it).
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
