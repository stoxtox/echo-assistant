// The thread: what Echo and the user are in the middle of, kept between sentences so "next",
// "that one" and "send it" need no fresh look at everything (Oct 7, 2026: "go to the next point"
// made Echo read the whole screen again and sum up what had just been said).
//
// One thread at a time: what they are doing, the things they are going through and which of them
// are done, the one they are on, and anything written but not yet sent. The assistant keeps it
// with keep_thread; a walk-through (lib/explain.js) keeps its own place in it. It rides along
// with each of the user's messages as a short note, and fades after a quiet quarter of an hour.

/** How long a thread nobody has touched still counts. */
export const THREAD_MS = 15 * 60 * 1000;
export const ITEMS_MAX = 12;

const line = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @typedef {{ doing: string, items: string[], done: number[], at: number, draft: string, where: string, touched: number, places: Record<number, number> }} Thread
 *   (places: where the page was scrolled to at each item, 0 top … 1 bottom, so "back to that one" is one jump)
 *   items: what they are going through, in order; done: indexes handled; at: the one they are on
 *   (-1: none); draft: words written for the user and not yet sent; where: the app or place.
 */

export class ThreadKeeper {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    /** @type {Thread | null} */
    this.thread = null;
  }

  /** The thread, while it is still fresh. @returns {Thread | null} */
  get current() {
    if (this.thread && this.now() - this.thread.touched > THREAD_MS) this.thread = null;
    return this.thread;
  }

  /**
   * Set or change the thread. Only what is given changes; a new `doing` with new `items` starts over.
   * @param {{ doing?: unknown, items?: unknown, at?: unknown, done?: unknown, draft?: unknown, where?: unknown }} patch
   * @returns {Thread}
   */
  keep(patch) {
    const had = this.current;
    const items = Array.isArray(patch.items) ? patch.items.map((x) => line(x, 60)).filter(Boolean).slice(0, ITEMS_MAX) : null;
    const fresh = !had || (items && items.join('|') !== had.items.join('|'));
    /** @type {Thread} */
    const t = fresh
      ? { doing: line(patch.doing ?? had?.doing, 120), items: items || [], done: [], at: -1, draft: '', where: line(patch.where ?? had?.where, 60), touched: this.now(), places: {} }
      : { ...had, touched: this.now() };
    if (!fresh && patch.doing !== undefined) t.doing = line(patch.doing, 120);
    if (patch.where !== undefined) t.where = line(patch.where, 60);
    if (patch.draft !== undefined) t.draft = line(patch.draft, 600);
    const inRange = (n) => Number.isInteger(n) && n >= 0 && n < t.items.length;
    if (Array.isArray(patch.done)) t.done = [...new Set([...t.done, ...patch.done.map(Number).filter(inRange)])].sort((a, b) => a - b);
    if (patch.at !== undefined) {
      const n = Number(patch.at);
      // Moving on from an item means it was handled.
      if (inRange(t.at) && n !== t.at && !t.done.includes(t.at)) t.done = [...t.done, t.at].sort((a, b) => a - b);
      t.at = inRange(n) ? n : -1;
    }
    this.thread = t;
    return t;
  }

  /** The page was scrolled to `position` while they are on an item: that is the item's place. @param {number} position */
  placed(position) {
    const t = this.current;
    if (!t || t.at < 0 || !Number.isFinite(position)) return;
    t.places = { ...(t.places || {}), [t.at]: Math.min(1, Math.max(0, position)) };
  }

  /** Where the page was for item `i` (0 … 1), or null when it was never there. @param {number} i */
  placeOf(i) {
    const v = this.current?.places?.[i];
    return typeof v === 'number' ? v : null;
  }

  /** The thing after the one they are on that is not done yet (-1: none left). */
  next() {
    const t = this.current;
    if (!t) return -1;
    for (let i = Math.max(0, t.at + 1); i < t.items.length; i++) if (!t.done.includes(i)) return i;
    for (let i = 0; i < t.items.length; i++) if (!t.done.includes(i) && i !== t.at) return i;
    return -1;
  }

  clear() {
    this.thread = null;
  }

  /** The note that rides with the user's message: where the two of them are. '' with no thread. */
  note() {
    const t = this.current;
    if (!t || (!t.doing && !t.items.length && !t.draft)) return '';
    const parts = [`(thread: ${t.doing || 'going through things together'}${t.where ? `, in ${t.where}` : ''}.`];
    if (t.items.length) {
      const mark = (i) => (i === t.at ? 'NOW' : t.done.includes(i) ? 'done' : 'to do');
      parts.push(`The list: ${t.items.map((x, i) => `${i + 1}. ${x} [${mark(i)}]`).join('; ')}.`);
      const n = this.next();
      parts.push(n >= 0 ? `"Next" means number ${n + 1}.` : 'Everything on it is handled.');
    }
    if (t.draft) parts.push(`Written for them and NOT sent yet: "${t.draft}". "Send it" means this, as it is.`);
    parts.push('Use this instead of looking at everything again; look only at what the next thing needs. Never go over a done one again unless they ask. Update it with keep_thread as you go.)');
    return parts.join(' ');
  }
}
