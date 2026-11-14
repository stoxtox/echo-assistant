// When may Echo learn that the recognizer mishears something? Only when the user has just said so.
// A learned correction is offered to the assistant as a hint on every future sentence that has the
// heard words (lib/correct.js nameHints), and biases the recognizer, so a wrong one is worse than
// none: on Oct 2 a guessed one, then its opposite, made two names flip back and
// forth until the user had said the right one five times.

const CORRECTING = [
  // "I said", "I actually said", "I meant" (not "I would say" or a filler "I mean").
  /\bi (?:actually |just |already |clearly |literally |definitely )?(?:said|meant|was saying)\b/i,
  /\byou (?:misheard|heard (?:it )?wrong|got (?:it|that) wrong|keep (?:hearing|saying|writing))\b/i,
  /\b(?:not|isn'?t|wasn'?t) what i said\b/i,
  /\bnot\b.{1,40}\b(?:but|it'?s|i said)\b/i,
  /^\s*no[,.!]?\s+(?:it'?s|its|i|the|that'?s)\b/i,
  /\b(?:it'?s|it is|that'?s|its) (?:an? \w+ )?(?:called|spelled|spelt|named)\b/i,
  /\b(?:spell(?:ed|t)?|spelling) (?:it|is|as|like)\b/i,
  /\bwrong (?:word|name|spelling)\b/i,
];

/** Do these words correct something Echo heard or wrote ("I said X", "no, it's X", "it's called X")? */
export function isExplicitCorrection(text: string): boolean {
  const t = String(text || '');
  return CORRECTING.some((re) => re.test(t));
}
