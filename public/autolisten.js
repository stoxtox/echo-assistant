// Auto-listen: after Echo asks something ("Should I send it?", "Which one?"), the mic opens by
// itself for a short window once she has completely finished speaking, so you can just answer: no
// Space, no "Hey Echo", no chime. If you don't speak, it closes quietly. While Echo is driving the
// Mac (computer use), the same capture stays on between her words, so "stop" or "no, search for X
// instead" reaches her any time.
//
// This file is only the decisions and the timing: when the window opens and when it closes
// (`until`, which the Mac app's mic is told, so it closes the window itself). In the Mac app its mic
// is armed for the window (public/nativemic.js); in a plain browser tab public/app.js does the
// capture with the page's own mic. Pure (no DOM), so test/autolisten.test.js runs it in Node.

/** How long the mic stays open for an answer, by default. */
export const AUTO_LISTEN_DEFAULT_MS = 8000;
/** The longest window the setting allows. */
export const AUTO_LISTEN_MAX_MS = 20000;

/** The setting (0 = off) as a window length in ms. */
export function autoListenMs(value) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return AUTO_LISTEN_DEFAULT_MS;
  if (n <= 0) return 0;
  return Math.min(AUTO_LISTEN_MAX_MS, Math.max(2000, Math.round(n)));
}

