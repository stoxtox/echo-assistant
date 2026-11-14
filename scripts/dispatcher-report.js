#!/usr/bin/env node
// Context size and model latency from Echo's dispatcher timing log (data/dispatcher-timing.jsonl,
// written by lib/dispatcher.js), and how long hearing took before that (data/stt-log.jsonl,
// written by server.js), for comparing before and after a change.
//
//   node scripts/dispatcher-report.js [data/dispatcher-timing.jsonl] [--since 2026-09-29]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';

const args = process.argv.slice(2);
const i = args.indexOf('--since');
const since = i >= 0 ? Date.parse(args[i + 1]) : 0;
if (Number.isNaN(since)) {
  console.error(`--since needs a date, like --since 2026-09-29`);
  process.exit(2);
}
// The first argument that isn't a flag or the --since date.
const file = args.find((a, k) => !a.startsWith('--') && !(i >= 0 && k === i + 1)) || path.join(config.dataDir, 'dispatcher-timing.jsonl');

/** @param {string} f */
const readLog = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => Date.parse(l.at) >= since);

let lines = [];
try {
  lines = readLog(file);
} catch {
  console.error(`No timing log at ${file} yet.`);
  process.exit(1);
}
const q = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const row = (label, xs, fmt) => console.log(`${label.padEnd(26)} p50 ${fmt(q(xs, 0.5)).padStart(8)}   p90 ${fmt(q(xs, 0.9)).padStart(8)}   (n=${xs.length})`);
const k = (n) => (Number.isFinite(n) ? `${Math.round(n / 1000)}K` : '-');
const s = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)}s` : '-');
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');

const req = lines.filter((l) => l.type === 'request');
const turns = lines.filter((l) => l.type === 'turn');
const rot = lines.filter((l) => l.type === 'rotate');
row('context per model call', req.map((r) => r.ctx), k);
row('first token per call', req.map((r) => r.firstMs), s);
row('model call', req.map((r) => r.ms), s);
row('whole turn', turns.map((t) => t.ms), s);
row('model calls per turn', turns.map((t) => t.requests), (n) => (Number.isFinite(n) ? String(n) : '-'));
// Tokens per turn: the model calls logged since the previous turn line, added up. Every call
// re-reads the whole context, so this is what a turn costs in input (cached or not).
const perTurn = [];
let acc = { all: 0, fresh: 0, n: 0 };
for (const l of lines) {
  if (l.type === 'request') acc = { all: acc.all + (l.ctx || 0), fresh: acc.fresh + (l.cacheWrite || 0) + (l.input || 0), n: acc.n + 1 };
  else if (l.type === 'turn') {
    if (acc.n) perTurn.push(acc);
    acc = { all: 0, fresh: 0, n: 0 };
  }
}
row('input tokens per turn', perTurn.map((t) => t.all), k);
row('uncached tokens per turn', perTurn.map((t) => t.fresh), (n) => (Number.isFinite(n) ? `${(n / 1000).toFixed(1)}K` : '-'));
// Time to the first spoken word (turns logged since the speed work), and which model answered.
const spokeAt = turns.filter((t) => Number.isFinite(t.firstSpeakMs));
if (spokeAt.length) row('first words to the voice', spokeAt.map((t) => t.firstSpeakMs), s);
const byModel = new Map();
for (const r of req) byModel.set(r.model || '?', [...(byModel.get(r.model || '?') || []), r]);
if (byModel.size > 1) {
  console.log('\nby model');
  for (const [m, rs] of byModel) row(`  ${m.slice(0, 24)} first token`, rs.map((r) => r.firstMs), s);
}
const handoffs = turns.filter((t) => t.handoff).length;
if (handoffs) console.log(`quick turns handed to the main model: ${handoffs}`);
console.log(`fresh sessions: ${rot.length}${rot.length ? ` (${Object.entries(rot.reduce((m, r) => ({ ...m, [r.reason]: (m[r.reason] || 0) + 1 }), {})).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);

// Hearing, before the dispatcher gets the words: speech to text, then the names it may be (hints).
let heard = [];
try {
  heard = readLog(path.join(path.dirname(file), 'stt-log.jsonl')).filter((l) => l.raw !== undefined && !l.event);
} catch {}
if (heard.length) {
  console.log('\nspeech (stt-log.jsonl)');
  row('speech to text', heard.map((h) => h.sttMs), s);
  row('names as hints', heard.map((h) => h.fixMs), s);
  console.log(`sentences with a name hint: ${heard.filter((h) => h.hints?.length).length} of ${heard.length} (${pct(heard.filter((h) => h.hints?.length).length, heard.length)})`);
}
