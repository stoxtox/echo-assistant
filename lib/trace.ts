// One id per turn, from the moment a sentence (or a typed message, or a task event) arrives, so a
// turn can be followed through every log: data/stt-log.jsonl (hearing), dispatcher-timing.jsonl
// (model calls), computer-log.jsonl (actions) and data/events.jsonl (the turn's milestones).
// The core plan's "event spine" (ECHO_CORE_PLAN.md D15) starts here: events.jsonl holds typed
// milestones a replay, a scorecard or a trace viewer can read without knowing every other log.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { fromEvent } from './timeline.ts';

/** A trace id that sorts by time: t-<ms in base 36>-<4 hex>. */
export function newTrace(now: number = Date.now()): string {
  return `t-${now.toString(36)}-${randomBytes(2).toString('hex')}`;
}

/** When a trace id was made (ms), or NaN for anything else. */
export function traceTime(id: string): number {
  const m = /^t-([0-9a-z]+)-[0-9a-f]{4}$/.exec(String(id || ''));
  return m && m[1] ? parseInt(m[1], 36) : NaN;
}

/** The milestones of a turn, in the order they happen. */
export type TurnEvent =
  | { type: 'turn_start'; trace: string; source: 'speech' | 'typed' | 'event'; model?: string }
  | { type: 'first_speech'; trace: string; ms: number }
  // When Echo's voice became audible for the turn (the page says so: lib/server/window.js voice_started).
  | { type: 'first_sound'; trace: string; ms: number }
  // Said while a reply was under way (lib/dispatcher.js holdNext / watchSlow): a sentence joined the
  // waiting turn, a repeat of it was held back, a line about a slow reply was said.
  | { type: 'merged'; trace: string; into: string }
  | { type: 'repeat_held'; trace: string }
  | { type: 'next_dropped'; trace: string; count: number }
  | { type: 'catch_up'; trace: string; count: number }
  | { type: 'slow_notice'; trace: string; text: string }
  // The turn's first move was a tool, and Echo said a short word at once (lib/dispatcher.js watchTool): how far into the turn, and the tool's name.
  | { type: 'ack'; trace: string; ms: number; tool: string }
  // "Can you hear me?" answered at once while busy (lib/status.js).
  | { type: 'status_answer'; trace: string }
  // Every tool call, by name only (never what went in or came out): how long it took, whether it worked.
  | { type: 'tool_start'; trace: string; name: string }
  | { type: 'tool_end'; trace: string; name: string; ms: number; ok: boolean }
  // The model decided a sentence wasn't for Echo and stayed quiet (lib/dispatcher.js finishTurn).
  | { type: 'dropped'; trace: string; reason: 'quiet' }
  // folded: the session answered this turn's message in the same reply as the turn before it (`into`).
  | { type: 'turn_end'; trace: string; ms: number; requests: number; ctx: number; spoke: boolean; spokenChars?: number; textChars?: number; brief?: boolean; quiet?: boolean; folded?: boolean; into?: string };

export const eventsFile = (dataDir: string = config.dataDir): string => path.join(dataDir, 'events.jsonl');

/** Add a milestone to data/events.jsonl. Never throws: logging must not get in the way of a turn. */
export function logEvent(e: TurnEvent, file: string = eventsFile()): void {
  try {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n');
  } catch {}
  // And on the one timeline (lib/timeline.ts): the milestone and its numbers, never a line's text.
  fromEvent(e);
}
