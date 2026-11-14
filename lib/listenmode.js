// One way of listening, in three states (Oct 8, 2026):
//   listening  the mic is open and anything said to Echo gets through
//   resting    the mic is open for its name only
//   off        the mic is off; a held key and typing still work
// The state is one setting (listenMode). This file holds what moves it: the words that ask for it,
// and the quiet that lets it rest. Pure, so the tests call it directly.

/** @typedef {'listening' | 'resting' | 'off'} ListenMode */
export const LISTEN_MODES = /** @type {const} */ (['listening', 'resting', 'off']);
/** Listening drifts to Resting after this long with nothing said by either side. */
export const QUIET_REST_MS = 3 * 60 * 1000;

/** @param {unknown} m @returns {ListenMode} */
export const listenModeOf = (m) => (LISTEN_MODES.includes(/** @type {any} */ (m)) ? /** @type {ListenMode} */ (m) : 'resting');

const LEAD = "(?:(?:ok(?:ay)?|alright|all right|echo|hey echo|now|please|thanks|thank you)[,.!]?\\s+)*";
const TAIL = "(?:\\s+(?:now|please|echo|for now|for a (?:bit|while|minute|moment)))*[.!]*\\s*$";
/** "Stop listening", "mic off": the mic goes off. Only when that is the whole sentence. */
const MIC_OFF = new RegExp(`^\\s*${LEAD}(?:stop listening(?: to me)?|(?:turn |switch )?(?:the |your )?mic(?:rophone)? off|(?:turn|switch) off (?:the |your )?mic(?:rophone)?|mute (?:yourself|your mic(?:rophone)?))${TAIL}`, 'i');
/** "Go quiet", "that's all for now", "go to sleep": Echo rests until its name. */
const REST = new RegExp(`^\\s*${LEAD}(?:(?:go|be|stay|keep) quiet|quiet now|that'?s (?:all|it|enough)|we'?re done|i'?m done|good ?bye|bye(?: bye)?|go to sleep|(?:you can )?rest|take a (?:break|rest))${TAIL}`, 'i');

/**
 * What a sentence said to Echo asks its listening to become, or null.
 * @param {unknown} text @returns {'resting' | 'off' | null}
 */
export function spokenMode(text) {
  const t = String(text || '').replace(/[’‘]/g, "'");
  if (MIC_OFF.test(t)) return 'off';
  if (REST.test(t) || SHUSH.test(t) || notToEcho(t)) return 'resting';
  return null;
}

/** "Shhh", "shush", "hush": rest. */
const SHUSH = /^\s*(?:s+h+h*|shush|hush)(?:\s+(?:echo|now|please))*[.!]*\s*$/i;
const NOT_YOU = /\b(?:i (?:was|am)(?: not|n't) talking to you|i'm not talking to you|(?:was|am|'m)(?: not|n't) (?:talking|speaking) to you|not (?:talking|speaking) to you|that (?:was|is)(?: not|n't) for you|not for you|^\s*not you\b|not you,? echo|i was (?:talking|speaking) (?:to|with) (?:my |some|him|her|them))/i;
/**
 * "I wasn't talking to you", "that wasn't for you", "I was talking to my wife": what came before
 * was not said to Echo. It rests, and what it picked up is to be forgotten. A short sentence only.
 * @param {unknown} text
 */
export function notToEcho(text) {
  const t = String(text || '').replace(/[’‘]/g, "'");
  return t.split(/\s+/).length <= 18 && NOT_YOU.test(t);
}

/**
 * Does a reply only say that Echo did not catch what was said? Such a reply is no part of a
 * conversation: it must not hold the window open for more of what it could not follow, and two
 * in a row mean Echo is hearing something that is not for it.
 * @param {unknown} reply
 */
export function onlyDidntCatch(reply) {
  const t = String(reply || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length > 240) return false;
  return /^(?:sorry[,.]? |hmm[,.]? )?(?:i (?:didn't|did not|couldn't|could not) (?:quite |really )?(?:catch|get|hear|make out|follow)|i'm not (?:catching|getting|following|sure what you (?:mean|said))|i (?:only )?caught |i heard ["“]|i'm catching |all i caught|sorry, i'm not getting|say (?:that|it) again|could you (?:say|repeat)|can you (?:say|repeat))/.test(t)
    || /\b(?:say (?:that|it|those) again|didn't (?:quite )?catch (?:that|it)|not (?:catching|getting) (?:that|what you're saying)|isn't coming through)\b/.test(t) && t.length < 200;
}
/** After this many replies in a row that only say "I didn't catch that", Echo rests. */
export const UNCLEAR_RESTS_AFTER = 2;

/** What a double-tap of the key, or a tap on the pearl, switches to. @param {unknown} mode @returns {ListenMode} */
export const toggled = (mode) => (listenModeOf(mode) === 'listening' ? 'resting' : 'listening');

/**
 * Has it been quiet long enough for Listening to rest? Never in the middle of something.
 * @param {{ mode: unknown, now: number, lastAt: number, busy?: boolean, working?: boolean, waiting?: boolean }} o
 *   lastAt: when either side last said something; working: Echo is doing a job; waiting: a card or a question is open
 */
export function shouldRest({ mode, now, lastAt, busy = false, working = false, waiting = false }) {
  return listenModeOf(mode) === 'listening' && !busy && !working && !waiting && now - lastAt >= QUIET_REST_MS;
}

/** The line the window and the island show when the state changes. @param {ListenMode} mode @param {string} [why] */
export function modeLine(mode, why = '') {
  const reason = { asked: '', key: '', pearl: '', menu: '', name: 'you said my name', quiet: 'three quiet minutes', unclear: "I couldn't follow, so say my name when it's for me", call: 'you are on a call', lock: 'the screen locked', unlock: 'the screen unlocked' }[why] || '';
  const what = mode === 'listening' ? 'Listening' : mode === 'off' ? 'Mic off' : 'Resting';
  return reason ? `${what}: ${reason}` : what;
}
