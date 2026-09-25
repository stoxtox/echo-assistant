// First-run setup (the wizard in the window) and "Reset Echo".
//
// Setup saves the person's name, what they want help with, where their projects live, their
// voice and hands-free choice, and a self-improve PIN. Someone who hasn't written code gets
// beginner mode (plain explanations) and safe mode (stricter approvals).
//
// Reset wipes everything personal this install has stored (settings, memory, conversations,
// contacts favorites, vocabulary, tasks, costs, logs, PIN, attachments) and leaves the app and the
// user's own project files alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, DEFAULT_PROJECTS_DIR, APP_DIR } from './config.js';
import { getSettings, saveSettings, INTERESTS, needsOnboarding } from './settings.js';
import { isInside } from './text.js';

/** "~/Echo Projects" -> "/Users/me/Echo Projects". Relative paths are taken from the home folder. */
export function expandHome(p, home = os.homedir()) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return path.isAbsolute(s) ? path.normalize(s) : path.join(home, s);
}

/**
 * Is this a sensible place for projects? Inside the home folder, not the home folder itself,
 * and not Echo's own folder or data.
 * @returns {string | null} why not, or null if fine
 */
export function projectsDirProblem(dir, home = os.homedir()) {
  if (!dir) return 'Pick a folder.';
  if (!isInside(dir, home) || dir === home) return 'Pick a folder inside your home folder, like "Echo Projects".';
  if (isInside(dir, APP_DIR) || isInside(APP_DIR, dir) || isInside(dir, config.dataDir)) return "That's Echo's own folder. Pick a different one.";
  if (['Library', 'Applications', '.Trash'].includes(path.relative(home, dir).split(path.sep)[0])) return 'Pick a folder for your own files, not a system folder.';
  return null;
}

/** What the window needs to show the wizard. */
export function onboardingState(selfImprove) {
  const s = getSettings();
  return {
    needed: needsOnboarding(),
    settings: s,
    interests: INTERESTS,
    hasPin: Boolean(selfImprove?.hasPin()),
    // A fresh install suggests ~/Echo Projects; VOICEOPS_ROOTS (a developer setup) wins.
    defaults: { projectsDir: s.projectsDir || (process.env.VOICEOPS_ROOTS ? config.roots[0] : DEFAULT_PROJECTS_DIR), home: os.homedir() },
  };
}

/**
 * Save one or more wizard answers. Every field is optional, so each step can save as it goes.
 * @param {{ userName?: string, assistantName?: string, interests?: string[], projectsDir?: string,
 *   developer?: boolean, beginnerMode?: boolean, safeMode?: boolean, ttsProvider?: string,
 *   voice?: string, speed?: number, handsFree?: boolean, sttLanguage?: string, pin?: string, finish?: boolean }} answers
 * @param {{ selfImprove?: { hasPin(): boolean, setPin(p: string, c?: string): void } | null, home?: string }} [opts]
 */
export function saveOnboarding(answers, { selfImprove = null, home = os.homedir() } = {}) {
  const patch = {};
  for (const k of ['userName', 'assistantName', 'interests', 'ttsProvider', 'voice', 'speed', 'handsFree', 'sttLanguage', 'beginnerMode', 'safeMode']) {
    if (answers[k] !== undefined) patch[k] = answers[k];
  }
  if (patch.assistantName !== undefined && !String(patch.assistantName).trim()) delete patch.assistantName;
  // Not a developer: explain things plainly and ask before anything risky.
  if (typeof answers.developer === 'boolean') {
    if (answers.beginnerMode === undefined) patch.beginnerMode = !answers.developer;
    if (answers.safeMode === undefined) patch.safeMode = !answers.developer;
  }
  let projectsDir = null;
  if (answers.projectsDir !== undefined) {
    projectsDir = expandHome(answers.projectsDir, home);
    const problem = projectsDirProblem(projectsDir, home);
    if (problem) throw new Error(problem);
    fs.mkdirSync(projectsDir, { recursive: true });
    patch.projectsDir = projectsDir;
  }
  if (answers.pin !== undefined && answers.pin !== '') {
    if (!selfImprove) throw new Error('Self-improve is not available.');
    // Setup only sets a first PIN; changing one needs the current PIN, in Settings.
    if (selfImprove.hasPin()) throw new Error('A PIN is already set. Change it in Settings.');
    selfImprove.setPin(String(answers.pin));
  }
  if (answers.finish) {
    patch.onboarded = true;
    // Finishing without having picked a folder still gives projects a home.
    if (!getSettings().projectsDir && !patch.projectsDir && !process.env.VOICEOPS_ROOTS) {
      fs.mkdirSync(DEFAULT_PROJECTS_DIR, { recursive: true });
      patch.projectsDir = DEFAULT_PROJECTS_DIR;
    }
  }
  const settings = saveSettings(patch);
  return { settings, projectsDir: settings.projectsDir || config.roots[0] };
}

/* ---------- Reset Echo ---------- */

/** Claude Code keeps its own copy of each conversation; these are the ones Echo started. */
export function echoSessionIds(dataDir = config.dataDir) {
  const ids = new Set();
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const state = read('state.json');
  if (state?.sessionId) ids.add(state.sessionId);
  for (const id of Object.keys(state?.costSeen || {})) ids.add(id);
  const tasks = read('tasks.json');
  for (const t of Array.isArray(tasks) ? tasks : tasks?.tasks || []) if (t?.sessionId) ids.add(t.sessionId);
  return [...ids].filter((id) => /^[\w-]{8,}$/.test(id));
}

/** Remove everything inside a folder, keeping the folder (and anything `keep` says to). */
function emptyDir(dir, keep = (name) => false) {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (keep(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/**
 * Wipe this install's personal data. The app, its packages and models, and the user's own
 * project folders stay.
 * @param {{ dataDir?: string, logDir?: string, attachmentsDir?: string, claudeDir?: string }} [dirs]
 */
export function wipePersonalData({
  dataDir = config.dataDir,
  logDir = config.logDir,
  attachmentsDir = config.attachmentsDir,
  claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
} = {}) {
  // Never wipe something that isn't clearly Echo's own data folder.
  for (const d of [dataDir, logDir]) {
    if (!d || d === os.homedir() || d === path.parse(d).root || isInside(APP_DIR, d)) throw new Error(`Refusing to wipe ${d}`);
  }
  const sessions = echoSessionIds(dataDir);
  let transcripts = 0;
  const projectsDir = path.join(claudeDir, 'projects');
  try {
    for (const folder of fs.readdirSync(projectsDir)) {
      for (const id of sessions) {
        const f = path.join(projectsDir, folder, `${id}.jsonl`);
        if (fs.existsSync(f)) {
          fs.rmSync(f, { force: true });
          fs.rmSync(path.join(projectsDir, folder, id), { recursive: true, force: true });
          transcripts++;
        }
      }
    }
  } catch {}
  return {
    data: emptyDir(dataDir),
    // The launcher's pid file isn't personal, and "stop Echo" needs it.
    logs: emptyDir(logDir, (name) => name.endsWith('.pid')),
    attachments: attachmentsDir && path.basename(attachmentsDir) === 'attachments' ? emptyDir(attachmentsDir) : 0,
    transcripts,
  };
}
