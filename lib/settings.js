import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, setProjectsDir } from './config.js';
import { AUTO_LISTEN_DEFAULT_MS } from '../public/autolisten.js';
import { readJson, writeJson } from './atomic.js';

const FILE = path.join(config.dataDir, 'settings.json');

/** How much of Echo's friend persona shows (the text is in lib/persona.js). */
export const PERSONALITIES = {
  friendly: { label: 'Friendly' },
  balanced: { label: 'Balanced' },
  professional: { label: 'Professional' },
};

/** Personalities from before the Friendly/Balanced/Professional setting. */
const LEGACY_PERSONALITIES = { buddy: 'friendly', hype: 'friendly', chill: 'balanced', witty: 'friendly', pro: 'professional' };

/** A saved personality as one of PERSONALITIES (old ids carried over, anything else the default). */
function normalizePersonality(p) {
  if (Object.hasOwn(PERSONALITIES, p)) return p;
  return LEGACY_PERSONALITIES[p] || DEFAULTS.personality;
}

/** What a new user wants help with (asked in setup). Shapes suggestions and how Echo explains things. */
export const INTERESTS = {
  errands: 'Everyday errands',
  research: 'Questions and research',
  documents: 'Spreadsheets, Excel and documents',
  apps: 'Building apps and websites',
};

/** Speech recognition is locked to English; these are the accents you can pick. */
export const STT_LANGUAGES = ['en-IN', 'en-US', 'en'];

/**
 * The Mac's own region setting ("en_IN"), read once. Node's locale isn't it when the Mac app starts
 * the server: with no LANG set it is en-US wherever the Mac is.
 */
