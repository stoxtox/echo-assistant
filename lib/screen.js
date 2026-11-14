// Screen awareness: Echo looks at your screen only when you ask, and can point at things on it.
//
// Private by default:
// - A look happens only when the assistant calls look_at_screen (because you asked something like
//   "what's this error?") or point_at needs to find a label. Nothing watches the screen otherwise.
// - The Mac app (macos/Sources/Screen.swift) captures one frame, reads it with Apple's on-device
//   text recognition, and blacks out secrets (password fields, API keys, card numbers) in the image
//   and the text before anything leaves the app. This file redacts the text again (belt and braces).
// - Screenshots stay in memory. The only file ever written is a short-lived copy for a coding
//   worker you asked to "fix the error on my screen"; it's deleted when that task ends, or after
//   30 minutes at the latest, and any leftovers are swept on start-up.
// - The log (data/screen-log.jsonl) only says that the screen was looked at or pointed at: never
//   what was on it.
// - In a plain browser (no Mac app), a look asks you to pick the screen to share and shows you the
//   picture before it's sent; the browser can't read text or black out secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { fromScreen } from './timeline.ts';

/** How long the Mac app may take over any request before the tool gives up. */
export const APP_TIMEOUT_MS = 20 * 1000;
/**
 * A look gets less, and one more try. The Mac app answers a look within about 4 s or says it
 * couldn't (Screen.swift), so 6 s of silence means it is stuck, not slow: on Oct 3 the first look
 * of a session sat for the full 20 s, and the next six took half a second each.
 */
export const LOOK_TIMEOUT_MS = 6 * 1000;
/**
 * Pointing, the lesson's state read and a wait get their own, shorter limits too. On Oct 3 a
 * `point` request sat for the full 20 s with no answer. The app finds a label and answers within
 * a second or two, and reads its state in well under one; a wait answers by its own time-out
 * (10 s when it names none, 15 s at most: Driver.swift), so 2 s past that it is stuck.
 */
export const POINT_TIMEOUT_MS = 6 * 1000;
export const STATE_TIMEOUT_MS = 4 * 1000;
/** Finding where a thing is for a hint (`locate`) reads no picture and moves nothing: a hint never waits longer than this for it. */
export const LOCATE_TIMEOUT_MS = 3 * 1000;
export const WAIT_GRACE_MS = 2 * 1000;
/**
 * How long the Mac app may take over this request (never more than `most`, the limit for any).
 * @param {string} kind @param {any} params @param {number} [most]
 */
export function appTimeoutMs(kind, params, most = APP_TIMEOUT_MS) {
  if (kind === 'point') return Math.min(most, POINT_TIMEOUT_MS);
  if (kind === 'state') return Math.min(most, STATE_TIMEOUT_MS);
  if (kind === 'locate') return Math.min(most, LOCATE_TIMEOUT_MS);
  if (kind === 'wait') {
    const own = Number(params?.timeoutMs);
    return Math.min(most, Math.min(15_000, Math.max(300, Number.isFinite(own) ? own : 10_000)) + WAIT_GRACE_MS);
  }
  return most;
}
/** A browser look waits for you to pick a screen and approve the picture. */
export const BROWSER_LOOK_TIMEOUT_MS = 90 * 1000;
/** The last look is kept in memory this long, so it can be handed to a worker. */
export const LAST_LOOK_TTL_MS = 10 * 60 * 1000;
/** A worker's copy of the screenshot is deleted after this long, even if the task is still running. */
export const WORKER_SHOT_TTL_MS = 30 * 60 * 1000;
export const MAX_SCREEN_TEXT = 20000;
export const MAX_SCREEN_IMAGE_BYTES = 6 * 1024 * 1024;

/** The folder for workers' temporary screenshots (outside Echo, the projects and the data folder). */
export const screenTmpDir = () =>
  process.env.ECHO_SCREEN_TMP_DIR || path.join(os.tmpdir(), `echo-screen-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`);

