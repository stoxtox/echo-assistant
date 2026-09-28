// Guards against blank transcriptions. Whisper sometimes returns just "." for a clip even though
// the live preview (the browser's own recognition) showed the words, and a bare "." must never
// reach the assistant. Pure helpers, unit-tested in test/heard.test.js; server.js does the I/O.
import fs from 'node:fs';
import path from 'node:path';

/** True when there's nothing said: empty, whitespace, or only punctuation and symbols. */
export function isBlankText(text) {
  return !/[\p{L}\p{N}]/u.test(String(text ?? ''));
}

const wordCount = (s) => String(s || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * Pick what to send: the final transcription, or the live preview text when the final one came
 * back blank or much shorter than what the live listener showed (a clipped or silent recording).
 * @param {string} final  the engine's transcription (Whisper, Deepgram)
 * @param {string} [live]  what the live listener showed while you spoke
 * @returns {{ text: string, source: 'final' | 'live' | 'none', reason: '' | 'blank' | 'short' | 'disagree' }}
 */
export function pickTranscript(final, live = '') {
  const f = String(final || '').trim();
  const l = String(live || '').trim();
  const liveOk = !isBlankText(l);
  if (isBlankText(f)) return liveOk ? { text: l, source: 'live', reason: 'blank' } : { text: '', source: 'none', reason: 'blank' };
  const lw = wordCount(l);
  if (liveOk && lw >= 5 && wordCount(f) <= lw * 0.4) return { text: l, source: 'live', reason: 'short' };
  // A whole different sentence (not just a name or two spelled differently): Whisper made it up.
  if (liveOk && lw >= 6 && agreement(f, l) < 0.35) return { text: l, source: 'live', reason: 'disagree' };
  return { text: f, source: 'final', reason: '' };
}

/**
 * What's in a 16-bit PCM WAV clip, to tell why a transcription came back blank: how long it is,
 * its sample rate, and how loud (peak and RMS, 0..1). A near-zero peak means the mic sent silence.
 * @param {Buffer} wav
 */
export function wavStats(wav) {
  const out = { bytes: wav?.length || 0, rate: 0, channels: 0, seconds: 0, peak: 0, rms: 0, voicedMs: 0 };
  if (!wav || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return out;
  out.channels = wav.readUInt16LE(22);
  out.rate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  // Find the data chunk (usually at 36, but other chunks can come first).
  let off = 12;
  let dataAt = -1;
  let dataLen = 0;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const len = wav.readUInt32LE(off + 4);
    if (id === 'data') {
      dataAt = off + 8;
      dataLen = Math.min(len, wav.length - dataAt);
      break;
    }
    off += 8 + len + (len % 2);
  }
  if (dataAt < 0 || bits !== 16 || !out.rate || !out.channels) return out;
  const n = Math.floor(dataLen / 2);
  out.seconds = +(n / out.channels / out.rate).toFixed(3);
  let sum = 0;
  let peak = 0;
  let voiced = 0;
  const win = Math.max(1, Math.round(out.rate * 0.02) * out.channels); // 20 ms windows
  let wSum = 0;
  let wN = 0;
  for (let i = 0; i < n; i++) {
    const v = wav.readInt16LE(dataAt + i * 2) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    wSum += v * v;
    if (++wN === win) {
      if (Math.sqrt(wSum / wN) > 0.01) voiced++;
      wSum = 0;
      wN = 0;
    }
  }
  out.peak = +peak.toFixed(4);
  out.rms = n ? +Math.sqrt(sum / n).toFixed(4) : 0;
  out.voicedMs = voiced * 20;
  return out;
}

/** A best guess at why a clip came back blank, from its stats and the page's notes. */
export function blankCause(stats, page = {}) {
  if (page.trackMuted || page.trackState === 'ended') return 'mic track muted or ended (another capture took the mic?)';
  if (page.ctxState && page.ctxState !== 'running') return `audio context ${page.ctxState}`;
  if (!stats.seconds) return 'no audio in the clip';
  if (stats.rate && stats.rate !== 16000) return `unexpected sample rate ${stats.rate}`;
  if (stats.peak < 0.003) return 'digital silence (the mic delivered zeros)';
  if (stats.voicedMs < 200) return 'almost no speech in the clip (too quiet, or cut before you spoke)';
  if (stats.seconds < 0.8) return 'clip very short (cut off early)';
  return 'speech present but not transcribed';
}

/**
 * Keep a clip whose transcription came back blank, for finding the cause later. Only the newest
 * `keep` clips stay. Returns the saved path.
 * @param {string} dir @param {Buffer} wav @param {number} [keep]
 */
export function saveBlankClip(dir, wav, keep = 30) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
  fs.writeFileSync(file, wav);
  const old = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/* ---------- speech in the clip, and what Whisper makes up ---------- */
// Measured on the clips Echo kept (docs/speech-recognition.md): push-to-talk clips often hold
// seconds of silence (before you start, between sentences, after you stop). On those, Whisper
// skips whole sentences and invents others ("the phase of the world, the data of the bodies"),
// and a clip with only a click or a breath comes back "Thank you." So the silence is squeezed out
// before Whisper hears the clip, a clip with no speech in it never reaches Whisper, and Whisper's
// stock inventions are dropped.

/** A clip with less speech than this is a click, a breath or the room: nothing was said. */
export const MIN_SPEECH_MS = 200;
const FRAME_MS = 20;

/** The first channel of a 16-bit PCM WAV as floats (-1..1), or null if it isn't one. */
export function wavSamples(wav) {
  if (!wav || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return null;
  const channels = wav.readUInt16LE(22);
  const rate = wav.readUInt32LE(24);
  if (wav.readUInt16LE(34) !== 16 || !channels || !rate) return null;
  let off = 12;
  while (off + 8 <= wav.length) {
    const len = wav.readUInt32LE(off + 4);
    if (wav.toString('ascii', off, off + 4) === 'data') {
      const n = Math.floor(Math.min(len, wav.length - off - 8) / 2 / channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = wav.readInt16LE(off + 8 + i * 2 * channels) / 32768;
      return { samples, rate };
    }
    off += 8 + len + (len % 2);
  }
  return null;
}

/** Mono floats -> a 16-bit PCM WAV. */
export function pcmWav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
}

/**
 * Squeeze the silence out of a clip: speech is kept with a little padding, and every pause longer
 * than `keepGapMs` is cut down to that. Speech is found against the clip's own noise floor, so a
 * noisy room doesn't count as talking. speechMs counts only sound that lasts (a click doesn't).
 * @param {Buffer} wav
 * @param {{ keepGapMs?: number, padMs?: number }} [opts]
 * @returns {{ wav: Buffer, speechMs: number, seconds: number, keptSeconds: number }}
 */
export function squeezeSilence(wav, { keepGapMs = 300, padMs = 150 } = {}) {
  const pcm = wavSamples(wav);
  if (!pcm) return { wav, speechMs: 0, seconds: 0, keptSeconds: 0 };
  const { samples, rate } = pcm;
  const w = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const n = Math.ceil(samples.length / w);
  const level = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * w);
    for (let i = f * w; i < end; i++) sum += samples[i] * samples[i];
    level[f] = Math.sqrt(sum / Math.max(1, end - f * w));
  }
  const floor = [...level].sort((a, b) => a - b)[Math.floor(n * 0.1)] || 0;
  const threshold = Math.min(0.02, Math.max(0.006, floor * 2.5));
  const voiced = Array.from(level, (l) => l > threshold);
  // Speech lasts: only runs of 60 ms or more count (a click or a tap is one frame or two).
  let speechFrames = 0;
  for (let f = 0; f < n; ) {
    let e = f;
    while (e < n && voiced[e]) e++;
    if (e - f >= 3) speechFrames += e - f;
    else for (let k = f; k < e; k++) voiced[k] = false;
    f = Math.max(e, f + 1);
  }
  const pad = Math.round(padMs / FRAME_MS);
  const gap = Math.round(keepGapMs / FRAME_MS);
  const near = new Uint8Array(n);
  for (let f = 0; f < n; f++) if (voiced[f]) for (let k = Math.max(0, f - pad); k <= Math.min(n - 1, f + pad); k++) near[k] = 1;
  const keep = [];
  let quiet = 0;
  for (let f = 0; f < n; f++) {
    if (near[f]) quiet = 0;
    else if (++quiet > gap) continue;
    keep.push(f);
  }
  // Trailing pause: keep only the gap (already capped); leading pause: same, via `quiet` above.
  const out = new Float32Array(keep.length * w);
  let o = 0;
  for (const f of keep) {
    const part = samples.subarray(f * w, Math.min(samples.length, (f + 1) * w));
    out.set(part, o);
    o += part.length;
  }
  const kept = out.subarray(0, o);
  return { wav: pcmWav(kept, rate), speechMs: speechFrames * FRAME_MS, seconds: +(samples.length / rate).toFixed(2), keptSeconds: +(kept.length / rate).toFixed(2) };
}

