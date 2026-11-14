// Not saying the same answer twice. Oct 11, 2026: Gujarati heard as English nonsense, a laugh and
// half-sentences each began a new turn, and Echo answered every one by saying its last answer
// again ("Kem cho! Majama…" twice, "I've made my move" three times). When something unclear
// arrives right after Echo answered, the message carries a note: the answer stands, don't
// repeat it; ask once what they said, and after that stay quiet.
import { soundsForeign, unknownWords } from './addressed.js';

/** How long after Echo's last words an unclear message counts as "right after the answer". */
export const REPEAT_WINDOW_MS = 45_000;
export const UNCLEAR_NOTE = '(unclear after your answer)';

// They are asking to hear it again: then saying it again is the answer.
const ASKS_AGAIN = /\b(again|repeat|once more|one more time|what did you say|say that|pardon|come again|did(?:n'?t| not) (?:hear|catch|get))\b/i;
// A sound written down, or only filler words: nothing was asked.
const SOUND = /^\s*\*[^*]+\*\s*$/;
const FILLER = /^(?:(?:right|okay|ok|oh|ah|hmm+|mm+|uh+|um+|ha(?:\s?ha)*|wow|alright|all right|so|well)[\s,.!…]*)+$/i;
// Echo's last reply was itself "say that again?".
const ASKED_AGAIN = /\b(say (?:that|it) again|didn'?t (?:quite )?catch|could you (?:say|repeat)|one more time|say it (?:once more|a little slower))\b/i;

/**
 * Is this message unclear, right after an answer? '' when it is not (or when it asks to hear the
 * answer again); otherwise why.
 * @param {string} text what was heard
 * @param {{ lastReply?: string, sinceMs?: number, context?: string[] }} [o] lastReply: Echo's last
 *   reply; sinceMs: how long ago its voice finished it; context: words that are not odd here
 * @returns {'' | 'foreign' | 'odd' | 'noise'} foreign: most of it is no English; odd: a short line
 *   with a word nothing explains (often a name: it may well be a real request); noise: a sound or filler
 */
export function unclearAfterAnswer(text, { lastReply = '', sinceMs = Infinity, context = [] } = {}) {
  const t = String(text || '').trim();
  const last = String(lastReply || '').trim();
  if (!t || !last || !(sinceMs <= REPEAT_WINDOW_MS)) return '';
  if (ASKS_AGAIN.test(t)) return '';
  if (SOUND.test(t)) return 'noise';
  if (soundsForeign(t, [last, ...context])) return 'foreign';
  // A short line with a word nothing explains ("Somewhere bowl, Akbar"): more lenient than
  // soundsForeign, because all this does is keep the last answer from being said again.
  const u = unknownWords(t, [last, ...context]);
  if (u.odd.length && u.real <= 8 && u.odd.length / Math.max(1, u.real) >= 0.2) return 'odd';
  // After a question, "right", "okay" and "oh" are answers; after a statement they ask nothing.
  if (!/\?\s*$/.test(last) && FILLER.test(t)) return 'noise';
  return '';
}

/** Did Echo's last reply already ask them to say it again? @param {string} lastReply */
export const askedAgain = (lastReply) => ASKED_AGAIN.test(String(lastReply || ''));

/**
 * The note that rides on such a message. Only a line that is plainly no request ('foreign',
 * 'noise') may be left unanswered; an 'odd' one may be a real request with a name in it.
 * @param {'foreign' | 'odd' | 'noise'} why @param {boolean} asked Echo's last reply already asked them to repeat
 */
export function noRepeatNote(why, asked) {
  const what = why === 'noise' ? 'this is a sound or a filler word, not a request' : 'these words may be a mishearing, or speech in another language written down as English';
  const head = `${UNCLEAR_NOTE}: ${what}. Your last answer was just said and still stands: do NOT say it again, in the same or other words.`;
  if (why === 'odd') return `${head} If you can tell what they want, do that. If not, ask once, in five words or fewer, what they said.`;
  return `${head} ${asked
    ? 'You already asked them to say it again, so reply with exactly [quiet] and nothing else, unless you can now tell what they want.'
    : 'If you can tell what they want, do that. If not, ask once, in five words or fewer, what they said; or reply with exactly [quiet] when it plainly needs no answer.'}`;
}

/** May a message with this verdict be left unanswered? @param {string} why */
export const mayStayQuiet = (why) => why === 'foreign' || why === 'noise';
