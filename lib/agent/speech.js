// What the user's words mean while Echo works on the Mac: stop, wait, "that's all", a correction
// for the step under way, or something on screen ("the first video"). Moved out of lib/computer.js unchanged.
// "Stop", "stop it", "okay stop", "Echo, stop!", "that's enough", "cancel": the whole utterance.
// "Stop, search for otters instead" is a new instruction, not a stop.
import { redactText } from '../screen.js';

const STOP_WORDS = /^(?:(?:hey |okay |ok |no |wait |echo |please |just |oh )*)(stop(?: it| that| now| there| driving| everything| please)?|halt|cancel(?: that| it)?|abort|enough|that'?s enough|never ?mind|quit|freeze|take your hands off)(?: now| please| echo| stop)*$/i;

/**
 * Is this utterance a spoken "stop"?
 * @param {string} text
 */
export function isStopCommand(text) {
  const t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  // "stop stop", "stop, stop it"
  const words = t.split(' ');
  if (words.length > 6) return false;
  return STOP_WORDS.test(t) || (words.every((w) => w === 'stop') && words.length > 0);
}

// "Wait", "hold on", "pause", "one sec": hold the current request, but keep the session (a TV
// saying "Wait!" no longer ends everything).
const PAUSE_WORDS = /^(?:(?:hey |okay |ok |no |echo |please |just |oh )*)(wait(?: a (?:sec(?:ond)?|moment|minute))?|(?:hold|hang) on(?: a (?:sec(?:ond)?|moment|minute))?|pause|one sec(?:ond)?|give me a (?:sec(?:ond)?|moment|minute)|just a (?:sec(?:ond)?|moment|minute))(?: please| echo| now)*$/i;

/**
 * Is this utterance a spoken "wait" (pause the current step, keep the session)?
 * @param {string} text
 */
export function isPauseCommand(text) {
  const t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return Boolean(t) && t.split(' ').length <= 6 && PAUSE_WORDS.test(t);
}

// A correction or an answer: it changes what Echo is doing right now ("no, the other one", "yes,
// send it", "go back", "search for otters instead"). Anything else said mid-run is queued as the
// next step instead of cutting in (and a TV line never throws away the step under way).
const IMMEDIATE = /^(?:(?:okay|ok|oh|hey|echo|sorry|actually|um|uh)[ ,]+)*(?:no\b|nope\b|not\b|wrong\b|yes\b|yeah\b|yep\b|sure\b|go ahead\b|do it\b|send it\b|you can\b|that'?s (?:it|right|perfect|wrong|fine|good)\b|the other\b|go back\b|undo\b|back\b|cancel that\b|don'?t\b)|\b(?:instead|not that|wrong one|other one)\b/i;

/**
 * Mid-run: does this change the current step now ('now'), or is it the next thing to do ('queue')?
 * With a question or a confirmation card waiting, everything is an answer ('now').
 * @param {string} text @param {{ answering?: boolean }} [o]
 * @returns {'now' | 'queue'}
 */
export function midRunKind(text, { answering = false } = {}) {
  if (answering) return 'now';
  const t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  return IMMEDIATE.test(t) ? 'now' : 'queue';
}

// "That's all", "thanks, that's it", "I'm done", "we're good": the user is finished with the session.
const END_WORDS = /^(?:(?:ok(?:ay)? |great |perfect |cool |nice |good |no |yeah |yes |alright |all right |thanks |thank you |echo )*)(that'?s (?:all|it|everything|enough for now)|that'?ll be all|that will be all|(?:i'?m|i am) (?:done|good|all set)|(?:we'?re|we are) (?:done|good|all set)|all done|done|nothing else|no more|finish(?:ed)?|you can stop(?: now)?|that'?s all for now)(?: thanks| thank you| echo| for now)*$/i;

/**
 * Is this utterance the user closing the driving session ("that's all", "I'm done")?
 * @param {string} text
 */
export function isEndCommand(text) {
  const t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 8) return false;
  return END_WORDS.test(t);
}

/**
 * Where something the user said goes while Echo may be driving.
 *  - 'stop': end the run now, like Escape
 *  - 'pause': "wait": the current request stops, the session stays (only mid-request)
 *  - 'end': the user is done with the driving session ("that's all"): close it calmly
 *  - 'instruct': the assistant is mid-run: hand it over on its next step
 *  - 'turn': an ordinary new turn (in a driving session, it carries on in the same app)
 * @param {{ text: string, driving: boolean, busy: boolean }} o
 * @returns {'stop' | 'pause' | 'end' | 'instruct' | 'turn'}
 */
export function routeSpeech({ text, driving, busy }) {
  if (!driving) return 'turn';
  if (isStopCommand(text)) return 'stop';
  if (busy && isPauseCommand(text)) return 'pause';
  if (isEndCommand(text)) return busy ? 'stop' : 'end';
  return busy ? 'instruct' : 'turn';
}

// "Click the first video", "the MrBeast video", "the one in the top right corner", "that red
// button", "the second result": the user means something they can see, not a label to search for.
const ORDINAL = /\b(first|second|third|fourth|fifth|last|top|bottom|next|previous|1st|2nd|3rd|4th|5th)\b/;
const PLACE = /\b(top|bottom|upper|lower|left|right|middle|center|centre|corner|side)\b/;
const THING = /\b(video|videos|result|results|link|thumbnail|image|picture|photo|song|track|item|button|icon|tab|one|post|story|article|option|card|row|channel|playlist|ad)\b/;
const POINTING = /\b(click|tap|press|open|play|select|choose|pick|hit|go (?:to|into)|watch)\b/;
const DEICTIC = /\b(that|this|the one|those|these)\b/;

/**
 * Does this request point at something by where it is or what it looks like on screen (so the
 * assistant should look at the screen first and click by what it sees)?
 * @param {string} text
 */
export function screenReference(text) {
  const t = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.split(' ').length > 20) return false;
  if (!POINTING.test(t) && !/^the one\b/.test(t)) return false;
  if (PLACE.test(t) && (THING.test(t) || /\bcorner\b/.test(t))) return true;
  if (ORDINAL.test(t) && THING.test(t)) return true;
  if (DEICTIC.test(t) && THING.test(t)) return true;
  // "click the MrBeast video": a name plus the kind of thing.
  return /\b(video|thumbnail|result|song|channel|playlist|post)\b/.test(t);
}

/** A short spoken narration of a step ("Opening Chrome…"), trimmed and without secrets. */
export function narration(say) {
  const t = redactText(String(say || '').replace(/\s+/g, ' ').trim()).text.slice(0, 60).trim();
  return /[\p{L}]/u.test(t) ? t : '';
}

/* ---------- key combos ---------- */