const phrase = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
/** What Whisper says on silence, clicks and room noise (it learned them from video subtitles). */
const INVENTED = new Set([
  'you', 'thank you', 'thank you very much', 'thank you so much', 'thanks', 'thanks a lot', 'thank you bye', 'bye', 'bye bye', 'goodbye',
  'thanks for watching', 'thank you for watching', 'thanks for listening', 'thank you for listening', 'thanks for watching bye',
  'please subscribe', 'subscribe', 'like and subscribe', 'please like and subscribe', 'see you next time', 'see you in the next video',
  'the end', 'music', 'applause', 'silence', 'blank audio', 'inaudible', 'no speech',
]);
/** Short inventions that are also real answers: only dropped when there's barely any speech. */
const SHORT_REAL = new Set(['thank you', 'thank you very much', 'thank you so much', 'thanks', 'thanks a lot', 'bye', 'bye bye', 'goodbye']);
/** True for Whisper's stock silence phrases ("Thank you.", "Thanks for watching!", "you"). */
export function isInvented(text) {
  return INVENTED.has(phrase(text));
}

/** Below this average log-probability a segment is Whisper guessing, not hearing. */
export const MIN_LOGPROB = -1.0;

const bag = (s) => phrase(s).split(' ').filter(Boolean);
/** How much of the live text the final one has (0..1): a rough "do they agree". */
export function agreement(final, live) {
  const f = new Set(bag(final));
  const l = bag(live);
  return l.length ? l.filter((w) => f.has(w)).length / l.length : 1;
}

