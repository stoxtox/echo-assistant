// Context-aware correction of speech transcripts, before Echo acts on them.
//
// 1. Instant: learned corrections that are safe to swap anywhere ("hoe broken" -> "Hoboken").
// 2. Smart: a small, fast model (Claude Haiku, kept warm in one session) fixes likely
//    mishearings using your vocabulary, project names and the last few exchanges.
//    It never rephrases or answers; it only fixes words, and lists what it's unsure about.
//    If it takes too long, the instant result is used.
import { EventEmitter } from 'node:events';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { InputQueue } from './queue.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './settings.js';
import { applyCorrections, correctionSets, vocabularyTerms, isEnglishWord } from './vocab.js';
import { phoneticKey, jaroWinkler } from './projects.js';

const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}:]/gu, '');

/**
 * Word-level alignment of two texts (longest common subsequence): runs of equal words and
 * changed spans. `from` is the index of a changed span's first word in `before`.
 * @returns {Array<{ same: boolean, heard: string[], meant: string[], from: number }>}
 */
export function diffOps(before, after) {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = norm(a[i]) === norm(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0, from = 0, heard = [], meant = [];
  const flush = () => {
    if (heard.length || meant.length) out.push({ same: false, heard, meant, from });
    heard = [];
    meant = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && norm(a[i]) === norm(b[j])) {
      flush();
      out.push({ same: true, heard: [a[i]], meant: [b[j]], from: i });
      i++;
      j++;
      from = i;
    } else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) meant.push(b[j++]);
    else heard.push(a[i++]);
  }
  flush();
  return out;
}

/** Word-level spans that differ between two texts. */
export function diffWords(before, after) {
  return diffOps(before, after)
    .filter((o) => !o.same)
    .map((c) => ({ heard: c.heard.join(' ').replace(/[.,!?;]+$/, ''), meant: c.meant.join(' ').replace(/[.,!?;]+$/, '') }))
    .filter((c) => c.heard.toLowerCase() !== c.meant.toLowerCase());
}

// Letters spelled out one by one: "T-A-V-I-S-H", "t.a.v.i.s", "T A V I S H" (capitals only
// when separated by spaces, so ordinary words like "a" and "I" never look like spelling).
const SPELLED = /(?<![\p{L}\p{N}])(?:\p{L}(?:[-.]\p{L}){2,}|\p{Lu}(?: \p{Lu}){2,})(?![\p{L}\p{N}])\.?/gu;

/** Words the user spelled out letter by letter, as words ("Tavish"), with their word spans. */
export function spelledWords(text) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const starts = [];
  let pos = 0;
  for (const w of words) {
    pos = String(text).indexOf(w, pos);
    starts.push(pos);
    pos += w.length;
  }
  const out = [];
  for (const m of String(text).matchAll(SPELLED)) {
    const letters = m[0].replace(/[^\p{L}]/gu, '');
    const word = letters[0].toUpperCase() + letters.slice(1).toLowerCase();
    const first = starts.findLastIndex((s) => s <= m.index);
    const last = starts.findLastIndex((s) => s < m.index + m[0].length);
    out.push({ word, first, last });
  }
  return out;
}

/**
 * Spelled-out letters always win: a spoken word that sounds like a word the user spelled
 * ("Tavis ... T-A-V-I-S-H") takes the spelled form.
 */
export function applySpelling(text) {
  const spelled = spelledWords(text);
  if (!spelled.length) return { text, applied: [] };
  const words = text.split(/\s+/).filter(Boolean);
  const applied = [];
  words.forEach((w, i) => {
    if (spelled.some((s) => i >= s.first && i <= s.last)) return;
    const bare = w.replace(/[^\p{L}]/gu, '');
    if (bare.length < 3 || isEnglishWord(bare)) return;
    for (const s of spelled) {
      if (bare.toLowerCase() === s.word.toLowerCase()) continue;
      if (jaroWinkler(phoneticKey(bare), phoneticKey(s.word)) >= 0.8 || jaroWinkler(bare.toLowerCase(), s.word.toLowerCase()) >= 0.8) {
        words[i] = w.replace(bare, s.word);
        applied.push({ heard: bare, meant: s.word });
        break;
      }
    }
  });
  return { text: applied.length ? words.join(' ') : text, applied };
}

/** Names of saved contact favorites (their aliases and full names). */
function favoriteNames() {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'contact-aliases.json'), 'utf8'));
    return Object.entries(all?.aliases || all || {}).flatMap(([alias, f]) => [alias, /** @type {any} */ (f)?.alias, /** @type {any} */ (f)?.name]).filter((t) => typeof t === 'string' && t.trim());
  } catch {
    return [];
  }
}

/** The user's own name and its parts ("Sam Lee" -> Sam Lee, Sam, Lee). */
function ownNames() {
  const name = String(getSettings().userName || '').trim();
  return name ? [...new Set([name, ...name.split(/\s+/)])].filter((n) => n.length > 1) : [];
}