/* ---------- redaction ---------- */

const REDACTED = '[redacted]';

/** Luhn checksum, so ordinary long numbers (order ids, timestamps) aren't taken for card numbers. */
export function luhn(digits) {
  const d = String(digits).replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

// Keep in step with Redactor in macos/Sources/Screen.swift.
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, // Anthropic, OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi, // passwords inside URLs (postgres://user:pw@host)
];
// "password: hunter2", "API_KEY=abc123", "token = xyz": the label stays, the value goes.
const LABELLED = /\b(pass(?:word|wd|code)?|pwd|secret|client[_ -]?secret|token|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|access[_ -]?key|private[_ -]?key|auth(?:orization)?|pin|cvv|cvc|otp)(\s*[:=]\s*)(["']?)([^\s"',;]{3,})\3/gi;
// Long mixed-case letter-and-digit strings (most API keys), but not git hashes (lowercase hex).
const LONG_TOKEN = /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

/**
 * Black out secrets in text read off the screen.
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
export function redactText(text) {
  let count = 0;
  let out = String(text ?? '');
  const hit = (replacement) => (...args) => {
    count++;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  };
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, hit((m) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(m) ? m.replace(/:[^:@/]+@$/, `:${REDACTED}@`) : /^(Bearer|Basic)\s/i.test(m) ? `${m.split(/\s+/)[0]} ${REDACTED}` : REDACTED)));
  }
  out = out.replace(LABELLED, (m, label, sep, q, value) => {
    if (value === REDACTED || /^\[redacted\]/.test(value)) return m;
    count++;
    return `${label}${sep}${REDACTED}`;
  });
  out = out.replace(LONG_TOKEN, hit(REDACTED));
  out = out.replace(CARD, (m) => {
    if (!luhn(m)) return m;
    count++;
    return REDACTED;
  });
  return { text: out, count };
}

/* ---------- checking what the app sends back ---------- */

const IMAGE_MAGIC = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
};

/**
 * A look as the Mac app (or the browser fallback) sent it, checked and redacted.
 * @param {any} body
 */
export function cleanLook(body) {
  const b = body && typeof body === 'object' ? body : {};
  const source = b.source === 'browser' ? 'browser' : 'native';
  const raw = typeof b.text === 'string' ? b.text.slice(0, MAX_SCREEN_TEXT) : '';
  const red = redactText(raw);
  let image = null;
  if (typeof b.image === 'string' && b.image) {
    const mime = b.mime === 'image/png' ? 'image/png' : 'image/jpeg';
    const data = Buffer.from(b.image, 'base64');
    if (!data.length || data.length > MAX_SCREEN_IMAGE_BYTES) throw new Error('The screenshot is too large.');
    if (!IMAGE_MAGIC[mime](data)) throw new Error("The screenshot isn't a JPEG or PNG image.");
    image = { data, mime, width: Number(b.width) || 0, height: Number(b.height) || 0 };
  }
  const str = (v, n = 200) => (typeof v === 'string' ? redactText(v.slice(0, n)).text : '');
  return {
    source,
    text: red.text,
    image,
    app: str(b.app, 80),
    window: str(b.window, 200),
    // Secrets the app blacked out in the picture (and the text), plus any this file caught.
    redactions: Math.max(0, Number(b.redactions) || 0) + red.count,
    ocr: source === 'native',
    at: Date.now(),
  };
}

/* ---------- checking where the app pointed ---------- */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** A rectangle { x, y, width, height } of finite numbers with a real size, or null. */
export function cleanRect(r) {
  if (!r || typeof r !== 'object') return null;
  const { x, y, width, height } = r;
  if (![x, y, width, height].every(finite) || width < 1 || height < 1 || width > 1e5 || height > 1e5) return null;
  return { x, y, width, height };
}

/* ---------- where a found thing is, in words ---------- */

/** Which part of its window a found thing is in (macos/Sources/PointMath.swift PlaceMath.region). */
export const PLACES = ['top left', 'top', 'top right', 'left', 'middle', 'right', 'bottom left', 'bottom', 'bottom right'];
/** The named part of the window it sits in, and what kind of thing it is. */
export const CONTAINERS = ['toolbar', 'sidebar', 'menu bar', 'tab bar', 'dialog'];
export const TARGET_KINDS = ['button', 'menu', 'field', 'tab', 'checkbox', 'icon'];

/**
 * Where the app says a found thing is: `place`, `container` and `kind`, each only when it is one
 * of the words above. They are fixed words, never anything read off the screen, so anything else
 * the app sends in their place is dropped.
 * @param {any} body
 * @returns {{ place?: string, container?: string, kind?: string }}
 */
export function cleanPlace(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    ...(PLACES.includes(b.place) ? { place: b.place } : {}),
    ...(CONTAINERS.includes(b.container) ? { container: b.container } : {}),
    ...(TARGET_KINDS.includes(b.kind) ? { kind: b.kind } : {}),
  };
}

