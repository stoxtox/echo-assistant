// Long-term memory (data/memory.md, one "- fact" per line) in two parts: a trimmed core that goes
// into every session's system prompt, and the rest, which the assistant pulls with the recall tool
// when a topic comes up. The whole file used to go into every model call (55 KB, about 14K tokens,
// a quarter of the context), which made every reply slower.
//
// The core is stable: it only changes when memory.md does, so the prompt cache keeps hitting.
// Short facts (names, preferences, standing rules) are kept whole, newest first; long notes are
// cut to their first sentence with a pointer to recall.

/** About 2K tokens of memory in every prompt. */
export const CORE_BUDGET = 8000;
/** A fact longer than this is shortened in the core (recall has it in full). */
const LONG_FACT = 280;

/** The facts in memory.md, in file order (blank lines and headings dropped). @param {string} text */
export function memoryFacts(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ''));
}

/** A long fact shortened to its first sentence (or a word boundary), marked as cut. */
function shorten(fact) {
  if (fact.length <= LONG_FACT) return fact;
  const m = fact.slice(0, LONG_FACT).match(/^.{40,}?[.!?](?=\s)/);
  const head = m ? m[0] : fact.slice(0, LONG_FACT).replace(/\s+\S*$/, '');
  return `${head} (more with recall)`;
}

/**
 * The core memory for the prompt: every fact that fits in `budget` characters, newest first when
 * they don't all fit, printed in file order so the text stays the same between turns.
 * @param {string} text memory.md
 * @param {number} [budget]
 * @returns {{ text: string, kept: number, total: number }}
 */
export function coreMemory(text, budget = CORE_BUDGET) {
  const facts = memoryFacts(text);
  const lines = facts.map(shorten);
  const keep = new Set();
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const n = lines[i].length + 3;
    if (used + n > budget) continue;
    used += n;
    keep.add(i);
  }
  const out = lines.filter((_, i) => keep.has(i)).map((l) => `- ${l}`);
  const left = facts.length - keep.size;
  if (left) out.push(`- (${left} older note${left === 1 ? '' : 's'} not shown: call recall with a topic when one might matter)`);
  return { text: out.join('\n'), kept: keep.size, total: facts.length };
}

const STOP = new Set('a an the and or but of to in on at for with about from by is are was were be it its this that what who how when where which do does did i me my you your we our they them their he she his her'.split(' '));
const words = (s) => String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w)) || [];

/**
 * The facts that match a topic, best first, in full.
 * @param {string} text memory.md
 * @param {string} topic
 * @param {number} [max]
 * @returns {string[]}
 */
export function recallMemory(text, topic, max = 8) {
  const want = words(topic);
  if (!want.length) return [];
  const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');
  const wanted = new Set(want.map(stem));
  return memoryFacts(text)
    .map((fact, i) => {
      const have = new Set(words(fact).map(stem));
      let score = 0;
      for (const w of wanted) if (have.has(w)) score++;
      return { fact, i, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, max)
    .map((r) => r.fact);
}
