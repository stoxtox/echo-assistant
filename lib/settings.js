import fs from 'node:fs';
import path from 'node:path';
import { config, setProjectsDir } from './config.js';

const FILE = path.join(config.dataDir, 'settings.json');

export const PERSONALITIES = {
  buddy: {
    label: 'Buddy',
    prompt: 'Warm, upbeat and a little playful, like a friend who happens to be a great engineer. React naturally ("Oh nice!", "Ooh, tricky one.", "Ugh, that build again?") and celebrate wins. Light humor is welcome; never cheesy or over the top.',
  },
  hype: {
    label: 'Hype',
    prompt: 'High energy and enthusiastic. Big reactions to wins ("Let\'s go!", "Boom, fixed!"), confident and motivating, fast-paced. Still concise: energy, not length.',
  },
  chill: {
    label: 'Chill',
    prompt: 'Relaxed and easygoing, calm voice, unhurried. Casual phrasing ("yeah, no worries", "all good"). Dry, gentle humor.',
  },
  witty: {
    label: 'Witty',
    prompt: 'Clever and quick with dry, playful wit, like a sharp sidekick. A quip now and then, especially about bugs and builds, but always get the information across first.',
  },
  pro: {
    label: 'Pro',
    prompt: 'Calm, crisp and professional, like an excellent chief of staff. Friendly but efficient. No jokes unless the user jokes first.',
  },
};

/** What a new user wants help with (asked in setup). Shapes suggestions and how Echo explains things. */
export const INTERESTS = {
  errands: 'Everyday errands',
  research: 'Questions and research',
  documents: 'Spreadsheets, Excel and documents',
  apps: 'Building apps and websites',
};

/** Speech recognition is locked to English; these are the accents you can pick. */
export const STT_LANGUAGES = ['en-IN', 'en-US', 'en'];

const DEFAULTS = {
  assistantName: 'Echo',
  userName: '',
  personality: 'buddy',
  ttsProvider: 'kokoro', // kokoro | elevenlabs | browser
  voice: 'af_heart',
  speed: 1.05,
  sounds: true,
  // Speech recognition
  sttEngine: 'auto', // auto (local Whisper if installed) | whisper | deepgram | browser
  sttLanguage: 'en-IN', // always English: en-IN (Indian accent) | en-US | en. See sttLanguageFor() in stt.js.
  smartCorrection: true, // fix likely mishearings with context before Echo acts
  endSilenceMs: 1300, // hands-free: how long a pause ends your sentence
  livePreview: true, // show words as you speak (browser recognition, display only)
  // Setup and beginner mode. `onboarded` is false only on a fresh install until setup finishes;
  // an install from before setup existed has no value and never sees the wizard.
  onboarded: /** @type {boolean | undefined} */ (undefined),
  interests: /** @type {string[]} */ ([]), // keys of INTERESTS
  projectsDir: '', // where new projects and files go; '' = the default (see config.js)
  beginnerMode: false, // plain, non-technical explanations and suggestions
  safeMode: false, // stricter approvals: deletes, installs, app control and sends always ask
  handsFree: false, // the window's hands-free switch, remembered per install
  autoUpdate: false, // install new releases by themselves when nothing is running (lib/updater.js)
};

export function getSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  const s = { ...DEFAULTS, ...saved };
  // A hand-edited or old file must never switch recognition to another language.
  if (!STT_LANGUAGES.includes(s.sttLanguage)) s.sttLanguage = DEFAULTS.sttLanguage;
  return s;
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  if (!PERSONALITIES[next.personality]) next.personality = DEFAULTS.personality;
  next.speed = Math.min(1.5, Math.max(0.7, Number(next.speed) || 1));
  next.endSilenceMs = Math.min(4000, Math.max(600, Number(next.endSilenceMs) || 1300));
  if (!['auto', 'whisper', 'deepgram', 'browser'].includes(next.sttEngine)) next.sttEngine = 'auto';
  if (!STT_LANGUAGES.includes(next.sttLanguage)) next.sttLanguage = DEFAULTS.sttLanguage;
  next.interests = [...new Set((Array.isArray(next.interests) ? next.interests : []).filter((i) => Object.hasOwn(INTERESTS, i)))];
  next.projectsDir = typeof next.projectsDir === 'string' && path.isAbsolute(next.projectsDir) ? path.normalize(next.projectsDir) : '';
  for (const k of ['beginnerMode', 'safeMode', 'handsFree', 'autoUpdate']) next[k] = Boolean(next[k]);
  next.userName = String(next.userName || '').trim().slice(0, 40);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  if (next.projectsDir) setProjectsDir(next.projectsDir);
  return next;
}

/** A fresh install (no settings yet) starts with the setup wizard. Returns true if it's one. */
export function markFirstRun() {
  if (fs.existsSync(FILE)) return false;
  saveSettings({ onboarded: false });
  return true;
}

/** Does the window need to show the setup wizard? */
export const needsOnboarding = () => getSettings().onboarded === false;
