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
 *
 * Voiced sound is counted in 20 ms frames against the clip's OWN noise floor (voicedThreshold),
 * not a fixed 0.01: in a quiet room a soft speaker's long sentence used to count as a blip. voicedRms is
 * the loudness of the voiced frames alone, so a clip that ends in a second of quiet (hands-free)
 * and one that doesn't (push-to-talk) read the same for the same voice. speechStartSec /
 * speechEndSec: where sound that lasts (60 ms or more, so not a click) begins and ends in the clip.
 * @param {Buffer} wav
 */
export function wavStats(wav) {
  const out = { bytes: wav?.length || 0, rate: 0, channels: 0, seconds: 0, peak: 0, rms: 0, voicedMs: 0, voicedRms: 0, speechStartSec: 0, speechEndSec: 0 };
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
  const win = Math.max(1, Math.round(out.rate * 0.02) * out.channels); // 20 ms windows
  /** Each whole window's mean square. @type {number[]} */
  const frames = [];
  let wSum = 0;
  let wN = 0;
  for (let i = 0; i < n; i++) {
    const v = wav.readInt16LE(dataAt + i * 2) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    wSum += v * v;
    if (++wN === win) {
      frames.push(wSum / wN);
      wSum = 0;
      wN = 0;
    }
  }
  out.peak = +peak.toFixed(4);
  out.rms = n ? +Math.sqrt(sum / n).toFixed(4) : 0;
  const threshold = voicedThreshold(frames.map(Math.sqrt));
  let voiced = 0;
  let voicedSum = 0;
  let first = -1;
  let last = -1;
  for (let f = 0; f < frames.length; ) {
    let e = f;
    while (e < frames.length && Math.sqrt(frames[e]) > threshold) voicedSum += frames[e++];
    voiced += e - f;
    if (e - f >= 3) {
      if (first < 0) first = f;
      last = e;
    }
    f = Math.max(e, f + 1);
  }
  out.voicedMs = voiced * FRAME_MS;
  out.voicedRms = voiced ? +Math.sqrt(voicedSum / voiced).toFixed(4) : 0;
  if (first >= 0) {
    out.speechStartSec = +((first * FRAME_MS) / 1000).toFixed(3);
    out.speechEndSec = +((last * FRAME_MS) / 1000).toFixed(3);
  }
  return out;
}

const FRAME_MS = 20;
/**
 * The level (rms) a 20 ms frame must pass to count as voiced: two and a half times the clip's own
 * noise floor (its quietest tenth), never under 0.006 (a silent room) or over `cap` (a clip that
 * is speech from end to end has no quiet tenth, and must not set its own bar).
 * @param {ArrayLike<number>} levels each frame's rms @param {number} [cap]
 */