/**
 * Where it is, as people say it before they point: "in the toolbar at the top left", "on the
 * right", "in the sidebar". '' when the app didn't say.
 * @param {{ place?: string, container?: string, kind?: string } | null | undefined} where
 */
export function whereWords(where) {
  const { place, container } = cleanPlace(where);
  const at = !place ? '' : place === 'middle' ? 'in the middle' : place === 'left' || place === 'right' ? `on the ${place}` : `at the ${place}`;
  return [container ? `in the ${container}` : '', at].filter(Boolean).join(' ');
}

/**
 * The app's answer to a point request, checked. A "found" without a real on-screen position
 * (no frame, a zero or NaN one, or one off its screen) is not a point: pointed stays false, so
 * the assistant never says "it's here" while the pointer is somewhere else.
 * @param {any} body
 */
export function cleanPoint(body) {
  const b = body && typeof body === 'object' ? body : {};
  const s = (v, n) => (v ? String(v).slice(0, n) : undefined);
  const d = b.debug && typeof b.debug === 'object' ? b.debug : {};
  const frame = cleanRect(d.frame);
  const screenRect = cleanRect(d.screen);
  const debug = {
    method: s(d.method, 20),
    frame: frame || undefined,
    screen: screenRect ? { ...screenRect, index: finite(d.screen.index) ? d.screen.index : undefined, scale: finite(d.screen.scale) ? d.screen.scale : undefined } : undefined,
    visible: typeof d.visible === 'boolean' ? d.visible : undefined,
  };
  // With a route: which of its labels the light is resting on (0 is the first), as the app found it.
  const routeIndex = Number.isInteger(b.routeIndex) && b.routeIndex >= 0 && b.routeIndex < ROUTE_MAX ? b.routeIndex : undefined;
  const out = { ok: true, found: Boolean(b.found), via: s(b.via, 20), label: s(b.label, 120), role: s(b.role, 40), app: s(b.app, 80), message: s(b.message, 300), reason: s(b.reason, 40), ...(routeIndex !== undefined ? { routeIndex } : {}), ...cleanPlace(b), debug };
  if (!out.found) return out;
  const onScreen = frame && screenRect &&
    frame.x < screenRect.x + screenRect.width && frame.x + frame.width > screenRect.x &&
    frame.y < screenRect.y + screenRect.height && frame.y + frame.height > screenRect.y;
  if (!onScreen) {
    return { ...out, found: false, reason: frame ? 'off_screen' : 'no_frame', message: `Found "${out.label || 'it'}" but not a place on screen to point at, so the pointer didn't move. It may be scrolled out of view or hidden. (If this keeps happening, the Echo Mac app may need updating.)` };
  }
  // The light flew out for this request and the app will say when it lands (section 5 of the
  // protocol): the answer keeps the request's id, so words can be held for that arrival.
  if (b.light === true && typeof b.id === 'string') return { ...out, light: true, id: b.id.slice(0, 16) };
  return out;
}

