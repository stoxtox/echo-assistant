// Transcribe while you talk (build step 4, "Speed II").
//
// Before, the page recorded a whole sentence and only sent it once you'd stopped, so Whisper
// started on it after the end-of-speech pause (1.3 s by default) and took another second or so.
// Now the page streams the audio here as you speak (public/sttstream.js, over the WebSocket):
//
//   - every second or so of new speech, what's been said so far is transcribed and shown live
//     (a partial transcript; only asked for when the browser's own live preview shows nothing);
//   - as soon as you pause (300 ms of quiet), everything so far is transcribed again, so while the
//     page is still waiting to be sure you've finished, the text is already being made (a partial
//     still under way is dropped for it: a Whisper run takes about 1.3 s however short the clip);
//   - when the finished clip arrives (POST /api/utterance, same as before), and the transcription
//     made at the pause holds all of its speech, that text is used at once: no second Whisper run.
//
// The clip the page sends stays the one that counts: its checks (silence, inventions, the live
// text, the addressee gates) run exactly as before. The early transcription is only used when the
// streamed audio is the clip's own beginning, byte for byte, it reaches past the clip's last
// speech, it found the same amount of speech, and Whisper was sure of what it heard. Otherwise the
// clip is transcribed as before.
// Local Whisper only: Deepgram is paid per minute, so it's never asked twice.
import { EventEmitter } from 'node:events';
import { squeezeSilence } from './heard.js';

export const STREAM_RATE = 16000;
export const STREAM_LIMITS = {
  maxSeconds: 60, // a longer stream stops growing (the clip is transcribed whole at the end)
  maxStreams: 4, // per page
  idleMs: 2 * 60 * 1000, // a stream nobody finished is forgotten after this
  partialEveryMs: 1000, // new speech between two partial transcripts
  padSec: 0.15, // the early transcription must reach this far past the clip's last speech
  speechSlackMs: 60, // and have found the same speech, give or take three 20 ms frames
  // and Whisper must have been sure of it: on unclear audio, a slightly different clip can come
  // back as a different guess, so the whole clip is transcribed as before (about 1 turn in 5).
  reuseMinLogprob: -0.5,
};

/** A 16 kHz mono 16-bit WAV around raw PCM. */
export function int16Wav(pcm, rate = STREAM_RATE) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([b, pcm]);
}

/** The raw PCM of a 16-bit mono WAV at `rate`, or null. */
export function wavPcm(wav, rate = STREAM_RATE) {
  if (!wav || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== rate || wav.readUInt16LE(34) !== 16) return null;
  let off = 12;
  while (off + 8 <= wav.length) {
    const len = wav.readUInt32LE(off + 4);
    if (wav.toString('ascii', off, off + 4) === 'data') return wav.subarray(off + 8, Math.min(wav.length, off + 8 + len));
    off += 8 + len + (len % 2);
  }
  return null;
}

/**
 * A binary stream message from the page: [id length][id (ASCII)][16-bit PCM, little-endian].
 * @param {Buffer} raw
 */
export function parseAudioMessage(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 2) return null;
  const n = raw[0];
  if (!n || n > 32 || raw.length < 1 + n) return null;
  const id = raw.toString('ascii', 1, 1 + n);
  if (!/^[\w-]+$/.test(id)) return null;
  const pcm = raw.subarray(1 + n);
  return { id, pcm: pcm.subarray(0, pcm.length - (pcm.length % 2)) };
}

/**
 * @typedef {{ text: string, words: Array<{ word: string, p: number }>, uncertain: Array<{ word: string, confidence: number }>, engine: string, ms: number, segments?: Array<{ text: string, lp?: number }>, speechMs?: number, seconds?: number, keptSeconds?: number }} Heard
 * @typedef {{ heard: Heard, samples: number, kind: 'partial' | 'pause', gen: number }} Result
 * @typedef {{
 *   id: string, owner: unknown, mode: string, engine: string, language?: string, opened: number, touched: number,
 *   chunks: Buffer[], bytes: number, full: boolean, gen: number, paused: boolean, lastRunSamples: number,
 *   job: null | { promise: Promise<Result | null>, samples: number, kind: 'partial' | 'pause', stop: AbortController },
 *   queued: null | 'partial' | 'pause', best: Result | null, runs: number,
 * }} Stream
 */

