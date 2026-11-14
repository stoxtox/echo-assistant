#!/usr/bin/env node
// How long Echo takes to start speaking, and where that time goes: the pause that ends your
// sentence, the model's first words (and any thinking before them), the voice starting, and
// how often a new answer had to wait behind the old one's voice. From the timeline: numbers only.
//
//   npm run speed -- --since 1d        the last day (30m, 2h, 3d)
//   npm run speed -- --data DIR        another data folder
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';
import { readTimeline, when, type Row } from '../lib/timeline.ts';
import { secs, span } from '../lib/timelineview.ts';

export type Speed = {
  turns: number;
  firstSound: { median: number; p90: number };
  /** Turns with no tool before the first word and no wait behind old speech: the plain path. */
  plain: { n: number; median: number; p90: number };
  toolFirst: { n: number; median: number };
  /** The new answer's words were ready but its voice came more than 3 s later (queued behind the old answer). */
  queued: number;
  /** Times a new turn cut the old answer's voice off instead. */
  cut: number;
  firstToken: number;
  firstWords: number;
  thinking: { n: number; median: number };
  voiceStart: number;
  /** Second listens that restarted a turn (about 1.3 s each). */
  restarted: number;
};

const pick = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] as number) : 0;
};

export function speed(rows: Row[]): Speed {
  const by = new Map<string, Row[]>();
  for (const r of rows) if (r.trace) by.set(r.trace, [...(by.get(r.trace) || []), r]);
  const all: number[] = [], plain: number[] = [], tool: number[] = [], token: number[] = [], words: number[] = [], think: number[] = [], voice: number[] = [];
  let queued = 0;
  for (const t of by.values()) {
    const start = t.find((r) => r.type === 'turn.start'), sound = t.find((r) => r.type === 'turn.first_sound'), ready = t.find((r) => r.type === 'turn.first_speech');
    if (!start || !sound || (start.f.source !== 'speech' && start.f.source !== 'typed')) continue;
    const fs = Number(sound.f.ms), fr = ready ? Number(ready.f.ms) : fs;
    all.push(fs);
    const waited = fs - fr > 3000;
    if (waited) queued++;
    else voice.push(fs - fr);
    const toolFirst = t.some((r) => r.type === 'turn.tool_start' && when(r) - when(start) < fr);
    if (toolFirst) tool.push(fs);
    else if (!waited) plain.push(fs);
    const req = t.find((r) => r.type === 'model.request');
    if (req && typeof req.f.firstMs === 'number') token.push(req.f.firstMs);
    if (req && typeof req.f.textMs === 'number' && !toolFirst) words.push(req.f.textMs);
    if (req && typeof req.f.thinkMs === 'number') think.push(req.f.thinkMs);
  }
  return {
    turns: all.length,
    firstSound: { median: pick(all, 0.5), p90: pick(all, 0.9) },
    plain: { n: plain.length, median: pick(plain, 0.5), p90: pick(plain, 0.9) },
    toolFirst: { n: tool.length, median: pick(tool, 0.5) },
    queued,
    cut: rows.filter((r) => r.type === 'play.cut').length,
    firstToken: pick(token, 0.5),
    firstWords: pick(words, 0.5),
    thinking: { n: think.length, median: pick(think, 0.5) },
    voiceStart: pick(voice, 0.5),
    restarted: rows.filter((r) => r.type === 'speech.second' && r.f.outcome === 'restarted').length,
  };
}

export function render(s: Speed): string[] {
  if (!s.turns) return ['No turns with a spoken answer in that time.'];
  return [
    `${s.turns} turns. First sound after the turn began: ${secs(s.firstSound.median)} for half of them, ${secs(s.firstSound.p90)} for the slowest tenth.`,
    `Plain turns (no tool first, nothing queued): ${s.plain.n}, ${secs(s.plain.median)} for half, ${secs(s.plain.p90)} for the slowest tenth.`,
    `Turns that used a tool before speaking: ${s.toolFirst.n}, ${secs(s.toolFirst.median)} for half.`,
    `Waited more than 3 s behind the old answer's voice: ${s.queued}. Old answer cut off by a new turn instead: ${s.cut}.`,
    `Where a plain turn's time goes: the model's first sign of life ${secs(s.firstToken)}${s.firstWords ? `, its first words ${secs(s.firstWords)}` : ''}${s.thinking.n ? ` (it thought first in ${s.thinking.n} calls, ${secs(s.thinking.median)} for half)` : ''}, then the voice ${secs(s.voiceStart)}.`,
    `Turns restarted by the second listen (about 1.3 s each): ${s.restarted}.`,
    'Not counted here: the pause that ends your sentence, before the turn begins (0.7 to 1.3 s; none with a held key).',
  ];
}

function main(argv: string[]): void {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = span(opt('--since') ?? '1d');
  if (!Number.isFinite(since)) {
    console.error('--since takes a time like 30m, 2h or 3d.');
    process.exitCode = 2;
    return;
  }
  const dataDir = opt('--data') ? path.resolve(opt('--data') as string) : config.dataDir;
  const now = Date.now();
  const s = speed(readTimeline(dataDir, now - since, now));
  console.log(argv.includes('--json') ? JSON.stringify(s) : render(s).join('\n'));
}

// Run as a program (not when a test imports it).
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