/** The last sentence of a reply, without trailing quotes, brackets or spaces. */
export function lastSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().replace(/["'”’)\]\s]+$/, '');
  if (!t) return '';
  // Split after . ! ? (or … ) followed by a space; keep the last non-empty piece.
  const parts = t.split(/(?<=[.!?…])\s+/).filter((p) => /[\p{L}\p{N}]/u.test(p));
  return (parts[parts.length - 1] || '').trim();
}

// Asking without a question mark: an offer or a choice that clearly waits for you.
const WAITS = /^(so,?\s+)?(want me to|should i|shall i|do you want|would you like|which (one|of)|ready (to|for)|okay to|ok to|can i|may i|let me know (which|if|whether|what|when)|tell me (which|what|whether|if|when)|say (yes|the word|which|when)|your call|go ahead|whenever you'?re ready|show me)\b/i;
// A "?" that isn't a question for you: a quoted title or a rhetorical aside.
const RHETORICAL = /^(who knows|guess what|right)\?$/i;

/**
 * Does Echo's reply end by waiting for an answer? Looks at the last sentence only: a reply that
 * asks something in the middle and then carries on doesn't count.
 * @param {string} text
 */
export function awaitsAnswer(text) {
  const last = lastSentence(text);
  if (!last || RHETORICAL.test(last)) return false;
  if (/\?$/.test(last)) return true;
  return WAITS.test(last.replace(/[.!…]+$/, ''));
}

/**
 * The timing of the auto-listen window and of listening during a computer-use run.
 *
 *   speechEnded({ question }) → after the echo tail (tailMs), open for windowMs
 *   heard()                   → you started talking: the window stays open until your pause
 *   answered()                → your words went off: close
 *   speechStarted()           → Echo talks again: close (her voice is never captured)
 *   setDriving(on)            → while she drives, open between her words, with no time limit
 *
 * `canOpen()` is asked before opening (the mic-off switch, push-to-talk in progress, a dialog…).
 * @typedef {{
 *   windowMs?: number, tailMs?: number,
 *   canOpen?: (mode: 'answer' | 'run') => boolean,
 *   onOpen?: (mode: 'answer' | 'run') => void,
 *   onClose?: (reason: string, mode: 'answer' | 'run') => void,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (t: any) => void,
 *   now?: () => number,
 * }} AutoListenOptions
 */
export class AutoListen {
  /** @param {AutoListenOptions} [o] */
  constructor(o = {}) {
    this.windowMs = o.windowMs ?? AUTO_LISTEN_DEFAULT_MS;
    this.tailMs = o.tailMs ?? 450;
    this.canOpen = o.canOpen || (() => true);
    this.onOpen = o.onOpen || (() => {});
    this.onClose = o.onClose || (() => {});
    this.setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer || ((t) => clearTimeout(t));
    /** @type {'closed' | 'pending' | 'open' | 'hearing'} */
    this.state = 'closed';
    /** @type {'answer' | 'run'} */
    this.mode = 'answer';
    this.driving = false;
    this.speaking = false;
    this.openTimer = null;
    this.closeTimer = null;
    /** When the answer window closes by itself, on the wall clock (0: no limit, or closed). */
    this.until = 0;
    this.now = o.now || Date.now;
  }

  get isOpen() {
    return this.state === 'open' || this.state === 'hearing';
  }

  /** Echo started speaking: nothing is captured until she's done. */
  speechStarted() {
    this.speaking = true;
    if (this.state !== 'closed') this.close('speaking');
  }

  /**
   * Echo finished speaking (all of it: the last audio has ended).
   * @param {{ question?: boolean }} [o] her reply ended waiting for an answer
   */
  speechEnded({ question = false } = {}) {
    this.speaking = false;
    const mode = this.driving ? 'run' : question && this.windowMs > 0 ? 'answer' : null;
    if (!mode) return false;
    this.cancelTimers();
    this.state = 'pending';
    this.mode = mode;
    // The speakers and the room still carry her voice for a moment: wait it out.
    this.openTimer = this.setTimer(() => {
      this.openTimer = null;
      if (this.state === 'pending') this.open(mode);
    }, this.tailMs);
    return true;
  }

  /** Open now (after the tail). Returns false when something says not to. */
  open(mode = this.mode) {
    if (this.speaking || !this.canOpen(mode)) {
      this.state = 'closed';
      return false;
    }
    this.mode = mode;
    this.state = 'open';
    this.onOpen(mode);
    if (mode === 'answer') this.closeIn(this.windowMs);
    return true;
  }

  /** You started talking inside the window: no time-out now, your pause ends it. */
  heard() {
    if (!this.isOpen) return false;
    this.state = 'hearing';
    if (this.closeTimer) this.clearTimer(this.closeTimer);
    this.closeTimer = null;
    this.until = 0;
    return true;
  }

  /** Close by itself after this long with nothing said. @param {number} ms */
  closeIn(ms) {
    this.until = this.now() + ms;
    this.closeTimer = this.setTimer(() => {
      this.closeTimer = null;
      if (this.state === 'open') this.close('timeout');
    }, ms);
  }

  /** What you said went off to be transcribed. During a run, keep listening for the next thing. */
  answered() {
    if (this.state === 'closed') return;
    if (this.mode === 'run' && this.driving) {
      this.state = 'open';
      return;
    }
    this.close('answered');
  }

  /** The heard sound was too short to count (a click, a cough): back to waiting, same deadline rules. */
  notSpeech() {
    if (this.state !== 'hearing') return;
    this.state = 'open';
    if (this.mode === 'answer') this.closeIn(Math.min(this.windowMs, 3000));
  }

  /** Echo is (or stopped) driving the Mac. */
  setDriving(on) {
    on = Boolean(on);
    if (on === this.driving) return;
    this.driving = on;
    if (on) {
      if (!this.speaking && this.state === 'closed') this.open('run');
      else if (this.state !== 'closed') this.mode = 'run';
    } else if (this.mode === 'run' && this.state !== 'hearing') {
      this.close('run_ended');
    }
  }

  /** @param {string} reason */
  close(reason) {
    this.cancelTimers();
    if (this.state === 'closed') return;
    const was = this.state;
    this.state = 'closed';
    if (was !== 'pending') this.onClose(reason, this.mode);
  }

  cancelTimers() {
    if (this.openTimer) this.clearTimer(this.openTimer);
    if (this.closeTimer) this.clearTimer(this.closeTimer);
    this.openTimer = null;
    this.closeTimer = null;
    this.until = 0;
  }
}
