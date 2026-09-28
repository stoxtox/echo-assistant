// How Echo's replies are cut up for the voice, and the quick acknowledgement she says as soon as
// you finish talking. Pure functions, so they're unit-tested (test/speechflow.test.js).
//
// The voice gets whole sentences, never half of one: an engine given a clause ("The job search
// finished,") says it like a finished thought, so a reply cut at commas sounds read out word by
// word. The acknowledgement covers the wait for the first sentence. The first piece is the first
// two sentences when they're short (a short reply is one request, so one breath and one melody),
// else the first sentence; only a first sentence over ~20 words starts at a comma, to keep the
// first words quick. Later pieces group sentences into ~10-36 words, and only a run-on with no
// sentence end in sight is cut, at a comma if there is one. The page
// plays the pieces back to back with a short natural pause between them (public/karaoke.js).

/** Words the voice shouldn't pause on: a piece never ends with one of these. */
const DANGLING = new Set('a an the to of and or but so in on at for with by from as is are was were be my your our their his her its this that these those i we you they it not no very just than then if when while about into over some any'.split(' '));

/** The first piece: two sentences if they fit in this many words (a short reply is one request). */
const FIRST_WORDS = 20;
/** A first sentence longer than FIRST_WORDS may start at a comma, after at least this many words. */
const FIRST_CLAUSE_WORDS = 6;
/** Later pieces: at least this many words (or two sentences) unless the reply is ending. */
const MIN_PIECE_WORDS = 8;
/** Never more than this many words in one piece (the local voice truncates very long input). */
const MAX_PIECE_WORDS = 36;
/** Waiting on a sentence this long without an end: say what's ready instead. */
const RUNON_WORDS = 20;

