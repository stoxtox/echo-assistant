#!/usr/bin/env node
// Replays a real dispatcher session transcript (an Agent SDK .jsonl) against the session rotation
// in lib/rotation.js, and estimates context size, per-call latency and input cost before and after.
//
//   node scripts/rotation-replay.js <transcript.jsonl> [--since 2026-09-28T21:00Z] [--limit 60000] [--seed 3000]
//
// Read-only. "Before" is what the transcript measured. "After" re-plays the same growth per model
// call, but starts a fresh session (system prompt + a seed of about --seed tokens) at each turn
// boundary once the context passes --limit. Latency "after" maps each call's new context size onto
// the latency the transcript itself measured at that size (median per 100K bucket); cost counts
// cache reads at 0.1x and cache writes at 1.25x the input price, relative to "before".
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
if (!file) {
  console.error('usage: node scripts/rotation-replay.js <transcript.jsonl> [--since ISO] [--limit 60000] [--seed 3000]');
  process.exit(1);
}
const since = Date.parse(opt('since', '1970-01-01'));
const limit = Number(opt('limit', 60_000));
const seed = Number(opt('seed', 3000));

/** One entry per model call: when it was sent, when it finished, its usage, and whether a real user turn started it. */
const calls = new Map();
let lastUserAt = 0;
let lastUserIsPrompt = false;
const rl = readline.createInterface({ input: fs.createReadStream(file) });
for await (const line of rl) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const at = Date.parse(e.timestamp);
  if (e.type === 'user' && !e.isSidechain) {
    lastUserAt = at;
    lastUserIsPrompt = typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && !e.message.content.some((b) => b.type === 'tool_result'));
    continue;
  }
  if (e.type !== 'assistant' || e.isSidechain || !e.message?.usage) continue;
  const id = e.message.id;
  const c = calls.get(id);
  if (c) c.end = Math.max(c.end, at);
  else calls.set(id, { sent: lastUserAt, end: at, usage: e.message.usage, turnStart: lastUserIsPrompt });
  lastUserIsPrompt = false;
}

// Latency and the base prompt size come from the whole transcript; the replay from the window.
const every = [...calls.values()].sort((a, b) => a.end - b.end);
const all = every.filter((c) => c.end >= since);
if (!all.length) {
  console.error('No model calls found in that window.');
  process.exit(1);
}
const ctxOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
const q = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
};
const bucket = (ctx) => Math.min(9, Math.floor(ctx / 100_000));

// Latency the transcript measured, per 100K context bucket.
const byBucket = new Map();
for (const c of every) {
  const ms = c.end - c.sent;
  if (!c.sent || ms <= 0 || ms > 120_000) continue;
  const b = bucket(ctxOf(c.usage));
  byBucket.set(b, [...(byBucket.get(b) || []), ms]);
}
const latencyAt = (ctx) => {
  for (let b = bucket(ctx); b < 10; b++) if (byBucket.get(b)?.length >= 5) return q(byBucket.get(b), 0.5);
  return q(every.map((c) => c.end - c.sent).filter((ms) => ms > 0 && ms < 120_000), 0.5);
};

// The system prompt and tools: the smallest context the session ever had.
const baseCtx = Math.min(...every.map((c) => ctxOf(c.usage)));
let before = { ctx: [], ms: [], units: 0 };
let after = { ctx: [], ms: [], units: 0, rotations: 0 };
let prev = ctxOf(all[0].usage);
let sim = Math.min(prev, baseCtx + seed);
for (const c of all) {
  const ctx = ctxOf(c.usage);
  const u = c.usage;
  before.ctx.push(ctx);
  if (c.sent && c.end > c.sent && c.end - c.sent < 120_000) before.ms.push(c.end - c.sent);
  before.units += (u.cache_read_input_tokens || 0) * 0.1 + (u.cache_creation_input_tokens || 0) * 1.25 + (u.input_tokens || 0);
  const growth = Math.max(0, ctx - prev);
  prev = ctx;
  if (c.turnStart && sim >= limit) {
    // Rotate: a fresh session re-writes the system prompt and the seed into the cache once.
    sim = baseCtx + seed;
    after.rotations++;
    after.units += (baseCtx + seed) * 1.25;
  }
  const cached = sim;
  sim += growth;
  after.ctx.push(sim);
  after.ms.push(latencyAt(sim));
  after.units += cached * 0.1 + growth * 1.25;
}

const fmtK = (n) => `${Math.round(n / 1000)}K`;
const fmtS = (ms) => `${(ms / 1000).toFixed(1)} s`;
console.log(`Replayed ${all.length} model calls (${new Date(all[0].end).toISOString()} to ${new Date(all.at(-1).end).toISOString()}), rotation at ${fmtK(limit)}, seed ${fmtK(seed)}, base ${fmtK(baseCtx)}.`);
console.log('');
console.log('|                     | before | after (estimate) |');
console.log('|---------------------|--------|------------------|');
console.log(`| context p50         | ${fmtK(q(before.ctx, 0.5))} | ${fmtK(q(after.ctx, 0.5))} |`);
console.log(`| context p90         | ${fmtK(q(before.ctx, 0.9))} | ${fmtK(q(after.ctx, 0.9))} |`);
console.log(`| context peak        | ${fmtK(Math.max(...before.ctx))} | ${fmtK(Math.max(...after.ctx))} |`);
console.log(`| latency/call p50    | ${fmtS(q(before.ms, 0.5))} | ${fmtS(q(after.ms, 0.5))} |`);
console.log(`| latency/call p90    | ${fmtS(q(before.ms, 0.9))} | ${fmtS(q(after.ms, 0.9))} |`);
console.log(`| input cost (relative) | 100% | ${Math.round((after.units / before.units) * 100)}% |`);
console.log(`| fresh sessions      | 0 | ${after.rotations} |`);
console.log('');
console.log('Measured latency by context size (p50, calls):', [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([b, xs]) => `${b * 100}-${b * 100 + 100}K ${fmtS(q(xs, 0.5))} (${xs.length})`).join(', '));
