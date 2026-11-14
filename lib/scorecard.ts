// The scorecard (ECHO_CORE_PLAN.md §6): the numbers every stage is judged by, computed from Echo's
// own logs for any stretch of days, next to the October 2 baseline and the final target. Nothing
// here asks anyone to label anything: what was meant for Echo comes from the replay harness's
// evidence labels (lib/replay/cases.ts), the rest from what the logs recorded.
import fs from 'node:fs';
import path from 'node:path';
import { buildCases, conversationLines, overlap, words } from './replay/cases.ts';
import { config } from './config.js';
import { readTimeline } from './timeline.ts';

/** A moment's day where the user is (as the cost log keys its days): an evening isn't two days in UTC. */
const localDay = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: config.timezone });

export type Metric = {
  id: number;
  name: string;
  /** The measured value (a rate 0..1, seconds, dollars, a count…), null when the logs can't say. */
  value: number | null;
  /** The value as it reads in the table. */
  shown: string;
  baseline: string;
  target: string;
  /** True when the value meets the final target. */
  met: boolean | null;
  note?: string;
};

type Line = Record<string, any> & { at?: string; t?: string };

function jsonl(file: string): Line[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === 'object' ? [v] : [];
    } catch {
      return [];
    }
  });
}

/** The p-th percentile (0..1) of numbers, null when there are none. */
export function percentile(xs: number[], p: number): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))] ?? null;
}

/* ---------- what the user's sentences were ---------- */