/**
 * Words the model must never replace: contact favorites, vocabulary words, and anything the
 * user spelled out in this sentence.
 */
export function protectedTerms() {
  const names = favoriteNames();
  return [...names, ...names.flatMap((n) => n.split(/\s+/)).filter((w) => w.length > 2), ...vocabularyTerms()];
}

/**
 * Keeps the model's fixes except those that change a protected word, anything spelled out,
 * or that bring in the user's own name for a word that doesn't sound like it.
 * @param {string} before the transcript given to the model
 * @param {string} after the model's corrected text
 */
export function guardCorrection(before, after, { terms = protectedTerms(), own = ownNames() } = {}) {
  const words = before.split(/\s+/).filter(Boolean);
  const locked = new Set();
  for (const s of spelledWords(before)) for (let i = s.first; i <= s.last; i++) locked.add(i);
  const spelled = new Set(spelledWords(before).map((s) => s.word.toLowerCase()));
  const lower = words.map(norm);
  for (const t of terms) {
    const parts = t.split(/\s+/).map(norm).filter(Boolean);
    if (!parts.length) continue;
    for (let i = 0; i + parts.length <= lower.length; i++) {
      if (parts.every((p, k) => lower[i + k] === p)) for (let k = 0; k < parts.length; k++) locked.add(i + k);
    }
  }
  lower.forEach((w, i) => spelled.has(w) && locked.add(i));
  const ownLower = own.map(norm);
  const soundsLike = (heard, name) => heard.some((h) => jaroWinkler(phoneticKey(h), phoneticKey(name)) >= 0.85);
  const out = [];
  const rejected = [];
  for (const op of diffOps(before, after)) {
    if (op.same) {
      out.push(...op.meant);
      continue;
    }
    const touchesLocked = op.heard.some((_, k) => locked.has(op.from + k));
    const heardNorm = op.heard.map(norm);
    const bringsOwnName = ownLower.some((n) => op.meant.some((m) => norm(m) === n) && !heardNorm.includes(n) && !soundsLike(heardNorm, n));
    if (op.heard.length && (touchesLocked || bringsOwnName)) {
      out.push(...op.heard);
      rejected.push({ heard: op.heard.join(' '), meant: op.meant.join(' ') });
    } else out.push(...op.meant);
  }
  return { text: out.join(' '), rejected };
}

/** A fix is a guess when the words don't sound alike (e.g. "water bottle" -> "bibimbap"). */
export function isGuess({ heard, meant }) {
  if (/^\d{1,2}[:.]\d{2}$/.test(meant.trim())) return false; // time formatting
  const s = jaroWinkler(phoneticKey(heard), phoneticKey(meant));
  return s < 0.8;
}

const MODEL = process.env.VOICEOPS_CORRECTION_MODEL || 'claude-haiku-4-5';
const TIMEOUT_MS = Number(process.env.VOICEOPS_CORRECTION_TIMEOUT_MS || 3500);
const MAX_TURNS_PER_SESSION = 40; // start fresh now and then so the context stays small

