// Listening while Echo works: what may cut into an action under way, and what has to wait.
//
// A spoken "stop", "wait", "no, go back" or a correction interrupts the step Echo is doing. A TV
// or a podcast says those words all the time, so an interruption needs all four:
//   1. addressed to Echo (addressee v1 accepted it: lib/addressed.js judgeAddressee),
//   2. heard clearly (the recognizer's confidence; with no scores, only if it says "Echo"),
//   3. short: 5 words or fewer, or "Echo, …",
//   4. near: loud enough and well above the room's own sound (clipLoudness). A voice across the
//      room or out of a speaker sits in a room full of that same sound; yours is close to the mic.
//      While audio plays on the Mac (lib/mediaplaying.js) the bar is higher.
// Anything else is held: the step goes on, and the assistant sees it at the next step as
// "heard nearby, maybe not for you". An unsure "stop" gets the "Was that for me?" chip instead,
// and stop always works from the Stop button, Escape, or by taking the mouse.
import { routeSpeech, midRunKind } from './computer.js';
import { nameAnywhere } from './addressed.js';
import { wavSamples } from './heard.js';

/** Speech this loud (RMS of its loudest frames, 0..1) or more can be someone at the Mac. */
export const NEAR_MIN_LEVEL = 0.015;
/** How far above the room's own sound (dB) a close voice stands. */
export const NEAR_MIN_SNR_DB = 12;
/** The same while audio plays on the Mac. */
export const NEAR_MEDIA_SNR_DB = 18;
/** Under this background level (RMS) the room is quiet: no TV or music under the voice. */
export const QUIET_FLOOR = 0.006;
/** An interruption is at most this many words (unless it starts with her name). */
export const INTERRUPT_MAX_WORDS = 5;

/**
 * How long after Echo's reply ended the sentence BEGAN. The page stamps the time when it sends
 * the clip, which is the sentence's end: with an 8 s window, a 4 s sentence (and the second of
 * quiet that ends a clip) had to begin within about 2.7 s. Every window check uses this instead.
 * Zero when the sentence began before the reply had ended (you talked over it).
 * @param {unknown} sinceReplyMs from the end of the reply to when the clip was sent
 * @param {unknown} [clipMs] how long the clip is
 * @returns {number | undefined} undefined when the time since the reply isn't known
 */
export function sinceReplyAtOnset(sinceReplyMs, clipMs = 0) {
  if (typeof sinceReplyMs !== 'number' || !Number.isFinite(sinceReplyMs)) return undefined;
  const len = typeof clipMs === 'number' && clipMs > 0 ? clipMs : 0;
  return Math.max(0, Math.round(sinceReplyMs - len));
}

const words = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * How loud the voice in a clip is against the room: the loudest frames (90th percentile of 20 ms
 * RMS) and the quietest (15th percentile, the room between words). Null for a clip too short to tell.
 * @param {Buffer} wav
 * @returns {{ level: number, floor: number, snrDb: number } | null}
 */
export function clipLoudness(wav) {
  const got = wavSamples(wav);
  if (!got) return null;
  const { samples, rate } = got;
  const size = Math.max(1, Math.round(rate * 0.02));
  const frames = [];
  for (let i = 0; i + size <= samples.length; i += size) {
    let sum = 0;
    for (let j = i; j < i + size; j++) sum += samples[j] * samples[j];
    frames.push(Math.sqrt(sum / size));
  }
  if (frames.length < 10) return null;
  frames.sort((a, b) => a - b);
  const at = (q) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))];
  const level = at(0.9);
  const floor = at(0.15);
  const snrDb = 20 * Math.log10(Math.max(level, 1e-6) / Math.max(floor, 1e-5));
  return { level: +level.toFixed(4), floor: +floor.toFixed(4), snrDb: +snrDb.toFixed(1) };
}

/**
 * Is the voice close to the mic? Null when there's no clip to measure.
 * @param {{ level: number, floor: number, snrDb: number } | null | undefined} loud
 * @param {boolean} [mediaPlaying]
 */
export function isNear(loud, mediaPlaying = false) {
  if (!loud) return null;
  return loud.level >= NEAR_MIN_LEVEL && loud.snrDb >= (mediaPlaying ? NEAR_MEDIA_SNR_DB : NEAR_MIN_SNR_DB);
}

