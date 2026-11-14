// Transcribe while you talk: the page's half (the server's is lib/sttstream.js).
// While a clip is being recorded, its audio goes to Echo as you speak, over the WebSocket, as
// 16 kHz 16-bit PCM: exactly the samples the finished clip will hold (the same resampling and
// rounding as the page's encodeWav), so the server can tell a transcription it made early really
// is of this clip. A cheap loudness check marks your pauses: at 300 ms of quiet the server
// transcribes what it has, so the text is ready by the time the page is sure you've finished.
// Pure (no DOM), so test/sttstream.test.js runs it in Node.

export const STREAM_DEFAULTS = {
  outRate: 16000,
  pauseMs: 300, // this much quiet after speech: transcribe everything so far
  resumeMs: 60, // this much sound after a pause: you're still talking
  spokeMs: 100, // a pause only counts after this much speech
  tickMs: 1000, // ask for a partial transcript this often while you talk
  flushMs: 100, // audio goes out in pieces this long
};

/** RMS level of a frame (0..1). */
function level(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/**
 * A whole clip from the mic's rate to `to`: each output sample is the average of the input samples
 * it spans. (public/app.js uses it for every clip it sends.)
 * @param {Float32Array} pcm @param {number} from @param {number} to
 */
export function downsample(pcm, from, to) {
  if (from === to) return pcm;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(pcm.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += pcm[j];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}

/** A 16-bit mono WAV of float samples (the clip the page uploads). @returns {ArrayBuffer} */
export function wavBytes(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  new Uint8Array(buf, 44).set(toInt16(samples));
  return buf;
}

/**
 * downsample(), one frame at a time: sample i of the output is the average of input samples
 * floor(i·r) to floor((i+1)·r), exactly as for the whole clip, so the streamed samples match the
 * finished clip's.
 */
export class Resampler {
  /** @param {number} from @param {number} to */
  constructor(from, to) {
    this.same = from === to;
    this.ratio = from / to;
    this.pending = []; // input not yet used, as numbers
    this.base = 0; // input index of pending[0]
    this.received = 0;
    this.next = 0; // next output index
  }

  /** @param {Float32Array} frame @returns {Float32Array} */
  push(frame) {
    if (this.same) return Float32Array.from(frame);
    for (let i = 0; i < frame.length; i++) this.pending.push(frame[i]);
    this.received += frame.length;
    const out = [];
    const r = this.ratio;
    while (Math.floor(this.received / r) > this.next) {
      const i = this.next;
      const a = Math.floor(i * r), b = Math.min(this.received, Math.floor((i + 1) * r));
      let sum = 0;
      for (let j = a; j < b; j++) sum += this.pending[j - this.base];
      out.push(sum / Math.max(1, b - a));
      this.next++;
    }
    const keep = Math.floor(this.next * r);
    if (keep > this.base) {
      this.pending.splice(0, keep - this.base);
      this.base = keep;
    }
    return Float32Array.from(out);
  }
}

/** Float samples to 16-bit little-endian PCM (the same rounding as the uploaded clip). */
export function toInt16(samples) {
  const buf = new ArrayBuffer(samples.length * 2);
  const v = new DataView(buf);
  for (let i = 0; i < samples.length; i++) v.setInt16(i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

/** [id length][id][pcm]: one binary WebSocket message. @param {string} id @param {Uint8Array} pcm */
export function audioMessage(id, pcm) {
  const out = new Uint8Array(1 + id.length + pcm.length);
  out[0] = id.length;
  for (let i = 0; i < id.length; i++) out[1 + i] = id.charCodeAt(i) & 0x7f;
  out.set(pcm, 1 + id.length);
  return out;
}

let counter = 0;
const newId = () => `s${Date.now().toString(36)}${(counter++ % 1296).toString(36)}`;

/**
 * @typedef {{
 *   rate: number,
 *   sendJson: (msg: object) => boolean | void,
 *   sendBinary: (data: Uint8Array) => boolean | void,
 *   threshold?: () => number,
 *   wantPartials?: () => boolean,
 * } & Partial<typeof STREAM_DEFAULTS>} StreamOptions
 * wantPartials: whether to ask for your words so far. Each Whisper run takes about as long however
 * short the clip, so they're only asked for when nothing else shows your words live.
 */
export class StreamClient {
  /** @param {StreamOptions} opts */
  constructor(opts) {
    this.o = { ...STREAM_DEFAULTS, threshold: () => 0.01, wantPartials: () => true, ...opts };
    this.id = null;
    this.reset();
  }

  reset() {
    this.id = null;
    this.resampler = null;
    this.out = [];
    this.outLen = 0;
    this.spokeMs = 0;
    this.silentMs = 0;
    this.loudMs = 0;
    this.paused = false;
    this.sinceTickMs = 0;
    this.sent = 0; // output samples sent
  }

  get active() {
    return this.id !== null;
  }

  /**
   * A clip starts (with whatever it already holds: the pre-roll). Returns the stream id.
   * @param {string} mode @param {Float32Array[]} [frames]
   */
  begin(mode, frames = []) {
    if (this.id) this.cancel();
    this.id = newId();
    this.resampler = new Resampler(this.o.rate, this.o.outRate);
    this.o.sendJson({ type: 'stt_stream', op: 'open', id: this.id, mode });
    for (const f of frames) this.feed(f, { quiet: true });
    return this.id;
  }

  /**
   * One frame of the clip (the same frames, in the same order, as the clip gets).
   * @param {Float32Array} frame @param {{ quiet?: boolean }} [o] quiet: pre-roll, no pause detection
   */
  feed(frame, { quiet = false } = {}) {
    if (!this.id || !this.resampler) return;
    const o = this.o;
    const ms = (frame.length / o.rate) * 1000;
    const out = this.resampler.push(frame);
    if (out.length) {
      this.out.push(out);
      this.outLen += out.length;
    }
    if (quiet) return;
    const loud = level(frame) > o.threshold();
    if (loud) {
      this.spokeMs += ms;
      this.loudMs += ms;
      this.silentMs = 0;
    } else {
      this.loudMs = 0;
      this.silentMs += ms;
    }
    if (this.outLen >= (o.flushMs / 1000) * o.outRate) this.flush();
    if (this.paused && this.loudMs >= o.resumeMs) {
      this.paused = false;
      this.sinceTickMs = 0;
      o.sendJson({ type: 'stt_stream', op: 'resume', id: this.id });
    } else if (!this.paused && this.spokeMs >= o.spokeMs && this.silentMs >= o.pauseMs) {
      this.pause();
    } else if (!this.paused) {
      this.sinceTickMs += ms;
      if (this.sinceTickMs >= o.tickMs && loud && o.wantPartials()) {
        this.sinceTickMs = 0;
        this.flush();
        o.sendJson({ type: 'stt_stream', op: 'tick', id: this.id });
      }
    }
  }

  /** Transcribe everything so far now (a pause, or push-to-talk let go after a quiet moment). */
  pause() {
    if (!this.id || this.paused) return;
    this.paused = true;
    this.flush();
    this.o.sendJson({ type: 'stt_stream', op: 'pause', id: this.id });
  }

  flush() {
    if (!this.id || !this.outLen) return;
    const all = new Float32Array(this.outLen);
    let o = 0;
    for (const c of this.out) {
      all.set(c, o);
      o += c.length;
    }
    this.out = [];
    this.outLen = 0;
    this.sent += all.length;
    this.o.sendBinary(audioMessage(this.id, toInt16(all)));
  }

  /** The clip is finished: the rest of its audio goes out. Returns the id for the clip's upload. */
  end() {
    const id = this.id;
    this.flush();
    this.reset();
    return id;
  }

  /** The clip was dropped: the server forgets the stream. */
  cancel() {
    if (this.id) this.o.sendJson({ type: 'stt_stream', op: 'close', id: this.id });
    this.reset();
  }
}
