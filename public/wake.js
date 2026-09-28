// The wake-word listener's local half: a cheap loudness detector that runs on every mic frame and
// never sends anything by itself. When a burst of speech starts, its first ~1.8 s (or less, if it
// ends sooner) goes to `check`, which asks this machine's Whisper whether it opens with "Hey Echo"
// (lib/wake.js). No match: the audio is dropped. A match: `onWake`, then the request is recorded
// until a natural pause and handed to `onTurn` (wake word and all; the server takes it off).
// Pure (no DOM), so test/wake.test.js and scripts/wake-bench.js run it in Node.

/** Root-mean-square level of one frame (0..1). */
export function frameLevel(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** Join Float32Array chunks. */
export function joinChunks(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const WAKE_DEFAULTS = {
  windowMs: 1800, // how much of a burst is checked for the wake word
  preRollMs: 300, // audio kept from just before the burst, so "Hey" isn't clipped
  startMs: 120, // this much loud sound starts a burst
  gapMs: 350, // a pause this long ends a burst (and the next one gets its own check)
  minVoicedMs: 180, // a shorter burst (a click, a cough) is never checked
  endSilenceMs: 1300, // after the wake word, this pause ends your request
  waitMs: 6000, // after a bare "Hey Echo", how long to wait for the request
  maxMs: 30000, // the longest request
};

/**
 * @typedef {{ wake: boolean, rest?: string }} WakeResult
 * @typedef {{
 *   rate: number,
 *   check: (samples: Float32Array) => Promise<WakeResult>,
 *   onWake?: (r: WakeResult) => void,
 *   onTurn?: (samples: Float32Array, info: { rest: string, followUp: boolean }) => void,
 *   onCancel?: (why: string) => void,
 *   onState?: (state: string) => void,
 * } & Partial<typeof WAKE_DEFAULTS>} WakeOptions
 */
export class WakeListener {
  /** @param {WakeOptions} opts */
  constructor(opts) {
    this.o = { ...WAKE_DEFAULTS, ...opts };
    this.noiseFloor = 0.004;
    this.checks = 0;
    this.gen = 0;
    this.state = 'idle'; // starts idle without calling onState (the page isn't ready for it yet)
    this.reset();
  }

  /** Back to waiting for the wake word, forgetting any audio (Echo started talking, the mic went off). */
  reset() {
    this.gen++;
    this.preRoll = [];
    this.buf = null; // chunks of the current burst or request
    this.bufMs = 0;
    this.voicedMs = 0; // recent loud sound (decays), to start a burst
    this.burstVoicedMs = 0;
    this.silentMs = 0;
    this.skip = false; // the rest of a burst that was checked and wasn't the wake word
    this.awakeAt = 0; // bufMs when the wake word was confirmed
    this.heardRequest = false;
    this.rest = '';
    this.followUp = false;
    this.setState('idle');
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.o.onState?.(s);
  }

  /** Listen for a reply without the wake word (Echo just asked you something). */
  expectFollowUp() {
    this.reset();
    this.buf = [...this.preRoll];
    this.bufMs = 0;
    this.awakeAt = 0;
    this.followUp = true;
    this.setState('awake');
  }

  /** @param {Float32Array} frame */
  feed(frame) {
    const o = this.o;
    const ms = (frame.length / o.rate) * 1000;
    const level = frameLevel(frame);
    const threshold = Math.max(0.01, this.noiseFloor * 3.5);
    const loud = level > threshold;
    if (!loud && this.state === 'idle' && !this.buf) this.noiseFloor = this.noiseFloor * 0.995 + level * 0.005;
    if (loud) {
      // Capped, so a long burst doesn't leave enough behind to start the next one on silence.
      this.voicedMs = Math.min(this.voicedMs + ms, this.o.startMs);
      this.silentMs = 0;
    } else {
      this.voicedMs = Math.max(0, this.voicedMs - ms);
      this.silentMs += ms;
    }

    if (this.state === 'awake') return this.feedAwake(frame, ms, loud);

    if (!this.buf) {
      this.preRoll.push(frame);
      let keep = this.preRoll.length * ms;
      while (keep > o.preRollMs && this.preRoll.length > 1) {
        this.preRoll.shift();
        keep -= ms;
      }
      if (this.skip) {
        if (this.silentMs >= o.gapMs) this.skip = false;
        return;
      }
      if (this.voicedMs >= o.startMs) {
        this.buf = [...this.preRoll];
        this.bufMs = this.buf.length * ms;
        this.burstVoicedMs = this.voicedMs;
        this.preRoll = [];
      }
      return;
    }

    this.buf.push(frame);
    this.bufMs += ms;
    if (loud) this.burstVoicedMs += ms;
    if (this.state === 'checking') {
      if (this.bufMs > o.maxMs) this.reset();
      return;
    }
    const ended = this.silentMs >= o.gapMs;
    if (ended && this.burstVoicedMs < o.minVoicedMs) {
      this.buf = null;
      return;
    }
    if (ended || this.bufMs >= o.windowMs) this.runCheck(ended);
  }

  /** @param {boolean} ended the burst is already over */
  runCheck(ended) {
    const gen = this.gen;
    const windowSamples = Math.round((this.o.windowMs / 1000) * this.o.rate);
    const all = joinChunks(this.buf || []);
    const window = all.subarray(0, Math.min(all.length, windowSamples));
    this.checks++;
    this.setState('checking');
    this.o.check(window).then(
      (r) => this.checked(gen, r, ended),
      () => this.checked(gen, { wake: false }, ended),
    );
  }

  checked(gen, r, ended) {
    if (gen !== this.gen) return; // reset while checking
    if (!r?.wake) {
      // Not for Echo: drop the audio, and let the rest of this burst go by unchecked.
      this.buf = null;
      this.bufMs = 0;
      this.skip = this.silentMs < this.o.gapMs;
      this.setState('idle');
      return;
    }
    const windowMs = Math.min(this.bufMs, this.o.windowMs);
    this.awakeAt = windowMs;
    this.rest = r.rest || '';
    // "Hey Echo, check the build" in one breath: the request has started already.
    this.heardRequest = Boolean(this.rest) || (!ended && this.bufMs - windowMs > 300);
    this.requestVoicedMs = 0;
    this.setState('awake');
    this.o.onWake?.(r);
  }

  feedAwake(frame, ms, loud) {
    const o = this.o;
    if (!this.buf) this.buf = [];
    this.buf.push(frame);
    this.bufMs += ms;
    if (loud && this.bufMs > this.awakeAt) {
      this.requestVoicedMs = (this.requestVoicedMs || 0) + ms;
      if (this.requestVoicedMs > 250) this.heardRequest = true;
    }
    const sinceWake = this.bufMs - this.awakeAt;
    if (this.heardRequest && (this.silentMs >= o.endSilenceMs || this.bufMs >= o.maxMs)) return this.finish();
    if (!this.heardRequest && sinceWake >= o.waitMs) {
      const followUp = this.followUp;
      this.reset();
      this.o.onCancel?.(followUp ? 'no_follow_up' : 'no_request');
    }
  }

  finish() {
    const samples = joinChunks(this.buf || []);
    const info = { rest: this.rest, followUp: this.followUp };
    this.reset();
    this.o.onTurn?.(samples, info);
  }
}