/**
 * A quiet room (nothing playing under the voice), from the page's own measure when it has one,
 * else from the clip.
 * @param {{ pageQuiet?: boolean, loud?: { floor: number } | null, mediaPlaying?: boolean }} o
 * @returns {boolean | undefined}
 */
export function quietRoom({ pageQuiet, loud, mediaPlaying = false }) {
  if (mediaPlaying) return false;
  if (typeof pageQuiet === 'boolean') return pageQuiet;
  if (!loud) return undefined;
  return loud.floor < QUIET_FLOOR;
}

/** Starts with her name: "Echo, stop", "hey Echo go back". */
const LEADS_WITH_NAME = /^(?:(?:hey|ok|okay|oh|no) )*(?:echo|eko|ekko|ekho)\b/;

/**
 * Would this cut into the action under way? stop / wait / "that's all" mid-step, or a correction
 * or an answer that changes the step now ("no, the other one", "go back", "yes" to a card).
 * @param {string} text @param {{ busy?: boolean, answering?: boolean }} o
 * @returns {'stop' | 'pause' | 'now' | null}
 */
export function interruptKind(text, { busy = true, answering = false } = {}) {
  const route = routeSpeech({ text, driving: true, busy });
  if (route === 'stop' || route === 'end') return 'stop';
  if (route === 'pause') return 'pause';
  if (route === 'instruct' && midRunKind(text, { answering }) === 'now') return 'now';
  return null;
}

/**
 * May this interrupt the action under way? All four: addressed, clear, short, near.
 * @param {{ text: string, accepted: boolean, clarity?: 'ok' | 'low' | 'unknown',
 *   loud?: { level: number, floor: number, snrDb: number } | null, mediaPlaying?: boolean }} o
 * @returns {{ pass: boolean, why: 'ok' | 'not_addressed' | 'unclear' | 'long' | 'far' }}
 */
export function interruptGate({ text, accepted, clarity = 'unknown', loud = null, mediaPlaying = false }) {
  const w = words(text);
  const named = LEADS_WITH_NAME.test(w.join(' ')) || nameAnywhere(text);
  if (!accepted) return { pass: false, why: 'not_addressed' };
  if (!(clarity === 'ok' || (clarity === 'unknown' && named))) return { pass: false, why: 'unclear' };
  if (w.length > INTERRUPT_MAX_WORDS && !LEADS_WITH_NAME.test(w.join(' '))) return { pass: false, why: 'long' };
  // While audio plays, "stop" alone needs a clearly closer voice; "Echo, stop" the usual one.
  const near = isNear(loud, mediaPlaying && !named);
  // No clip to measure (live words only): her name has to carry it.
  if (near === false || (near === null && !named)) return { pass: false, why: 'far' };
  return { pass: true, why: 'ok' };
}

/**
 * What to do with speech heard while Echo drives the Mac, once addressee v1 has judged it.
 *   'go'     : a turn or a new request, as before (it doesn't cut in)
 *   'cut'    : it interrupts the step now (stop, wait, a correction), and it passed interruptGate
 *   'hold'   : a correction that didn't pass: the step goes on, the assistant sees it next step
 *   'ask'    : a stop or wait that didn't pass: the "Was that for me?" chip
 *   'ignore' : not for Echo
 * @param {{ text: string, decision: string, busy?: boolean, answering?: boolean,
 *   clarity?: 'ok' | 'low' | 'unknown', loud?: { level: number, floor: number, snrDb: number } | null, mediaPlaying?: boolean }} o
 * @returns {{ action: 'go' | 'cut' | 'hold' | 'ask' | 'ignore', kind: 'stop' | 'pause' | 'now' | null, why: string }}
 */
export function midRunDecision({ text, decision, busy = true, answering = false, clarity = 'unknown', loud = null, mediaPlaying = false }) {
  const kind = interruptKind(text, { busy, answering });
  if (decision !== 'accept') {
    return { action: decision === 'ask' ? 'ask' : 'ignore', kind, why: 'not_addressed' };
  }
  if (!kind) return { action: 'go', kind, why: 'no_interrupt' };
  const g = interruptGate({ text, accepted: true, clarity, loud, mediaPlaying });
  if (g.pass) return { action: 'cut', kind, why: g.why };
  return { action: kind === 'now' ? 'hold' : 'ask', kind, why: g.why };
}
