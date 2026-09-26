// How Echo's replies are cut up for the voice, and the quick acknowledgement she says as soon as
// you finish talking. Pure functions, so they're unit-tested (test/speechflow.test.js).
//
// Speech starts at the first clause boundary (a comma, or about 7 words), not the end of the
// sentence, so the voice begins while the model is still writing. Later pieces can be a little
// longer, which keeps the intonation natural. The page plays the pieces back to back.

/** Words the voice shouldn't pause on: a piece never ends with one of these. */
const DANGLING = new Set('a an the to of and or but so in on at for with by from as is are was were be my your our their his her its this that these those i we you they it not no very just than then if when while about into over some any'.split(' '));

/**
 * The next piece of `buf` worth sending to the voice, or null to wait for more text.
 * @param {string} buf  text written so far and not yet spoken
 * @param {{ first?: boolean }} [o]  first piece of the reply: cut it shorter, to start sooner
 * @returns {{ chunk: string, rest: string } | null}
 */
export function nextSpeechChunk(buf, { first = false } = {}) {
  const text = String(buf || '');
  const minClauseWords = first ? 3 : 5;
  const maxWords = first ? 7 : 12;
  let words = 0;
  let inWord = false;
  const wordEnds = []; // index just past each finished word
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const space = /\s/.test(c);
    if (!space) inWord = true;
    else if (inWord) {
      inWord = false;
      words++;
      wordEnds.push(i);
      const prev = text[i - 1];
      // A sentence end (or a line break) always ends a piece.
      if (/[.!?…]/.test(prev) || (/["')\]]/.test(prev) && /[.!?…]/.test(text[i - 2] || '')) || c === '\n') {
        const chunk = text.slice(0, i).trim();
        if (chunk.length > 1) return { chunk, rest: text.slice(i).replace(/^\s+/, '') };
      }
      // A clause boundary, once there's enough to say.
      if (/[,;:—–]/.test(prev) && words >= minClauseWords) return { chunk: text.slice(0, i).trim(), rest: text.slice(i).replace(/^\s+/, '') };
    }
    if (c === '\n' && !inWord && i > 0 && text.slice(0, i).trim()) {
      return { chunk: text.slice(0, i).trim(), rest: text.slice(i).replace(/^\s+/, '') };
    }
  }
  // No boundary yet: a long run of words is cut at a word break, never after a dangling word.
  if (words > maxWords) {
    let n = maxWords;
    const wordAt = (k) => text.slice(k === 1 ? 0 : wordEnds[k - 2], wordEnds[k - 1]).trim().toLowerCase().replace(/[^a-z']/g, '');
    while (n > 3 && DANGLING.has(wordAt(n))) n--;
    const cut = wordEnds[n - 1];
    return { chunk: text.slice(0, cut).trim(), rest: text.slice(cut).replace(/^\s+/, '') };
  }
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