/* ---------- the firefly: what a point or act request tells the light (docs/firefly-protocol.md) ---------- */

/** What the light is doing there: only pointing something out, about to act itself, or waiting for the user's OK. */
export const INTENTS = ['show', 'act', 'ask'];
/** The most a caption beside the light says (the app shows about 40 characters of it). */
export const CAPTION_MAX = 60;
/**
 * The caption beside the light for a step: one line, secrets blacked out, at most CAPTION_MAX
 * characters, and only if it has words in it. Anything else is no caption.
 * @param {unknown} say
 */
export function cleanCaption(say) {
  if (typeof say !== 'string') return '';
  const t = redactText(say.replace(/\s+/g, ' ').trim()).text.slice(0, CAPTION_MAX).trim();
  return /\p{L}/u.test(t) ? t : '';
}
/** Why a waiting or searching light is let go. */
export const OUTCOMES = ['done', 'skipped', 'stopped', 'not_found'];
/** A route through menus is at most this many labels, each this short. */
export const ROUTE_MAX = 6;
export const ROUTE_LABEL_MAX = 60;
export const ROUTE_RULE = `A route is 1 to ${ROUTE_MAX} labels in the order they are opened, each ${ROUTE_LABEL_MAX} characters or fewer, e.g. ["File", "Export", "PDF…"].`;

/**
 * The route through menus a point request may carry: the labels to open in order, the last one
 * being the target. Nothing given is no route; anything else that isn't a short list of short
 * labels is refused, never trimmed to fit (half a route would point at the wrong thing).
 * @param {unknown} v
 * @returns {{ route?: string[], error?: string }}
 */
export function cleanRoute(v) {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length)) return {};
  if (!Array.isArray(v) || v.length > ROUTE_MAX) return { error: ROUTE_RULE };
  const route = v.map((l) => (typeof l === 'string' ? l.replace(/\s+/g, ' ').trim() : ''));
  if (route.some((l) => !l || l.length > ROUTE_LABEL_MAX)) return { error: ROUTE_RULE };
  return { route };
}

/* ---------- the bridge between the assistant's tools and the app ---------- */

/** Request kinds for computer use and guide mode (lib/computer.js): "act" (resolve, then do), "wait", "observe" (controls with refs, lib/executor.js), "state" (read-only, for lessons: lib/teach.js uiAdapter), and "locate" (read-only: where a thing is, in words, for a lesson's hint; the light never moves). */
export const APP_KINDS = ['act', 'wait', 'observe', 'state', 'locate', 'local'];

/**
 * Requests go out to the Echo page(s) as { id, kind: 'look' | 'point', params }; the Mac app (or
 * the browser fallback) answers with deliver(id, body). Emits 'request', 'done' and 'log', and
 * 'firefly' (a waiting or searching light is let go: docs/firefly-protocol.md).
 */
export class ScreenBridge extends EventEmitter {
  /** @param {{ logFile?: string, timeoutMs?: number, lookTimeoutMs?: number, browserTimeoutMs?: number }} [opts] */
  constructor({ logFile = path.join(config.dataDir, 'screen-log.jsonl'), timeoutMs = APP_TIMEOUT_MS, lookTimeoutMs = Math.min(LOOK_TIMEOUT_MS, timeoutMs), browserTimeoutMs = BROWSER_LOOK_TIMEOUT_MS } = {}) {
    super();
    this.logFile = logFile;
    this.timeoutMs = timeoutMs;
    this.lookTimeoutMs = lookTimeoutMs;
    this.browserTimeoutMs = browserTimeoutMs;
    /** Which kinds of request the Mac app has ever answered, and when it last answered anything:
     * an app that answers others but never a newer kind is an older build, not a stuck one. */
    this.answeredKinds = new Set();
    this.lastAnswerAt = 0;
    /** @type {Map<string, { kind: string, resolve: Function, reject: Function, timer: any, started: number }>} */
    this.pending = new Map();
    /** Pages that can capture natively (the Mac app). Set by the server. */
    this.nativeClients = () => 0;
    /** @type {ReturnType<typeof cleanLook> | null} */
    this.last = null;
    this.lastTimer = null;
    /** @type {Map<number, string[]>} task id -> temporary screenshot files */
    this.workerShots = new Map();
  }