/**
 * The server's half of transcribe-while-talking. Events:
 *   'partial' { owner, id, text }            what's been said so far (for the live caption)
 *   'ready'   { owner, id, heard, samples }  transcribed at a pause that's still a pause: the
 *                                            turn can be prepared (server.js)
 */
export class SpeechStreams extends EventEmitter {
  /**
   * @param {{ transcribe: (wav: Buffer, opts: { engine?: string, language?: string, signal?: AbortSignal }) => Promise<Heard>, now?: () => number, limits?: Partial<typeof STREAM_LIMITS> }} o
   */
  constructor({ transcribe, now = Date.now, limits = {} }) {
    super();
    this.transcribe = transcribe;
    this.now = now;
    this.limits = { ...STREAM_LIMITS, ...limits };
    /** @type {Map<string, Stream>} */
    this.streams = new Map();
    this.counts = { opened: 0, reused: 0, missed: 0, runs: 0 };
  }

  /** @param {unknown} owner @param {string} id */
  get(owner, id) {
    const s = this.streams.get(String(id));
    return s && s.owner === owner ? s : null;
  }

  /**
   * The page started hearing you. Only local Whisper streams.
   * @param {unknown} owner the page's connection
   * @param {string} id
   * @param {{ mode?: string, engine?: string, language?: string }} [o]
   */
  open(owner, id, { mode = '', engine = 'whisper', language } = {}) {
    this.sweep();
    if (engine !== 'whisper' || !/^[\w-]{1,32}$/.test(String(id))) return false;
    const mine = [...this.streams.values()].filter((s) => s.owner === owner).sort((a, b) => a.opened - b.opened);
    while (mine.length >= this.limits.maxStreams) this.streams.delete(/** @type {Stream} */ (mine.shift()).id);
    const t = this.now();
    this.streams.set(String(id), { id: String(id), owner, mode, engine, language, opened: t, touched: t, chunks: [], bytes: 0, full: false, gen: 0, paused: false, lastRunSamples: 0, job: null, queued: null, best: null, runs: 0 });
    this.counts.opened++;
    return true;
  }

  /** @param {unknown} owner @param {string} id @param {Buffer} pcm */
  audio(owner, id, pcm) {
    const s = this.get(owner, id);
    if (!s || s.full || !pcm.length) return;
    const max = this.limits.maxSeconds * STREAM_RATE * 2;
    const room = max - s.bytes;
    const part = pcm.length > room ? pcm.subarray(0, room) : pcm;
    s.chunks.push(Buffer.from(part));
    s.bytes += part.length;
    s.touched = this.now();
    if (s.bytes >= max) s.full = true;
  }

  /** You paused: transcribe everything so far. @param {unknown} owner @param {string} id */
  pause(owner, id) {
    const s = this.get(owner, id);
    if (!s) return;
    s.paused = true;
    this.run(s, 'pause');
  }

  /**
   * You carried on talking: a transcription made at the pause is no longer the whole turn. One
   * still under way is dropped, so Whisper is free for the next pause.
   */
  resume(owner, id) {
    const s = this.get(owner, id);
    if (!s) return;
    s.paused = false;
    s.gen++;
    if (s.job?.kind === 'pause') {
      s.job.stop.abort();
      s.job = null;
    }
  }

  /** More speech: a partial transcript, if Whisper is free and there's enough new. */
  tick(owner, id) {
    const s = this.get(owner, id);
    if (!s || s.job) return;
    if (s.bytes / 2 - s.lastRunSamples >= (this.limits.partialEveryMs / 1000) * STREAM_RATE) this.run(s, 'partial');
  }

  /** The page dropped the clip (cancelled, too short, Echo started speaking). */
  close(owner, id) {
    const s = this.get(owner, id);
    if (s) this.streams.delete(s.id);
  }

  /** Every stream of a page that went away. @param {unknown} owner */
  closeAll(owner) {
    for (const s of [...this.streams.values()]) if (s.owner === owner) this.streams.delete(s.id);
  }

  sweep() {
    const t = this.now();
    for (const s of [...this.streams.values()]) if (t - s.touched > this.limits.idleMs) this.streams.delete(s.id);
  }

