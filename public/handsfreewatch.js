// Hands-free's safety net for a deaf mic, for the page's own mic (the fallback in a plain browser
// tab; in the Mac app hands-free is its mic's: public/nativemic.js). Hands-free ends a turn with the page's loudness detector
// (public/app.js detectSpeech): it starts a clip when your voice is loud enough and sends it after a
// pause. The live preview (the browser's recognizer) listens through its own capture. When the
// page's mic stream goes deaf (the Mac slept, the input changed, the Mac app's own mic took the
// device over, or the audio context stalled), it delivers silence or nothing at all: the detector
// never hears you, so no turn ever ends, while the preview keeps showing your words piling up.
// Push-to-talk heals itself (every clip is sent, and a silent one reopens the mic); hands-free never
// got that far.
//
// The watch sees both sides: the level of every frame hands-free's detector gets, and the preview's
// words. A pause in the words with no clip under way decides:
//   'deaf'   the mic heard (almost) nothing, or nothing arrived, while the words were said: send the
//            words as the turn, and reopen the mic;
//   'stale'  the detector took (or is taking) that speech already: late words from the preview,
//            tidied away so they don't pile up or get sent twice;
//   'quiet'  the mic heard sound that the detector judged too quiet for speech (a TV, people
//            nearby): left alone, as before.
// Pure (no DOM), so test/handsfreewatch.test.js runs it in Node.

/** A frame this quiet the detector (threshold at least 0.01) can never take for speech. */
export const DEAF_LEVEL = 0.004;
/** No frame for this long: the mic isn't delivering (a stalled audio context, a dead stream). */
export const STALL_MS = 1000;
/** The preview's first words arrive a moment after you start: the audio just before counts too. */
export const LEAD_MS = 1500;
/** The detector heard speech this close to the words: they're the tail of a clip it took. */
export const RECENT_MS = 3000;
/** How much of the frame history is kept (the longest clip is 30 s). */
const KEEP_MS = 40000;

/** How long the words must pause before the watch decides (never shorter than 2 s). */
export const watchPauseMs = (endSilenceMs) => Math.max(Number(endSilenceMs) || 1300, 2000);

/** RMS level of a frame (0..1). @param {Float32Array | number[]} frame */
export function frameLevel(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export class HandsFreeWatch {
  /**
   * @param {{ pauseMs?: () => number, isHearing?: () => boolean, onDeaf?: (text: string) => void,
   *   onStale?: () => void, now?: () => number, setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (t: any) => void }} [o]
   */
  constructor(o = {}) {
    this.pauseMs = o.pauseMs || (() => watchPauseMs(0));
    this.isHearing = o.isHearing || (() => false);
    this.onDeaf = o.onDeaf || (() => {});
    this.onStale = o.onStale || (() => {});
    this.now = o.now || (() => performance.now());
    this.setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer || ((t) => clearTimeout(t));
    /** @type {Array<[number, number]>} [time, level] of each frame */
    this.levels = [];
    this.lastFrameAt = -Infinity;
    this.heardAt = -Infinity; // the last frame the detector was mid-clip
    this.since = 0; // when the preview's current words began (0: none)
    this.text = '';
    this.timer = null;
  }

  /** A frame reached hands-free's detector. @param {Float32Array | number[]} frame */
  frame(frame) {
    const t = this.now();
    this.lastFrameAt = t;
    if (this.isHearing()) this.heardAt = t;
    this.levels.push([t, frameLevel(frame)]);
    while (this.levels.length && this.levels[0][0] < t - KEEP_MS) this.levels.shift();
  }

  /** The preview's words so far (all of them, not only the new ones). @param {string} text */
  words(text) {
    if (!/[\p{L}\p{N}]/u.test(String(text || ''))) return;
    if (!this.since) this.since = this.now();
    this.text = String(text).trim();
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => this.fire(), this.pauseMs());
  }

  /** @returns {'hearing' | 'stale' | 'deaf' | 'quiet' | 'none'} */
  verdict() {
    if (!this.since) return 'none';
    if (this.isHearing()) return 'hearing';
    if (this.heardAt >= this.since - RECENT_MS) return 'stale';
    const t = this.now();
    if (this.lastFrameAt < this.since || t - this.lastFrameAt > STALL_MS) return 'deaf';
    let loudest = 0;
    for (const [at, level] of this.levels) if (at >= this.since - LEAD_MS) loudest = Math.max(loudest, level);
    return loudest < DEAF_LEVEL ? 'deaf' : 'quiet';
  }

  /** The words paused: decide. */
  fire() {
    const v = this.verdict();
    const text = this.text;
    // Still mid-clip: the detector ends this turn itself; the next words start a fresh watch.
    this.reset();
    if (v === 'deaf') this.onDeaf(text);
    else if (v === 'stale') this.onStale();
    return v;
  }

  /** Forget the current words (a turn was sent, or hands-free paused). */
  reset() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.since = 0;
    this.text = '';
  }
}
