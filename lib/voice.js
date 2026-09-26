import { speakable } from './text.js';

// Text-to-speech providers. Kokoro runs locally for free; ElevenLabs is the premium option
// and turns on when ELEVENLABS_API_KEY is set (put it in Echo/.env).
const ELEVEN = 'https://api.elevenlabs.io/v1';

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
// Short phrases said often (the acknowledgement, the fillers), rendered ahead of time so they
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

export async function synthesize({ text, provider, voice, speed }) {
  text = speakable(text);
  if (!text) throw new Error('Nothing to say');

  if (provider === 'elevenlabs' && hasElevenLabs()) {
    // The with-timestamps variant also returns per-character timings, used for the karaoke highlight.
    const res = await fetch(`${ELEVEN}/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, speed: Math.min(1.2, speed) } }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return { mime: 'audio/mpeg', data: Buffer.from(body.audio_base64 || '', 'base64'), words: alignmentWords(body.alignment || body.normalized_alignment) };
  }

  const cached = phraseCache.get(`${kokoroVoice(voice)}|${speed}|${text}`);
  if (cached) return cached;
  const tts = await loadKokoro();
  const job = chain.then(() => tts.generate(text, { voice: kokoroVoice(voice), speed }));
  chain = job.catch(() => {});
  const audio = await job;
  lastSynthAt = Date.now();
  return { mime: 'audio/wav', data: Buffer.from(audio.toWav()), words: null };
}