  get native() {
    return this.nativeClients() > 0;
  }

  /**
   * Ask the app to look or point. Resolves with the app's answer.
   * @param {'look' | 'point' | 'act' | 'wait' | 'observe' | 'state' | 'locate' | 'local'} kind
   * @param {object} [params]
   */
  request(kind, params = {}) {
    const id = randomBytes(8).toString('hex');
    const native = this.native;
    if (kind === 'point' && !native) return Promise.resolve({ found: false, error: 'no_app', message: 'Pointing needs the Echo Mac app. It isn\'t open right now.' });
    // Computer use and lessons (lib/computer.js) also need the Mac app.
    if (APP_KINDS.includes(kind) && !native) return Promise.resolve({ ok: false, found: false, error: 'no_app', message: 'That needs the Echo Mac app. It isn\'t open right now.' });
    // Every point and act request says what the light is doing there (its colour): whoever built
    // the request knows; one that didn't say is pointing (show) or acting (act).
    const lit = kind === 'point' || kind === 'act';
    if (lit && !INTENTS.includes(/** @type {any} */ (params).intent)) params = { ...params, intent: kind === 'point' ? 'show' : 'act' };
    // The few words shown beside the light (docs/firefly-protocol.md): one clean line or nothing.
    if (lit && 'caption' in params) {
      const { caption: said, ...rest } = /** @type {any} */ (params);
      const caption = cleanCaption(said);
      params = caption ? { ...rest, caption } : rest;
    }
    const look = kind === 'look' && native;
    const ms = look ? this.lookTimeoutMs : native ? appTimeoutMs(kind, params, this.timeoutMs) : this.browserTimeoutMs;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      // A look that gets no answer is asked once more (a late answer to the first try is ignored).
      const ask = (id, attempt) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          this.emit('done', { id, kind, timedOut: true });
          // Every time-out is logged: which kind of request and how long it waited, never what for.
          this.record('screen_timeout', { kind, reason: native ? 'no_answer' : 'not_shared', ms: Date.now() - started, attempt });
          if (look && attempt === 1) return ask(randomBytes(8).toString('hex'), 2);
          // The app may still be showing its searching light for this request: the search is over.
          if (lit) this.firefly(id, 'not_found');
          reject(new Error(look
            ? `The Mac app didn't answer in time (two tries, ${Math.round((Date.now() - started) / 1000)} seconds), so nothing was read from the screen: no text and no picture. Tell the user plainly that you couldn't see the screen just now, and don't guess what is on it.`
            : native ? "The Mac app didn't answer in time." : 'Nobody shared the screen in time.'));
        }, ms);
        this.pending.set(id, { kind, resolve, reject, timer, started });
        this.emit('request', { id, kind, params, native });
      };
      ask(id, 1);
    });
  }

  /**
   * The app's answer.
   * @param {string} id
   * @param {any} body
   * @returns {boolean} whether a request was waiting for it
   */
  deliver(id, body) {
    const p = this.pending.get(String(id));
    if (!p) return false;
    this.pending.delete(String(id));
    clearTimeout(p.timer);
    this.answeredKinds.add(p.kind);
    this.lastAnswerAt = Date.now();
    this.emit('done', { id, kind: p.kind });
    const b = body && typeof body === 'object' ? body : {};
    // Computer use and guide mode: lib/computer.js checks and logs these answers itself.
    if (APP_KINDS.includes(p.kind)) {
      p.resolve(b);
      return true;
    }
    if (b.ok === false) {
      // 'slow' is the Mac app giving up on its own deadline (Screen.swift): how long it took is logged too.
      this.record(p.kind === 'look' ? 'screen_look_failed' : 'point_failed', { source: b.source === 'browser' ? 'browser' : 'native', reason: String(b.error || 'failed').slice(0, 40), ...(b.error === 'slow' ? { ms: Date.now() - p.started } : {}) });
      p.resolve({ ok: false, error: String(b.error || 'failed').slice(0, 40), message: String(b.message || '').slice(0, 400) });
      return true;
    }
    if (p.kind === 'point') {
      const point = cleanPoint(b);
      this.record('pointed', { via: point.via || '', found: point.found, ...(point.reason ? { reason: point.reason } : {}) });
      p.resolve(point);
      return true;
    }
    try {
      const look = cleanLook(b);
      this.remember(look);
      // How long it took, and each half (taking the picture, reading it) when the Mac app says: numbers only.
      const ms = (/** @type {any} */ v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : undefined);
      this.record('screen_looked', { source: look.source, image: Boolean(look.image), redactions: look.redactions, ms: Date.now() - p.started, ...(ms(b.captureMs) ? { captureMs: ms(b.captureMs) } : {}), ...(ms(b.readMs) ? { readMs: ms(b.readMs) } : {}) });
      p.resolve({ ok: true, look });
    } catch (e) {
      this.record('screen_look_failed', { reason: 'bad_result' });
      p.resolve({ ok: false, error: 'bad_result', message: e.message });
    }
    return true;
  }

  /**
   * Let a light go: one waiting on a lesson step (its stepId) or a card (its confirm id), or one
   * still searching for a request the server gave up on (the request's id). Goes to the app the
   * way requests do; an id the app isn't holding is ignored there.
   * @param {string} release @param {'done' | 'skipped' | 'stopped' | 'not_found'} outcome
   */
  firefly(release, outcome) {
    if (!release || !OUTCOMES.includes(outcome)) return;
    this.emit('firefly', { release: String(release).slice(0, 40), outcome });
  }

  /**
   * A risky step is waiting for the user's OK: the light stays where the step's resolve put it,
   * in its asking colour, until `firefly(id, …)` lets it go (lib/computer.js askFirst).
   * @param {string} id the confirmation's id
   */
  fireflyAsk(id) {
    if (id) this.emit('firefly', { hold: String(id).slice(0, 40), intent: 'ask' });
  }

  /** Cancel a waiting request (the user said no in the browser card). */
  cancel(id, why = 'cancelled') {
    return this.deliver(id, { ok: false, error: why, message: why === 'declined' ? 'The user chose not to share their screen.' : '' });
  }

  /** Keep the last look in memory for a little while (never on disk), for handing to a worker. */
  remember(look) {
    this.last = look;
    clearTimeout(this.lastTimer);
    this.lastTimer = setTimeout(() => (this.last = null), LAST_LOOK_TTL_MS);
    this.lastTimer.unref?.();
  }

  /** The last look, if it's recent. */
  recentLook(maxAgeMs = LAST_LOOK_TTL_MS) {
    return this.last && Date.now() - this.last.at < maxAgeMs ? this.last : null;
  }

  /** Forget the last look now. */
  forget() {
    this.last = null;
    clearTimeout(this.lastTimer);
  }

  /** "screen looked at" events only: when, and how. Never what was on the screen. */
  record(event, extra = {}) {
    const entry = { at: new Date().toISOString(), event, ...extra };
    this.emit('log', entry);
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch {}
    fromScreen(entry); // and on the one timeline (lib/timeline.ts)
  }

  /* ---------- handing a look to a coding worker ---------- */

  /**
   * Save the recent look's (redacted) screenshot as a temporary file a worker can open, and
   * describe it for the worker's instructions. Call attachToTask() once the task exists.
   * @returns {{ file: string | null, note: string } | null} null if there's no recent look
   */
  workerContext() {
    const look = this.recentLook();
    if (!look) return null;
    let file = null;
    if (look.image) {
      const dir = screenTmpDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      file = path.join(dir, `screen-${Date.now()}-${randomBytes(4).toString('hex')}.${look.image.mime === 'image/png' ? 'png' : 'jpg'}`);
      fs.writeFileSync(file, look.image.data, { mode: 0o600 });
      const t = setTimeout(() => removeQuietly(file), WORKER_SHOT_TTL_MS);
      t.unref?.();
    }
    const where = [look.app && `the ${look.app} app`, look.window && `window "${look.window}"`].filter(Boolean).join(', ');
    const note = [
      `What the user had on screen when they asked${where ? ` (${where})` : ''}. Secrets were blacked out before you got it.`,
      file ? `Screenshot (temporary, read it with the Read tool; it is deleted when this task ends): ${file}` : '',
      look.text.trim() ? `Text read from the screen:\n"""\n${look.text.trim().slice(0, 6000)}\n"""` : '',
    ].filter(Boolean).join('\n');
    return { file, note };
  }

  /** Delete a task's temporary screenshots when it ends. */
  attachToTask(taskId, file) {
    if (!file) return;
    this.workerShots.set(taskId, [...(this.workerShots.get(taskId) || []), file]);
  }

  /** The task ended: its temporary screenshots go. */
  releaseTask(taskId) {
    for (const f of this.workerShots.get(taskId) || []) removeQuietly(f);
    this.workerShots.delete(taskId);
  }
}

