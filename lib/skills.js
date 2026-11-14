// Per-app skills (Stage 7). When a job on the Mac is checked done (lib/agent/critic.js), the steps
// that worked are kept as an episode: the app, the goal, the steps. When a job like it (a goal about
// the same thing, in the same app) has worked twice, it becomes a skill: the shorter way, kept
// with its version. A session lists the skills by app (a line each) and gets a skill's steps when
// it's about to do that kind of job (skill_steps), so the second time is quicker than the first.
// Typing in a skill keeps where it typed, never what: that belongs to the job, not the skill.
// Settings lists them, each with a Remove button.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { readJson, writeJson } from './atomic.js';
import { sameThing, names } from './rules.js';

/** @typedef {{ at: string, app: string, goal: string, steps: string[] }} Episode */
/** @typedef {{ id: string, app: string, title: string, steps: string[], version: number, at: string, uses: number }} Skill */

/** A job like an earlier one this many times (the first time included) becomes a skill. */
export const PROMOTE_AFTER = 2;
const MAX_SKILLS = 80;
const MAX_STEPS = 40;
const episodesFile = () => path.join(config.dataDir, 'episodes.jsonl');
const skillsFile = () => path.join(config.dataDir, 'skills.json');

/** A step as a skill keeps it: what was typed becomes "(the text)". @param {string} step */
export function skillStep(step) {
  return String(step).replace(/^type “[^”]*”/, 'type (the text)').slice(0, 160);
}

/** @returns {Episode[]} */
function loadEpisodes() {
  try {
    return fs.readFileSync(episodesFile(), 'utf8').split('\n').flatMap((l) => {
      try {
        const e = JSON.parse(l);
        return e && typeof e.app === 'string' && Array.isArray(e.steps) ? [e] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/** @returns {Skill[]} */
export function loadSkills() {
  const s = readJson(skillsFile(), []);
  return Array.isArray(s) ? s.filter((x) => x && typeof x.id === 'string' && Array.isArray(x.steps)) : [];
}

/**
 * A job that was checked done: keep how, and make it a skill when it has worked before.
 * @param {{ app: string, goal: string, steps: string[], now?: Date }} o
 * @returns {{ episode: Episode, skill: Skill | null }}
 */
export function recordEpisode({ app, goal, steps, now = new Date() }) {
  const episode = { at: now.toISOString(), app: String(app).slice(0, 60), goal: String(goal).slice(0, 200), steps: steps.map(skillStep).slice(0, MAX_STEPS) };
  const like = loadEpisodes().filter((e) => e.app === episode.app && sameThing(e.goal, episode.goal) >= 0.6);
  fs.mkdirSync(path.dirname(episodesFile()), { recursive: true });
  fs.appendFileSync(episodesFile(), JSON.stringify(episode) + '\n');
  if (like.length + 1 < PROMOTE_AFTER || !episode.steps.length) return { episode, skill: null };
  const shortest = [...like, episode].filter((e) => e.steps.length).sort((a, b) => a.steps.length - b.steps.length)[0];
  const skills = loadSkills();
  const old = skills.find((s) => s.app === episode.app && sameThing(s.title, episode.goal) >= 0.6);
  const changed = !old || JSON.stringify(old.steps) !== JSON.stringify(shortest.steps);
  const skill = { id: old?.id || randomBytes(3).toString('hex'), app: episode.app, title: episode.goal, steps: shortest.steps, version: old ? old.version + (changed ? 1 : 0) : 1, at: now.toISOString(), uses: old?.uses || 0 };
  writeJson(skillsFile(), [...skills.filter((s) => s !== old), skill].slice(-MAX_SKILLS));
  return { episode, skill };
}

/** The skills as a short list for a session: titles by app, with ids for skill_steps. */
export function skillsText(skills = loadSkills()) {
  if (!skills.length) return '';
  const byApp = new Map();
  for (const s of skills.slice(-30)) byApp.set(s.app, [...(byApp.get(s.app) || []), `${s.title} (${s.id})`]);
  return ['Ways that worked before (skills): before a job like one of these, call skill_steps with its id and follow those steps, checking each one, rather than working it out again.', ...[...byApp.entries()].map(([app, list]) => `In ${app}: ${list.join('; ')}`)].join('\n');
}

/**
 * A skill's steps, by id or by the closest title (in an app, when given).
 * @param {string} q @param {string} [app]
 * @returns {Skill | null}
 */
export function findSkill(q, app) {
  const skills = loadSkills().filter((s) => !app || s.app.toLowerCase() === String(app).toLowerCase());
  const hit = skills.find((s) => s.id === q) || skills.map((s) => ({ s, score: names(s.title, q) })).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score)[0]?.s;
  if (!hit) return null;
  writeJson(skillsFile(), loadSkills().map((s) => (s.id === hit.id ? { ...s, uses: s.uses + 1 } : s)));
  return hit;
}

/** @param {string} id @returns {Skill | null} */
export function removeSkill(id) {
  const skills = loadSkills();
  const hit = skills.find((s) => s.id === id) || null;
  if (hit) writeJson(skillsFile(), skills.filter((s) => s !== hit));
  return hit;
}
