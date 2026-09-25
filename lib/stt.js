// Speech-to-text engines.
//
//   whisper   local whisper.cpp (large-v3-turbo) on Apple Silicon. Free, private, ~0.7s per
//             sentence. Gets your vocabulary as its initial prompt. Default when installed.
//   deepgram  Deepgram Nova-3 in the cloud with keyterm prompting. Paid (per minute of audio).
//             Turns on when DEEPGRAM_API_KEY is set in .env.
//   browser   Chrome's built-in recognition (runs in the page). Always available fallback.
//
// Every engine is locked to English (the sttLanguage setting only picks the accent), so an
// English sentence is never transcribed or translated as another language.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { config, APP_DIR } from './config.js';
import { whisperPrompt, vocabularyTerms, isEnglishWord } from './vocab.js';

const WHISPER_PORT = Number(process.env.VOICEOPS_WHISPER_PORT || config.port + 1);
const MODEL = process.env.VOICEOPS_WHISPER_MODEL || path.join(APP_DIR, 'models', 'ggml-large-v3-turbo-q5_0.bin');
const LOW_CONFIDENCE = 0.6;

function whisperBinary() {
  for (const p of ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server']) if (fs.existsSync(p)) return p;
  try {
    return execFileSync('which', ['whisper-server'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export function engines() {
  const bin = whisperBinary();
  return {
    whisper: { available: Boolean(bin && fs.existsSync(MODEL)), why: !bin ? 'Run: brew install whisper-cpp' : !fs.existsSync(MODEL) ? 'Run: npm run setup:whisper' : '' },
    deepgram: { available: Boolean(process.env.DEEPGRAM_API_KEY), why: process.env.DEEPGRAM_API_KEY ? '' : 'Add DEEPGRAM_API_KEY to .env' },
    browser: { available: true, why: '' },
  };
}

/** 'auto' means the best engine that's available: local Whisper, else the browser. */
export function resolveEngine(choice) {
  const e = engines();
  if (choice && choice !== 'auto' && e[choice]?.available) return choice;
  return e.whisper.available ? 'whisper' : 'browser';
}

const ACCENTS = ['en-IN', 'en-US', 'en'];

/**
 * The language code each engine gets for the sttLanguage setting. Always English.
 *   whisper  'en' (whisper has no accents; forcing 'en' stops auto-detect)
 *   deepgram the setting itself: 'en-IN' | 'en-US' | 'en'
 *   browser  'en-IN' | 'en-US' (Chrome needs a region; 'en' means en-US)
 * @param {string} engine
 * @param {string} [setting]
 */
export function sttLanguageFor(engine, setting) {
  const accent = ACCENTS.includes(setting) ? setting : 'en-IN';
  if (engine === 'whisper') return 'en';
  if (engine === 'browser') return accent === 'en' ? 'en-US' : accent;
  return accent;
}

/* ---------- local whisper.cpp server ---------- */
let whisperProc = null;
let whisperReady = null;

/** whisper-server command line: English only, never auto-detect or translate. */
export function whisperArgs() {
  return ['-m', MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT), '-l', 'en', '-t', '6', '-nt'];
}

export function startWhisper() {
  if (whisperReady) return whisperReady;
  const bin = whisperBinary();
  if (!bin || !fs.existsSync(MODEL)) return Promise.reject(new Error(engines().whisper.why));
  whisperProc = spawn(bin, whisperArgs(), { stdio: ['ignore', 'ignore', 'pipe'] });
  whisperProc.stderr.on('data', () => {}); // whisper.cpp logs a lot; ignore
  whisperProc.on('exit', () => {
    whisperProc = null;
    whisperReady = null;
  });
  whisperReady = (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${WHISPER_PORT}/`);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new Error('Whisper did not start');
  })();
  whisperReady.catch(() => (whisperReady = null));
  return whisperReady;
}

export function stopWhisper() {
  whisperProc?.kill();
}
process.on('exit', stopWhisper);

/** whisper.cpp reports sub-word tokens; join them into words, keeping the weakest probability. */
export function mergeTokens(tokens) {
  const words = [];
  for (const t of tokens) {
    const text = t.word ?? t.text ?? '';
    if (!text || /^\[.*\]$/.test(text.trim())) continue;
    const p = t.probability ?? t.p ?? 1;
    if (/^\s/.test(text) || !words.length || /^[.,!?;:]$/.test(words[words.length - 1].word)) words.push({ word: text.trim(), p });
    else {
      const last = words[words.length - 1];
      last.word += text.trim();
      last.p = Math.min(last.p, p);
    }
  }
  return words.filter((w) => w.word);
}

/**
 * The /inference request. The per-request language overrides whatever the server was started
 * with, so it's always sent: English, no language detection, no translation.
 * @param {Buffer} wav
 * @param {string} [prompt]
 */
export function whisperForm(wav, prompt = whisperPrompt()) {
  const form = new FormData();
  form.append('file', new Blob([/** @type {BlobPart} */ (wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  form.append('language', sttLanguageFor('whisper'));
  form.append('detect_language', 'false');
  form.append('translate', 'false');
  form.append('prompt', prompt);
  return form;
}

async function whisperTranscribe(wav) {
  await startWhisper();
  const form = whisperForm(wav);
  const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Whisper ${res.status}`);
  const body = await res.json();
  const words = mergeTokens((body.segments || []).flatMap((s) => s.words || []));
  // Whisper sometimes "hears" the glossary itself on silence; treat that as nothing said.
  const text = String(body.text || '').trim();
  if (/^glossary\b/i.test(text)) return { text: '', words: [] };
  return { text, words };
}

/* ---------- Deepgram Nova-3 ---------- */
/** Deepgram query string: always an English language code, never auto-detect. */
export function deepgramParams(setting) {
  const params = new URLSearchParams({ model: 'nova-3', smart_format: 'true', punctuate: 'true', language: sttLanguageFor('deepgram', setting) });
  // Keyterms: up to ~500 tokens in total; most important terms come first.
  let budget = 0;
  for (const term of vocabularyTerms()) {
    budget += Math.ceil(term.length / 3) + 1;
    if (budget > 450) break;
    params.append('keyterm', term);
  }
  return params;
}

async function deepgramTranscribe(wav, setting) {
  const params = deepgramParams(setting);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav' },
    body: wav,
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const alt = (await res.json()).results?.channels?.[0]?.alternatives?.[0] || {};
  return { text: String(alt.transcript || '').trim(), words: (alt.words || []).map((w) => ({ word: w.punctuated_word || w.word, p: w.confidence })) };
}

/**
 * Words worth confirming: low confidence AND likely to matter (numbers, names, unusual words).
 * @param {Array<{ word: string, p: number }>} words
 */
export function uncertainWords(words) {
  return words
    .filter((w, i) => w.p < LOW_CONFIDENCE && w.word.replace(/[^\p{L}\p{N}]/gu, '').length > 2)
    // Only words that matter: numbers, names (capitalized, not sentence-initial), or non-words.
    .filter((w, i) => /\d/.test(w.word) || (i > 0 && /^[A-Z]/.test(w.word)) || !isEnglishWord(w.word.replace(/[^\p{L}]/gu, '')))
    .map((w) => ({ word: w.word.replace(/[.,!?;:]+$/, ''), confidence: Number(w.p.toFixed(2)) }));
}

/**
 * Transcribe one utterance (16 kHz mono WAV). `language` is the sttLanguage setting.
 * @param {Buffer} wav
 * @param {{ engine?: string, language?: string }} [opts]
 * @returns {Promise<{ text: string, words: Array<{ word: string, p: number }>, uncertain: Array<{ word: string, confidence: number }>, engine: string, ms: number }>}
 */
export async function transcribe(wav, { engine, language } = {}) {
  const t0 = Date.now();
  const r = engine === 'deepgram' ? await deepgramTranscribe(wav, language) : await whisperTranscribe(wav);
  return { ...r, uncertain: uncertainWords(r.words), engine, ms: Date.now() - t0 };
}
