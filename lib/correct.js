// What the user said, on its way to Echo: as heard, never rewritten.
//
// - Letters spelled out one by one are joined into the word ("T-A-V-I-S-H" is Tavish), and a spoken
//   word that sounds like it takes the spelling.
// - Names the sentence may have been misheard as (a learned mishearing, or a word that sounds like
//   one of your projects, contacts or words) go to the assistant as hints, which it weighs with the
//   conversation in view. Nothing is replaced, and no model is called.
//
// (Until October this file also rewrote sentences: learned replacements, then a correction model.
// It misheard more than it fixed, and was removed.)
import { loadVocab, vocabularyTerms, isEnglishWord, favoriteNames, ownNames, spokenName } from './vocab.js';
import { phoneticKey, jaroWinkler, listProjects, loadStore } from './projects.js';

const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}:]/gu, '');

// Letters spelled out one by one: "T-A-V-I-S-H", "t.a.v.i.s", "T A V I S H" (capitals only
// when separated by spaces, so ordinary words like "a" and "I" never look like spelling).
const SPELLED = /(?<![\p{L}\p{N}])(?:\p{L}(?:[-.]\p{L}){2,}|\p{Lu}(?: \p{Lu}){2,})(?![\p{L}\p{N}])\.?/gu;

/** Letter-level edit distance (insert, delete, substitute). */
export function editDistance(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

/**
 * The known name a spelled-out word stands for, when the letters are close enough: the recognizer
 * often drops or swaps a letter or two ("M-R-G-L-D" for Marigold). Up to 1 letter off for short
 * names, 2 for names of 5+ letters; only a single closest name counts.
 * @param {string} letters @param {string[]} names
 */
export function matchSpelled(letters, names) {
  const w = letters.toLowerCase();
  if (w.length < 3) return null;
  let best = null;
  let bestD = Infinity;
  let tie = false;
  for (const name of new Set(names)) {
    const n = name.replace(/[^\p{L}\p{N}]/gu, '');
    if (n.length < 3 || !/^\p{L}+$/u.test(n)) continue;
    const d = editDistance(w, n);
    if (d > (Math.min(w.length, n.length) >= 5 ? 2 : 1)) continue;
    if (d < bestD) [best, bestD, tie] = [n, d, false];
    else if (d === bestD && n.toLowerCase() !== best?.toLowerCase()) tie = true;
  }
  return best && !tie ? best : null;
}

/** Single-word names the user's spelling can stand for: projects (as said), contacts, vocabulary. */
function spellableNames() {
  const projects = listProjects({ includeHidden: true }).flatMap((p) => [spokenName(p.name), p.name]);
  return [...projects, ...favoriteNames(), ...vocabularyTerms()].flatMap((t) => String(t).split(/\s+/)).filter((w) => /^\p{L}{3,}$/u.test(w) && !isEnglishWord(w));
}

/**
 * Words the user spelled out letter by letter, as words ("Tavish"), with their word spans.
 * Letters that are a letter or two off a known name become that name (`names`).
 * @param {string} text @param {string[]} [names]
 */
export function spelledWords(text, names = []) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const starts = [];
  let pos = 0;
  for (const w of words) {
    pos = String(text).indexOf(w, pos);
    starts.push(pos);
    pos += w.length;
  }
  const out = [];
  for (const m of String(text).matchAll(SPELLED)) {
    const letters = m[0].replace(/[^\p{L}]/gu, '');
    const word = matchSpelled(letters, names) || letters[0].toUpperCase() + letters.slice(1).toLowerCase();
    const first = starts.findLastIndex((s) => s <= m.index);
    const last = starts.findLastIndex((s) => s < m.index + m[0].length);
    out.push({ word, first, last });
  }
  return out;
}

/**
 * Spelled-out letters always win: a spoken word that sounds like a word the user spelled
 * ("Tavis ... T-A-V-I-S-H") takes the spelled form, or the known name the letters are close to
 * ("Marigol ... M-R-G-L-D" -> Marigold).
 * @param {string} text @param {string[]} [names] known names (default: projects, contacts, vocabulary)
 */
export function applySpelling(text, names = spellableNames()) {
  const spelled = spelledWords(text, names);
  if (!spelled.length) return { text, applied: [] };
  const words = text.split(/\s+/).filter(Boolean);
  const applied = [];
  words.forEach((w, i) => {
    if (spelled.some((s) => i >= s.first && i <= s.last)) return;
    const bare = w.replace(/[^\p{L}]/gu, '');
    if (bare.length < 3 || isEnglishWord(bare)) return;
    for (const s of spelled) {
      if (bare.toLowerCase() === s.word.toLowerCase()) continue;
      if (jaroWinkler(phoneticKey(bare), phoneticKey(s.word)) >= 0.8 || jaroWinkler(bare.toLowerCase(), s.word.toLowerCase()) >= 0.8) {
        words[i] = w.replace(bare, s.word);
        applied.push({ heard: bare, meant: s.word });
        break;
      }
    }
  });
  return { text: applied.length ? words.join(' ') : text, applied };
}

/**
 * Your names a heard word may stand for: projects (as named and as said), and contacts. Each with
 * its confirmed nicknames (project aliases).
 * @returns {Array<{ name: string, aliases: string[] }>}
 */
export function swappableNames() {
  const aliases = loadStore().aliases;
  const nicknames = (n) => Object.entries(aliases).filter(([, t]) => t === n).map(([a]) => a);
  const projects = listProjects({ includeHidden: true }).flatMap((p) => {
    const a = nicknames(p.name);
    return [{ name: p.name, aliases: a }, ...(spokenName(p.name) !== p.name ? [{ name: spokenName(p.name), aliases: a }] : [])];
  });
  return [...projects, ...favoriteNames().filter((n) => /\p{Lu}/u.test(n)).map((name) => ({ name, aliases: [] }))];
}

