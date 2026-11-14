// "Keep an eye on it": Echo watches one window by itself, between the user's messages, and speaks
// up when what it is waiting for happens (Oct 7, 2026: "I can't watch it in the background, so
// ask me in a couple of minutes"). A build in Terminal finishing or failing; another assistant's
// reply coming to an end.
//
// A watch reads the window's text every few seconds (the Mac app's read-only `state` request,
// through Accessibility: no picture is taken, nothing is clicked, and the app need not be in
// front). It ends when a phrase it was told to wait for appears (or one that means it failed),
// when the text stops changing, or when its time is up. Then the assistant gets one event, looks
// once, and tells the user. The text itself is never kept: only whether it changed.
import { createHash } from 'node:crypto';

export const WATCH_EVERY_MS = 6000;
/** Unchanged this long after it was seen changing: it has stopped. */
export const QUIET_MS = 14_000;
/** Unchanged this long from the very start: it was already finished. */
export const STILL_FROM_START_MS = 45_000;
export const WATCH_DEFAULT_MS = 15 * 60 * 1000;
export const WATCH_MAX_MS = 60 * 60 * 1000;
export const WATCH_MOST = 3;
/** This many reads in a row that fail (the app quit, the Mac app is away): the watch is lost. */
export const MISSES_MOST = 4;

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const phrases = (v) => (Array.isArray(v) ? v : []).map((x) => tidy(x).toLowerCase()).filter((x) => x.length >= 2).slice(0, 8);
const count = (text, phrase) => text.split(phrase).length - 1;
/** How many times a phrase is there, and the few words right after its last one (to tell a new one from the old one when the count is the same: the window only shows the end of a long log). */
const seen = (text, phrase) => {
  const at = text.lastIndexOf(phrase);
  return { n: count(text, phrase), after: at < 0 ? '' : text.slice(at + phrase.length, at + phrase.length + 24) };
};
/** Has the phrase appeared again since the first look? */
const again = (now, base) => now.n > (base?.n || 0) || (now.n > 0 && Boolean(base) && base.n > 0 && base.after.length >= 6 && !now.after.startsWith(base.after));
const digest = (text) => createHash('sha1').update(text).digest('hex');

/**
 * @typedef {{ id: string, what: string, app: string, until: string[], fail: string[], quiet: boolean,
 *   startedAt: number, endsAt: number, checks: number, misses: number, base: Record<string, { n: number, after: string }> | null,
 *   last: string, changedAt: number, everChanged: boolean, timer: any }} Watch
 */

