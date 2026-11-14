#!/usr/bin/env node
// The listening replay (lib/listenreplay.js): answers to Echo, background clips (TV, podcasts,
// other people) and ten long computer-use runs with a TV on, through the same decisions the
// server makes. test/listening.test.js holds it to the bar; this prints the numbers.
//
//   node scripts/listen-replay.js
import { runListening } from '../lib/listenreplay.js';

const r = runListening();
const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`Answers heard without "Echo":  ${r.answers.accepted}/${r.answers.n} accepted (${pct(r.answers.rate)}, bar 95%)`);
for (const m of r.answers.missed) console.log(`  missed: "${m.text}" (${Math.round(m.sinceReplyMs / 1000)} s after she asked) → ${m.got}`);
console.log(`Background clips:              ${r.background.triggered}/${r.background.n} started or cancelled something (${pct(r.background.rate)}, bar 1%)`);
for (const b of r.background.which) console.log(`  triggered: "${b.text}" (${b.why})`);
console.log(`Long runs with a TV on:        ${r.runs.cancelled}/${r.runs.n} cancelled (bar 0)`);
for (const x of r.runs.which) console.log(`  ${x.name}: ${x.cuts.join(' · ')}`);
const pass = r.answers.rate >= 0.95 && r.background.rate <= 0.01 && r.runs.cancelled === 0;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