/** Leading and trailing punctuation off a word; a possessive "'s" too ("Ria's" -> "Ria"). */
const bareWord = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/i, '');
/**
 * Sounds like the name and is spelled close to it: "Vela" and Veyla, "Eko" and Echo, not "Text"
 * and Tavish. Everyday words must be spelled closer ("horizon" and Horizo, not "like" and Lumina).
 */
const soundsLikeKnown = (w, name, { sound = 0.85, spelling = 0.75 } = {}) =>
  jaroWinkler(phoneticKey(w), phoneticKey(name)) >= sound && jaroWinkler(w.toLowerCase(), name.toLowerCase()) >= spelling;

/**
 * What a sentence is compared with to find names it may have been misheard as, read fresh each time
 * (the vocabulary can change): `known` words spelled exactly as saved (projects, nicknames,
 * contacts, your words, your name), `names` a mishearing could stand for (only the unusual ones:
 * "Studio" in "Lumina Studio" is an everyday word, and hearing "studio" needs no hint), and the
 * `learned` mishearings (what was heard -> what was meant).
 */
export function knownNames() {
  const terms = ['Claude', ...vocabularyTerms(), ...favoriteNames(), ...ownNames(), ...swappableNames().flatMap((s) => [s.name, ...s.aliases])].map(String);
  const known = new Set(terms.flatMap((t) => [t, ...t.split(/\s+/)]).map(norm).filter(Boolean));
  // Claude is said often (Claude Code, "hey Claude") and heard as "cloud"; the word list has it as a word.
  const names = [...new Set(['Claude', ...terms.flatMap((t) => t.split(/\s+/)).map(bareWord).filter((w) => w.length >= 3 && !isEnglishWord(w))])];
  return { known, names, learned: loadVocab().corrections };
}

/**
 * Names a sentence may have been misheard as, for the assistant to weigh with the conversation in
 * view; nothing in the sentence is replaced (the way Siri, Alexa and Google Assistant resolve names:
 * the recognizer is biased toward your names, then names are matched against yours when the words
 * are understood, and you're asked when it matters). A learned mishearing that appears ("Ria" for
 * Mira), or a word that sounds like one of your names without being it ("Vela" for Veyla, "track
 * sticks" for Traxstix). Spelled-out words are what the user meant and never get a hint.
 * @param {string} text the sentence as heard (spelled-out letters already joined)
 * @param {{ known?: Set<string>, names?: string[], learned?: Record<string, string> }} [ctx] see knownNames()
 * @returns {Array<{ heard: string, maybe: string, why: 'learned' | 'sounds-like' }>} at most 6
 */
export function nameHints(text, { known = new Set(), names = [], learned = {} } = {}) {
  const out = [];
  const seen = new Set();
  const add = (heard, maybe, why) => {
    const k = `${heard.toLowerCase()}>${maybe.toLowerCase()}`;
    if (seen.has(k) || norm(heard) === norm(maybe)) return;
    seen.add(k);
    out.push({ heard, maybe, why });
  };
  const spaced = ` ${String(text).toLowerCase().replace(/[^\p{L}\p{N}'’\s]/gu, ' ').replace(/\s+/g, ' ').trim()} `;
  for (const [heard, meant] of Object.entries(learned)) {
    if (spaced.includes(` ${heard.toLowerCase()} `) && !spaced.includes(` ${String(meant).toLowerCase()} `)) add(heard, String(meant), 'learned');
  }
  const raws = String(text).split(/\s+/).filter(Boolean);
  const words = raws.map(bareWord);
  for (const [k, w] of words.entries()) {
    if (w.length < 3 || /['’]/.test(w) || known.has(norm(w))) continue;
    const starts = k === 0 || /[.!?]["')\]]*$/.test(raws[k - 1]);
    const spelling = /^\p{Lu}/u.test(w) ? (starts ? 0.75 : 0.7) : 0.85;
    if (spelling < 0.85 || w.length >= 4) for (const n of names) if (soundsLikeKnown(w, n, { spelling })) add(w, n, 'sounds-like');
    const next = words[k + 1] || '';
    if (next.length >= 3 && !known.has(norm(`${w}${next}`))) {
      for (const n of names) if (n.length >= 6 && soundsLikeKnown(`${w}${next}`, n, { sound: 0.9 })) add(`${w} ${next}`, n, 'sounds-like');
    }
  }
  return out.slice(0, 6);
}

/**
 * The sentence for the assistant, as heard: spelled-out letters joined into the word ("T-A-V-I-S-H"
 * is Tavish), nothing rewritten, and the names it may have been misheard as (nameHints). Instant:
 * no model call.
 * @param {string} raw @param {{ uncertain?: Array<{ word: string }> }} [o]
 * @returns {{ text: string, changes: Array<{ heard: string, meant: string }>, unsure: string[], ms: number,
 *   hints: Array<{ heard: string, maybe: string, why: 'learned' | 'sounds-like' }> }}
 */
export function hearAsSaid(raw, { uncertain = [] } = {}) {
  const t0 = Date.now();
  const spelled = applySpelling(raw, spellableNames());
  const hints = nameHints(spelled.text, knownNames());
  return { text: spelled.text, changes: spelled.applied, unsure: uncertain.map((u) => u.word), hints, ms: Date.now() - t0 };
}