const APPROVAL_ANSWER = /^(yes|yeah|yep|yup|no|nope|ok(ay)?|sure|allow( it)?|approve( it)?|deny( it)?|do it|go ahead|send it|confirm(ed)?|cancel)\b[\s,.!]*(please|it|that)?[.!]?$/i;
const KEEP_GOING = /\b(keep going|continue|go on|carry on|keep at it|finish it|don'?t stop)\b/i;
const CORRECTION = /^(no[,. ]+|not that\b|i said\b|i meant\b|that'?s (wrong|not (it|right|what))\b|wrong\b)/i;
const DISPUTE = /\b(not (done|finished|working|there|it|right)|(you )?(didn'?t|haven'?t|did not|has not|hasn'?t)\b|still (not|no|isn'?t|the same)|nothing (changed|happened)|it'?s not)\b/i;
const CLAIMED_DONE = /\b(done|finished|all set|completed|it'?s (ready|live|there)|i'?ve (made|changed|added|set|updated|fixed))\b/i;

export type SentenceKind = 'repeat' | 'approval' | 'keep_going' | 'correction' | 'request';

/**
 * Why a sentence was said: a new request, or overhead (saying it again, answering an approval,
 * pushing Echo on, correcting it).
 * @param prev the user's sentences before it, newest last, with their times
 */
export function sentenceKind(text: string, at: number, prev: Array<{ text: string; at: number }>): SentenceKind {
  const t = text.trim();
  const n = words(t).length;
  if (n <= 6 && KEEP_GOING.test(t)) return 'keep_going';
  if (n <= 4 && APPROVAL_ANSWER.test(t)) return 'approval';
  if (CORRECTION.test(t)) return 'correction';
  if (prev.some((p) => at - p.at < 2 * 60_000 && at > p.at && overlap(t, p.text) >= 0.6)) return 'repeat';
  return 'request';
}

/* ---------- the card ---------- */

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const secs = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)} s`);
const within = (at: string | number | undefined, from: number, to: number) => {
  const t = typeof at === 'number' ? at : Date.parse(String(at));
  return Number.isFinite(t) && t >= from && t < to;
};

/**
 * Compute the scorecard for [from, to) from a data folder.
 * @param dataDir Echo's data folder (or a copy of it)
 */
export function scorecard(dataDir: string, from: number, to: number): { metrics: Metric[]; days: number; spokenTurns: number } {
  const stt = jsonl(path.join(dataDir, 'stt-log.jsonl')).filter((e) => within(e.at, from, to));
  const events = jsonl(path.join(dataDir, 'events.jsonl')).filter((e) => within(e.at, from, to));
  const timing = jsonl(path.join(dataDir, 'dispatcher-timing.jsonl')).filter((e) => within(e.at, from, to));
  const computer = jsonl(path.join(dataDir, 'computer-log.jsonl')).filter((e) => within(e.at, from, to));
  const convo = conversationLines(path.join(dataDir, 'conversations')).filter((l) => within(l.t, from, to));
  let tasks: any[] = [];
  try {
    tasks = JSON.parse(fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8'));
  } catch {}
  let costs: any = { days: {} };
  try {
    costs = JSON.parse(fs.readFileSync(path.join(dataDir, 'costs.json'), 'utf8'));
  } catch {}

  const spoken = stt.filter((e) => !e.event && typeof e.raw === 'string');
  const activeDays = new Set(spoken.map((e) => localDay(Date.parse(String(e.at)))).filter((d) => d !== 'Invalid Date')).size || 1;
  const m: Metric[] = [];
  const add = (id: number, name: string, value: number | null, shown: string, baseline: string, target: string, ok: (v: number) => boolean, note?: string) =>
    m.push({ id, name, value, shown, baseline, target, met: value === null ? null : ok(value), ...(note ? { note } : {}) });

  // 1–3: what was meant for Echo, by the replay harness's evidence labels, against what Echo did then.
  const cases = buildCases(dataDir).filter((c) => within(c.at, from, to));
  const forEcho = cases.filter((c) => c.label === 'for_echo');
  const notForEcho = cases.filter((c) => c.label === 'not_for_echo');
  const dropped = forEcho.filter((c) => c.logged !== 'deliver');
  add(1, 'Real requests set aside', dropped.length, `${dropped.length} (${(dropped.length / activeDays).toFixed(1)}/day)`, '114 in 9 days', '0', (v) => v === 0, `of ${forEcho.length} sentences the evidence says were for Echo`);
  const accepted = forEcho.length ? 1 - dropped.length / forEcho.length : null;
  const drivingForEcho = forEcho.filter((c) => c.driving);
  const drivingAccepted = drivingForEcho.length ? 1 - drivingForEcho.filter((c) => c.logged !== 'deliver').length / drivingForEcho.length : null;
  add(2, 'For-Echo speech accepted (while Echo worked)', accepted, `${pct(accepted)} (${pct(drivingAccepted)})`, '≈62% while Echo worked', '≥99%', (v) => v >= 0.99 && (drivingAccepted ?? 1) >= 0.99);
  const noise = notForEcho.length ? notForEcho.filter((c) => c.logged === 'deliver').length / notForEcho.length : null;
  add(3, 'Background speech that triggered something', noise, pct(noise), 'unmeasured', '≤2%', (v) => v <= 0.02, `of ${notForEcho.length} sentences the evidence says weren't for Echo`);

  // 4, 11: the user's own sentences, sorted into requests and overhead.
  const userLines = convo.filter((l) => l.line.startsWith('User: ')).map((l) => ({ text: l.line.slice(6).replace(/\s+_\(heard:.*$/, ''), at: l.t }));
  const kinds = userLines.map((u, i) => sentenceKind(u.text, u.at, userLines.slice(Math.max(0, i - 6), i)));
  const overhead = kinds.length ? kinds.filter((k) => k !== 'request').length / kinds.length : null;
  add(4, 'Your speech that is overhead', overhead, pct(overhead), '≈38%', '≤10%', (v) => v <= 0.1, kinds.length ? `repeats ${kinds.filter((k) => k === 'repeat').length}, approvals ${kinds.filter((k) => k === 'approval').length}, corrections ${kinds.filter((k) => k === 'correction').length}, "keep going" ${kinds.filter((k) => k === 'keep_going').length}` : undefined);

  // 5: Echo's turns that weren't answers to the user (approvals, updates, hand-offs: event turns).
  const starts = events.filter((e) => e.type === 'turn_start');
  const notAnswers = starts.length ? starts.filter((e) => e.source === 'event').length / starts.length : null;
  add(5, "Echo's turns that aren't answers", notAnswers, pct(notAnswers), '56%', '≤20%', (v) => v <= 0.2, starts.length ? `turns Echo started on its own (updates, approvals, hand-offs) out of ${starts.length}; the baseline also counted approval questions inside answers` : 'needs events.jsonl (Echo 0009 on)');

  // 6, 7: speed.
  const sttP50 = percentile(spoken.map((e) => Number(e.sttMs)), 0.5);
  add(6, 'Speech to text after you stop (p50)', sttP50, secs(sttP50), '1.44 s', '≤0.2 s', (v) => v <= 200);
  const sttByTrace = new Map(spoken.filter((e) => e.trace).map((e) => [e.trace, (Number(e.sttMs) || 0) + (Number(e.fixMs) || 0)]));
  // The voice's first sound as the page heard it (first_sound, from Echo 0035), else the first
  // sentence ready to speak (first_speech), which leaves out the voice's own time.
  const sounded = events.filter((e) => e.type === 'first_sound' && sttByTrace.has(e.trace));
  const atSpeaker = sounded.length > 0;
  const firstSound = (atSpeaker ? sounded : events.filter((e) => e.type === 'first_speech' && sttByTrace.has(e.trace))).map((e) => (sttByTrace.get(e.trace) || 0) + Number(e.ms));
  const fs50 = percentile(firstSound, 0.5);
  const fs95 = percentile(firstSound, 0.95);
  add(7, atSpeaker ? 'First sound after you stop (p50 / p95)' : 'First words after you stop (p50 / p95)', fs50, `${secs(fs50)} / ${secs(fs95)}`, '≈4.5 s / ≈10 s', '≤1.0 / ≤2.0 s', (v) => v <= 1000 && (fs95 ?? Infinity) <= 2000, atSpeaker ? `when Echo's voice became audible, over ${sounded.length} turns` : 'to the first sentence ready to speak; the voice adds its own time (measured from Echo 0035 on)');

  // 8: approval prompts.
  const workerAsks = tasks.flatMap((t) => (t.log || []).filter((e: any) => e.kind === 'ask' && within(e.t, from, to)));
  const cardAsks = computer.filter((e) => e.event === 'confirm_asked' || e.event === 'readback_asked');
  const asksPerDay = (workerAsks.length + cardAsks.length) / activeDays;
  add(8, 'Approval prompts per day', asksPerDay, asksPerDay.toFixed(1), '≈77', '−80% (≤15)', (v) => v <= 15, `${workerAsks.length} from workers, ${cardAsks.length} on the Mac, over ${activeDays} day(s) with speech`);

  // 9: actions that changed nothing.
  const actions = computer.filter((e) => e.event === 'action');
  const noop = actions.length ? actions.filter((e) => Array.isArray(e.changes) && e.changes.length === 0).length / actions.length : null;
  add(9, 'Actions that did nothing', noop, pct(noop), '14% (XD 19%)', '≤3%', (v) => v <= 0.03, `of ${actions.length} actions`);

  // 10: "done" the user then disputed (within three minutes of Echo saying so).
  let claims = 0;
  let disputed = 0;
  convo.forEach((l, i) => {
    if (!l.line.startsWith('Assistant: ') || !CLAIMED_DONE.test(l.line)) return;
    claims++;
    const next = convo.slice(i + 1).find((x) => x.line.startsWith('User: '));
    if (next && next.t - l.t < 3 * 60_000 && DISPUTE.test(next.line)) disputed++;
  });
  const disputedRate = claims ? disputed / claims : null;
  add(10, '"Done" claims disputed', disputedRate, claims ? `${disputed} of ${claims} (${pct(disputedRate)})` : 'n/a', '≈12–15', '≈0', (v) => v <= 0.02);

  // 11: "keep going".
  const keepGoing = kinds.filter((k) => k === 'keep_going').length;
  add(11, '"Keep going" turns', keepGoing, String(keepGoing), '18', '0', (v) => v === 0);

  // 12: model cost per spoken turn.
  // costs.json is kept by local day.
  const dayKeys = Object.keys(costs.days || {}).filter((d) => d >= localDay(from) && d <= localDay(to - 1));
  // A day's total: the assistant (its conversation is part of it) and the workers.
  const spent = dayKeys.reduce((s, d) => s + Number(costs.days[d]?.assistant || 0) + Number(costs.days[d]?.workers || 0), 0);
  const perTurn = spoken.length ? spent / spoken.length : null;
  add(12, 'Model usage per spoken turn', perTurn, perTurn === null ? 'n/a' : `$${perTurn.toFixed(3)}`, '$0.29', '≤$0.05', (v) => v <= 0.05, `$${spent.toFixed(2)} over ${spoken.length} spoken turns`);

  // 13: context size.
  const ctx90 = percentile(timing.filter((e) => e.type === 'turn').map((e) => Number(e.maxCtx || e.ctx)), 0.9);
  add(13, 'Context size (p90)', ctx90, ctx90 === null ? 'n/a' : `${Math.round(ctx90 / 1000)}k`, '92k', '≤60k', (v) => v <= 60_000);

  // 14: the same sentence heard twice, Echo hearing itself.
  const twice = stt.filter((e) => e.event === 'heard_twice').length;
  const own = stt.filter((e) => e.event === 'own_voice').length;
  add(14, 'Heard twice / own voice', twice + own, `${twice} / ${own}`, '23 / 9', '0 / 0', (v) => v === 0);

  // 15: golden tasks (Stage 5): every run of a task must pass.
  const golden = jsonl(path.join(dataDir, 'golden', 'results.jsonl')).filter((e) => within(e.at, from, to));
  const byTask = new Map<string, boolean[]>();
  for (const r of golden) byTask.set(String(r.task), [...(byTask.get(String(r.task)) || []), Boolean(r.pass)]);
  const pass3 = byTask.size ? [...byTask.values()].filter((runs) => runs.length >= 3 && runs.every(Boolean)).length / byTask.size : null;
  const simulated = golden.length > 0 && golden.every((r) => r.where === 'simulated');
  add(15, 'Golden tasks passing all 3 runs', pass3, byTask.size ? `${pct(pass3)} of ${byTask.size}` : 'n/a', 'none yet', '≥90%', (v) => v >= 0.9, byTask.size ? (simulated ? 'on the simulated Mac (npm run golden); real apps come with the golden runs on your Mac' : undefined) : 'run npm run golden');

  // 16: turns whose first move was a tool, where Echo said a short word at once (lib/dispatcher.js
  // watchTool), against how long the model's own first words took on those turns.
  const acks = events.filter((e) => e.type === 'ack');
  const ack50 = percentile(acks.map((e) => Number(e.ms)), 0.5);
  const ackTraces = new Set(acks.map((e) => e.trace));
  const words50 = percentile(events.filter((e) => e.type === 'first_speech' && ackTraces.has(e.trace)).map((e) => Number(e.ms)), 0.5);
  add(16, 'Word said at once when a tool comes first (p50)', ack50, acks.length ? `${secs(ack50)} over ${acks.length} turns` : 'n/a', '≈4.6 s, on 10 of 27 turns', '≤1.5 s', (v) => v <= 1500, acks.length ? `from the turn's start to the word being sent to the voice; the model's own first words on those turns came at ${secs(words50)}` : 'needs the ack events (from this build on)');

  // 17: sentences whose judging started before they ended ("probably done", lib/server/speech.js).
  const heads = readTimeline(dataDir, from, to - 1).filter((r) => r.type === 'speech.head_start');
  const saved50 = percentile(heads.map((r) => Number(r.f.savedMs)), 0.5);
  add(17, 'Head start on judging a sentence (p50 saved)', saved50, heads.length ? `${secs(saved50)} over ${heads.length} sentences` : 'n/a', '0 (0.9 s waited, 13 times a day)', '≥0.4 s', (v) => v >= 400, heads.length ? `still waited after the sentence ended: ${secs(percentile(heads.map((r) => Number(r.f.waitMs)), 0.5))} (p50)` : undefined);

  return { metrics: m, days: activeDays, spokenTurns: spoken.length };
}

/** The scorecard as a table for the terminal or a note. */
export function scorecardTable(r: ReturnType<typeof scorecard>): string {
  const rows = r.metrics.map((x) => `| ${x.id} | ${x.name} | ${x.shown} | ${x.baseline} | ${x.target} | ${x.met === null ? '–' : x.met ? '✓' : '✗'} |`);
  const notes = r.metrics.filter((x) => x.note).map((x) => `${x.id}. ${x.note}`);
  return [`| # | Metric | Now | Oct 2 baseline | Target | Met |`, `|---|---|---|---|---|---|`, ...rows, '', ...notes, '', 'The Oct 2 baseline was estimated by hand, some of it with other definitions; compare weeks with this script\'s own earlier runs (--save keeps them).'].join('\n');
}
