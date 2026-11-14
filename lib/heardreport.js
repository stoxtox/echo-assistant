// What the user actually heard of Echo's last reply. Echo's voice stops the moment the user
// speaks, and a new turn cuts what was still waiting to be said, so part of a reply is often never
// heard (Oct 7, 2026: a riddle was asked, the user's voice cut it off, and Echo carried on as if
// they had heard it). The voice tracker (lib/voicestate.js) knows each line's fate; this turns
// the last reply's lines into a note for the assistant. Pure.

/** @typedef {'heard' | 'cut' | 'unsaid' | 'pending' | 'unknown'} Fate */

const join = (lines) => lines.map((l) => String(l.text).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * @param {Array<{ text: string, fate: Fate }>} lines the last reply's spoken lines, in order
 * @returns {string} the note, or '' when all of it was heard or nothing is known
 */
export function heardNote(lines) {
  const known = lines.filter((l) => l.fate !== 'unknown');
  // With the voice off (quiet mode, "speak replies" off) nothing is ever heard: they read it instead.
  if (!known.some((l) => l.fate === 'heard' || l.fate === 'cut')) return '';
  const missedFrom = known.findIndex((l) => l.fate !== 'heard');
  if (missedFrom < 0) return '';
  const heard = join(known.slice(0, missedFrom));
  const missed = join(known.slice(missedFrom));
  if (!missed) return '';
  const cutMid = known[missedFrom]?.fate === 'cut';
  return `(Your last reply was cut short when the user spoke. ${heard ? `They heard: "${clip(heard, 220)}".` : 'They heard none of it.'} They did NOT hear${cutMid ? ' all of' : ''}: "${clip(missed, 320)}". Do not assume they know that part. If it still matters (a question you asked, a result, a warning), say it again in a few words or ask if they want it; if what they say now makes it moot, let it go without comment.)`;
}
