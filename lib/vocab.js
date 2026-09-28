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
import { getSettings } from './settings.js';

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

/** Names of saved contact favorites (their aliases and full names). */
export function favoriteNames() {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'contact-aliases.json'), 'utf8'));
    return Object.entries(all?.aliases || all || {}).flatMap(([alias, f]) => [alias, /** @type {any} */ (f)?.alias, /** @type {any} */ (f)?.name]).filter((t) => typeof t === 'string' && t.trim());
  } catch {
    return [];
  }
}

/** The user's own name and its parts ("Sam Lee" -> Sam Lee, Sam, Lee). */
export function ownNames() {
  const name = String(getSettings().userName || '').trim();
  return name ? [...new Set([name, ...name.split(/\s+/)])].filter((n) => n.length > 1) : [];
}

/** People the user talks about, spelled as saved (contacts' names, then the user's own). */
export function peopleNames() {
  return [...favoriteNames().filter((t) => /\p{Lu}/u.test(t)), ...ownNames().slice(0, 1)];
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
  // "Budget2" is said "Budget": both are expected words.
  const spoken = projects.map(spokenName);
  const seen = new Set();
  return [...projects, ...aliasTargets, ...spoken, ...v.words, ...learned].filter((t) => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * How a project's folder name is said out loud: "Budget2" -> "Budget", "Notes2.0" -> "Notes",
 * "Fit Track3" -> "Fit Track". The digits are a folder detail nobody speaks.
 */
export function spokenName(name) {
  return String(name).replace(/[\s_-]*v?\d+(?:\.\d+)*$/i, '').trim() || String(name);
}

/** Terms a recognizer already spells right on its own: every word is an ordinary English word. */
const ordinary = (t) => t.split(/[\s-]+/).every((w) => isEnglishWord(w.replace(/[^\p{L}]/gu, '')) && !/\p{Ll}\p{Lu}/u.test(w));

export const WHISPER_PROMPT_PREFIX = 'Glossary:';

/**
 * Whisper's initial prompt: the unusual names you say, spelled right.
 * Measured on Indian-English clips (scripts/stt-bench.js): a long list helps Whisper far less than
 * a short one (whisper.cpp keeps only the last ~220 tokens, and a long list dilutes the bias), so
 * this keeps to the names that need it: no ordinary English words, no folder digits, and never an
 * alias (those are mishearings). The most important names go last, nearest the audio: projects,
 * most recently worked on last.
 * @param {{ maxChars?: number, extra?: string[] }} [opts] extra: people's names (default: contacts, your own name)
 */
export function whisperPrompt({ maxChars = 320, extra = peopleNames() } = {}) {
  const v = loadVocab();
  const projects = listProjects().map((p) => spokenName(p.name));
  const learned = Object.values(v.corrections).filter((m) => !/^[\d:.\s]+$/.test(m)).map(spokenName);
  const aliasTargets = Object.values(loadStore().aliases).map(spokenName);
  // Most important first here; the prompt is written in reverse so they end up last.
  const ranked = [...aliasTargets, ...projects, ...extra, ...learned, ...v.words];
  const seen = new Set();
  const picked = [];
  let length = WHISPER_PROMPT_PREFIX.length + 1;
  for (const raw of ranked) {
    const t = String(raw).trim();
    const k = t.toLowerCase();
    // Latin-script names only: the prompt is English, and another script can pull Whisper out of it.
    if (!t || seen.has(k) || ordinary(t) || /[^\p{Script=Latin}\p{N}\s.'&+-]/u.test(t)) continue;
    seen.add(k);
    if (length + t.length + 2 > maxChars) continue;
    length += t.length + 2;
    picked.push(t);
  }
  return picked.length ? `${WHISPER_PROMPT_PREFIX} ${picked.reverse().join(', ')}.` : '';
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
