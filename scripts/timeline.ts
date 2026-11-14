#!/usr/bin/env node
// Reads Echo's timeline (lib/timeline.ts) back as a story: one plain-English line per event from
// the Mac app, the page and the server, in the order they happened, with the quiet stretches and
// the slow steps marked, and after each turn where its time went.
//
//   npm run timeline -- --since 10m            the last ten minutes (30s, 10m, 2h, 1d)
//   npm run timeline -- --since 1h --slow      only the gaps, the slow steps, what went wrong and the turn summaries
//   npm run timeline -- --trace t-abc-1234     one turn
//   npm run timeline -- --json                 the rows themselves, one per line
//   npm run timeline -- --data DIR             another data folder
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { readTimeline, when, type Row } from '../lib/timeline.ts';
import { GAP_MS, HIDDEN, secs, clock, describe, mark, turnSummary, span } from '../lib/timelineview.ts';

// The wording lives in lib/timelineview.ts (the window's "What happened" view uses it too).
export { describe, mark, turnSummary, span };

/**
 * The story of these rows, one line each.
 * @param o.trace only this turn; o.slow only gaps, slow steps, problems and turn summaries
 */
export function render(all: Row[], o: { trace?: string; slow?: boolean } = {}): string[] {
  const rows = (o.trace ? all.filter((r) => r.trace === o.trace) : all).filter((r) => !HIDDEN.has(r.type));
  const out: string[] = [];
  const pad = ' '.repeat(14);
  let last = NaN;
  for (const r of rows) {
    const t = when(r);
    if (t - last >= GAP_MS) out.push(`${pad}${'·'.padEnd(8)}${secs(t - last)} with nothing happening`);
    last = t;
    const flag = mark(r);
    if (!o.slow || flag) out.push(`${clock(t)}  ${r.src.padEnd(8)}${describe(r)}${flag}`);
    // Summed over every row, not only this turn's: listening happens before the turn has an id.
    if (r.type === 'turn.end' && r.trace) out.push(`${pad}${'='.padEnd(8)}${turnSummary(r.trace, all)}`, '');
  }
  return out;
}

function main(argv: string[]): void {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npm run timeline -- --since 10m [--trace id] [--slow] [--json] [--data DIR]');
    return;
  }
  const since = span(opt('--since') ?? '10m');
  if (!Number.isFinite(since)) {
    console.error('--since takes a time like 30s, 10m, 2h or 1d.');
    process.exitCode = 2;
    return;
  }
  const dataDir = opt('--data') ? path.resolve(opt('--data') as string) : config.dataDir;
  const trace = opt('--trace');
  const now = Date.now();
  const rows = readTimeline(dataDir, now - since, now);
  if (argv.includes('--json')) {
    for (const r of trace ? rows.filter((x) => x.trace === trace) : rows) console.log(JSON.stringify(r));
    return;
  }
  const lines = render(rows, { trace, slow: argv.includes('--slow') });
  console.log(lines.length ? lines.join('\n') : `Nothing on the timeline in the last ${opt('--since') ?? '10m'}${trace ? ` for ${trace}` : ''} (${path.join(dataDir, 'timeline')}).`);
}

// Run as a program (not when a test imports it).
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
