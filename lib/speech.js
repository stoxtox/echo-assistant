// How Echo's replies are cut up for the voice. Pure functions, so they're unit-tested
// (test/speechflow.test.js). Echo never says a canned acknowledgement: the moment you finish
// talking the pearl shows she heard you (a 'thinking' cue), and her first spoken words are the
// model's own, already about what she's doing.
//
// The voice gets whole sentences, never half of one, with one exception made for speed: the
// first piece goes the moment the first sentence is written, not after the reply, so Echo starts
// talking while the rest is still coming (and the voice renders a short piece faster). A tiny
// opener ("Done.", "Hey there!") waits to be paired with the next sentence, and a first sentence
// over ~12 words starts at a comma (after at least 5 words), so the first words are never held
// up by a long one. Later pieces group sentences into ~10-36 words, and only a run-on with no
// sentence end in sight is cut, at a comma if there is one. The page plays the pieces back to
// back with a short natural pause between them (public/karaoke.js), and each piece carries the
// one before it so the voice keeps the melody.

/** Words the voice shouldn't pause on: a piece never ends with one of these. */
const DANGLING = new Set('a an the to of and or but so in on at for with by from as is are was were be my your our their his her its this that these those i we you they it not no very just than then if when while about into over some any'.split(' '));

/** A tiny opener and the sentence after it go together if they fit in this many words. */
const FIRST_WORDS = 20;
/** A first sentence shorter than this waits for the next one ("Done." alone sounds clipped). */
const OPENER_WORDS = 3;
/** A first sentence longer than this starts at a comma, if there is one early enough. */
const FIRST_LONG_WORDS = 12;
/** ...after at least this many words. */
const FIRST_CLAUSE_WORDS = 5;
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

/** The first clause of a long sentence (ending at a comma, 5-12 words in), or null. */
function firstClause(text) {
  const wordEnds = [...text.matchAll(/\S+(?=\s)/g)].map((m) => ({ end: m.index + m[0].length, word: m[0] }));
  for (let n = Math.min(wordEnds.length, FIRST_LONG_WORDS); n >= FIRST_CLAUSE_WORDS; n--) if (/[,;:—–]["')\]]*$/.test(wordEnds[n - 1].word)) return cut(text, wordEnds[n - 1].end);
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
    return first && countWords(text) > FIRST_LONG_WORDS ? firstClause(text) : null;
  }

  // Take whole sentences while they fit.
  let n = 0;
  let words = 0;
  while (n < done.length && (n === 0 || words + done[n].words <= MAX_PIECE_WORDS)) words += done[n++].words;
  if (first) {
    // The first sentence goes now (a long one from its first comma). A tiny opener waits for the
    // next sentence, or for enough of it that waiting longer would be slower.
    if (done[0].words > FIRST_LONG_WORDS) return firstClause(text.slice(0, done[0].end)) || cut(text, done[0].end);
    if (done[0].words >= OPENER_WORDS) return cut(text, done[0].end);
    if (done.length > 1) return cut(text, done[done[0].words + done[1].words <= FIRST_WORDS ? 1 : 0].end);
    return done[0].words + tailWords > FIRST_WORDS ? cut(text, done[0].end) : null;
  }
  if (words >= MIN_PIECE_WORDS || n >= 2 || tailWords >= RUNON_WORDS) return cut(text, done[n - 1].end);
  return null;
}
