// The job journal (Stage 6): a job on the Mac with a goal (set_goal) is written down as it goes, so
// it survives the conversation's session being swapped for a fresh one and Echo restarting: the
// goal and its points, the app, how many steps, and the last few things done. A fresh session is
// told about it with the rest of what's still open (lib/rotation.js pendingLines); a restarted Echo
// loads it, so check_done still knows what done means. It's cleared when the job is checked done,
// replaced by a new goal, or two hours old.
import fs from 'node:fs';
import { readJson, writeJson } from '../atomic.js';

/** A job older than this is history, not something to carry on. */
export const JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
/** The last steps kept for "where it got to". */
const LAST = 5;

/** @typedef {{ goal: string, points: string[], app?: string, steps: number, last: string[], done?: string[], at: number, updatedAt: number }} Job */

/**
 * The job on file, if there is a recent one.
 * @param {string} file @param {number} [now]
 * @returns {Job | null}
 */
export function loadJob(file, now = Date.now()) {
  const j = readJson(file, null);
  if (!j || typeof j !== 'object' || typeof j.goal !== 'string' || !j.goal) return null;
  if (now - Number(j.updatedAt || j.at || 0) > JOB_MAX_AGE_MS) return null;
  return { goal: j.goal, points: Array.isArray(j.points) ? j.points.map(String) : [], app: j.app ? String(j.app) : undefined, steps: Number(j.steps) || 0, last: Array.isArray(j.last) ? j.last.map(String).slice(-LAST) : [], done: Array.isArray(j.done) ? j.done.map(String).slice(-60) : [], at: Number(j.at) || now, updatedAt: Number(j.updatedAt) || now };
}

/** @param {string} file @param {Job} job */
export function saveJob(file, job) {
  writeJson(file, job, { backup: false });
}

/** @param {string} file */
export function clearJob(file) {
  fs.rmSync(file, { force: true });
}

/**
 * One step done towards the job.
 * @param {Job} job @param {string} what e.g. 'click "Align Center"' @param {{ app?: string, now?: number }} [o]
 * @returns {Job}
 */
export function stepDone(job, what, { app, now = Date.now() } = {}) {
  // done: every step that worked, in order (the way it was done, for a skill: lib/skills.js).
  return { ...job, steps: job.steps + 1, last: [...job.last, what.slice(0, 100)].slice(-LAST), done: [...(job.done || []), what.slice(0, 160)].slice(-60), ...(app ? { app } : {}), updatedAt: now };
}

/** The job as a line for a fresh session (it carries over exactly). @param {Job} job */
export function jobLine(job) {
  const points = job.points.length ? ` Done when: ${job.points.join('; ')}.` : '';
  const last = job.last.length ? ` Last done: ${job.last.join(', ')}.` : '';
  return `- Unfinished job on the Mac${job.app ? ` in ${job.app}` : ''}: ${job.goal}.${points} ${job.steps} step${job.steps === 1 ? '' : 's'} so far.${last} If the user carries on with it, look at the screen first, then continue; check_done before saying it's done.`;
}
