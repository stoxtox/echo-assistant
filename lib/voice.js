import { speakable } from './text.js';
import { VoiceBudget, PREMIUM } from './voicebudget.js';

// Text-to-speech providers. Kokoro runs locally for free; ElevenLabs and Cartesia are the premium
// options and turn on when ELEVENLABS_API_KEY / CARTESIA_API_KEY is set (put it in Echo/.env).
// A premium voice speaks while its free characters last, then Kokoro until they're back
// (lib/voicebudget.js); a premium sentence that fails or is too slow is said by Kokoro instead.
const ELEVEN = 'https://api.elevenlabs.io/v1';
const CARTESIA = 'https://api.cartesia.ai';
const CARTESIA_VERSION = '2026-08-14';
const CARTESIA_MODEL = process.env.CARTESIA_MODEL || 'sonic-3.6';
/** A premium sentence that takes longer than this is said by Kokoro instead. */
export const PREMIUM_TIMEOUT_MS = 4000;

const KOKORO_VOICES = [
  ['af_heart', 'Heart (US, warm)'],
  ['af_bella', 'Bella (US, bright)'],
  ['af_nova', 'Nova (US)'],
  ['af_sky', 'Sky (US)'],
  ['af_river', 'River (US)'],
  ['am_michael', 'Michael (US)'],
  ['am_puck', 'Puck (US, playful)'],
  ['am_fenrir', 'Fenrir (US, deep)'],
  ['am_echo', 'Echo (US)'],
  ['bf_emma', 'Emma (UK)'],
  ['bf_isabella', 'Isabella (UK)'],
  ['bm_george', 'George (UK)'],
  ['bm_fable', 'Fable (UK)'],
];

let kokoro = null;
let kokoroLoading = null;
let chain = Promise.resolve(); // Kokoro runs one synthesis at a time
let lastSynthAt = 0;
const KEEP_WARM_MS = 4 * 60 * 1000;
// Short fixed phrases ("Okay, go ahead."), rendered ahead of time so they
// play the instant they're needed: `${voice}|${speed}|${text}` -> audio.
const phraseCache = new Map();
const PHRASE_CACHE_MAX = 80;

// How far along the voice download is (~90 MB on first launch), for the setup wizard.
const files = new Map(); // file -> { loaded, total }
let voiceState = { state: 'idle', progress: 0, error: '' };
export function voiceStatus() {
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  return { ...voiceState, progress: voiceState.state === 'ready' ? 1 : total ? loaded / total : 0, mb: Math.round(total / 1e6) };
}

async function loadKokoro() {
  if (kokoro) return kokoro;
  kokoroLoading ??= (async () => {
    voiceState = { state: 'loading', progress: 0, error: '' };
    try {
      const { KokoroTTS } = await import('kokoro-js');
      kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: (/** @type {any} */ p) => {
          if (p?.status === 'progress' && p.file && p.total) files.set(p.file, { loaded: p.loaded || 0, total: p.total });
          if (p?.status === 'download' || p?.status === 'progress') voiceState.state = 'downloading';
        },
      });
      voiceState = { state: 'ready', progress: 1, error: '' };
      return kokoro;
    } catch (e) {
      voiceState = { state: 'error', progress: 0, error: e.message };
      kokoroLoading = null;
      throw e;
    }
  })();
  return kokoroLoading;
}

export function warmUp() {
  loadKokoro()
    .then((tts) => tts.generate('Ready.', { voice: 'af_heart' }))
    .then(() => {
      lastSynthAt = Date.now();
      console.log('[voice] Kokoro ready');
    })
    .catch((e) => console.error('[voice] Kokoro failed to load:', e.message));
  // Keep the engine warm: a tiny synthesis now and then when Echo has been quiet, so the first
  // words after a long pause don't wait on a cold model.
  const t = setInterval(() => {
    if (!kokoro || Date.now() - lastSynthAt < KEEP_WARM_MS) return;
    lastSynthAt = Date.now();
    chain = chain.then(() => kokoro.generate('Okay.', { voice: 'af_heart' })).catch(() => {});
  }, KEEP_WARM_MS / 2);
  t.unref?.();
}

const kokoroVoice = (voice) => (KOKORO_VOICES.some(([id]) => id === voice) ? voice : 'af_heart');

/**
 * Render short, often-said phrases ahead of time in this voice and speed (Kokoro only), one at a
 * time behind real speech. Safe to call again when the voice changes.
 * @param {string[]} phrases @param {{ voice?: string, speed?: number }} o
 */
