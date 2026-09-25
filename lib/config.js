import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, '..');

// The port the everyday Echo runs on. Test and smoke-test copies use another port via VOICEOPS_PORT.
export const DEFAULT_PORT = 4777;

/** Where a new user's projects and files go unless they pick another folder in setup. */
export const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), 'Echo Projects');

/**
 * A shareable copy made by `npm run package` carries this marker. Its projects default to
 * ~/Echo Projects; a developer checkout keeps the old default (the folder Echo sits in).
 */
export const PACKAGED = fs.existsSync(path.join(APP_DIR, '.echo-package'));

const dataDir = process.env.VOICEOPS_DATA_DIR || path.join(APP_DIR, 'data');

/** The projects folder chosen in setup (saved in settings.json), if any. */
function savedProjectsDir() {
  try {
    const dir = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).projectsDir;
    return typeof dir === 'string' && path.isAbsolute(dir) ? dir : '';
  } catch {
    return '';
  }
}

const defaultRoots = () => [savedProjectsDir() || (PACKAGED ? DEFAULT_PROJECTS_DIR : path.resolve(APP_DIR, '..'))];
const roots = process.env.VOICEOPS_ROOTS ? process.env.VOICEOPS_ROOTS.split(':') : defaultRoots();
const researchFor = (root) => process.env.VOICEOPS_RESEARCH_DIR || path.join(root, '_research');

/** The Mac's own time zone, so a new install doesn't assume the original owner's. */
const systemTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  } catch {
    return 'America/New_York';
  }
};

export const config = {
  port: Number(process.env.VOICEOPS_PORT || DEFAULT_PORT),
  // Folders whose subfolders are treated as projects. Colon-separated to add more.
  roots,
  dataDir,
  logDir: process.env.VOICEOPS_LOG_DIR || path.join(APP_DIR, 'logs'),
  // Where research and personal tasks (job searches, movie lookups…) save their output.
  researchDir: researchFor(roots[0]),
  // Images attached in the chat. Inside the research folder, so workers can be handed them.
  attachmentsDir: process.env.VOICEOPS_ATTACHMENTS_DIR || path.join(researchFor(roots[0]), 'attachments'),
  // Self-improvement worktrees live outside the live folder.
  worktreeDir: process.env.VOICEOPS_WORKTREE_DIR || path.join(path.dirname(APP_DIR), '.voiceops-worktrees'),
  timezone: process.env.VOICEOPS_TZ || systemTimezone(),
  // Leave unset to use your Claude Code default model.
  dispatcherModel: process.env.VOICEOPS_DISPATCHER_MODEL || undefined,
  // Low effort keeps spoken replies snappy; workers keep full effort for real work.
  dispatcherEffort: /** @type {'low' | 'medium' | 'high' | 'xhigh' | 'max'} */ (process.env.VOICEOPS_DISPATCHER_EFFORT || 'low'),
  workerModel: process.env.VOICEOPS_WORKER_MODEL || undefined,
  maxConcurrentWorkers: Number(process.env.VOICEOPS_MAX_WORKERS || 4),
  selfUnlockMinutes: Number(process.env.VOICEOPS_SELF_UNLOCK_MINUTES || 30),
};

/**
 * Point Echo at the projects folder picked in setup (unless VOICEOPS_ROOTS pins it).
 * Research and attachments follow it unless their own env vars pin them.
 * @param {string} dir absolute path
 */
export function setProjectsDir(dir) {
  if (process.env.VOICEOPS_ROOTS || !dir) return;
  config.roots = [dir];
  config.researchDir = researchFor(dir);
  if (!process.env.VOICEOPS_ATTACHMENTS_DIR) config.attachmentsDir = path.join(config.researchDir, 'attachments');
}