export function voicedThreshold(levels, cap = 0.01) {
  const floor = Array.from(levels).sort((a, b) => a - b)[Math.floor(levels.length * 0.1)] || 0;
  return Math.min(cap, Math.max(0.006, floor * 2.5));
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
/**
 * The same, measured on the clip itself (wavStats voicedMs: 20 ms frames above the clip's own
 * noise floor). Under a quarter of a second there's no word in it, and the recognizer answers
 * with confident nonsense.
 */
export const MIN_VOICED_MS = 250;
/** A whole clip this quiet (rms) is the room's own sound: half the level the page calls a quiet room. */
export const NOISE_FLOOR_RMS = 0.003;

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
 * speechEndSec: where the last lasting sound ends (0 with none), so a transcription of the clip's
 * beginning can be known to hold all of its speech (lib/sttstream.js).
 * @returns {{ wav: Buffer, speechMs: number, seconds: number, keptSeconds: number, speechEndSec: number }}
 */
export function squeezeSilence(wav, { keepGapMs = 300, padMs = 150 } = {}) {
  const pcm = wavSamples(wav);
  if (!pcm) return { wav, speechMs: 0, seconds: 0, keptSeconds: 0, speechEndSec: 0 };
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
  const threshold = voicedThreshold(level, 0.02);
  const voiced = Array.from(level, (l) => l > threshold);
  // Speech lasts: only runs of 60 ms or more count (a click or a tap is one frame or two).
  let speechFrames = 0;
  let lastVoiced = -1;
  for (let f = 0; f < n; ) {
    let e = f;
    while (e < n && voiced[e]) e++;
    if (e - f >= 3) {
      speechFrames += e - f;
      lastVoiced = e - 1;
    } else for (let k = f; k < e; k++) voiced[k] = false;
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
  const speechEndSec = lastVoiced < 0 ? 0 : +(Math.min(samples.length, (lastVoiced + 1) * w) / rate).toFixed(3);
  return { wav: pcmWav(kept, rate), speechMs: speechFrames * FRAME_MS, seconds: +(samples.length / rate).toFixed(2), keptSeconds: +(kept.length / rate).toFixed(2), speechEndSec };
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
 * Echo's own voice coming back (through a call, a screen share, loud speakers): every sentence
 * heard is one Echo said in its last few lines. "Showing him a quick demo now. Showing him a
 * quick demo now." was answered as if the user had said it (Oct 8, 2026).
 * @param {string} text what was heard @param {readonly string[]} lines Echo's last few lines, any order
 */
export function echoesRecent(text, lines) {
  if (bag(text).length < 4) return false;
  const said = lines.flatMap((l) => String(l).split(/(?<=[.!?…])\s+/)).map((x) => bag(x)).filter((b) => b.length >= 2);
  if (!said.length) return false;
  const heard = String(text).split(/(?<=[.!?…])\s+/).map((x) => bag(x)).filter((b) => b.length);
  return heard.every((h) => said.some((b) => {
    const have = new Set(b);
    return h.filter((x) => have.has(x)).length / h.length >= 0.85 && h.length >= Math.min(3, b.length);
  }));
}

/**
 * A name label Whisper sometimes puts in front, as in a meeting transcript ("Gino: And you'll do it
 * again."): one to three capitalised words and a colon at the start. Words that start a dictated
 * note ("Note:", "Subject:") stay.
 */
const SPEAKER = /^\s*([A-Z][a-z]+(?:[ '-][A-Z][a-z]+){0,2})\s*:\s+(?=\S)/;
const NOT_A_SPEAKER = new Set(['note', 'notes', 'subject', 'title', 'reminder', 'todo', 'step', 'answer', 'question', 're', 'to', 'from', 'dear', 'hi', 'hello', 'hey', 'echo', 'ps', 'update', 'summary', 'warning', 'error', 'tip', 'example', 'option', 'quote', 'agenda', 'heading',
  // Words someone may say first, then pause: "Yes: send it", "Okay: next one".
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'tonight',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'yes', 'yeah', 'yep', 'no', 'nope', 'okay', 'ok', 'sure', 'stop', 'wait', 'so', 'well', 'now', 'then', 'also', 'and', 'but', 'first', 'second', 'next', 'finally', 'please', 'thanks', 'right', 'cancel', 'done']);
/**
 * Careful, since "Monday: call the dentist" and "Mom: running late" are things people dictate: a
 * label goes only when the live listener heard the sentence without it, or (no live words) when
 * it's a first and last name. A first word that starts a note, a day or a month always stays.
 * @param {string} text @param {string} [live] what the live listener showed
 */
export function dropSpeakerLabel(text, live = '') {
  const t = String(text || '').replace(/^\s*>>\s*/, '');
  const m = t.match(SPEAKER);
  if (!m) return t;
  const label = m[1].toLowerCase().split(/[ '-]/);
  if (NOT_A_SPEAKER.has(label[0])) return t;
  const heardLive = new Set(bag(live));
  const drop = heardLive.size ? !label.some((w) => heardLive.has(w)) : label.length >= 2;
  return drop ? t.slice(m[0].length) : t;
}

/**
 * Is there too little sound in the clip for anything to have been said? Under a quarter second of
 * voiced sound, or the whole clip at the room's own level. Not for a clip with nothing measured.
 * @param {{ seconds?: number, rms?: number, voicedMs?: number } | null | undefined} stats lib/heard.js wavStats
 */
export function nearSilent(stats) {
  if (!stats || !(stats.seconds > 0)) return false;
  return stats.voicedMs < MIN_VOICED_MS || stats.rms < NOISE_FLOOR_RMS;
}

/** Words someone could have said: not blank, not one of Whisper's stock inventions, and more than a lone letter. */
export const realWords = (text) => !isBlankText(text) && !isInvented(text) && bag(text).some((w) => w.length >= 2);

/**
 * Clean Whisper's result: drop its stock inventions and the segments it was only guessing at,
 * and decide whether anything was really said.
 * @param {{ text: string, segments?: Array<{ text: string, lp?: number }>, speechMs?: number }} heard
 * @param {{ live?: string, livePreview?: boolean, stats?: { seconds?: number, rms?: number, voicedMs?: number } | null, sure?: boolean }} [ctx]
 *   livePreview: the live listener was on. stats: the clip's own numbers (wavStats): a near-silent
 *   clip yields no text. sure: push-to-talk or "Hey Echo", where real words always count.
 * @returns {{ text: string, dropped: string[], reason: '' | 'no_speech' | 'invented' | 'low_confidence' }}
 */
export function cleanHeard(heard, { live = '', livePreview = false, stats = null, sure = false } = {}) {
  const liveBlank = isBlankText(live);
  const none = () => ({ text: '', dropped: isBlankText(heard.text) ? [] : [heard.text], reason: /** @type {const} */ ('no_speech') });
  if (typeof heard.speechMs === 'number' && heard.speechMs < MIN_SPEECH_MS) return none();
  // Near-silent clips came back as confident nonsense and reached the model (Oct 2). Push-to-talk
  // (and the request after "Hey Echo") with real words in it is the one exception, however short
  // or soft: you asked to be heard, and a quick "yes" on the key was being thrown away.
  if (!isBlankText(heard.text) && nearSilent(stats) && !(sure && realWords(heard.text))) return none();
  const segs = (heard.segments?.length ? heard.segments : [{ text: heard.text }]).map((s) => ({ text: dropSpeakerLabel(String(s.text || '').trim(), live).trim(), lp: s.lp })).filter((s) => !isBlankText(s.text));
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
 * @param {{ wav: Buffer, heard: { text: string, engine?: string, ms?: number, segments?: Array<{ text: string, lp?: number }>, speechMs?: number }, live?: unknown, livePreview?: boolean, page?: object, clipDir: string, stats?: ReturnType<typeof wavStats>, sure?: boolean }} o
 *   stats: the clip's numbers when the caller has them already. sure: push-to-talk or "Hey Echo".
 */
export function checkHeard({ wav, heard, live, livePreview = false, page = {}, clipDir, stats = wavStats(wav), sure = false }) {
  const liveText = typeof live === 'string' ? live : '';
  const cleaned = cleanHeard(heard, { live: liveText, livePreview, stats, sure });
  const pick = pickTranscript(cleaned.text, liveText);
  if (pick.source === 'final') return { pick, cleaned, entry: null };
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

/**
 * Two clips are the same sentence when they share this much of BOTH: nearly the same length, at
 * nearly the same time. Measured against the shorter one alone, a hands-free clip holding two
 * sentences "was" the push-to-talk clip of the second, and the first sentence was lost.
 */
export const TWICE_MIN_OVERLAP = 0.6;

/**
 * How much of the LONGER one's time the two share (0..1), so it is high only when they share most
 * of both. Each is known by when its speech ended and how long the speech was (the quiet a clip
 * begins or ends with is not counted: lib/server/speech.js).
 * @param {{ endAt: number, ms: number }} a @param {{ endAt: number, ms: number }} b
 */
export function clipOverlap(a, b) {
  const longer = Math.max(a.ms, b.ms);
  if (!(Math.min(a.ms, b.ms) > 0)) return 0;
  const shared = Math.min(a.endAt, b.endAt) - Math.max(a.endAt - a.ms, b.endAt - b.ms);
  return Math.max(0, Math.min(1, shared / longer));
}

/**
 * The same sentence heard twice, by two mics at once: hands-free (the window's mic) and the Mac
 * app's push-to-talk shortcut both recorded "All right, I did." on Oct 1, and Echo answered both.
 * Decided by when the two were said, never by their words alone: two recognizers write one
 * sentence differently (both went through), and words that happen to match aren't proof (23
 * push-to-talk requests were dropped on Oct 2). Two clips from the SAME microphone are never one
 * sentence: one mic can't record two clips at once, whichever way each was started.
 * @param {{ mic?: string, endAt: number, ms: number } | null | undefined} prev mic: 'app' or 'page'
 * @param {{ mic?: string, endAt: number, ms: number } | null | undefined} next
 */
export function heardTwice(prev, next) {
  if (!prev || !next || (prev.mic || '') === (next.mic || '')) return false;
  return clipOverlap(prev, next) >= TWICE_MIN_OVERLAP;
}

/**
 * Do two transcriptions of one moment say the same thing? Two recognizers spell one sentence
 * differently, so half the words of either being in the other is enough. Used only for clips
 * already known to cover the same moment (heardTwice).
 * @param {string} a @param {string} b
 */
export function sameInSubstance(a, b) {
  if (isBlankText(a) || isBlankText(b)) return false;
  return Math.max(agreement(a, b), agreement(b, a)) >= 0.5;
}