export async function prewarmPhrases(phrases, { voice, speed = 1 } = {}) {
  const tts = await loadKokoro().catch(() => null);
  if (!tts) return 0;
  let n = 0;
  for (const p of phrases) {
    const text = speakable(p);
    const key = `${kokoroVoice(voice)}|${speed}|${text}`;
    if (!text || phraseCache.has(key)) continue;
    const job = chain.then(() => tts.generate(text, { voice: kokoroVoice(voice), speed }));
    chain = job.catch(() => {});
    try {
      const audio = await job;
      if (phraseCache.size >= PHRASE_CACHE_MAX) phraseCache.delete(phraseCache.keys().next().value);
      phraseCache.set(key, { mime: 'audio/wav', data: Buffer.from(audio.toWav()), words: null });
      n++;
    } catch {}
  }
  return n;
}

export const hasElevenLabs = () => Boolean(process.env.ELEVENLABS_API_KEY);
export const hasCartesia = () => Boolean(process.env.CARTESIA_API_KEY);
const cartesiaHeaders = () => ({ Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`, 'Cartesia-Version': CARTESIA_VERSION });

/** The premium voices' free characters; the server sets `onChange` to tell you when it switches. */
export const voiceBudget = new VoiceBudget();

export async function listVoices() {
  const providers = [
    { id: 'kokoro', label: 'Kokoro (free, local)', voices: KOKORO_VOICES.map(([id, name]) => ({ id, name })) },
  ];
  if (hasElevenLabs()) {
    try {
      const res = await fetch(`${ELEVEN}/voices`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
      const body = await res.json();
      providers.push({
        id: 'elevenlabs',
        label: 'ElevenLabs (premium)',
        voices: (body.voices || []).map((v) => ({ id: v.voice_id, name: `${v.name}${v.labels?.accent ? ` (${v.labels.accent})` : ''}` })),
      });
    } catch (e) {
      console.error('[voice] ElevenLabs voices:', e.message);
    }
  }
  if (hasCartesia()) {
    try {
      const res = await fetch(`${CARTESIA}/voices?limit=100&language=en`, { headers: cartesiaHeaders() });
      const body = await res.json();
      providers.push({
        id: 'cartesia',
        label: 'Cartesia (premium, fastest)',
        voices: (body.data || []).map((v) => ({ id: v.id, name: `${v.name}${v.accents?.length ? ` (${v.accents[0]})` : ''}` })),
      });
    } catch (e) {
      console.error('[voice] Cartesia voices:', e.message);
    }
  }
  providers.push({ id: 'browser', label: 'Browser (basic)', voices: [] });
  return providers;
}

/**
 * ElevenLabs character alignment -> words with start/end seconds: [{ w, s, e }].
 * @param {{ characters?: string[], character_start_times_seconds?: number[], character_end_times_seconds?: number[] } | null | undefined} a
 */
export function alignmentWords(a) {
  const chars = a?.characters, starts = a?.character_start_times_seconds, ends = a?.character_end_times_seconds;
  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends)) return null;
  const out = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) { cur = null; continue; }
    if (!cur) out.push((cur = { w: '', s: +(Number(starts[i]) || 0).toFixed(3), e: 0 }));
    cur.w += chars[i];
    cur.e = +(Number(ends[i]) || 0).toFixed(3);
  }
  return out.length ? out : null;
}

/** Word timings as a response header value (ASCII-safe), or null if too big to send as one. */
export function wordsHeader(words) {
  if (!words?.length) return null;
  const v = encodeURIComponent(JSON.stringify(words));
  return v.length <= 7000 ? v : null;
}

/**
 * The ElevenLabs request body. `previousText` is the piece of the same reply spoken just before:
 * the model continues its intonation instead of starting fresh, so pieces sound like one thought.
 * @param {{ text: string, speed?: number, previousText?: string }} o
 */
export function elevenBody({ text, speed = 1, previousText = '' }) {
  const prev = speakable(previousText || '').slice(-400);
  return { text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, speed: Math.min(1.2, speed) }, ...(prev && { previous_text: prev }) };
}

/** The Cartesia request body (Sonic 3 or newer: speed goes in generation_config). */
export function cartesiaBody({ text, voice, speed = 1 }) {
  return {
    model_id: CARTESIA_MODEL,
    transcript: text,
    voice: { mode: 'id', id: voice },
    output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 },
    language: 'en',
    generation_config: { speed: Math.min(1.5, Math.max(0.6, speed)) },
  };
}

class PremiumError extends Error {
  /** @param {string} message @param {{ status?: number, body?: string, timeout?: boolean }} info */
  constructor(message, info) {
    super(message);
    this.info = info;
  }
}

/** One sentence from a premium voice, or a PremiumError (with the status, for the budget). */
async function premiumSynth({ provider, text, voice, speed, previousText }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREMIUM_TIMEOUT_MS);
  try {
    if (provider === 'elevenlabs') {
      // The with-timestamps variant also returns per-character timings, used for the karaoke highlight.
      const res = await fetch(`${ELEVEN}/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '', 'Content-Type': 'application/json' },
        body: JSON.stringify(elevenBody({ text, speed, previousText })),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new PremiumError(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`, { status: res.status, body });
      }
      const body = await res.json();
      return { mime: 'audio/mpeg', data: Buffer.from(body.audio_base64 || '', 'base64'), words: alignmentWords(body.alignment || body.normalized_alignment) };
    }
    const res = await fetch(`${CARTESIA}/tts/bytes`, {
      method: 'POST',
      headers: { ...cartesiaHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(cartesiaBody({ text, voice, speed })),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new PremiumError(`Cartesia ${res.status}: ${body.slice(0, 200)}`, { status: res.status, body });
    }
    return { mime: 'audio/wav', data: Buffer.from(await res.arrayBuffer()), words: null };
  } catch (e) {
    if (e instanceof PremiumError) throw e;
    throw new PremiumError(`${provider}: ${controller.signal.aborted ? 'too slow' : e.message}`, { timeout: controller.signal.aborted });
  } finally {
    clearTimeout(timer);
  }
}

/** Kokoro, one sentence at a time (replaceable in tests, where the model isn't loaded). */
let localSynth = async (/** @type {string} */ text, /** @type {string} */ voice, /** @type {number} */ speed) => {
  const cached = phraseCache.get(`${kokoroVoice(voice)}|${speed}|${text}`);
  if (cached) return cached;
  const tts = await loadKokoro();
  const job = chain.then(() => tts.generate(text, { voice: kokoroVoice(voice), speed }));
  chain = job.catch(() => {});
  const audio = await job;
  lastSynthAt = Date.now();
  return { mime: 'audio/wav', data: Buffer.from(audio.toWav()), words: null };
};
/** @param {typeof localSynth} fn */
export function setLocalVoiceForTests(fn) {
  localSynth = fn;
}

/**
 * One piece of speech. With a premium provider: the premium voice while it may speak (free
 * characters left, not resting), otherwise Kokoro in `fallbackVoice`. `strict` (the voice bench)
 * throws instead of falling back. The result says which voice spoke and why it fell back.
 * @param {{ text: string, provider?: string, voice?: string, speed?: number, previousText?: string, fallbackVoice?: string, strict?: boolean }} o
 * @returns {Promise<{ mime: string, data: Buffer, words: any, provider: string, fellBack?: string }>}
 */
export async function synthesize({ text, provider, voice, speed, previousText, fallbackVoice, strict = false }) {
  // A line break with no punctuation (a list item) still gets a pause once the lines are joined.
  text = speakable(String(text || '').replace(/([\p{L}\p{N}])[ \t]*\n+/gu, '$1.\n'));
  if (!text) throw new Error('Nothing to say');

  let fellBack = '';
  if (provider && PREMIUM.includes(provider)) {
    const gate = voiceBudget.canUse(provider, text.length);
    if (gate.ok) {
      try {
        const audio = await premiumSynth({ provider, text, voice, speed, previousText });
        voiceBudget.spent(provider, text.length);
        return { ...audio, provider };
      } catch (e) {
        voiceBudget.failed(provider, e.info || {});
        if (strict) throw e;
        console.error('[voice]', e.message, '(Kokoro says this one)');
        fellBack = voiceBudget.resting(provider) ? voiceBudget.get(provider).why : e.info?.timeout ? 'slow' : 'error';
      }
    } else {
      if (strict) throw new Error(`${provider}: ${gate.why}`);
      fellBack = gate.why;
    }
  }
  const audio = await localSynth(text, fellBack ? fallbackVoice || 'af_heart' : voice, speed ?? 1);
  return { ...audio, provider: 'kokoro', ...(fellBack && { fellBack }) };
}
