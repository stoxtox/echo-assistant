// Custom vocabulary for speech recognition: words the recognizer should expect.
// Built from your project folders + words you asked Echo to remember + corrections Echo has learned.
//
// data/vocabulary.json:
//   { "words": ["Maya", "Hoboken", ...],          // "remember the word Hoboken" (add_vocabulary)
//     "corrections": { "hoe broken": "Hoboken" } }  // learned from "no, I meant X"
import { recentTerms } from './recentterms.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { listProjects, loadStore } from './projects.js';
import { getSettings } from './settings.js';
import { readJson, writeJson } from './atomic.js';

const file = () => path.join(config.dataDir, 'vocabulary.json');

// A fresh install starts with only the product's own names; everything personal is learned
// per install ("remember the word X", "no, I meant X") and saved in the data folder.
export const DEFAULT_VOCAB = {
  words: ['Echo', 'Claude'],
  corrections: {},
};

export function loadVocab() {
  const saved = readJson(file(), null);
  if (!saved || typeof saved !== 'object') return structuredClone(DEFAULT_VOCAB);
  return { words: saved.words || [], corrections: saved.corrections || {}, ...(Array.isArray(saved.retired) ? { retired: saved.retired } : {}) };
}

function save(v) {
  writeJson(file(), v);
}

/**
 * Corrections that were learned by mistake and are too broad to keep. Each is dropped once on
 * start-up (with the word it added to the list), then remembered in `retired`, so teaching it
 * again on purpose sticks.
 */
export const RETIRED_CORRECTIONS = [
  // "Hey Claude" was saved as a mishearing of "Hey Clicky", but the user says "Claude" all the time.
  { id: 'hey-claude-clicky', heard: 'hey claude', meant: 'Hey Clicky' },
];

/** Drop retired corrections from this install's vocabulary. Returns the ids dropped. */
export function dropRetiredCorrections() {
  const saved = readJson(file(), null);
  if (!saved || typeof saved !== 'object') return [];
  const done = new Set(Array.isArray(saved.retired) ? saved.retired : []);
  const dropped = [];
  for (const r of RETIRED_CORRECTIONS) {
    if (done.has(r.id)) continue;
    done.add(r.id);
    const meant = saved.corrections?.[r.heard];
    if (typeof meant !== 'string' || meant.toLowerCase() !== r.meant.toLowerCase()) continue;
    delete saved.corrections[r.heard];
    // learnCorrection added what it meant to the word list; that goes too.
    if (Array.isArray(saved.words)) saved.words = saved.words.filter((w) => String(w).toLowerCase() !== r.meant.toLowerCase());
    dropped.push(r.id);
  }
  saved.retired = [...done];
  save(saved);
  return dropped;
}

/** Replace the word list (the add_vocabulary tool adds to it: lib/tools/core.js). */
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
  // The newest correction wins: one saying the opposite ("meant" → "heard") would make every
  // mention flip back and forth, so it goes; so does any other rule rewriting "meant" itself.
  delete v.corrections[m.toLowerCase()];
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

let appCache = { at: -Infinity, dirs: '', names: /** @type {string[]} */ ([]) };
/**
 * The apps installed on this Mac ("Adobe XD", "Microsoft Excel", and "Adobe Illustrator" for
 * "Adobe Illustrator 2026"), so speech correction knows their names: on Oct 1 "Adobe XD" was heard
 * as "auto-biopsy" and "Adobe X team". Read from /Applications (and the folders suites put their
 * apps in), /System/Applications and ~/Applications; cached for ten minutes. ECHO_APP_DIRS
 * (colon-separated folders, or empty for none) replaces those.
 * @returns {string[]}
 */
export function installedAppNames() {
  const env = process.env.ECHO_APP_DIRS;
  const dirs = env !== undefined ? env.split(':').filter(Boolean) : ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
  const key = dirs.join(':');
  if (appCache.dirs === key && Date.now() - appCache.at < 10 * 60 * 1000) return appCache.names;
  const names = new Set();
  const add = (file) => {
    const name = path.basename(file, '.app').trim();
    if (!name || name.startsWith('.')) return;
    names.add(name);
    const plain = name.replace(/\s+(?:\d{4}|\d+(?:\.\d+)*)$/, '').trim();
    if (plain && plain !== name) names.add(plain);
  };
  for (const dir of dirs) {
    let list = [];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (e.name.endsWith('.app')) add(e.name);
      // Suites keep their apps one folder down: /Applications/Adobe XD/Adobe XD.app.
      else if (e.isDirectory() && !e.name.startsWith('.')) {
        try {
          for (const f of fs.readdirSync(path.join(dir, e.name))) if (f.endsWith('.app')) add(f);
        } catch {}
      }
    }
  }
  appCache = { at: Date.now(), dirs: key, names: [...names].slice(0, 400) };
  return appCache.names;
}

/**
 * Everything the recognizer should know, most important first:
 * project names, confirmed aliases' targets, your words, learned corrections, then installed apps.
 */
export function vocabularyTerms() {
  const v = loadVocab();
  const projects = listProjects().map((p) => p.name);
  const learned = Object.values(v.corrections).filter((m) => !/^[\d:.\s]+$/.test(m));
  const aliasTargets = Object.values(loadStore().aliases);
  // "Budget2" is said "Budget": both are expected words.
  const spoken = projects.map(spokenName);
  const seen = new Set();
  // First, what the conversation is about right now (lib/recentterms.js): the Mac app keeps only the first few hundred.
  return [...recentTerms.all(), ...projects, ...aliasTargets, ...spoken, ...v.words, ...learned, ...installedAppNames()].filter((t) => {
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
  // The names Echo has just been saying come first of all (so last in the prompt, nearest the audio), newest first.
  const ranked = [...recentTerms.names().reverse(), ...aliasTargets, ...projects, ...extra, ...learned, ...v.words];
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