/** Echo's name as recognizers write it. */
const ECHO_NAME = /^(echo|eko|ekko|ekho|eco|ecco|echoes)$/;
/**
 * Hands-free speech meant for Echo: her name in the first few words ("Echo, ...", "Hey Echo ...",
 * "OK Echo ...") or as the last word ("..., Echo?").
 */
export function addressesEcho(text) {
  const w = bag(text);
  return w.slice(0, 4).some((x) => ECHO_NAME.test(x)) || ECHO_NAME.test(w.at(-1) || '');
}

/**
 * Echo's own voice picked up by the mic: nearly every word heard is in her last reply. (The mic
 * already ignores her while she speaks and just after; this catches speakers loud enough to linger.)
 */
export function echoesReply(text, reply) {
  return bag(text).length >= 4 && !isBlankText(reply) && agreement(reply, text) >= 0.85;
}

/**
 * Clean Whisper's result: drop its stock inventions and the segments it was only guessing at,
 * and decide whether anything was really said.
 * @param {{ text: string, segments?: Array<{ text: string, lp?: number }>, speechMs?: number }} heard
 * @param {{ live?: string, livePreview?: boolean }} [ctx] livePreview: the live listener was on
 * @returns {{ text: string, dropped: string[], reason: '' | 'no_speech' | 'invented' | 'low_confidence' }}
 */
