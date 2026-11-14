// A second listen. Apple's recognizer answers at once and is wrong about one sentence in six for
// this user (measured Oct 4, 2026 on 125 of their own clips: "Nava snacks" for "Now what's
// next?", "He still receive" for "he still didn't receive"); local Whisper is right far more
// often but takes about 1.3 s. So Apple's words start the turn, Whisper listens to the same clip
// meanwhile, and this file decides whether Whisper's version should replace Apple's.
//
// Whisper is not simply believed: it invents a tail on some clips ("What is it? A video game."),
// and on speech that isn't English it writes fluent English that was never said. Nothing here
// talks to a model; it only compares two transcripts.
import { isEnglishWord } from './vocab.js';

/**
 * Is the second listen in use? The setting, and never inside the tests (ECHO_SECOND_LISTEN=off,
 * set by test/helpers.js): on a Mac that has the Whisper model, every test sentence would
 * otherwise be transcribed for real, which is slow and changes what the tests see.
 * @param {{ secondListen?: boolean }} settings
 */
export const secondListenOn = (settings) => settings?.secondListen !== false && process.env.ECHO_SECOND_LISTEN !== 'off';

/** Whisper is this sure of a segment, or its version isn't used (avg_logprob; lib/sttstream.js uses the same bar). */
export const SECOND_MIN_LOGPROB = -0.5;
/** Words whose presence or absence changes what was meant, however small the edit. */
const MEANING = new Set(['not', "n't", 'no', 'never', "don't", "didn't", "can't", "won't", "isn't", "doesn't", "wasn't", "couldn't", "shouldn't", "wouldn't", "haven't", "hasn't", 'cannot', 'without', 'stop', 'cancel', 'delete', 'remove', 'send', 'submit']);
/** Ways of writing the same thing: not a difference worth a second turn. @type {Array<[RegExp, string]>} */
const SAME = [[/\ball right\b/g, 'alright'], [/\bgonna\b/g, 'going to'], [/\bwanna\b/g, 'want to'], [/\bgotta\b/g, 'got to'], [/\bcolour/g, 'color'], [/\bokay\b/g, 'ok'], [/\byeah\b/g, 'yes'], [/\bi am\b/g, "i'm"], [/\bwe are\b/g, "we're"], [/\bit is\b/g, "it's"], [/\bwhat is\b/g, "what's"], [/\b(?:a |one )?hundred\b/g, '100'], [/\bwe have\b/g, "we've"], [/\byou are\b/g, "you're"]];
/** Said at the start of a sentence without meaning anything: Apple drops them, Whisper writes them. */
const LEAD_IN = /^(?:(?:alright|ok|so|well|and|but|yes|oh|um|uh|hey|echo|hey echo)\s+)+/;

/** A transcript as words, with spelling habits and punctuation taken out. @param {string} text */
export function plainWords(text) {
  let s = String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [a, b] of SAME) s = s.replace(a, b);
  return s.split(' ').filter(Boolean);
}

/** The same word, give or take an ending ("build" / "built", "sign" / "signed", "link" / "links"). */
const alike = (x, y) => {
  if (x === y) return true;
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n >= 4 && x.length - n <= 2 && y.length - n <= 2;
};
/** Without a word said twice in a row ("no, no"). */
const once = (words) => words.filter((w, i) => w !== words[i - 1]);

/** How many words must change to turn one list into the other. */
export function wordEdits(a, b) {
  let d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const p = d;
    d = [i];
    for (let j = 1; j <= b.length; j++) d[j] = Math.min(p[j] + 1, d[j - 1] + 1, p[j - 1] + (alike(a[i - 1], b[j - 1]) ? 0 : 1));
  }
  return d[b.length];
}

/** Words that carry no meaning of their own. */
const SMALL = new Set(['a', 'an', 'the', 'to', 'it', 'is', 'of', 'so', 'and', 'but', 'i', "i'm", 'you', "you're", 'that', 'this', 'in', 'on', 'at', 'for', 'we', "we're", 'are', 'be', 'do', 'had', 'have', 'has', 'ok', 'yes', 'alright', 'oh', 'ah', 'um', 'uh', 'then', 'there', 'just']);

/** The words no English dictionary has (digits and one-letter words aside). */
export function oddWords(words) {
  return words.filter((w) => !/^\d/.test(w) && w.length > 1 && !isEnglishWord(w.replace(/'.*$/, '')) && !isEnglishWord(w));
}

/** The share of a transcript's words that no English dictionary has (digits and short words aside). */
export function oddShare(words) {
  const real = words.filter((w) => !/^\d/.test(w) && w.length > 1);
  return real.length ? oddWords(words).length / real.length : 0;
}

/**
 * Which transcript goes to Echo.
 * @param {string} apple what Apple's recognizer wrote (already on its way to the assistant)
 * @param {{ text?: string, segments?: Array<{ lp?: number }> } | null} whisper the second listen
 * @returns {{ use: 'apple' | 'whisper', why: string, text: string }}
 *   why: same | minor | blank | unsure (Whisper not confident) | not_english (Apple wrote sounds,
 *   not English: Whisper's English would be invented) | tail (Whisper only added to the end) |
 *   length (too different in length to be the same sentence) | better (Whisper's replaces Apple's)
 */
export function secondOpinion(apple, whisper) {
  const keep = (why) => ({ use: /** @type {const} */ ('apple'), why, text: apple });
  const heard = String(whisper?.text || '').trim();
  if (!heard) return keep('blank');
  const a = plainWords(apple);
  const w = plainWords(heard);
  if (!a.length || !w.length) return keep('blank');
  if (a.join(' ') === w.join(' ')) return keep('same');
  const lps = (whisper?.segments || []).map((s) => s.lp).filter((x) => typeof x === 'number');
  if (lps.length && Math.min(...lps) < SECOND_MIN_LOGPROB) return keep('unsure');
  // Apple wrote down sounds ("Kaya Pan Karya Che"): another language. Whisper, told to hear
  // English, makes a sentence up ("I'm not going to go to the bathroom"), so it isn't believed.
  if (oddWords(a).length >= 2 && oddShare(a) >= 0.3) return keep('not_english');
  // Whisper's own version isn't English either: it is guessing.
  if (oddShare(w) >= 0.34) return keep('unsure');
  // Whisper's version is Apple's with more on the end: the invented tail.
  if (w.length > a.length && w.slice(0, a.length).join(' ') === a.join(' ')) return keep('tail');
  if (w.length > a.length * 2 + 3 || a.length > w.length * 2 + 3) return keep('length');
  const a2 = once(a.join(' ').replace(LEAD_IN, '').split(' ').filter(Boolean));
  const w2 = once(w.join(' ').replace(LEAD_IN, '').split(' ').filter(Boolean));
  if (wordEdits(a2, w2) === 0) return keep('minor');
  const meaning = [...MEANING].some((m) => a2.includes(m) !== w2.includes(m)) || a2.some((x) => x.endsWith("n't")) !== w2.some((x) => x.endsWith("n't"));
  // A few words: each one is most of the meaning ("Turn" for "Done"). Saying a word twice is not a difference.
  const few = a2.length <= 3 && [...new Set(a2)].sort().join(' ') !== [...new Set(w2)].sort().join(' ');
  // Longer: only the words that carry meaning count ("a", "to", "it" here or there is not worth doing the turn again).
  const content = (x) => x.filter((t) => !SMALL.has(t));
  if (!meaning && !few && wordEdits(content(a2), content(w2)) === 0) return keep('minor');
  return { use: 'whisper', why: 'better', text: heard };
}