export class Watcher {
  /**
   * @param {{ read: (app: string) => Promise<{ ok?: boolean, text?: string }>, onEnd: (w: Watch, why: string, detail: string) => void,
   *   onStart?: (w: Watch) => void, now?: () => number, everyMs?: number,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void }} o
   *   read: the window's text for an app; onEnd: the watch is over (why: found | failed | stopped_changing | time_up | lost | cancelled)
   */
  constructor({ read, onEnd, onStart = () => {}, now = Date.now, everyMs = WATCH_EVERY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.read = read;
    this.onEnd = onEnd;
    this.onStart = onStart;
    this.now = now;
    this.everyMs = everyMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    /** @type {Map<string, Watch>} */
    this.watches = new Map();
    this.seq = 0;
  }

  /**
   * Start watching. With no phrases to wait for, it waits for the text to stop changing.
   * @param {{ what?: unknown, app?: unknown, until?: unknown, fail?: unknown, quiet?: unknown, minutes?: unknown }} a
   * @returns {{ id?: string, error?: string }}
   */
  start(a) {
    const app = tidy(a.app).slice(0, 60);
    if (!app) return { error: 'Say which app to watch.' };
    if (this.watches.size >= WATCH_MOST) return { error: `Echo is already watching ${this.watches.size} things. Stop one first.` };
    const until = phrases(a.until), fail = phrases(a.fail);
    const ms = Math.min(WATCH_MAX_MS, Math.max(30_000, (Number(a.minutes) || 0) * 60_000 || WATCH_DEFAULT_MS));
    const t = this.now();
    /** @type {Watch} */
    const w = { id: `w${++this.seq}`, what: tidy(a.what).slice(0, 80) || `the ${app} window`, app, until, fail, quiet: a.quiet === true || !until.length, startedAt: t, endsAt: t + ms, checks: 0, misses: 0, base: null, last: '', changedAt: t, everChanged: false, timer: null };
    this.watches.set(w.id, w);
    this.onStart(w);
    this.arm(w);
    return { id: w.id };
  }

  arm(w) {
    w.timer = this.setTimer(() => { this.check(w).catch(() => {}); }, this.everyMs);
    w.timer?.unref?.();
  }

  /** One look. @param {Watch} w */
  async check(w) {
    if (!this.watches.has(w.id)) return;
    const t = this.now();
    let r;
    try { r = await this.read(w.app); } catch { r = null; }
    if (!this.watches.has(w.id)) return;
    w.checks++;
    if (!r || r.ok === false || typeof r.text !== 'string') {
      if (++w.misses >= MISSES_MOST) return this.end(w, 'lost', '');
    } else {
      w.misses = 0;
      const text = tidy(r.text).toLowerCase();
      const counts = Object.fromEntries([...w.until, ...w.fail].map((p) => [p, seen(text, p)]));
      const sum = digest(text);
      if (w.base === null) {
        // The first look is where things stood: a "passed" already on screen from an earlier run is not news.
        w.base = counts;
        w.last = sum;
      } else {
        const news = (list) => list.find((p) => again(counts[p], w.base?.[p]));
        const failed = news(w.fail), found = news(w.until);
        if (failed) return this.end(w, 'failed', failed);
        if (found) return this.end(w, 'found', found);
        if (sum !== w.last) { w.last = sum; w.changedAt = t; w.everChanged = true; }
        else if (w.quiet && ((w.everChanged && t - w.changedAt >= QUIET_MS) || (!w.everChanged && t - w.startedAt >= STILL_FROM_START_MS))) return this.end(w, 'stopped_changing', '');
      }
    }
    if (t >= w.endsAt) return this.end(w, 'time_up', '');
    this.arm(w);
  }

  /** @param {Watch} w @param {string} why @param {string} detail */
  end(w, why, detail) {
    if (!this.watches.delete(w.id)) return;
    this.clearTimer(w.timer);
    this.onEnd(w, why, detail);
  }

  /** Stop one watch (by id, or the one on that app or thing), or all of them. Returns how many stopped. */
  stop(which = '') {
    const q = tidy(which).toLowerCase();
    const hit = [...this.watches.values()].filter((w) => !q || w.id === q || w.app.toLowerCase().includes(q) || w.what.toLowerCase().includes(q));
    for (const w of hit) this.end(w, 'cancelled', '');
    return hit.length;
  }

  /** For the assistant, with each of the user's messages: what Echo is keeping an eye on. */
  note() {
    if (!this.watches.size) return '';
    const t = this.now();
    return `(watching for them: ${[...this.watches.values()].map((w) => `${w.what} in ${w.app}, ${Math.max(1, Math.round((t - w.startedAt) / 60_000))} min so far`).join('; ')}. You will be told when it ends; if they ask how it is going, look once and say. stop_watch ends it.)`;
  }
}

/** What the assistant is told when a watch ends. @param {Watch} w @param {string} why @param {string} detail */
export function watchEvent(w, why, detail) {
  const mins = Math.max(1, Math.round((Date.now() - w.startedAt) / 60_000));
  const head = `[watch] You were keeping an eye on ${w.what} in ${w.app} for the user.`;
  const look = 'Look at that app once (look_at_screen), then tell them in one or two sentences how it ended and the one thing that matters. Do nothing else there unless they ask.';
  if (why === 'found') return `${head} "${detail}" has just appeared, so it looks finished. ${look}`;
  if (why === 'failed') return `${head} "${detail}" has just appeared, so it looks like it failed. ${look} Say what went wrong, in plain words.`;
  if (why === 'stopped_changing') return `${head} It has stopped changing, so it looks done (or is waiting for them). ${look}`;
  if (why === 'time_up') return `${head} After ${mins} minutes it is still going. Tell them so in one line and ask if you should keep watching.`;
  if (why === 'lost') return `${head} Echo can no longer read that window (the app may have closed). Tell them in one line.`;
  return '';
}
