#!/usr/bin/env node
// One turn's story from every log, in time order: what was heard, how the turn ran, which model
// calls it made, what it did on the Mac (lib/trace.ts).
//
//   node scripts/trace.ts <trace id>     that turn
//   node scripts/trace.ts --last [n]     the last n turns (default 1), newest last
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { eventsFile } from '../lib/trace.ts';

type Line = { at: string; trace?: string; [k: string]: unknown };
const LOGS: Record<string, string> = {
  hear: path.join(config.dataDir, 'stt-log.jsonl'),
  turn: eventsFile(),
  model: path.join(config.dataDir, 'dispatcher-timing.jsonl'),
  mac: path.join(config.dataDir, 'computer-log.jsonl'),
};

function read(file: string): Line[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
    try {
      const v = JSON.parse(l);
      return v && typeof v === 'object' ? [v as Line] : [];
    } catch {
      return [];
    }
  });
}

const BORING = new Set(['at', 'trace', 'type', 'event']);
function describe(source: string, l: Line): string {
  const kind = String(l.type || l.event || (source === 'hear' ? 'heard' : ''));
  const rest = Object.entries(l)
    .filter(([k, v]) => !BORING.has(k) && v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
    .join(' ');
  return `${l.at.slice(11, 23)}  ${source.padEnd(5)} ${kind.padEnd(14)} ${rest}`;
}

export function traceStory(id: string): string[] {
  const rows: Array<[string, Line]> = [];
  for (const [source, file] of Object.entries(LOGS)) for (const l of read(file)) if (l.trace === id) rows.push([source, l]);
  rows.sort((a, b) => a[1].at.localeCompare(b[1].at));
  return rows.map(([s, l]) => describe(s, l));
}

const args = process.argv.slice(2);
if (args[0] === '--last') {
  const n = Number(args[1]) || 1;
  const ids = read(LOGS.turn as string).filter((e) => e.type === 'turn_start' && e.trace).map((e) => String(e.trace));
  for (const id of ids.slice(-n)) console.log(`\n${id}\n${traceStory(id).join('\n')}`);
} else if (args[0]) {
  const story = traceStory(args[0]);
  console.log(story.length ? story.join('\n') : `Nothing logged with trace ${args[0]}.`);
} else {
  console.log('Usage: node scripts/trace.ts <trace id> | --last [n]');
}
