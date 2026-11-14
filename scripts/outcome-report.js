#!/usr/bin/env node
// Did computer use actually work? One line per kind of outcome, by request, from the live logs
// (data/computer-log.jsonl and the daily conversations in data/conversations/), judged by
// lib/outcomes.js. Your own labels (--review) take precedence and measure how often the
// automatic judgement is right.
//
//   node scripts/outcome-report.js [--since 2026-10-01] [--app Excel] [--json]
//   node scripts/outcome-report.js --review [--all]   label the unclear ones (y/n), saved to data/outcome-labels.json
//
// The report prints numbers only. --review and --json show what was said, so keep them on this Mac.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { config } from '../lib/config.js';
import { transcriptLines, judgeAll } from '../lib/outcomes.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const since = flag('--since') ? Date.parse(flag('--since')) : 0;
if (Number.isNaN(since)) {
  console.error('--since needs a date, like --since 2026-10-01');
  process.exit(2);
}
const appFilter = String(flag('--app') || '').toLowerCase();
const labelsFile = path.join(config.dataDir, 'outcome-labels.json');

let events = [];
try {
  events = fs.readFileSync(path.join(config.dataDir, 'computer-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
} catch {
  console.error(`No computer-use log in ${config.dataDir} yet.`);
  process.exit(1);
}
const convoDir = path.join(config.dataDir, 'conversations');
let lines = [];
try {
  lines = fs.readdirSync(convoDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()
    .flatMap((f) => transcriptLines(fs.readFileSync(path.join(convoDir, f), 'utf8'), f.slice(0, 10), config.timezone));
} catch {}

/** @type {Record<string, { worked: boolean, at: string }>} */
let labels = {};
try {
  labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
} catch {}

const all = judgeAll(events, lines).filter((r) => r.start >= since && (!appFilter || r.app.toLowerCase().includes(appFilter)));
const acted = all.filter((r) => r.outcome.label !== 'looked');
/** The label to count: yours when you gave one, else the automatic one. */
const final = (r) => (labels[r.id] ? (labels[r.id].worked ? 'success' : 'failed') : r.outcome.label);

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const q = (xs, p) => {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const sec = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : '-');
const when = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

if (args.includes('--json')) {
  console.log(JSON.stringify(all.map((r) => ({ id: r.id, app: r.app, at: new Date(r.start).toISOString(), final: final(r), ...r.outcome, yours: labels[r.id] ?? null })), null, 1));
  process.exit(0);
}

if (args.includes('--review')) {
  const todo = acted
    .filter((r) => !labels[r.id] && (args.includes('--all') || r.outcome.label === 'unclear' || r.outcome.strength === 'weak'))
    .reverse();
  if (!todo.length) {
    console.log('Nothing to review.');
    process.exit(0);
  }
  if (!process.stdin.isTTY) {
    console.error('--review asks you a question per request; run it in a terminal.');
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${todo.length} to review, newest first. y = it worked, n = it didn't, s = skip, q = quit.\n`);
  for (const [i, r] of todo.entries()) {
    const o = r.outcome;
    console.log(`[${i + 1}/${todo.length}] ${when(r.start)} · ${r.app || 'unknown app'} · ${o.steps} step${o.steps === 1 ? '' : 's'}, ${o.verified} confirmed · Echo's guess: ${o.label} (${o.why.join('; ')})`);
    console.log(`  you asked:  ${o.asked || '(not found in the conversation log)'}`);
    console.log(`  Echo said:  ${o.said || '(nothing)'}`);
    console.log(`  you said next: ${o.next || '(nothing)'}`);
    const a = (await rl.question('  worked? [y/n/s/q] ')).trim().toLowerCase();
    if (a === 'q') break;
    if (a === 'y' || a === 'n') {
      labels[r.id] = { worked: a === 'y', at: new Date().toISOString() };
      fs.writeFileSync(labelsFile, JSON.stringify(labels, null, 1));
    }
    console.log('');
  }
  rl.close();
  process.exit(0);
}

const count = (rs, label) => rs.filter((r) => final(r) === label).length;
const judged = (rs) => rs.filter((r) => ['success', 'failed'].includes(final(r)));
const strong = (rs, label) => rs.filter((r) => !labels[r.id] && r.outcome.label === label && r.outcome.strength === 'strong').length;

console.log(`Computer use, by request${since ? ` since ${flag('--since')}` : ''}${appFilter ? ` in apps matching "${appFilter}"` : ''}: ${all.length} requests, ${acted.length} where Echo acted`);
const ok = count(acted, 'success');
const bad = count(acted, 'failed');
console.log(`  worked       ${String(ok).padStart(4)}   ${pct(ok, ok + bad).padStart(4)} of the ones that could be judged   (${strong(acted, 'success')} with a clear sign: Echo said done, or you sounded happy)`);
console.log(`  didn't work  ${String(bad).padStart(4)}   ${pct(bad, ok + bad).padStart(4)}                                   (${strong(acted, 'failed')} clear: you took over, said no, or asked again)`);
console.log(`  you stopped  ${String(count(acted, 'stopped')).padStart(4)}   (said no to a confirmation)`);
console.log(`  unclear      ${String(count(acted, 'unclear')).padStart(4)}   (the last step wasn't checked: an older Mac app)`);
const looked = all.filter((r) => r.outcome.label === 'looked');
const troubled = looked.filter((r) => r.outcome.why[0].startsWith('no steps;')).length;
console.log(`  looked only  ${String(looked.length).padStart(4)}   (a look, a point, an answer, or conversation: not counted above; ${troubled} showed trouble)`);

const reasons = {};
for (const r of acted) if (!labels[r.id] && r.outcome.label === 'failed') for (const w of r.outcome.why) reasons[w] = (reasons[w] || 0) + 1;
if (Object.keys(reasons).length) console.log(`\nwhy they didn't work: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(', ')}`);

const work = acted.map((r) => r.outcome.workMs);
const waited = acted.map((r) => r.outcome.waitedMs);
console.log(`\ntime per request: Echo working to its last step p50 ${sec(q(work, 0.5))} p90 ${sec(q(work, 0.9))};` +
  ` you answering confirmations p50 ${sec(q(waited, 0.5))} (on ${waited.filter((w) => w > 0).length} requests)`);

const apps = new Map();
for (const r of acted) apps.set(r.app || 'unknown', [...(apps.get(r.app || 'unknown') || []), r]);
console.log('\nby app');
for (const [app, rs] of [...apps].sort((a, b) => b[1].length - a[1].length)) {
  const s = count(rs, 'success');
  const f = count(rs, 'failed');
  console.log(`  ${app.slice(0, 22).padEnd(22)} acted ${String(rs.length).padStart(3)}   worked ${pct(s, s + f).padStart(4)} (${s}/${s + f})   unclear ${count(rs, 'unclear')}`);
}

// How often the automatic judgement matches yours.
const mine = Object.keys(labels);
const checkable = acted.filter((r) => labels[r.id] && ['success', 'failed'].includes(r.outcome.label));
const agree = checkable.filter((r) => (r.outcome.label === 'success') === labels[r.id].worked).length;
console.log(`\nyour labels: ${mine.length}${checkable.length ? `; the automatic judgement matched ${agree} of ${checkable.length} (${pct(agree, checkable.length)})` : ''}` +
  `. Add more with: node scripts/outcome-report.js --review`);
