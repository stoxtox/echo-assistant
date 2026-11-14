#!/usr/bin/env node
// How computer use ran, from the live log (data/computer-log.jsonl, written by lib/computer.js):
// how runs ended, how many actions were verified, and how long each step took, overall and per
// app. The simulated suite (`npm run eval`) checks the logic; this checks the mechanics on the Mac.
// Whether requests actually worked is scripts/outcome-report.js: a drive is a session that
// normally ends idle or when you say stop, so a run's ending isn't its outcome.
//
//   node scripts/computer-report.js [data/computer-log.jsonl] [--since 2026-09-29]
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
const file = args.find((a, k) => !a.startsWith('--') && !(i >= 0 && k === i + 1)) || path.join(config.dataDir, 'computer-log.jsonl');

let lines = [];
try {
  lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => Date.parse(l.at) >= since);
} catch {
  console.error(`No computer-use log at ${file} yet.`);
  process.exit(1);
}

const q = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const sec = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '-');

/** @type {Map<string, { actions: any[], ended?: any, app?: string, lastUnverifiedAt?: string }>} */
const runs = new Map();
for (const l of lines) {
  if (!l.run) continue;
  const r = runs.get(l.run) || { actions: [] };
  if (l.event === 'action') {
    r.actions.push(l);
    r.app ||= l.app;
  } else if (l.event === 'unverified') r.lastUnverifiedAt = l.at;
  else if (l.event === 'run_ended') r.ended = l;
  runs.set(l.run, r);
}

// A step's time is the gap since the previous action in the same run: the model's turn plus the action.
const gaps = (rs) => rs.flatMap((r) => r.actions.slice(1).map((a, k) => Date.parse(a.at) - Date.parse(r.actions[k].at)));

/** @param {string} label @param {Array<{ actions: any[], ended?: any }>} rs */
function report(label, rs) {
  const ended = rs.filter((r) => r.ended);
  const reasons = ended.reduce((m, r) => ({ ...m, [r.ended.reason]: (m[r.ended.reason] || 0) + 1 }), {});
  const actions = rs.flatMap((r) => r.actions);
  // `verified` comes from the observe/act/verify driver; older lines don't have it.
  const checked = actions.filter((a) => typeof a.verified === 'boolean');
  console.log(
    `${label.padEnd(18)} runs ${String(rs.length).padStart(3)}` +
      `   steps p50 ${String(q(rs.map((r) => r.actions.length), 0.5) ?? '-').padStart(2)}` +
      `   per step p50 ${sec(q(gaps(rs), 0.5)).padStart(6)} p90 ${sec(q(gaps(rs), 0.9)).padStart(6)}` +
      `   verified ${checked.length ? pct(checked.filter((a) => a.verified).length, checked.length) : 'unchecked'}` +
      `   failed actions ${actions.filter((a) => a.ok === false).length}`,
  );
  return reasons;
}

const all = [...runs.values()];
const reasons = report('all apps', all);
console.log(`endings: ${Object.entries(reasons).map(([r, n]) => `${r} ${n}`).join(', ') || 'none'}`);
// A likely false success: the run ended "done", but its last step wasn't confirmed on screen (or a
// step came back unconfirmed with nothing confirmed after it). A proxy until runs are labelled.
// Runs from before the verify driver have no `verified` at all, so they can't be judged.
const doneRuns = all.filter((r) => r.ended?.reason === 'done');
const checkable = doneRuns.filter((r) => typeof r.actions.at(-1)?.verified === 'boolean');
const unconfirmed = checkable.filter((r) => {
  const last = r.actions.at(-1);
  return last.verified !== true || (r.lastUnverifiedAt && Date.parse(r.lastUnverifiedAt) >= Date.parse(last.at));
});
console.log(
  `done without a confirmed last step (likely false success): ${unconfirmed.length} of ${checkable.length} (${pct(unconfirmed.length, checkable.length)})` +
    (doneRuns.length > checkable.length ? `, ${doneRuns.length - checkable.length} older done runs unchecked` : ''),
);
const byApp = new Map();
for (const r of all) byApp.set(r.app || 'unknown', [...(byApp.get(r.app || 'unknown') || []), r]);
console.log('');
for (const [app, rs] of [...byApp].sort((a, b) => b[1].length - a[1].length)) report(app, rs);
console.log('\nDid the requests work? node scripts/outcome-report.js');
