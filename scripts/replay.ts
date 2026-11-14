#!/usr/bin/env node
// How well does Echo decide what's meant for it? Every sentence in the logs, replayed through the
// real decision (lib/pipeline/utterance.ts) with labels from the evidence (lib/replay/cases.ts).
//
//   node scripts/replay.ts                    the report
//   node scripts/replay.ts --since 2026-10-01 only from then on
//   node scripts/replay.ts --save             keep these numbers as the baseline (data/listening/replay-baseline.json)
//   node scripts/replay.ts --check            exit 1 if worse than the baseline (more than half a point)
//   ECHO_FLAG_<NAME>=1 node scripts/replay.ts try a feature flag (lib/flags.ts) before it ships
//   --data DIR                                another data folder (a copy of Echo's logs)
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { getSettings } from '../lib/settings.js';
import { buildCases } from '../lib/replay/cases.ts';
import { replay, score, type Score } from '../lib/replay/run.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = opt('--data') || config.dataDir;
const since = opt('--since') ? Date.parse(String(opt('--since'))) : 0;
const baselineFile = path.join(dataDir, 'listening', 'replay-baseline.json');

let userLabels = {};
try {
  userLabels = JSON.parse(fs.readFileSync(path.join(dataDir, 'listening', 'labels.json'), 'utf8'));
} catch {}

const s = getSettings();
const cases = buildCases(dataDir, { userLabels }).filter((c) => Date.parse(c.at) >= since);
const result = score(await replay(cases, { wakeWord: Boolean(s.wakeWord) }));

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const line = (name: string, c: Score['counts']) =>
  `  ${name.padEnd(14)} for Echo ${String(c.forEcho).padStart(4)}, left alone ${String(c.dropped).padStart(4)} (${pct(c.dropped / (c.forEcho || 1))})   not for Echo ${String(c.notForEcho).padStart(4)}, taken ${String(c.accepted).padStart(3)} (${pct(c.accepted / (c.notForEcho || 1))})`;

console.log(`Replayed ${result.cases} sentences; ${result.labelled} have a label from the evidence.\n`);
console.log(`Meant for Echo but left alone (false drops):   ${pct(result.falseDropRate)}   (goal: under 1%)`);
console.log(`Not meant for Echo but taken (false accepts):  ${pct(result.falseAcceptRate)}   (goal: under 3%)`);
console.log(`Replay matches what Echo did at the time:      ${pct(result.fidelity)}   (how far the replay can be trusted)\n`);
console.log('By mic:');
for (const [m, c] of Object.entries(result.byMode)) console.log(line(m, c));
console.log(line('while working', result.driving));
console.log('\nBy where the label came from:');
for (const [m, c] of Object.entries(result.bySource)) console.log(line(m, c));
if (result.falseDrops.length) {
  console.log(`\nLeft alone though meant for Echo (latest ${Math.min(10, result.falseDrops.length)} of ${result.falseDrops.length}):`);
  for (const d of result.falseDrops.slice(-10)) console.log(`  ${d.at.slice(0, 16)} ${d.mode.padEnd(12)} ${d.driving ? '[working] ' : ''}“${d.text}”`);
}

if (args.includes('--save')) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify({ at: new Date().toISOString(), falseDropRate: result.falseDropRate, falseAcceptRate: result.falseAcceptRate, labelled: result.labelled }, null, 2));
  console.log(`\nSaved as the baseline: ${baselineFile}`);
}
if (args.includes('--check')) {
  let base: { falseDropRate: number; falseAcceptRate: number } | null = null;
  try {
    base = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  } catch {}
  if (!base) {
    console.log('\nNo baseline yet: run with --save first.');
  } else {
    const worse = result.falseDropRate > base.falseDropRate + 0.005 || result.falseAcceptRate > base.falseAcceptRate + 0.005;
    console.log(`\nBaseline: false drops ${pct(base.falseDropRate)}, false accepts ${pct(base.falseAcceptRate)}. ${worse ? 'WORSE.' : 'Not worse.'}`);
    if (worse) process.exit(1);
  }
}
