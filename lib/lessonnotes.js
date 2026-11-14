// How the last lesson in each app went, so the next one there can start with less help
// (RESEARCH.md 3.1 "fade", rule 20). One small note per app, in the data folder beside the rules
// and skills: how many steps, the middle rung of help they needed (lib/ladder.js), whether the
// user asked to be shown, and the date. A few numbers only, never what the lesson was about or
// anything that was said. A note is forgotten after 30 days, and "Reset Echo" clears them with the
// rest of the data folder.
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './atomic.js';

/** @typedef {{ app: string, steps: number, medianRung: number, shown: boolean, at: string }} LessonNote */

/** A note older than this says nothing about the user now. */
export const NOTE_DAYS = 30;
/** A lesson whose middle rung was this or lower (a hint in words, or less) went well. */
export const NOTE_EASY_RUNG = 2;
/** The next lesson in that app then begins this many steps one rung lower. */
export const NOTE_LOWER_STEPS = 2;
/** At most this many apps are remembered (the oldest go first). */
const MAX_NOTES = 40;

const file = () => path.join(config.dataDir, 'lesson-notes.json');
const key = (app) => String(app || '').trim().toLowerCase().slice(0, 80);
const fresh = (note, now) => now - Date.parse(note?.at) < NOTE_DAYS * 24 * 3600 * 1000;

/** The middle value of the rungs the steps ended on (the lower of the two middle ones). @param {number[]} rungs */
export function medianRung(rungs) {
  const sorted = [...rungs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
}

/**
 * Does the next lesson in that app begin with less help? Only when the last one there went well
 * (its middle rung was a hint in words or less) and wasn't long ago.
 * @param {Partial<LessonNote> | null | undefined} note @param {number} [now]
 */
export function startsLower(note, now = Date.now()) {
  return Boolean(note) && Number.isFinite(Number(note?.medianRung)) && Number(note?.medianRung) <= NOTE_EASY_RUNG && fresh(note, now);
}

/** The note for an app, or null (none, or too old). @param {string | undefined} app @param {number} [now] @returns {LessonNote | null} */
export function lessonNote(app, now = Date.now()) {
  const k = key(app);
  const list = /** @type {LessonNote[]} */ (readJson(file(), []));
  const note = k && Array.isArray(list) ? list.find((n) => n?.app === k) : null;
  return note && fresh(note, now) ? note : null;
}

/**
 * A lesson in an app ended: its note replaces the last one for that app.
 * @param {{ app?: string, steps: number, medianRung: number, shown: boolean }} n @param {number} [now]
 */
export function saveLessonNote({ app, steps, medianRung: rung, shown }, now = Date.now()) {
  const k = key(app);
  if (!k) return;
  const list = /** @type {LessonNote[]} */ (readJson(file(), []));
  const kept = (Array.isArray(list) ? list : []).filter((n) => n?.app !== k && fresh(n, now));
  writeJson(file(), [...kept, { app: k, steps: Number(steps) || 0, medianRung: Number(rung) || 0, shown: Boolean(shown), at: new Date(now).toISOString() }].slice(-MAX_NOTES));
}
