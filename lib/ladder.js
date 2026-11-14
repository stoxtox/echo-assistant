// The help ladder: how much help a lesson step is getting, and when that changes.
//
// Good tutors give a bit more help after a failure and a bit less after a success (RESEARCH.md
// 3.2), one rung at a time. This is only the bookkeeping: which rung a step is on, and what each
// thing that happens does to it. It knows nothing of screens or speech (lib/teach.js acts on what
// it returns), so it is tested by itself with a clock passed in.
//
//   0 wait      the step is said once, and Echo watches
//   1 prompt    one short line that doesn't give the answer
//   2 hint      where it is and what it looks like, in words
//   3 point     the light goes to it and holds
//   4 do_part   Echo does the first half and leaves the rest (only a step that has one)
//   5 do_it     Echo does the step and the lesson moves on
//
// A step begins on the rung the user has earned: the first two steps of a lesson at the point (a
// beginner is shown where things are), after that one rung lower than the last step ended on. That
// is the fading. A step never begins with Echo acting, so the highest start is the point.
//
// Up to the point the user is still doing the step, and each trigger is one rung. Past it Echo
// would be acting for them, which takes the learning away, so the climb onto those rungs takes
// twice as much: two misses, or twice the idle time (a slip gets its correction, not an offer to
// take over). Asking ("where?") always climbs at once.
//
// Two more kinds of fading. A user who passes three steps in a row needing no more than a prompt
// hears less (`sayLess`: no acknowledgement, no line of intent) until a step needs a hint or more.
// And some steps begin a rung lower than they otherwise would (`lowerSteps`): the first two of a
// lesson in an app the user did well in last time, or every step of a lesson they have just watched.

export const RUNG = { WAIT: 0, PROMPT: 1, HINT: 2, POINT: 3, DO_PART: 4, DO_IT: 5 };
/** This long with nothing happening, and the step gets one rung more help. */
export const LADDER_IDLE_MS = 12 * 1000;
/** After Echo asks the user something, it gives them this long before prompting again. */
export const LADDER_ASKED_MS = 3 * 1000;
/** A step passed inside this long, with little or no help, was a fast one. */
export const LADDER_FAST_MS = 8 * 1000;
/** This many fast ones in a row and Echo says less. */
export const LADDER_FAST_RUN = 2;
/** The first steps of a lesson that begin at the point. */
export const LADDER_SHOWN_STEPS = 2;
/** This many steps in a row passed with no more than a prompt, and Echo says less. */
export const LADDER_EASY_RUN = 3;

/** One rung more: nothing happened for a while, a wrong try the check saw, "done" when it isn't, "where?". */
const CLIMBS = ['idle', 'wrong', 'done', 'stuck'];
/** The user's own doing, which Echo may speak after at once; its own nudges wait out a question. */
const UNPROMPTED = ['idle', 'wrong'];
/** A try that didn't do it. */
const MISSES = ['wrong', 'done'];
/** This many misses, or this many idle times, before a rung where Echo acts for the user. */
export const LADDER_PATIENCE = 2;

export class HelpLadder {
  /** @param {{ lowerSteps?: number }} [o] lowerSteps: this many steps, from the first, begin one rung lower */
  constructor({ lowerSteps = 0 } = {}) {
    this.lowerSteps = lowerSteps;
    /** Three steps in a row needed almost no help: no acknowledgements, no line of intent. */
    this.sayLess = false;
    this.easyRun = 0;
    this.rung = RUNG.WAIT;
    /** The rung the last step ended on (passed or left); null before any has. */
    this.prev = /** @type {number | null} */ (null);
    /** The user is ahead of the lesson: shorter step lines, and no prompt unless asked. */
    this.terse = false;
    this.fastRun = 0;
    this.askedAt = -Infinity;
    /** When the step began, and when its rung last changed. */
    this.begunAt = 0;
    this.at = 0;
    this.has = { hint: true, point: true, part: false };
    /** Misses on the rung the step is on now. */
    this.misses = 0;
  }

  /**
   * A step begins. `has`: what this step can give (a hint in words, something to point at, a
   * first half Echo may do); a rung it can't give is passed over.
   * @param {number} index the step's place in the lesson, from 0
   * @param {number} t
   * @param {{ hint?: boolean, point?: boolean, part?: boolean }} [has]
   * @returns {number} the rung it starts on
   */
  begin(index, t, has = {}) {
    this.has = { hint: has.hint !== false, point: has.point !== false, part: Boolean(has.part) };
    const earned = index < LADDER_SHOWN_STEPS || this.prev === null ? RUNG.POINT : Math.max(RUNG.WAIT, Math.min(RUNG.POINT, this.prev - 1));
    let rung = Math.max(RUNG.WAIT, earned - (index < this.lowerSteps ? 1 : 0));
    while (rung > RUNG.WAIT && !this.gives(rung)) rung -= 1;
    this.rung = rung;
    this.misses = 0;
    this.begunAt = t;
    this.at = t;
    return rung;
  }