function systemPrompt() {
  const { hints } = correctionSets();
  const own = ownNames().map((n) => n.toLowerCase());
  const favorites = [...new Set(favoriteNames())];
  return `You fix speech-recognition mistakes in what the user just said to their voice assistant. The user speaks English with an Indian accent; the recognizer often mangles names, places, brands, project names, Indian food words, numbers and times.

Rules:
- Only fix words that were clearly misheard. Keep everything else exactly as spoken. Never rephrase, summarize, translate, or answer the user.
- Prefer words from the vocabulary and the recent conversation when the sound is close and the meaning fits.
- Write times as digits with a colon ("8:30", not "8.30" or "eight thirty").
- If a word looks misheard but you can't tell what was meant, leave it and list it under "unsure".
- If your fix is a guess (the sounds are only loosely alike, or several words would fit), make the fix but ALSO list the corrected word(s) under "unsure" so the assistant confirms them. Only confident fixes (close sound + fits the vocabulary or context) go unlisted.
- Letters spelled out one by one ("T-A-V-I-S-H") are exactly what the user meant. Never change them, and spell the spoken word that way.
- Never replace a word that is already a vocabulary word or a contact's name.
- Only use the user's own name when they clearly said it. Other people's names are never the user's name.
- If nothing needs fixing, return the text unchanged.

Vocabulary (the user's projects, people, places, brands and foods): ${vocabularyTerms().filter((t) => !own.includes(t.toLowerCase())).join(', ')}
${favorites.length ? `\nContacts (never change these names): ${favorites.join(', ')}\n` : ''}${own.length ? `\nThe user's own name is ${own[0]}. People rarely say their own name to their assistant.\n` : ''}
Known mishearings that apply only when the context fits: ${Object.entries(hints).map(([h, m]) => `"${h}" usually means "${m}"`).join('; ') || 'none'}

Reply with only JSON: {"text": "<corrected text>", "changes": [{"heard": "...", "meant": "..."}], "unsure": ["..."]}`;
}

export class Corrector extends EventEmitter {
  /** @param {{ queryFn?: (params: { prompt: any, options: any }) => AsyncIterable<any> }} [opts] */
  constructor({ queryFn = sdkQuery } = {}) {
    super();
    this.queryFn = queryFn;
    this.timeoutMs = TIMEOUT_MS;
    this.waiters = [];
    this.turns = 0;
    this.version = null;
    this.costSeen = 0;
  }

  vocabVersion() {
    return JSON.stringify([vocabularyTerms(), correctionSets().hints, favoriteNames(), ownNames()]);
  }

  // One long-lived session keeps the model warm, so each correction takes about a second.
  ensureSession() {
    const version = this.vocabVersion();
    if (this.input && this.version === version && this.turns < MAX_TURNS_PER_SESSION) return;
    this.input?.close();
    for (const w of this.waiters.splice(0)) w.resolve(null);
    this.version = version;
    this.turns = 0;
    this.costSeen = 0;
    const input = (this.input = new InputQueue());
    const q = this.queryFn({
      prompt: input,
      options: { model: MODEL, tools: [], persistSession: false, settingSources: [], permissionMode: 'dontAsk', systemPrompt: systemPrompt(), thinking: { type: 'disabled' } },
    });
    (async () => {
      try {
        for await (const msg of q) {
          if (msg.type !== 'result') continue;
          const delta = (msg.total_cost_usd || 0) - this.costSeen;
          this.costSeen = msg.total_cost_usd || 0;
          if (delta > 0) this.emit('cost', delta);
          this.waiters.shift()?.resolve(msg.subtype === 'success' ? msg.result : null);
        }
      } catch (e) {
        for (const w of this.waiters.splice(0)) w.resolve(null);
      } finally {
        if (this.input === input) this.input = null;
      }
    })();
  }

  /** Start the session and run one throwaway correction so the first real one is fast. */
  async warmUp() {
    try {
      this.ensureSession();
      this.turns++;
      const reply = new Promise((resolve) => this.waiters.push({ resolve }));
      this.input.push('Transcript to fix: hello');
      await reply;
    } catch {}
  }

  /**
   * @param {string} raw what the recognizer heard
   * @param {{ uncertain?: Array<{ word: string, confidence: number }>, recent?: string[], smart?: boolean }} [ctx]
   * @returns {Promise<{ text: string, changes: Array<{ heard: string, meant: string }>, unsure: string[], smart: boolean, ms: number, timedOut?: boolean, rejected?: Array<{ heard: string, meant: string }> }>}
   */
  async correct(raw, { uncertain = [], recent = [], smart = true } = {}) {
    const t0 = Date.now();
    const learned = applyCorrections(raw);
    const spelled = applySpelling(learned.text);
    const instant = { text: spelled.text, applied: [...learned.applied, ...spelled.applied] };
    const base = { text: instant.text, changes: instant.applied, unsure: uncertain.map((u) => u.word), smart: false };
    if (!smart || !raw.trim()) return { ...base, ms: Date.now() - t0 };

    this.ensureSession();
    this.turns++;
    const message = [
      recent.length ? `Recent conversation:\n${recent.slice(-6).join('\n')}` : '',
      uncertain.length ? `The recognizer was unsure about: ${uncertain.map((u) => `"${u.word}" (${Math.round(u.confidence * 100)}%)`).join(', ')}` : '',
      `Transcript to fix: ${instant.text}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const reply = new Promise((resolve) => this.waiters.push({ resolve }));
    this.input.push(message);
    const out = await Promise.race([reply, new Promise((r) => setTimeout(() => r('__timeout__'), this.timeoutMs))]);
    if (out === '__timeout__' || !out) return { ...base, ms: Date.now() - t0, timedOut: out === '__timeout__' };
    try {
      const json = JSON.parse(String(out).match(/\{[\s\S]*\}/)[0]);
      const proposed = String(json.text || '').trim();
      // Guard against the model answering or rewriting instead of correcting.
      if (!proposed || proposed.length > instant.text.length * 1.6 + 20) return { ...base, ms: Date.now() - t0 };
      // Spelled-out words, contacts, vocabulary words and the user's own name are never swapped in or out.
      const { text, rejected } = guardCorrection(instant.text, proposed);
      const changes = diffWords(instant.text, text);
      const guesses = changes.filter(isGuess).map((c) => c.meant);
      return {
        text,
        changes: [...instant.applied, ...changes],
        unsure: [...new Set([...(json.unsure || []), ...guesses, ...base.unsure].filter((w) => text.includes(w)))],
        ...(rejected.length ? { rejected } : {}),
        smart: true,
        ms: Date.now() - t0,
      };
    } catch {
      return { ...base, ms: Date.now() - t0 };
    }
  }

  stop() {
    this.input?.close();
  }
}
