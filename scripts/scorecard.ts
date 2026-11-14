#!/usr/bin/env node
// The weekly scorecard (ECHO_CORE_PLAN.md §6, lib/scorecard.ts): the 15 numbers every stage is
// judged by, from Echo's own logs, next to the October 2 baseline and the target.
//
//   node scripts/scorecard.ts                          the last 7 days
//   node scripts/scorecard.ts --from 2026-09-24 --to 2026-10-03
//   node scripts/scorecard.ts --json                   as JSON
//   node scripts/scorecard.ts --save                   also keep it in data/scorecard/<from>_<to>.json
//   --data DIR                                         another data folder (a copy of Echo's logs)
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { scorecard, scorecardTable } from '../lib/scorecard.ts';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = opt('--data') || config.dataDir;
const day = (s: string) => new Date(`${s}T00:00:00`).getTime();
const to = opt('--to') ? day(String(opt('--to'))) : Date.now();
const from = opt('--from') ? day(String(opt('--from'))) : to - 7 * 86_400_000;
if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
  console.error('Usage: --from YYYY-MM-DD --to YYYY-MM-DD (the "to" day is not included)');
  process.exit(2);
}
const r = scorecard(dataDir, from, to);
const label = `${new Date(from).toLocaleDateString('en-CA')} to ${new Date(to - 1).toLocaleDateString('en-CA')}`;
if (args.includes('--json')) console.log(JSON.stringify({ from, to, ...r }, null, 2));
else console.log(`Echo scorecard, ${label}: ${r.spokenTurns} spoken turns over ${r.days} day(s) with speech.\n\n${scorecardTable(r)}`);
if (args.includes('--save')) {
  const dir = path.join(dataDir, 'scorecard');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date(from).toLocaleDateString('en-CA')}_${new Date(to).toLocaleDateString('en-CA')}.json`);
  fs.writeFileSync(file, JSON.stringify({ from, to, ...r }, null, 2) + '\n');
  console.error(`Saved ${file}`);
}