export function cleanHeard(heard, { live = '', livePreview = false } = {}) {
  const liveBlank = isBlankText(live);
  if (typeof heard.speechMs === 'number' && heard.speechMs < MIN_SPEECH_MS) return { text: '', dropped: isBlankText(heard.text) ? [] : [heard.text], reason: 'no_speech' };
  const segs = (heard.segments?.length ? heard.segments : [{ text: heard.text }]).map((s) => ({ text: String(s.text || '').trim(), lp: s.lp })).filter((s) => !isBlankText(s.text));
  const dropped = [];
  let kept = segs.filter((s) => {
    const bad = typeof s.lp === 'number' && s.lp < MIN_LOGPROB;
    if (bad) dropped.push(s.text);
    return !bad;
  });
  const lowConfidence = segs.length > 0 && !kept.length;
  // Invented pieces tacked on after real words ("... in the mind. you", "... Thank you."), unless
  // the live listener heard them too.
  const liveWords = new Set(bag(live));
  while (kept.length > 1 && isInvented(kept.at(-1).text) && !bag(kept.at(-1).text).every((w) => liveWords.has(w))) dropped.push(kept.pop().text);
  kept = kept.filter((s) => {
    const bad = kept.length > 1 && phrase(s.text) === 'you';
    if (bad) dropped.push(s.text);
    return !bad;
  });
  const text = kept.map((s) => s.text).join(' ').trim();
  if (lowConfidence) return { text: '', dropped, reason: 'low_confidence' };
  // A whole turn that's only an invention: "you" is never a turn; "Thank you" is dropped when
  // there was barely any speech, or the live listener was on and heard nothing.
  if (text && isInvented(text)) {
    const p = phrase(text);
    const barely = typeof heard.speechMs === 'number' && heard.speechMs < 400;
    if (!SHORT_REAL.has(p) || barely || (livePreview && liveBlank)) return { text: '', dropped: [...dropped, text], reason: 'invented' };
  }
  return { text, dropped, reason: '' };
}

/**
 * Decide what a transcription turns into, and note the blank ones: the text to send (the cleaned
 * final transcription, the live text, or nothing), what cleaning dropped, plus a speech-log entry
 * and the saved clip when the final came back blank, much shorter than or entirely different from
 * the live text (null entry when all is well).
 * @param {{ wav: Buffer, heard: { text: string, engine?: string, ms?: number, segments?: Array<{ text: string, lp?: number }>, speechMs?: number }, live?: unknown, livePreview?: boolean, page?: object, clipDir: string }} o
 */
export function checkHeard({ wav, heard, live, livePreview = false, page = {}, clipDir }) {
  const liveText = typeof live === 'string' ? live : '';
  const cleaned = cleanHeard(heard, { live: liveText, livePreview });
  const pick = pickTranscript(cleaned.text, liveText);
  if (pick.source === 'final') return { pick, cleaned, entry: null };
  const stats = wavStats(wav);
  let clip = null;
  if (isBlankText(cleaned.text)) {
    try {
      clip = saveBlankClip(clipDir, wav);
    } catch (e) {
      console.error('[stt] could not save the blank clip:', e.message);
    }
  }
  const event = pick.reason === 'blank' ? (cleaned.reason ? `${cleaned.reason}_final` : 'blank_final') : `${pick.reason}_final`;
  const entry = {
    at: new Date().toISOString(), event, engine: heard.engine, sttMs: heard.ms, final: heard.text, ...(cleaned.dropped.length ? { dropped: cleaned.dropped } : {}),
    speechMs: heard.speechMs, live: liveText, used: pick.source, clip, stats, page, cause: cleaned.reason === 'no_speech' ? 'no speech in the clip (a click, a breath or the room)' : blankCause(stats, page),
  };
  return { pick, cleaned, entry };
}
