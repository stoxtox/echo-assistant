// Keeping the dispatcher's conversation small (lib/dispatcher.js).
//
// The assistant used to resume one ever-growing session: by Sep 28, 2026 each model call re-read
// about 800K tokens (~4 s and ~$0.40 a call). Now the session is rotated: past a context size, a
// number of turns, an idle gap or a new day, a fresh session starts. Its first message carries a
// short summary of the conversation so far (written by a small, cheap model), the last few
// exchanges word for word, and anything still waiting on the user (message cards, computer-use
// confirmations, a driving session), so nothing in flight is lost.
import fs from 'node:fs';
import path from 'node:path';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { fromTiming } from './timeline.ts';
import { jobLine } from './agent/journal.js';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** When to start a fresh session. Environment variables override the defaults. */
export function rotationLimits(env = process.env) {
  return {
    // Context tokens (input + cache read + cache write) of the last model call.
    // (Echo's own instructions and tools are about 45K of this before a word is said. At 60K the
    // conversation was starting over every 4 to 13 turns (Oct 7, 2026: ten times in an evening),
    // each time paying to write the whole prompt to the cache again.)
    // (Measured Oct 6 to 8 over 581 calls: the first word comes later the fuller the session is,
    // about 0.9 s at 50K, 1.0 s at 55 to 70K, 1.5 s at 70 to 100K and 1.8 s past that. A session
    // grows about 2K a turn, so 80K is some fourteen turns and keeps most of them in the fast band;
    // the thread and the summary carry what matters across, and the switch happens between turns.)
    tokens: num(env.ECHO_ROTATE_TOKENS, 80_000),
    // Never rotate a live driving session or a pending confirmation below this; above it, carry them over.
    hardTokens: num(env.ECHO_ROTATE_HARD_TOKENS, 150_000),
    // A driving session that is between turns, with nothing waiting on the user, starts fresh here
    // and is carried over. (Oct 11, 2026: twelve lively minutes on the screen went from 44K to 124K
    // without a reset, because only the hard cap applied while Echo was driving.)
    busyTokens: num(env.ECHO_ROTATE_BUSY_TOKENS, 105_000),
    turns: num(env.ECHO_ROTATE_TURNS, 40),
    idleMs: num(env.ECHO_ROTATE_IDLE_MIN, 30) * 60_000,
    // How many exchanges go into the new session word for word.
    verbatim: num(env.ECHO_ROTATE_VERBATIM, 4),
  };
}

export const SUMMARY_MODEL = process.env.ECHO_SUMMARY_MODEL || 'claude-haiku-4-5';
/** Exchanges kept since the last rotation (the summary's input). */
/** The heading of the summary's list of things carried out, kept from summary to summary (writeSummary, fallbackSummary). */
export const DONE_HEAD = 'Done so far:';
export const MAX_EXCHANGES = 80;

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The local calendar day, e.g. 2026-09-28. */
export const localDay = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: config.timezone });

/**
 * Is it time for a fresh session? Returns why, or null.
 * @param {{ sessionId?: string | null, ctxTokens?: number, sessionTurns?: number, lastTurnAt?: string, sessionDay?: string }} state
 * @param {{ now?: number, limits?: Partial<ReturnType<typeof rotationLimits>> & { tokens: number, hardTokens: number, turns: number, idleMs: number }, busyWithUser?: boolean, onlyDriving?: boolean }} [opts]
 *   busyWithUser: a driving session or a confirmation is live; only the hard token cap rotates then,
 *   or the busy cap when it is only a driving session (onlyDriving: nothing is waiting on the user)
 */
export function rotationDue(state, { now = Date.now(), limits = rotationLimits(), busyWithUser = false, onlyDriving = false } = {}) {
  if (!state?.sessionId) return null;
  const ctx = state.ctxTokens || 0;
  if (busyWithUser) return ctx >= limits.hardTokens ? 'hard_tokens' : onlyDriving && ctx >= (limits.busyTokens ?? limits.hardTokens) ? 'busy_tokens' : null;
  if (ctx >= limits.tokens) return 'tokens';
  if ((state.sessionTurns || 0) >= limits.turns) return 'turns';
  if (state.lastTurnAt && now - Date.parse(state.lastTurnAt) >= limits.idleMs) return 'idle';
  if (state.sessionDay && state.sessionDay !== localDay(now)) return 'new_day';
  return null;
}

