// Echo's voice, as the server knows it: when a line it asked for really starts and ends.
//
// The server asks for a line (a `speak` or `say` broadcast) and the page plays it (public/app.js).
// Lessons and pointing depend on when that line is over: a demonstration moves once its line of
// intent has been said, a story is followed by quiet, the help ladder counts idle time from the
// end of what Echo said. So every line gets an id here, the page says what happens to it over its
// WebSocket (lib/server/window.js):
//
//   { type: 'voice', event: 'queued', id }                 it will be voiced (the voice is on)
//   { type: 'voice', event: 'start', id, chars, ms, fresh } a piece of it is audible in `ms`
//   { type: 'voice', event: 'end', id, chars, ms, last }    a piece of it has ended (`last`: the line has)
//   { type: 'voice', event: 'idle', id }                    nothing is queued or playing (`id`: the last line it was given)
//
// and whoever needs to wait asks `whenDone(id)`. Nothing can hang on a voice that never answers:
// with no page attached, or the voice switched off, the line counts as over after the time its
// length would take (`estimateMs`, the only place that estimate is used), and a line the page
// took but never finished counts as over a few seconds past that.
//
// It also knows how long the voice takes to start (from asking to the first audible sound), so
// words held for the light can be asked for that much early (`leadStartMs`).
//
// Only ids, counts and durations pass through here: never what was said.
import { record as timeline } from './timeline.ts';

/** About how long a line of this many characters takes to say. */
export const estimateMs = (chars) => (chars > 0 ? 300 + 65 * chars : 0);
/** A line the page took is given this long past twice its estimate to end, then it counts as over. */
export const VOICE_HANG_MS = 8000;
/** The longest anything waits for the voice to go quiet. */
export const VOICE_QUIET_MS = 8000;
/** How many of the latest start-up delays the median is taken over. */
export const START_DELAYS = 10;
/** A start-up delay longer than this was something else (a stall, a lost line): not counted. */
const START_DELAY_MAX_MS = 5000;
/** Lines remembered (the oldest are let go as over). */
const MAX_LINES = 50;
const ID_OK = /^v\d{1,12}$/;

/** The middle value of a list of numbers (the lower of the two middle ones for an even count); 0 for none. */
export function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
}

/**
 * When to ask for words that should be heard as the light lands: `flightMs` after the light
 * left, less the voice's start-up delay; at once when the flight is shorter than that delay.
 * @param {number} flightMs how long the light's flight is expected to take
 * @param {number} startDelayMs how long the voice takes from being asked to its first sound
 * @returns {number} ms after the light left
 */
export function leadStartMs(flightMs, startDelayMs) {
  if (!(flightMs > 0)) return 0;
  return Math.max(0, Math.round(flightMs - Math.max(0, startDelayMs || 0)));
}

/**
 * @typedef {{ id: string, chars: number, askedAt: number, queued: boolean, startAt: number, endAt: number,
 *   heard: boolean, timer: any, waiters: Array<(r: { at: number, heard: boolean }) => void> }} Line
 */

