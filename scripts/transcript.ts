#!/usr/bin/env node
// Reads a session back as a conversation: what you said, what Echo showed and said, each with
// its time, and (from the timeline) how long Echo took to start speaking, which tools it used
// and when each line was actually heard.
//
//   npm run transcript -- --since 30m          the last half hour (30s, 10m, 2h, 1d)
//   npm run transcript -- --since 2h --full    also the reply text as the window showed it
//   npm run transcript -- --json               the lines themselves, one per line
//   npm run transcript -- --data DIR           another data folder
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { readTranscript, transcriptDir, type Line } from '../lib/transcript.ts';
import { readTimeline, when, type Row } from '../lib/timeline.ts';
import { secs, clock, span } from '../lib/timelineview.ts';

const pad = ' '.repeat(10);
const hms = (ms: number): string => clock(ms).slice(0, 8);

/** The conversation, one line per thing said, with what the timeline knows about each turn. */
export function render(lines: Line[], rows: Row[], o: { full?: boolean } = {}): string[] {
  const byTrace = new Map<string, Row[]>();
  for (const r of rows) if (r.trace) byTrace.set(r.trace, [...(byTrace.get(r.trace) || []), r]);
  /** When each spoken line began to play: the next unused play.start of its turn with as many characters. */
  const used = new Set<Row>();
  const playedAt = (l: Line): number | null => {
    const plays = (byTrace.get(l.trace || '') || []).filter((r) => r.type === 'play.start' && !used.has(r));
    const hit = plays.find((r) => Number(r.f.chars) === l.text.length) || plays[0];
    if (!hit) return null;
    used.add(hit);
    return when(hit);
  };
  const out: string[] = [];
  for (const l of lines) {
    const t = Date.parse(l.ts);
    if (l.who === 'you') {
      const how = l.kind === 'typed' ? 'typed' : l.kind === 'unanswered' ? `not passed on: ${l.reason || 'unknown'}` : l.mode || '';
      if (out.length) out.push('');
      out.push(`${hms(t)}  You${how ? ` (${how})` : ''}: ${l.text}${l.heard ? `   [heard as: ${l.heard}]` : ''}`);
      const turn = byTrace.get(l.trace || '') || [];
      const first = turn.find((r) => r.type === 'turn.first_sound');
      const end = turn.find((r) => r.type === 'turn.end');
      const tools = turn.filter((r) => r.type === 'turn.tool_start').map((r) => String(r.f.name || r.f.tool || '')).filter(Boolean);
      const bits = [
        first ? `first sound after ${secs(first.f.ms)}` : '',
        tools.length ? `tools: ${[...new Set(tools)].join(', ')}` : '',
        end ? `turn took ${secs(end.f.ms)}` : '',
        end?.f.quiet ? 'Echo chose to stay quiet' : '',
      ].filter(Boolean);
      if (bits.length) out.push(`${pad}· ${bits.join(' · ')}`);
    } else if (l.kind === 'shown') {
      if (o.full) out.push(`${hms(t)}  Echo showed: ${l.text.replace(/\n+/g, ' ⏎ ')}`);
    } else {
      const at = playedAt(l);
      out.push(`${hms(t)}  Echo${l.kind === 'step' ? ' (working)' : ''}: ${l.text}${at ? `   [heard ${hms(at)}${at - t > 1500 ? `, ${secs(at - t)} later` : ''}]` : ''}`);
    }
  }
  return out;
}

function main(argv: string[]): void {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: npm run transcript -- --since 30m [--full] [--json] [--data DIR]');
    return;
  }
  const since = span(opt('--since') ?? '30m');
  if (!Number.isFinite(since)) {
    console.error('--since takes a time like 30s, 10m, 2h or 1d.');
    process.exitCode = 2;
    return;
  }
  const dataDir = opt('--data') ? path.resolve(opt('--data') as string) : config.dataDir;
  const now = Date.now();
  const lines = readTranscript(dataDir, now - since, now);
  if (argv.includes('--json')) {
    for (const l of lines) console.log(JSON.stringify(l));
    return;
  }
  const out = render(lines, readTimeline(dataDir, now - since - 60_000, now), { full: argv.includes('--full') });
  console.log(out.length ? out.join('\n') : `Nothing in the conversation log for the last ${opt('--since') ?? '30m'} (${transcriptDir(dataDir)}). It is written while "Keep a conversation log" is on in Settings.`);
}

// Run as a program (not when a test imports it).
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