/**
 * Add a finished exchange, keeping only the last MAX_EXCHANGES.
 * @param {Array<Exchange>} list
 * @param {Exchange} ex
 * @typedef {{ at: string, user: string, echo: string, tools?: string[] }} Exchange
 */
export function addExchange(list, ex, max = MAX_EXCHANGES) {
  const next = [...(list || []), { at: ex.at, user: clip(ex.user, 800), echo: clip(ex.echo, 800), ...(ex.tools?.length ? { tools: ex.tools.slice(0, 8).map((t) => clip(t, 160)) } : {}) }];
  return next.slice(-max);
}

const exchangeText = (e) => `[${e.at.slice(11, 16)}] User: ${e.user}${e.tools?.length ? `\n  (tools: ${e.tools.join('; ')})` : ''}\n  Echo: ${e.echo || '(no spoken reply)'}`;

/**
 * What's still waiting on the user right now, in words the new session can act on (ids included).
 * @param {{ messages?: Array<{ id: string, name: string, masked: string, text: string }>,
 *   actions?: Array<{ id: string, what: string, app?: string }>,
 *   driving?: { app?: string, requests?: number } | null,
 *   job?: import('./agent/journal.js').Job | null }} live job: an unfinished job on the Mac (lib/agent/journal.js)
 */
export function pendingLines({ messages = [], actions = [], driving = null, job = null } = {}) {
  const lines = [];
  // An unfinished job on the Mac (lib/agent/journal.js): its goal and how far it got.
  if (job) lines.push(jobLine(job));
  for (const m of messages) lines.push(`- Message card waiting in the window: pending_id ${m.id}, to ${m.name} (${m.masked}): "${clip(m.text, 200)}". On a clear yes or no, call confirm_message with this pending_id.`);
  for (const a of actions) lines.push(`- Computer action waiting for the user's OK: id ${a.id}, ${clip(a.what, 160)}${a.app ? ` in ${a.app}` : ''}. On a clear yes or no, call confirm_action with this id.`);
  if (driving) lines.push(`- You are in a driving session${driving.app ? ` in ${driving.app}` : ''} (request ${driving.requests || 1}). It is still open: carry on in the same app, and call stop_driving when the user is done.`);
  return lines;
}

/**
 * The first message of a fresh session, before the user's words.
 * @param {{ summary?: string, recent?: Exchange[], pending?: string[] }} seed
 */
export function seedText({ summary = '', recent = [], pending = [] }) {
  return [
    '[conversation carried over] A fresh session started to keep replies fast. This is what came before; treat it as your own memory of the conversation and don\'t mention the switch.',
    summary.trim() ? `Summary so far:\n${summary.trim()}` : '',
    pending.length ? `Still waiting on the user (carry these over exactly):\n${pending.join('\n')}` : '',
    recent.length ? `Last exchanges, word for word:\n${recent.map(exchangeText).join('\n')}` : '',
    '[end of carried-over context; the new message follows]',
  ].filter(Boolean).join('\n\n');
}

/** The "Done so far" part of a summary, heading included ('' when it has none). @param {string} summary */
export function doneLines(summary) {
  const s = String(summary || '');
  const at = s.indexOf(DONE_HEAD);
  return at < 0 ? '' : s.slice(at).trim();
}

/** A summary without a model call: the previous summary, then a line per older exchange. */
export function fallbackSummary(prev, exchanges, verbatim = rotationLimits().verbatim) {
  const older = (exchanges || []).slice(0, Math.max(0, (exchanges || []).length - verbatim)).slice(-15);
  const lines = older.map((e) => `- ${e.at.slice(11, 16)} user: ${clip(e.user, 90)} / echo: ${clip(e.echo, 90)}`);
  return [String(prev || '').trim(), lines.length ? `Earlier since then:\n${lines.join('\n')}` : ''].filter(Boolean).join('\n');
}

/**
 * A compact rolling summary written by a small, fast model.
 * @param {string} prev the summary from the last rotation
 * @param {Exchange[]} exchanges since then
 * @param {{ queryFn?: (p: { prompt: any, options: any }) => AsyncIterable<any>, timeoutMs?: number, onCost?: (usd: number) => void }} [opts]
 * @returns {Promise<{ summary: string, ms: number, fallback: boolean }>}
 */