let macLocale = /** @type {string | undefined} */ (undefined);
function appleLocale() {
  if (macLocale === undefined) {
    macLocale = '';
    if (process.platform === 'darwin') {
      try {
        macLocale = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLocale'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {}
    }
  }
  return macLocale;
}

/**
 * The accent a fresh install starts with, from the Mac's region: India en-IN, the US en-US,
 * anywhere else plain English. Setup asks, and Settings can change it.
 * @param {{ mac?: string, locale?: string, lang?: string }} [o] mac: the Mac's region setting (AppleLocale)
 */
export function defaultAccent({ mac = appleLocale(), locale = Intl.DateTimeFormat().resolvedOptions().locale, lang = process.env.LANG || '' } = {}) {
  const region = (String(mac).match(/[-_]([A-Z]{2})\b/) || String(locale).match(/[-_]([A-Z]{2})\b/) || String(lang).match(/[-_]([A-Z]{2})\b/) || [])[1];
  return region === 'IN' ? 'en-IN' : region === 'US' ? 'en-US' : 'en';
}
/** What the accent defaulted to before October 2026: an install from then keeps it. */
const OLD_DEFAULT_ACCENT = 'en-IN';

/** What Settings (or the user, by voice) can change. Only these keys are read from, and written to, settings.json. */
const DEFAULTS = {
  assistantName: 'Echo',
  userName: '',
  personality: 'friendly', // friendly | balanced | professional (lib/persona.js)
  ttsProvider: 'kokoro', // kokoro | elevenlabs | cartesia | browser: set by the voice that is picked
  voice: 'af_heart',
  browserVoice: '', // the Mac's own voice, when that is the one picked (ttsProvider 'browser')
  speed: 1.05,
  sounds: true,
  // Speech recognition
  sttLanguage: defaultAccent(), // always English: en-IN (Indian accent) | en-US | en. Asked in setup; see sttLanguageFor() in stt.js.
  endSilenceMs: 1300, // hands-free: how long a pause ends your sentence (Settings offers PAUSE_CHOICES)
  wakeWord: true, // "Hey Echo" wakes her (public/wake.js); hands-free also only answers speech that says "Echo"
  // Setup and beginner mode. `onboarded` is false only on a fresh install until setup finishes;
  // an install from before setup existed has no value and never sees the wizard.
  onboarded: /** @type {boolean | undefined} */ (undefined),
  interests: /** @type {string[]} */ ([]), // keys of INTERESTS
  projectsDir: '', // where new projects and files go; '' = the default (see config.js)
  beginnerMode: false, // plain, non-technical explanations and suggestions (the fourth Personality choice)
  safeMode: false, // stricter approvals: deletes, installs, app control and sends always ask
  handsFree: false, // the window's hands-free switch, remembered per install
  listenMode: 'listening', // how Echo listens (lib/listenmode.js): listening | resting (its name only) | off (the mic is off)
  autoUpdate: false, // install new releases by themselves when nothing is running (lib/updater.js)
  pointer: true, // the companion orb that shows you where to click (Mac app; it never clicks by itself)
  companionLook: 'auto', // the companion's body: one of COMPANION_LOOKS (auto is Moon on a dark background, Glass on a light one)
  stepCaptions: true, // a few words beside the light saying what each step is (Mac app: macos/Sources/Pointer.swift)
  orbEyes: true, // the orb has eyes that blink and look where it's going (Mac app)
  companionLively: true, // Echo's face in the window hops and sparkles; false is calm: eyes and moods only (public/ui/companion.js)
  pttHotkey: 'ctrl-opt', // hold to talk from anywhere (Mac app): one of PTT_HOTKEYS
  // Computer use (lib/computer.js): Echo may click and type in other apps for you. Opt-in, off by default.
  computerUse: false,
  bargeIn: true, // talking over Echo stops her voice
  // Cost guard: a soft warning in the window when the assistant's own conversation costs more than
  // this many dollars in a day (lib/costs.js). 0 = never warn.
  dispatcherCostWarnUsd: 20,
  // The hard limit (0 = none): no new worker starts once the day's total (assistant and workers)
  // reaches dailyBudgetUsd.
  dailyBudgetUsd: 0,
  // Computer use: 'do' acts for you; 'show' ("show me how") points and narrates each step but
  // never clicks or types (lib/computer.js). Changed by voice ("show me how" / "just do it").
  driveMode: 'do',
  // Background operation: Echo acts through Accessibility and the page (no real mouse moves when it
  // can), and the orb shows where; your mouse stays yours.
  backgroundCursor: false,
  // Debug: keep the first few words of hands-free speech dropped as "not for Echo", for a week
  // (lib/droplog.js), so a wrong drop can be explained. Off: it writes down room talk.
  debugDroppedWords: false,
  // The conversation log (lib/transcript.ts): what was said and answered, word for word, kept on this Mac.
  // The caption under the menu bar (Mac app). Switched from Echo's menu bar menu (Show Caption).
  captionBar: true,
  keepTranscript: true,
  // A second listen by local Whisper to each sentence Apple's recognizer wrote (lib/secondlisten.js).
  secondListen: true,
  // Keep every voice clip on this Mac for 30 days, to measure how well Echo hears you
  // (lib/recordings.js). null: the default for this copy (on in the developer copy only).
  keepRecordings: null,
  // Feature flags for the core rebuild (lib/flags.ts): { session: true, … }. Empty: every flag at
  // its default.
  core: {},
};

/**
 * What used to be a setting and is now the same for everyone. The code that reads these still
 * finds them on getSettings(); a value saved in an old settings.json is ignored, and dropped the
 * next time settings are saved.
 */
const FIXED = {
  fallbackVoice: 'af_heart', // Kokoro speaks when the premium voice can't
  spokenAcks: false, // one short line before slow work only (lib/dispatcher.js PROGRESS_PROMPT)
  sttEngine: 'auto', // local Whisper when it is installed (lib/stt.js resolveEngine)
  livePreview: true, // your words show as you speak
  followUpSeconds: 45, // after her reply, this long to answer without saying "Echo" (lib/addressed.js)
  wakeSensitivity: 0.5, // how loose a match "Hey Echo" takes (lib/wake.js)
  autoListenMs: AUTO_LISTEN_DEFAULT_MS, // after Echo asks something, the mic opens this long for the answer (public/autolisten.js)
  listenDuringRuns: true, // while Echo drives the Mac, she keeps listening for "stop" and new instructions
  screenAware: true, // Echo may look at the screen when you ask; macOS's Screen Recording permission is the switch
  orbSize: 'medium', // the companion when it points (macos/Sources/Pointer.swift)
  reduceMotion: 'system', // the companion and caption pill keep still when macOS says so
  takeBack: 'pause', // a real click or key press while Echo drives stops only the current step (Escape ends the session)
  takeBackMovePx: 120, // mouse travel mid-step that counts as grabbing it
  nativeMic: true, // the Mac app's own mic (macos/Sources/NativeMic.swift) hears you whichever app is in front
  duckMedia: true, // the Mac's volume goes down while you talk in a driving session
  taskBudgetUsd: 0, // no limit on one worker task; the daily limit is the one that stops work
  fastModel: 'auto', // quick turns go to the fast model (fastModelId)
};

/** Tests only: other values for FIXED, held in memory and never saved (a test that needs "no quick model" or "no screen"). */
let fixedForTest = {};
/** @param {Partial<Record<keyof typeof FIXED, any>>} patch */
export function setFixedForTest(patch) {
  for (const k of Object.keys(patch)) if (!Object.hasOwn(FIXED, k)) throw new Error(`${k} is not a fixed setting`);
  fixedForTest = { ...fixedForTest, ...patch };
}
const fixed = () => ({ ...FIXED, ...fixedForTest });

/** "How long to wait when you pause" in Settings: the three pauses, as endSilenceMs. */
export const PAUSE_CHOICES = { short: 900, normal: 1300, long: 1900 };

/** The companion's two bodies, and Auto (public/ui/companion.js lookFor). */
export const COMPANION_LOOKS = { auto: 'Auto', glass: 'Glass', moon: 'Moon' };

/** Push-to-talk chords the Mac app can listen for (macos/Sources/PushToTalk.swift). */
export const PTT_HOTKEYS = {
  'ctrl-opt': 'Control + Option',
  'ctrl-cmd': 'Control + Command',
  'opt-cmd': 'Option + Command',
  'right-opt': 'Right Option',
  fn: 'Fn (Globe)',
  off: 'Off',
};

/** The fast model when settings.fastModel is 'auto'. */
export const DEFAULT_FAST_MODEL = 'claude-haiku-4-5';

/**
 * The model id for quick turns, or '' when fast routing is off.
 * @param {{ fastModel?: string }} s settings
 */
export function fastModelId(s) {
  const v = String(s?.fastModel || 'auto');
  if (v === 'off') return '';
  return v === 'auto' ? DEFAULT_FAST_MODEL : v;
}

/** The file as last read, and its modification time and size, so it's parsed again only when it changes. */
let cache = { key: '', saved: /** @type {Record<string, any>} */ ({}) };

/** What's saved in settings.json ({} if it's missing or unreadable), read again only when the file changed. */
function readSaved() {
  let key = 'missing';
  try {
    const st = fs.statSync(FILE);
    key = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {}
  if (key !== cache.key) {
    const saved = key === 'missing' ? {} : readJson(FILE, {});
    cache = { key, saved: saved && typeof saved === 'object' ? saved : {} };
  }
  return structuredClone(cache.saved);
}

/** Only the keys Settings still has: anything else in the file (a removed setting, a typo) is left out. */
function kept(obj) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (obj && Object.hasOwn(obj, k)) out[k] = obj[k];
  return out;
}

/** @returns {typeof DEFAULTS & typeof FIXED & Record<string, any>} */
export function getSettings() {
  const s = /** @type {typeof DEFAULTS & typeof FIXED & Record<string, any>} */ ({ ...DEFAULTS, ...kept(readSaved()), ...fixed() });
  // A look from before there were two bodies ('sunset') is Auto.
  if (!Object.hasOwn(COMPANION_LOOKS, s.companionLook)) s.companionLook = DEFAULTS.companionLook;
  // A hand-edited or old file must never switch recognition to another language.
  if (!STT_LANGUAGES.includes(s.sttLanguage)) s.sttLanguage = DEFAULTS.sttLanguage;
  s.personality = normalizePersonality(s.personality);
  return s;
}

/** @param {Record<string, any>} patch @returns {ReturnType<typeof getSettings>} */
export function saveSettings(patch) {
  const before = getSettings();
  const next = { ...kept(before), ...kept(patch) };
  // Flags merge (saving { core: { judge: true } } keeps the others) and stay plain booleans.
  next.core = cleanFlags({ ...(before.core || {}), ...(patch?.core || {}) });
  next.personality = normalizePersonality(next.personality);
  next.speed = Math.min(1.5, Math.max(0.7, Number(next.speed) || 1));
  next.endSilenceMs = Math.min(4000, Math.max(600, Number(next.endSilenceMs) || 1300));
  if (!STT_LANGUAGES.includes(next.sttLanguage)) next.sttLanguage = DEFAULTS.sttLanguage;
  next.interests = [...new Set((Array.isArray(next.interests) ? next.interests : []).filter((i) => Object.hasOwn(INTERESTS, i)))];
  next.projectsDir = typeof next.projectsDir === 'string' && path.isAbsolute(next.projectsDir) ? path.normalize(next.projectsDir) : '';
  for (const k of ['sounds', 'beginnerMode', 'safeMode', 'handsFree', 'autoUpdate', 'wakeWord', 'pointer', 'computerUse', 'bargeIn', 'backgroundCursor', 'debugDroppedWords', 'captionBar', 'keepTranscript', 'secondListen', 'orbEyes', 'companionLively', 'stepCaptions']) next[k] = Boolean(next[k]);
  next.keepRecordings = next.keepRecordings === null || next.keepRecordings === undefined ? null : Boolean(next.keepRecordings);
  if (!['do', 'show'].includes(next.driveMode)) next.driveMode = DEFAULTS.driveMode;
  if (!['listening', 'resting', 'off'].includes(next.listenMode)) next.listenMode = DEFAULTS.listenMode;
  if (!Object.hasOwn(COMPANION_LOOKS, next.companionLook)) next.companionLook = DEFAULTS.companionLook;
  if (!Object.hasOwn(PTT_HOTKEYS, next.pttHotkey)) next.pttHotkey = DEFAULTS.pttHotkey;
  next.userName = String(next.userName || '').trim().slice(0, 40);
  next.browserVoice = String(next.browserVoice || '').slice(0, 120);
  next.dispatcherCostWarnUsd = Math.min(1000, Math.max(0, Math.round((Number(next.dispatcherCostWarnUsd) || 0) * 100) / 100));
  next.dailyBudgetUsd = Math.min(5000, Math.max(0, Math.round((Number(next.dailyBudgetUsd) || 0) * 100) / 100));
  writeJson(FILE, next);
  if (next.projectsDir) setProjectsDir(next.projectsDir);
  return /** @type {ReturnType<typeof getSettings>} */ ({ ...next, ...fixed() });
}

/**
 * settings.core kept to short flag names with true/false values. lib/flags.ts ignores names it
 * doesn't know, so an old flag left here is harmless.
 * @param {unknown} core
 * @returns {Record<string, boolean>}
 */
export function cleanFlags(core) {
  /** @type {Record<string, boolean>} */
  const out = {};
  if (!core || typeof core !== 'object' || Array.isArray(core)) return out;
  for (const [k, v] of Object.entries(core).slice(0, 50)) if (/^[a-z][a-zA-Z0-9]{0,31}$/.test(k) && typeof v === 'boolean') out[k] = v;
  return out;
}

/** A fresh install (no settings yet) starts with the setup wizard. Returns true if it's one. */
export function markFirstRun() {
  if (fs.existsSync(FILE)) {
    keepOldDefaults();
    return false;
  }
  saveSettings({ onboarded: false });
  return true;
}

/** A default that changed keeps its old value on an install that never chose one. */
function keepOldDefaults() {
  const saved = readSaved();
  if (!Object.hasOwn(saved, 'sttLanguage')) saveSettings({ sttLanguage: OLD_DEFAULT_ACCENT });
}

/** Does the window need to show the setup wizard? */
export const needsOnboarding = () => getSettings().onboarded === false;
