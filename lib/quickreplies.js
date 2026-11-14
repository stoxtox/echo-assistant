// The likely answers to a question Echo just asked, offered as chips beside the reply field
// (the island's, and the window's composer) when the user is typing rather than talking. Only for
// a question with a small, known set of answers: yes or no, or "this or that". An open question
// ("which file?", "what should it say?") gets none. Pure.

const OPEN = /^(?:and |so |ok(?:ay)?,? |alright,? )*(?:what|which|who|whom|whose|where|when|why|how)\b/i;
const YES_NO = /^(?:and |so |ok(?:ay)?,? |alright,? )*(?:should|shall|do|does|did|want|would|will|can|could|may|is|are|was|were|have|has|ready|okay|ok|all good|sound good|make sense)\b|\bwant me to\b|\bshould i\b|\bshall i\b|\bis that (?:right|ok|okay|correct)\b|\bright\?$/i;
const LEAD = /^(?:and |so |ok(?:ay)?,? |alright,? )*(?:(?:do you (?:want|prefer)|would you (?:like|prefer)|should (?:i|it|we) (?:use|be|go with|pick|take|make it)|shall (?:i|we) (?:use|go with|pick|take)|want|is it|do you mean|did you mean)\s+)?/i;

/** The last question in a reply, without its question mark; '' when it doesn't end on one. @param {unknown} text */
export function lastQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!/\?["')\]]*$/.test(t)) return '';
  const parts = t.split(/(?<=[.!?…])\s+/);
  return (parts.at(-1) || '').replace(/\?["')\]]*$/, '').trim();
}

const tidy = (s) => {
  const t = s.replace(/^(?:the|a|an|to|with|by)\s+/i, '').replace(/[,.;:]+$/, '').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : '';
};

/**
 * Chips for the question a reply ends on: ["Yes", "No"], the two or three things it offers
 * ("Aisle or window?" → ["Aisle", "Window"]), or none.
 * @param {unknown} reply Echo's whole reply @returns {string[]}
 */
export function quickReplies(reply) {
  const q = lastQuestion(reply);
  if (!q || q.split(' ').length > 22) return [];
  if (OPEN.test(q)) return [];
  // "this, that or the other": short things on both sides of the last "or".
  const at = q.toLowerCase().lastIndexOf(' or ');
  if (at > 0) {
    const left = q.slice(0, at).replace(LEAD, '').split(/,\s*/).map(tidy).filter(Boolean);
    const right = tidy(q.slice(at + 4));
    const options = [...left, right];
    if (options.length >= 2 && options.length <= 3 && options.every((o) => o.split(' ').length <= 4 && o.length <= 28) && new Set(options.map((o) => o.toLowerCase())).size === options.length) return options;
  }
  return YES_NO.test(q) ? ['Yes', 'No'] : [];
}