export async function writeSummary(prev, exchanges, { queryFn = sdkQuery, timeoutMs = 25_000, onCost } = {}) {
  const started = Date.now();
  if (!exchanges?.length) return { summary: String(prev || ''), ms: 0, fallback: false };
  const prompt = `You keep the running memory of a voice assistant's conversation with its user. Update the summary below with the new exchanges. Plain text, no preamble, in two parts.

First, at most 15 short lines covering:
- key facts and decisions (names, times, places, amounts, what was agreed)
- open threads and questions still waiting for an answer
- anything waiting on a confirmation (message cards, actions), with its ids exactly as written
- tasks and workers mentioned, with their ids and latest state
- what the user is focused on right now
Drop small talk.

Then a part that begins with the line "${DONE_HEAD}" and has one short line for each thing that was actually carried out and that the user may ask about again: what was sent, uploaded, submitted, saved, created, deleted or changed, to whom or where, and how it ended (delivered, failed, waiting for review). Copy every line of this part from the previous summary unchanged, add the new ones, and never drop one because it is finished: a finished thing is exactly what gets asked about ("did you upload them?"). At most 20 lines; when there are more, merge the oldest.

Previous summary:
${String(prev || '').trim() || '(none)'}

New exchanges:
${exchanges.map(exchangeText).join('\n')}`;
  const run = async () => {
    let out = '';
    for await (const msg of queryFn({
      prompt,
      options: { model: SUMMARY_MODEL, tools: [], maxTurns: 1, persistSession: false, settingSources: [], permissionMode: 'dontAsk', systemPrompt: 'You write compact, factual conversation summaries.', thinking: { type: 'disabled' } },
    })) {
      if (msg.type === 'result') {
        if (msg.total_cost_usd) onCost?.(msg.total_cost_usd);
        if (msg.subtype === 'success') out = msg.result || '';
      }
    }
    return out.trim();
  };
  let timer;
  try {
    const summary = await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('summary timed out')), timeoutMs); timer.unref?.(); })]);
    if (!summary) throw new Error('empty summary');
    // The model left the list of things done out, or shortened it away: the old one is kept.
    const kept = summary.includes(DONE_HEAD) ? summary : [summary, doneLines(prev)].filter(Boolean).join('\n');
    return { summary: kept.slice(0, 6000), ms: Date.now() - started, fallback: false };
  } catch {
    return { summary: fallbackSummary(prev, exchanges), ms: Date.now() - started, fallback: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Context size of one model call, from its usage. */
export const contextTokens = (u) => (u?.input_tokens || 0) + (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);

/** One line per model call, turn and rotation in data/dispatcher-timing.jsonl (scripts/dispatcher-report.js reads it). */
export function logTiming(entry, file = path.join(config.dataDir, 'dispatcher-timing.jsonl')) {
  try {
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
  // And on the one timeline (lib/timeline.ts): models, counts and durations only.
  fromTiming(entry);
}

/**
 * Exchanges read back from a day's conversation log (data/conversations/<day>.md), for the first
 * rotation after an upgrade, when there is no record of the old session's exchanges yet.
 * @param {string} md
 * @param {string} day e.g. 2026-09-28
 * @returns {Exchange[]}
 */
export function exchangesFromLog(md, day, max = 12) {
  /** @type {Exchange[]} */
  const out = [];
  for (const m of String(md || '').matchAll(/^\*\*\[([^\]]+)\] (User|Assistant|Event):\*\* (.*)$/gm)) {
    const [, time, who, said] = m;
    const at = `${day}T${to24(time)}`;
    if (who === 'Assistant' && out.length) out[out.length - 1].echo = clip(`${out[out.length - 1].echo} ${said}`, 800);
    else if (who !== 'Assistant') out.push({ at, user: clip(who === 'Event' ? `[event] ${said}` : said, 800), echo: '' });
  }
  return out.slice(-max);
}

function to24(t) {
  const m = String(t).match(/(\d+):(\d+)(?::(\d+))?\s*(AM|PM)?/i);
  if (!m) return '00:00:00';
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[4] || '')) h += 12;
  else if (!m[4]) h = Number(m[1]);
  return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}
