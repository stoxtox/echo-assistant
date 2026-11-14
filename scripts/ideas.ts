#!/usr/bin/env node
// What the user wished Echo could do, as Echo noted it (the save_idea tool, data/ideas.jsonl).
//
//   npm run ideas                 every idea, newest last
//   npm run ideas -- --data DIR   another data folder
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';

const i = process.argv.indexOf('--data');
const file = path.join(i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1] as string) : config.dataDir, 'ideas.jsonl');
let lines: string[] = [];
try {
  lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
} catch {}
if (!lines.length) console.log(`No ideas noted yet (${file}).`);
for (const l of lines) {
  try {
    const r = JSON.parse(l);
    console.log(`${String(r.ts).slice(0, 16).replace('T', ' ')}  ${r.idea}${r.said ? `\n                  they said: “${r.said}”` : ''}`);
  } catch {}
}