/** "e.g." "Dr." "J." don't end a sentence. */
const ABBREV = /(^|\s|\()(e\.g|i\.e|vs|mr|mrs|ms|dr|st|approx|[a-z])\.$/i;

const countWords = (s) => (String(s).match(/\S+/g) || []).length;

/**
 * Complete sentences at the start of `text`: [{ end, words }], `end` just past the sentence.
 * A sentence ends at . ! ? … (maybe followed by a closing quote or bracket) and a space, or at
 * a line break. "1.5" doesn't end one (the mark must be followed by a space), nor do "e.g." or "Dr.".
 */
function sentences(text) {
  const out = [];
  let from = 0;
  const re = /[.!?…]+["')\]]*(?=\s)|\n/g;
  for (const m of text.matchAll(re)) {
    const end = m.index + m[0].length;
    if (m[0] === '.' && ABBREV.test(text.slice(Math.max(from, m.index - 6), m.index + 1))) continue;
    const words = countWords(text.slice(from, end));
    if (!words) {
      from = end;
      continue;
    }
    out.push({ end, words });
    from = end;
  }
  return out;
}

const cut = (text, i) => ({ chunk: text.slice(0, i).trim(), rest: text.slice(i).replace(/^\s+/, '') });

/** A run-on with no sentence end: cut at the last comma-like pause, else at a word break. */
function cutRunOn(text) {
  const wordEnds = [...text.matchAll(/\S+(?=\s)/g)].map((m) => ({ end: m.index + m[0].length, word: m[0] }));
  const limit = Math.min(wordEnds.length, MAX_PIECE_WORDS - 6);
  for (let n = limit; n >= 8; n--) if (/[,;:—–]["')\]]*$/.test(wordEnds[n - 1].word)) return cut(text, wordEnds[n - 1].end);
  let n = limit;
  const bare = (k) => wordEnds[k - 1].word.toLowerCase().replace(/[^a-z']/g, '');
  while (n > 3 && DANGLING.has(bare(n))) n--;
  return cut(text, wordEnds[n - 1].end);
}

/** The first clause of a long sentence (ending at a comma, 6-20 words in), or null. */
function firstClause(text) {
  const wordEnds = [...text.matchAll(/\S+(?=\s)/g)].map((m) => ({ end: m.index + m[0].length, word: m[0] }));
  for (let n = Math.min(wordEnds.length, FIRST_WORDS); n >= FIRST_CLAUSE_WORDS; n--) if (/[,;:—–]["')\]]*$/.test(wordEnds[n - 1].word)) return cut(text, wordEnds[n - 1].end);
  return null;
}

/**
 * The next piece of `buf` worth sending to the voice, or null to wait for more text. Whatever is
 * left when the reply ends is spoken as the last piece.
 * @param {string} buf  text written so far and not yet spoken
 * @param {{ first?: boolean }} [o]  first piece of the reply
 * @returns {{ chunk: string, rest: string } | null}
 */
export function nextSpeechChunk(buf, { first = false } = {}) {
  const text = String(buf || '');
  const done = sentences(text);
  const tailWords = countWords(text.slice(done.at(-1)?.end || 0));
  if (!done.length) {
    if (countWords(text) > MAX_PIECE_WORDS) return cutRunOn(text);
    // A long first sentence: start at a comma rather than keep the listener waiting.
    return first && countWords(text) > FIRST_WORDS ? firstClause(text) : null;
  }

  // Take whole sentences while they fit.
  let n = 0;
  let words = 0;
  while (n < done.length && (n === 0 || words + done[n].words <= MAX_PIECE_WORDS)) words += done[n++].words;
  if (first) {
    // Two short sentences in one go (a short reply is one request), else the first on its own.
    if (done.length > 1) return cut(text, done[done[0].words + done[1].words <= FIRST_WORDS ? 1 : 0].end);
    if (done[0].words > FIRST_WORDS) return firstClause(text.slice(0, done[0].end)) || cut(text, done[0].end);
    return done[0].words + tailWords > FIRST_WORDS ? cut(text, done[0].end) : null;
  }
  if (words >= MIN_PIECE_WORDS || n >= 2 || tailWords >= RUNON_WORDS) return cut(text, done[n - 1].end);
  return null;
}

/** Said the moment you finish talking, before any tools. Short, and never the same twice in a row. */
export const ACKS = {
  check: ['Sure, checking.', 'Okay, one sec.', 'Let me look.', 'Sure, looking now.'],
  do: ['Okay, on it.', 'Okay, doing that now.', 'Got it.', 'Alright, on it.'],
  think: ['Hmm, good one.', 'Okay, let me think.', 'Right, one sec.', 'Hmm, okay.'],
};
let lastAck = '';

/**
 * The acknowledgement for something the user just said, or null when a reply should come
 * straight away (greetings, thanks, yes or no, very short replies).
 * @param {string} said
 * @param {() => number} [rand]
 */
export function ackFor(said, rand = Math.random) {
  const s = String(said || '').trim().toLowerCase().replace(/^\[[^\]]*\]\s*/, '');
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;
  if (/^(hi|hey|hello|thanks|thank you|thx|cool|nice|great|ok|okay|yes|yeah|yep|no|nope|nah|sure|stop|cancel|never ?mind|good (morning|night|evening))\b/.test(s) && words.length < 6) return null;
  const pool =
    /\b(status|how('s| is| are)|where (are|is)|what('s| is) (happening|going on|the status)|check|any (news|update)|progress|done yet|finished|look up|find|search|see if)\b/.test(s) ? ACKS.check
    : /^(please |can you |could you |would you |go ahead|let'?s )?(make|build|start|create|text|send|add|open|put|write|set|schedule|remind|book|fix|stop|cancel|call|email|message|draft|update|change)\b/.test(s) || /\b(can|could|would) you (please )?(make|build|start|create|text|send|add|open|write|set|fix|find)\b/.test(s) ? ACKS.do
    : ACKS.think;
  const choices = pool.filter((a) => a !== lastAck);
  lastAck = choices[Math.floor(rand() * choices.length)] || pool[0];
  return lastAck;
}

/**
 * After an acknowledgement, the reply shouldn't say "Sure" or "Okay" again: drop a leading one
 * from the first spoken piece (the chat bubble keeps the full text).
 */
export function stripLeadingAck(chunk) {
  const s = String(chunk || '');
  const m = s.match(/^(sure( thing)?|okay|ok|alright|all right|right|got it|yep|yes|on it|one sec(ond)?)[,.!…]*\s+(?=\S)/i);
  // The rest stays exactly as written, so the karaoke highlight still finds it in the bubble.
  return m ? s.slice(m[0].length) : s;
}