const removeQuietly = (file) => {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
};

/** Is this path one of the workers' temporary screenshots? (Workers may read those.) */
export function isScreenShot(abs) {
  const rel = path.relative(screenTmpDir(), path.resolve(abs));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) && /^screen-[\w-]+\.(jpg|png)$/.test(rel);
}

/**
 * Delete leftover temporary screenshots (after a crash, or ones past their time).
 * @param {number} [maxAgeMs] 0 deletes them all
 */
export function sweepScreenShots(maxAgeMs = WORKER_SHOT_TTL_MS) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(screenTmpDir())) {
      const file = path.join(screenTmpDir(), f);
      const st = fs.statSync(file, { throwIfNoEntry: false });
      if (st?.isFile() && (maxAgeMs <= 0 || Date.now() - st.mtimeMs >= maxAgeMs)) {
        removeQuietly(file);
        removed++;
      }
    }
  } catch {}
  return removed;
}

/**
 * What a look tool call returns to the assistant: the text, and the picture when asked for.
 * @param {ReturnType<typeof cleanLook>} look
 * @param {{ includeImage?: boolean }} [opts]
 */
export function lookContent(look, { includeImage = false } = {}) {
  const head = [
    look.app ? `Frontmost app: ${look.app}${look.window ? ` (window "${look.window}")` : ''}.` : '',
    look.ocr ? 'Text read on this Mac from the screen (top to bottom):' : 'The browser shared a picture; there is no text reading in the browser.',
  ].filter(Boolean).join('\n');
  const body = look.text.trim() ? look.text.trim() : look.ocr ? '(no readable text on screen)' : '';
  const notes = [
    look.redactions ? `${look.redactions} secret${look.redactions === 1 ? ' was' : 's were'} blacked out (passwords, keys or card numbers). Don't guess them.` : '',
    look.image && !includeImage ? 'The screenshot is available: call look_at_screen again with include_image true if the text isn\'t enough.' : '',
    // Clicking or pointing at something found by eye ("the first video"): x/y are in this picture.
    look.image && includeImage && look.image.width ? `The picture is ${look.image.width}×${look.image.height} pixels. For click or point_at by x/y, give the target's center in these pixels (0,0 is the top left).` : '',
    'To give a coding worker this screen, pass attach_screen: true to start_task or follow_up.',
  ].filter(Boolean).join('\n');
  /** @type {any[]} */
  const content = [{ type: 'text', text: [head, body, notes].filter(Boolean).join('\n\n') }];
  if (includeImage && look.image) content.push({ type: 'image', data: look.image.data.toString('base64'), mimeType: look.image.mime });
  return { content };
}