  /** @param {Stream} s @param {'partial' | 'pause'} kind */
  run(s, kind) {
    const samples = s.bytes / 2;
    if (!samples) return;
    // One Whisper run at a time per stream. A pause doesn't wait for a partial under way: that
    // one is dropped (Whisper stops it early), since the pause's text is the one that's needed.
    if (s.job && kind === 'pause' && s.job.kind === 'partial') {
      s.job.stop.abort();
      s.job = null;
    }
    if (s.job) {
      if (kind === 'pause' || !s.queued) s.queued = kind;
      return;
    }
    // Already transcribed exactly this much (a pause with no new audio since).
    if (s.best && s.best.samples === samples) return;
    const gen = s.gen;
    const wav = int16Wav(Buffer.concat(s.chunks));
    s.lastRunSamples = samples;
    s.runs++;
    this.counts.runs++;
    const stop = new AbortController();
    const promise = this.transcribe(wav, { engine: s.engine, language: s.language, signal: stop.signal }).then(
      (heard) => {
        /** @type {Result} */
        const r = { heard, samples, kind, gen };
        if (!s.best || s.best.samples <= samples) s.best = r;
        if (heard.text) this.emit('partial', { owner: s.owner, id: s.id, text: heard.text });
        // Still the same pause, and still the whole stream: the turn can be got ready.
        if (kind === 'pause' && s.paused && s.gen === gen && this.streams.get(s.id) === s) this.emit('ready', { owner: s.owner, id: s.id, heard, samples });
        return r;
      },
      () => null,
    );
    s.job = { promise, samples, kind, stop };
    promise.finally(() => {
      if (s.job?.promise !== promise) return;
      s.job = null;
      const next = s.queued;
      s.queued = null;
      if (next && this.streams.get(s.id) === s) {
        if (next === 'pause' && s.paused) this.run(s, 'pause');
        else if (next === 'partial') this.tick(s.owner, s.id);
      }
    });
  }

  /**
   * The finished clip is here. When a transcription made while you talked holds all of its speech,
   * it's returned (waiting for it if Whisper is still on it); otherwise null and the reason, and the
   * caller transcribes the clip as before. The stream is closed either way. (The clip comes over
   * HTTP, not the page's socket, so it's found by its id alone; the audio must match it anyway.)
   * @param {string} id @param {Buffer} wav the clip the page sent
   * @returns {Promise<{ heard: Heard | null, why: string, waitedMs: number, specMs?: number, runs?: number }>}
   */
  async final(id, wav) {
    const t0 = this.now();
    const s = this.streams.get(String(id));
    if (!s) return { heard: null, why: 'no_stream', waitedMs: 0 };
    this.streams.delete(s.id);
    const done = (/** @type {Heard | null} */ heard, why, extra = {}) => {
      this.counts[heard ? 'reused' : 'missed']++;
      return { heard, why, waitedMs: this.now() - t0, runs: s.runs, ...extra };
    };
    const pcm = wavPcm(wav);
    if (!pcm) return done(null, 'not_16k');
    const sq = squeezeSilence(wav);
    const reaches = (samples) => samples / STREAM_RATE >= Math.min(sq.speechEndSec + this.limits.padSec, pcm.length / 2 / STREAM_RATE);
    // Whisper is still on a run that would cover the clip: wait for it rather than start again.
    // One that wouldn't is dropped, so the whole clip gets Whisper sooner.
    if (s.job && reaches(s.job.samples)) await s.job.promise;
    else s.job?.stop.abort();
    const best = s.best;
    if (!best) return done(null, s.job ? 'still_running' : 'not_transcribed');
    if (!reaches(best.samples)) return done(null, 'speech_after');
    const streamed = Buffer.concat(s.chunks).subarray(0, best.samples * 2);
    if (streamed.length > pcm.length || !pcm.subarray(0, streamed.length).equals(streamed)) return done(null, 'audio_differs');
    if (typeof best.heard.speechMs === 'number' && Math.abs(best.heard.speechMs - sq.speechMs) > this.limits.speechSlackMs) return done(null, 'speech_differs');
    const lps = (best.heard.segments || []).map((g) => g.lp).filter((lp) => typeof lp === 'number');
    if (lps.some((lp) => lp < this.limits.reuseMinLogprob)) return done(null, 'unsure');
    return done({ ...best.heard, speechMs: sq.speechMs, seconds: sq.seconds, keptSeconds: sq.keptSeconds, ms: this.now() - t0 }, best.kind, { specMs: best.heard.ms });
  }
}
