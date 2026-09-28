// The "Hey Echo" wake word. The page listens locally with a cheap loudness detector; each burst of
// speech (its first ~1.8 s) is sent to this machine's own Whisper server and matched here. Nothing
// is logged or saved before a match: no audio, no text. Pure helpers, tested in test/wake.test.js.

// Hyphenated words stay whole: "Eco-friendly homes..." on TV isn't anyone calling her.
const tokens = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}'\- ]+/gu, ' ').split(/\s+/).map((t) => t.replace(/^-+|-+$/g, '')).filter(Boolean);

/** How Whisper writes "Echo" for most speakers. */
const STRONG = new Set(['echo', 'eko', 'ekko', 'ekho', 'eco', 'ecco', 'ecko', 'ekco', 'eccho']);
/**
 * Near misses in an accent or a clipped clip ("ego", "eggo", "iko"), and "Echoes" ("Echoes of the
 * past..." on TV isn't anyone calling her): only with "hey" in front, or a high sensitivity.
 */
const NEAR = /^(e|eh|a|ai|i|ae)(k|kk|c|cc|ck|kh|ch|g|gg|gh)(o|oh|ow|u|oe|oes|os|a)$|^echo(e?s|'s)$/;
/** After "Hey" only: the vowel swallowed by it ("Hey Co", "Hey Ko"). */
const AFTER_HEY = /^(co|ko|ecko)$/;
/** "Hey Echo" run together, as Whisper sometimes writes it ("Heiko", "Hecho"). */
const JOINED = /^(hey|hay|hei|he|hi|a|ok|okay)(echo|eko|ekko|eco|ecco|ego)$|^(hecho|heko|heiko|heyko|haiko|heco)$/;
/** Words that can come before her name: "Hey", and what "Hey" turns into in an accent ("A echo", "Hay echo"). */
const GREETING = new Set(['hey', 'hay', 'hei', 'he', 'hi', 'heh', 'hey,', 'a', 'ah', 'eh', 'oh', 'o', 'ok', 'okay', 'yo', 'hello', 'hallo', 'hmm', 'um', 'uh', 'so', 'and']);

/**
 * Score one echo-like word: 1 for how Whisper writes "Echo", 0.6 for a near miss, else 0.
 * @param {string} w
 */
export function echoScore(w) {
  const x = w.replace(/'s$/, '');
  if (STRONG.has(w) || STRONG.has(x)) return 1;
  return NEAR.test(x) ? 0.6 : 0;
}

/** The score a match needs at a sensitivity (0..1): 0.5 (the default) takes "Echo" alone and "Hey Ego", 1 also takes "Ego" alone. */
export const wakeThreshold = (sensitivity = 0.5) => 1.2 - 0.6 * Math.min(1, Math.max(0, Number.isFinite(+sensitivity) ? +sensitivity : 0.5));

/**
 * Is this short transcript someone calling Echo? Her name has to open it ("Hey Echo", "Echo, ...",
 * "Hay Eko", "A echo"): only greetings may come before it, so "the echo of..." on TV doesn't count.
 * `rest` is whatever came after her name ("Hey Echo, check the build" -> "check the build").
 * @param {string} text
 * @param {{ sensitivity?: number, lp?: number }} [opts] lp: Whisper's average log-probability
 * @returns {{ wake: boolean, score: number, rest: string }}
 */
export function matchWake(text, { sensitivity = 0.5, lp } = {}) {
  const raw = String(text || '').trim();
  const w = tokens(raw);
  let best = { score: 0, at: -1 };
  for (let i = 0; i < Math.min(w.length, 3); i++) {
    const t = w[i];
    const hey = w.slice(0, i).some((g) => /^(hey|hay|hei|hi|he|a|ok|okay|hello)$/.test(g));
    let score = JOINED.test(t) ? 1.3 : echoScore(t) || (hey && AFTER_HEY.test(t) ? 0.6 : 0);
    if (score && i > 0) {
      // Everything before her name must be a greeting; "Hey" in front makes it surer.
      if (!w.slice(0, i).every((g) => GREETING.has(g))) break;
      if (hey) score += 0.3;
    }
    if (score > best.score) best = { score, at: i };
    if (!GREETING.has(t)) break;
  }
  if (best.at < 0) return { wake: false, score: 0, rest: '' };
  let score = best.score;
  // Whisper guessing (a mumble, a TV in the next room) counts for less.
  if (typeof lp === 'number' && lp < -1) score -= 0.3;
  score = +score.toFixed(2);
  return { wake: score >= wakeThreshold(sensitivity), score, rest: restAfter(raw, best.at + 1) };
}

/** The original text after the first `n` words, without the punctuation that joined them. */
function restAfter(raw, n) {
  const parts = raw.split(/\s+/);
  let seen = 0;
  let i = 0;
  for (; i < parts.length && seen < n; i++) if (/[\p{L}\p{N}]/u.test(parts[i])) seen++;
  return parts.slice(i).join(' ').replace(/^[\s,.!?;:-]+/, '').trim();
}

/**
 * A wake-word turn transcribed in full: take "Hey Echo" off the front and keep the request.
 * Text that doesn't open with her name is returned unchanged.
 * @param {string} text
 */
export function stripWake(text) {
  const m = matchWake(text);
  if (!m.wake) return String(text || '').trim();
  const rest = m.rest;
  return rest ? rest[0].toUpperCase() + rest.slice(1) : '';
}
