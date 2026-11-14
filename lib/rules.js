// Preferences as rules (Stage 7, "memory that ends re-explaining"). What the user tells Echo about
// how they always want things done ("never save unless I ask", "keep the footer at the bottom in
// XD", "stop opening new tabs") is kept as a rule: in their words, with when and how they said
// it, for every app or one app. Rules are in every session's instructions as things to follow
// every time, and Settings lists them, each with a Remove button. A new rule that says the same
// thing as an old one replaces it; one that says the opposite replaces it too (the newest wins).
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { readJson, writeJson } from './atomic.js';

/** @typedef {{ id: string, text: string, app?: string, at: string, said?: string }} Rule */

/** At most this many rules (the oldest go first). */
export const MAX_RULES = 60;

const file = () => path.join(config.dataDir, 'rules.json');
const STOP = new Set('a an the to and of in on for be is it i you me my this that with at are was do does please just so always never dont don\'t not no stop ever unless when only also'.split(' '));
/** A word's plain form, so "opening" is "open" and "tabs" is "tab". @param {string} w */
const stem = (w) => (w.length > 5 && w.endsWith('ing') ? w.slice(0, -3) : w.length > 4 && w.endsWith('ed') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const words = (s) => new Set((String(s).toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !STOP.has(w)).map(stem));
/** Says "don't / never / stop": the other way round from an "always / do" rule about the same thing. */
const negative = (s) => /\b(never|don'?t|do not|stop|no more|not)\b/i.test(s);

/**
 * How much two rules (or goals) are about the same thing, 0..1: the content words they share out
 * of all of theirs. One shared word is never much ("keep the footer at the bottom" and "keep the
 * header at the bottom" are two rules; "send the report to Sam" and "to Ria" two jobs).
 */
export function sameThing(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  const j = n / (A.size + B.size - n);
  return n >= 2 || (A.size === 1 && B.size === 1) ? j : Math.min(j, 0.3);
}

/**
 * How well a few words name a rule or a skill ("never save" for "Never save the file unless I
 * ask"): the words they share out of the shorter one's. For looking one up, not for telling two apart.
 */
export function names(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

/**
 * Rules Echo ships with: things the user told it that must hold from the first start, on any
 * Mac, with nothing written to the data folder. Each is a rule like any other: it is in every
 * session's instructions, Settings lists it, and the user can reword it or remove it (a removed
 * one leaves a note in the store, so it stays removed).
 * @type {Rule[]}
 */
export const BUILT_IN_RULES = [
  // Oct 6, 2026: Echo explained a long document by talking over it for several paragraphs.
  {
    id: 'show-when-explaining',
    text: 'When you explain something on my screen, show it: point at the part you mean and go one small piece at a time.',
    at: '2026-10-06T12:00:00.000Z',
    said: 'There are so many words on screen and you are explaining so many things. Next time show the thing as well, so people can learn better.',
  },
];

/** What the store holds: the user's rules, and a note ({ id, removed }) for each built-in rule they removed. @returns {any[]} */
function stored() {
  const r = readJson(file(), []);
  return Array.isArray(r) ? r.filter((x) => x && typeof x.id === 'string') : [];
}
/** Write the rules, keeping the notes of removed built-in rules. @param {Rule[]} rules @param {string} [removedId] */
function save(rules, removedId) {
  const gone = stored().filter((x) => x.removed === true && !rules.some((r) => r.id === x.id)).map((x) => ({ id: x.id, removed: true }));
  if (removedId && BUILT_IN_RULES.some((b) => b.id === removedId) && !gone.some((x) => x.id === removedId)) gone.push({ id: removedId, removed: true });
  writeJson(file(), [...gone, ...rules]);
}

/** The rules in force: the built-in ones the user hasn't reworded or removed, then the user's own. @returns {Rule[]} */
export function loadRules() {
  const all = stored();
  const mine = all.filter((x) => typeof x.text === 'string' && x.removed !== true);
  return [...BUILT_IN_RULES.filter((b) => !all.some((x) => x.id === b.id)), ...mine];
}

/**
 * Keep a rule. The same rule said again, or its opposite, replaces the old one.
 * @param {string} text the rule, in the user's words
 * @param {{ app?: string, said?: string, now?: Date }} [o] app: only in this app; said: what the user said
 * @returns {{ rule: Rule, replaced: Rule | null }}
 */
export function addRule(text, { app, said, now = new Date() } = {}) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!t) throw new Error('Say the rule.');
  const a = app ? String(app).trim().slice(0, 60) : undefined;
  const rules = loadRules();
  // The same rule again, or its opposite ("never save unless I ask", then "always save when you finish").
  const old = rules.find((r) => (r.app || '') === (a || '') && (sameThing(r.text, t) >= 0.6 || (negative(r.text) !== negative(t) && sameThing(r.text, t) >= 0.4)));
  const rule = { id: old?.id || randomBytes(4).toString('hex'), text: t, ...(a ? { app: a } : {}), at: now.toISOString(), ...(said ? { said: String(said).slice(0, 240) } : {}) };
  const next = [...rules.filter((r) => r !== old), rule].slice(-MAX_RULES);
  save(next);
  return { rule, replaced: old && (old.text !== t || negative(old.text) !== negative(t)) ? old : null };
}

/**
 * Drop a rule by its id, or the one that best matches the words given.
 * @param {string} idOrText
 * @returns {Rule | null} the rule dropped
 */
export function removeRule(idOrText) {
  const rules = loadRules();
  const q = String(idOrText || '').trim();
  let hit = rules.find((r) => r.id === q);
  if (!hit) {
    let best = 0;
    for (const r of rules) {
      const s = names(r.text, q);
      if (s > best) {
        best = s;
        hit = r;
      }
    }
    if (best < 0.5) hit = undefined;
  }
  if (!hit) return null;
  save(rules.filter((r) => r !== hit), hit.id);
  return hit;
}

/** The rules as instructions: general ones, then each app's. */
export function rulesText(rules = loadRules()) {
  if (!rules.length) return '';
  const general = rules.filter((r) => !r.app).map((r) => `- ${r.text}`);
  const byApp = new Map();
  for (const r of rules.filter((x) => x.app)) byApp.set(r.app, [...(byApp.get(r.app) || []), `- ${r.text}`]);
  return [
    "Rules the user gave you. Follow them every time, in every session, over your own defaults; if one gets in the way of what they're asking now, ask once:",
    ...general,
    ...[...byApp.entries()].flatMap(([app, lines]) => [`In ${app}:`, ...lines]),
  ].join('\n');
}