  /** Can this step give that rung's help? */
  gives(rung) {
    if (rung === RUNG.HINT) return this.has.hint;
    if (rung === RUNG.POINT) return this.has.point;
    if (rung === RUNG.DO_PART) return this.has.part;
    return true;
  }

  /** Echo asked the user something: its own nudges wait. */
  asked(t) {
    this.askedAt = t;
  }

  /** Still inside the wait after a question. */
  waiting(t) {
    return t < this.askedAt + LADDER_ASKED_MS;
  }

  /**
   * Has the idle time passed? Counted from the last thing the user did (`lastActivity`) or the
   * last change of rung, whichever is later.
   * @param {number} t @param {number} [lastActivity]
   */
  idleDue(t, lastActivity = -Infinity) {
    return this.rung < RUNG.DO_IT && !this.waiting(t) && t - Math.max(this.at, lastActivity) >= LADDER_IDLE_MS * this.patience;
  }

  /** The rung one trigger would move to (a rung this step can't give is passed over). */
  get next() {
    let to = Math.min(RUNG.DO_IT, this.rung + 1);
    while (to < RUNG.DO_IT && !this.gives(to)) to += 1;
    return to;
  }

  /** How much it takes to climb from here: twice as much when the next rung is Echo acting. */
  get patience() {
    return this.next >= RUNG.DO_PART ? LADDER_PATIENCE : 1;
  }

  /**
   * Something happened that calls for more help: one rung up, never more (a rung this step can't
   * give is passed over). null: no change (already at the top, an unknown trigger, Echo's own
   * nudge inside the wait after a question, or a first miss when the next rung is Echo acting).
   * `quiet`: the rung changed but nothing is to be said (no prompt for a user who is ahead, unless asked).
   * @param {string} trigger @param {number} t
   * @returns {{ from: number, to: number, trigger: string, quiet: boolean } | null}
   */
  climb(trigger, t) {
    if (!CLIMBS.includes(trigger) || this.rung >= RUNG.DO_IT) return null;
    if (UNPROMPTED.includes(trigger) && this.waiting(t)) return null;
    if (MISSES.includes(trigger) && ++this.misses < this.patience) return null;
    return this.move(this.next, trigger, t);
  }

  /** "Show me where": up to the point if the step is below it. null when it is there already (the light just goes again). */
  pointOut(t) {
    return this.rung >= RUNG.POINT ? null : this.move(RUNG.POINT, 'where', t);
  }

  /**
   * Straight to the top for this step: "show me" / "just do it" ('do'), or frustration, where
   * Echo offers to do it ('frustrated'). null when it is there already.
   * @param {string} trigger @param {number} t
   */
  top(trigger, t) {
    return this.rung >= RUNG.DO_IT ? null : this.move(RUNG.DO_IT, trigger, t);
  }

  move(to, trigger, t) {
    const from = this.rung;
    const quiet = this.terse && trigger === 'idle' && to === RUNG.PROMPT;
    // Anything but time passing shows the user isn't ahead after all.
    if (trigger !== 'idle') {
      this.terse = false;
      this.fastRun = 0;
    }
    // The step needed a hint or more: back to saying everything.
    if (to >= RUNG.HINT) {
      this.sayLess = false;
      this.easyRun = 0;
    }
    this.rung = to;
    this.misses = 0;
    this.at = t;
    return { from, to, trigger, quiet };
  }

  /** The step passed: the next one starts a rung lower. Two fast ones in a row and Echo says less. */
  solved(t) {
    this.prev = this.rung;
    const fast = this.rung <= RUNG.PROMPT && t - this.begunAt <= LADDER_FAST_MS;
    this.fastRun = fast ? this.fastRun + 1 : 0;
    if (this.fastRun >= LADDER_FAST_RUN) this.terse = true;
    this.easyRun = this.rung <= RUNG.PROMPT ? this.easyRun + 1 : 0;
    if (this.easyRun >= LADDER_EASY_RUN) this.sayLess = true;
  }

  /** The step was left undone ("skip", or Echo did it): the next one starts from where this one stood. */
  left() {
    this.prev = this.rung;
    this.fastRun = 0;
    this.easyRun = 0;
  }

  /** Echo did the step itself (a demonstration, or "just do it"): the next one is the user's, with the light. */
  shown() {
    this.prev = RUNG.DO_IT;
    this.fastRun = 0;
    this.easyRun = 0;
  }

  /** "I know this", "skip": Echo says less from here. */
  ahead() {
    this.terse = true;
  }
}