export class VoiceState {
  /** @param {{ now?: () => number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} [o] */
  constructor({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.seq = 0;
    /** Quiet mode (lib/dispatcher.js setTextOnly): the pages speak nothing, so a line is over as soon as it is asked for. */
    this.silent = false;
    /** The lines asked for lately, oldest first. @type {Map<string, Line>} */
    this.lines = new Map();
    /** The pages that have something queued or playing. @type {Set<any>} */
    this.busy = new Set();
    /** When the voice last ended a piece or went quiet (0: never heard). */
    this.lastEndAt = 0;
    /** The latest start-up delays (ms from asking for a line to its first sound). @type {number[]} */
    this.delays = [];
    /** Who waits for quiet. @type {Set<() => void>} */
    this.quietWaiters = new Set();
  }

  /** Is a page voicing something (queued or playing) right now? */
  get speaking() {
    return this.busy.size > 0;
  }

  /**
   * A line is about to be asked for: its id, to send with the broadcast and to wait on.
   * @param {string} text what will be spoken (only its length is kept)
   */
  line(text) {
    const id = `v${++this.seq}`;
    const chars = String(text ?? '').replace(/\s+/g, ' ').trim().length;
    this.lines.set(id, { id, chars, askedAt: this.now(), queued: false, startAt: 0, endAt: 0, heard: false, timer: null, waiters: [] });
    // Quiet mode: nothing is spoken, so nothing waits for the line to end.
    if (this.silent) this.finish(/** @type {Line} */ (this.lines.get(id)), this.now(), false);
    if (this.lines.size > MAX_LINES) {
      const [oldest] = this.lines.values();
      this.finish(oldest, this.now(), false);
      this.lines.delete(oldest.id);
    }
    return id;
  }

  /**
   * What a page says about its voice (see the top of this file). Anything else is ignored.
   * @param {{ event?: unknown, id?: unknown, chars?: unknown, ms?: unknown, last?: unknown, fresh?: unknown }} msg
   * @param {any} [who] the page (its socket), so two pages don't end each other's speaking
   */
  event(msg, who = 'page') {
    const t = this.now();
    const id = typeof msg?.id === 'string' && ID_OK.test(msg.id) ? msg.id : '';
    const l = this.lines.get(id);
    const ms = Number.isFinite(Number(msg?.ms)) ? Math.min(Math.max(Number(msg.ms), 0), 60000) : 0;
    switch (msg?.event) {
      case 'queued':
        if (id) this.busy.add(who);
        if (l) l.queued = true;
        break;
      case 'start':
        if (id) this.busy.add(who);
        if (l && !l.endAt && !l.startAt) {
          l.queued = true;
          l.startAt = t + ms;
          // Only a line that had nothing ahead of it tells how long the voice takes to start.
          const delay = l.startAt - l.askedAt;
          if (msg.fresh === true && delay >= 0 && delay <= START_DELAY_MAX_MS) this.delays = [...this.delays, delay].slice(-START_DELAYS);
        }
        break;
      case 'end':
        this.lastEndAt = t;
        if (l && msg.last === true) this.finish(l, t, true);
        break;
      case 'idle': {
        if (this.busy.delete(who)) this.lastEndAt = t;
        // Everything this page was given is over, said or not (hushed, or dropped while the user
        // talked). A line asked for after the one it names hasn't reached the page yet: it stands.
        if (l) for (const x of this.lines.values()) {
          if (x.queued && !x.endAt) this.finish(x, t, Boolean(x.startAt));
          if (x === l) break;
        }
        this.quietNow();
        break;
      }
    }
  }

  /** A page went away: it isn't speaking any more. */
  gone(who) {
    if (this.busy.delete(who)) this.lastEndAt = this.now();
    this.quietNow();
  }

  /**
   * What became of a line: heard (played to its end, or near it), cut (it began and was stopped
   * well short), unsaid (it ended without ever starting), pending (asked for, not begun), or
   * unknown (no such line any more).
   * @param {string} id @returns {'heard' | 'cut' | 'unsaid' | 'pending' | 'unknown'}
   */
  fate(id) {
    const l = this.lines.get(id);
    if (!l) return 'unknown';
    if (!l.startAt) return l.endAt ? 'unsaid' : 'pending';
    if (!l.endAt) return 'cut';
    return l.endAt - l.startAt < estimateMs(l.chars) * 0.55 ? 'cut' : 'heard';
  }

  /** How long the voice takes from being asked to its first sound: the median of the latest ten. 0 before any was heard. */
  startDelayMs() {
    return median(this.delays);
  }

  /** When a line that hasn't ended counts as over anyway. */
  deadline(l) {
    const est = estimateMs(l.chars);
    return l.askedAt + (l.queued ? 2 * est + VOICE_HANG_MS : est);
  }

  /** @param {Line} l @param {number} at @param {boolean} heard did the page say so (false: the estimate) */
  finish(l, at, heard) {
    if (l.endAt) return;
    l.endAt = at;
    l.heard = heard;
    if (l.timer) this.clearTimer(l.timer);
    l.timer = null;
    // For the timeline: how long the line took from being asked for, and how long the voice took
    // to start. A line the page took and never finished is the one worth finding afterwards.
    if (heard) timeline('server', 'voice.line', { id: l.id, chars: l.chars, ms: at - l.askedAt, ...(l.startAt ? { startMs: Math.round(l.startAt - l.askedAt) } : {}) });
    else if (l.queued) timeline('server', 'voice.unheard', { id: l.id, chars: l.chars, ms: at - l.askedAt });
    for (const w of l.waiters.splice(0)) w({ at, heard });
  }

  /** The line's own limit: checked again when it runs out, since the page may have taken the line meanwhile. */
  arm(l) {
    if (l.timer || l.endAt) return;
    const t = this.setTimer(() => {
      l.timer = null;
      if (l.endAt) return;
      if (this.now() < this.deadline(l)) this.arm(l);
      else this.finish(l, this.now(), false);
    }, Math.max(0, this.deadline(l) - this.now()));
    t?.unref?.();
    l.timer = t;
  }

  /**
   * Resolves when that line has ended: `heard` when the page said so, and `at` is when. With no
   * word from a page it resolves after the time the line's length would take (so nothing hangs
   * with no page attached, or the voice off); `timeoutMs` sets another limit, counted from now.
   * @param {string} id @param {number} [timeoutMs]
   * @returns {Promise<{ at: number, heard: boolean }>}
   */
  whenDone(id, timeoutMs) {
    const l = this.lines.get(id);
    if (!l) return Promise.resolve({ at: this.now(), heard: false });
    if (l.endAt) return Promise.resolve({ at: l.endAt, heard: l.heard });
    return new Promise((resolve) => {
      let own = null;
      const done = (r) => {
        if (own) this.clearTimer(own);
        resolve(r);
      };
      l.waiters.push(done);
      this.arm(l);
      if (timeoutMs === undefined) return;
      own = this.setTimer(() => {
        own = null;
        const k = l.waiters.indexOf(done);
        if (k < 0) return;
        l.waiters.splice(k, 1);
        resolve({ at: this.now(), heard: false });
      }, Math.max(0, timeoutMs));
      own?.unref?.();
    });
  }

  /**
   * Resolves once no page is voicing anything: true when it is quiet, false when `timeoutMs`
   * ran out first. At once when nothing is being said (or no page is attached).
   * @param {number} [timeoutMs] @returns {Promise<boolean>}
   */
  whenQuiet(timeoutMs = VOICE_QUIET_MS) {
    if (!this.speaking) return Promise.resolve(true);
    return new Promise((resolve) => {
      const quiet = () => {
        this.clearTimer(timer);
        this.quietWaiters.delete(quiet);
        resolve(true);
      };
      const timer = this.setTimer(() => {
        this.quietWaiters.delete(quiet);
        resolve(false);
      }, Math.max(0, timeoutMs));
      timer?.unref?.();
      this.quietWaiters.add(quiet);
    });
  }

  quietNow() {
    if (this.speaking) return;
    for (const w of [...this.quietWaiters]) w();
  }
}

/** The one voice the server has. */
export const voice = new VoiceState();
