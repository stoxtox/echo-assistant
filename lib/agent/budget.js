// How far one request may go on the Mac (Stage 6, "milestones instead of the step cap"). A fixed
// cap of 25 steps stopped long jobs halfway (an XD layout, a form), and the user had to say "keep
// going" (16 times between Sep 24 and Oct 2). Now Echo keeps going while it's getting somewhere,
// says a line of progress at milestones, and stops only when it's stuck (most recent steps did
// nothing, or it's doing the same thing over and over) or at a firm ceiling.
//
// Pure: lib/computer.js keeps each step's outcome in the run and asks these.

/** A short progress line every this many steps (and carry on). */
export const MILESTONE_STEPS = 20;
/** The firm ceiling for one request, whatever the progress. */
export const HARD_STEPS = 120;
/** One request's time limit with milestones (was 5 minutes). */
export const HARD_MS = 20 * 60 * 1000;
/** Stuck: this many of the last STUCK_WINDOW steps did nothing. */
export const STUCK_FAILS = 5;
export const STUCK_WINDOW = 8;
/** Stuck: the same action on the same target, not done, this many times in a row. */
export const REPEAT_LIMIT = 3;
/** Steps kept per run for the checks. */
const KEEP = 24;

/** @typedef {{ action: string, target: string, done: boolean }} Step */

/**
 * Remember a step's outcome (newest last, the most recent few only).
 * @param {Step[] | undefined} history @param {Step} step
 * @returns {Step[]}
 */
export function remember(history, step) {
  const h = [...(history || []), { action: String(step.action), target: String(step.target || '').toLowerCase().trim(), done: Boolean(step.done) }];
  return h.length > KEEP ? h.slice(-KEEP) : h;
}

/**
 * Is it stuck? Most of the recent steps did nothing, or the same thing keeps failing.
 * @param {Step[] | undefined} history
 * @returns {{ stuck: boolean, why?: string }}
 */
export function stuck(history) {
  const h = history || [];
  const recent = h.slice(-STUCK_WINDOW);
  const fails = recent.filter((s) => !s.done).length;
  if (recent.length >= STUCK_WINDOW && fails >= STUCK_FAILS) return { stuck: true, why: `${fails} of the last ${recent.length} steps didn't do anything` };
  const last = h.slice(-REPEAT_LIMIT);
  if (last.length === REPEAT_LIMIT && last.every((s) => !s.done && s.action === last[0].action && s.target === last[0].target)) {
    return { stuck: true, why: `the same ${last[0].action}${last[0].target ? ` on "${last[0].target}"` : ''} didn't work ${REPEAT_LIMIT} times in a row` };
  }
  return { stuck: false };
}

/** Is this step a milestone (a progress line, then carry on)? @param {number} steps steps so far in this request */
export const milestone = (steps) => steps > 0 && steps % MILESTONE_STEPS === 0;
