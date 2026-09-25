// Custom vocabulary for speech recognition: words the recognizer should expect.
// Built from your project folders + a list you can edit + corrections Echo has learned.
//
// data/vocabulary.json:
//   { "words": ["Maya", "Hoboken", ...],          // edit freely (also in Voice & vibe)
//     "corrections": { "hoe broken": "Hoboken" } }  // learned from "no, I meant X"
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { listProjects, loadStore } from './projects.js';

const file = () => path.join(config.dataDir, 'vocabulary.json');

// A fresh install starts with only the product's own names; everything personal is learned
// per install (Voice & vibe panel, "no, I meant X") and saved in the data folder.
export const DEFAULT_VOCAB = {
  words: ['Echo', 'Claude'],
  corrections: {},
};

export function loadVocab() {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { words: saved.words || [], corrections: saved.corrections || {} };
  } catch {
    return structuredClone(DEFAULT_VOCAB);
  }
}

function save(v) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(v, null, 2));
}

/** Replace the editable word list (from the settings panel). */
export function setWords(words) {
  const v = loadVocab();
  v.words = [...new Set(words.map((w) => String(w).trim()).filter(Boolean))].slice(0, 400);
  save(v);
  return v;
}

/** Learn that `heard` was a mishearing of `meant`. */
export function learnCorrection(heard, meant) {
  const h = String(heard).trim().toLowerCase();
  const m = String(meant).trim();
  if (!h || !m || h === m.toLowerCase()) throw new Error('Need both the misheard words and what you meant.');
  const v = loadVocab();
  v.corrections[h] = m;
  if (!v.words.some((w) => w.toLowerCase() === m.toLowerCase()) && !/^[\d:.\s]+$/.test(m)) v.words.push(m);
  save(v);
  return v;
}

/**
 * Everything the recognizer should know, most important first:
 * project names, confirmed aliases' targets, your words, learned corrections.
 */
export function vocabularyTerms() {
  const v = loadVocab();
  const projects = listProjects().map((p) => p.name);
  const learned = Object.values(v.corrections).filter((m) => !/^[\d:.\s]+$/.test(m));
  const aliasTargets = Object.values(loadStore().aliases);
  const seen = new Set();
  return [...projects, ...aliasTargets, ...v.words, ...learned].filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Whisper's initial prompt: a short natural sentence listing expected words (≈200 tokens max). */
export function whisperPrompt(maxChars = 700) {
  let out = 'Glossary:';
  for (const t of vocabularyTerms()) {
    if (out.length + t.length + 2 > maxChars) break;
    out += ` ${t},`;
  }
  return out.replace(/,$/, '.');
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let dictionary = null;
export function isEnglishWord(w) {
  if (!dictionary) {
    try {
      dictionary = new Set(fs.readFileSync('/usr/share/dict/words', 'utf8').toLowerCase().split('\n'));
    } catch {
      dictionary = new Set();
    }
  }
  const x = w.toLowerCase();
  // The system word list has no plurals or verb forms, so try common stems too.
  return [x, x.replace(/s$/, ''), x.replace(/es$/, ''), x.replace(/ies$/, 'y'), x.replace(/ed$/, ''), x.replace(/ing$/, '')].some((f) => f && dictionary.has(f));
}

/**
 * Is it safe to swap this mishearing in everywhere? Multi-word phrases ("white soaps") and
 * non-words ("hoebroken") yes. Ordinary words ("money", "football") no: they're only
 * fixed by the context-aware correction step when the sentence fits.
 */
export function isSafeToAutoReplace(heard) {
  const words = heard.trim().split(/\s+/);
  return words.length > 1 || !isEnglishWord(words[0]);
}

/** Learned corrections split into instant ones and context-only hints. */
export function correctionSets() {
  const { corrections } = loadVocab();
  const instant = {};
  const hints = {};
  for (const [heard, meant] of Object.entries(corrections)) (isSafeToAutoReplace(heard) ? instant : hints)[heard] = meant;
  return { instant, hints };
}

/** Instant, rule-based pass: whole-word, case-insensitive replacement of safe learned corrections. */
export function applyCorrections(text) {
  const { instant } = correctionSets();
  const applied = [];
  let out = String(text);
  // Longest phrases first so "white soaps" wins over "soaps".
  for (const heard of Object.keys(instant).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escape(heard)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    if (re.test(out)) {
      out = out.replace(re, (_, pre) => pre + instant[heard]);
      applied.push({ heard, meant: instant[heard] });
    }
  }
  return { text: out, applied };
}
