// The companion: Echo's face in the window. A glass pearl with two small eyes and a rim of
// coloured light. The light is Echo's voice: it ripples out when it hears you, circles while it
// thinks and pulses as it speaks. The three bars (public/ui/mark.js, style.css .mark) stay as the
// logo; this is the character you talk to.
//
//   import { createCompanion } from '/ui/companion.js';
//   const face = createCompanion(el, { audio: () => analyserOrNull, level: () => numberOrNull, hit: button, onPress });
//   face.setState('speaking');        // 'idle' | 'listening' | 'thinking' | 'speaking' (as the mark had)
//   face.setNeeds(true);              // a confirmation card is waiting
//   face.moment('happy');             // 'happy' | 'proud' | 'celebrate' | 'content' | 'curious' | 'surprised' | 'sorry' | 'wave' | 'nod' | 'wink'
//   face.setWorking(true);            // Echo is doing something on the Mac: its eyes go along it
//   face.lookToward(someElement);     // a glance, then back to what it was doing
//   face.setCalm(true);               // Settings, Companion: no hops, no sparkles
//   face.setReduced('system');        // the reduce-motion setting: 'system' | 'on' | 'off'
//   face.setLook('auto');             // its body: 'auto' | 'glass' | 'moon' (Settings, Companion)
//
// The button over it (`hit`) is for talking and for playing. One click calls onPress at once (the
// page starts or stops listening). Two or more quick clicks are play: a happy squish, and five
// make it dizzy; the second click takes back what the first one did. Holding it and stroking it
// pets it, and never calls onPress.
//
// `el` holds one <canvas> that is larger than `el` itself (style.css .pearl), so the rings, the
// hop and the sparkles have room without moving anything around them. Every number eases towards
// a target, so moods blend into each other instead of cutting.
//
// With reduced motion (macOS, or the setting) nothing bobs, hops, shakes or ripples and the eyes
// keep still: the moods differ in the eyes and the light only, and it blinks slowly.
//
// The pure parts (which mood wins, each mood's targets, the easing step, blinking and glancing,
// the rings, the pointer, the pokes, clicks and petting, the body, the "sorry" lines) are exported
// for test/companion.test.js.
import { levelOf, follow } from './mark.js';

const TAU = Math.PI * 2;
const GRAD = ['#4780ff', '#a866ff', '#ff669e', '#ffb866'];
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export const MOODS = /** @type {const} */ (['idle', 'listening', 'thinking', 'working', 'speaking', 'happy', 'content', 'curious', 'surprised', 'needs', 'sorry', 'sleepy']);
/** The voice states app.js reports (the same four the mark had). */
export const STATES = /** @type {const} */ (['idle', 'listening', 'thinking', 'speaking']);
/** The class each voice state puts on the element: the strip turns into a card while Echo works (style.css). */
export const STATE_CLASS = { idle: '', listening: 'listen', thinking: 'think', speaking: 'speak' };

/** A moment: the mood it shows, for how many seconds, and what the body does as it starts. */
export const MOMENTS = {
  happy: { mood: 'happy', seconds: 2.6, lift: 60, squash: -0.2, sparks: 12 },
  // A lesson step passed: a pleased nod, no fireworks. The last step: the full celebration.
  proud: { mood: 'happy', seconds: 1.3, lift: 0, squash: 0.16, sparks: 0 },
  celebrate: { mood: 'happy', seconds: 3.2, lift: 78, squash: -0.26, sparks: 22 },
  surprised: { mood: 'surprised', seconds: 1.6, lift: 46, squash: -0.34, sparks: 0 },
  // Waking up: the same start, shorter, so whatever woke it shows right behind.
  wake: { mood: 'surprised', seconds: 0.7, lift: 30, squash: -0.3, sparks: 0 },
  sorry: { mood: 'sorry', seconds: 3, lift: 0, squash: 0.08, sparks: 0 },
  // You said yes to what it asked, or a small thing went right: it stands a little taller with
  // smiling eyes and one spark. No hop: this can happen many times in a minute.
  content: { mood: 'content', seconds: 2, lift: 0, squash: -0.08, sparks: 1 },
  // It has just asked you something: a tilt of the head, one eye a little bigger.
  curious: { mood: 'curious', seconds: 2.2, lift: 0, squash: -0.05, sparks: 0 },
};
/** How long a wink lasts, in seconds (one eye closes with a smile; whatever the mood). */
export const WINK_S = 0.7;
/** Thinking for this long, it concentrates: the eyes narrow and look further up. */
export const THINK_HARD_S = 6;

/** What the pearl is made of: smoky glass with a lit edge, or a white pearl with dark eyes. */
export const LOOKS = /** @type {const} */ (['glass', 'moon']);

/**
 * The body it wears for the "Companion look" setting. Glass and Moon are themselves. Anything else
 * is Auto: Moon when what is behind it is dark, Glass when it is light, so it always stands out.
 * @param {unknown} setting 'auto' | 'glass' | 'moon' @param {boolean} dark is the background dark?
 * @returns {typeof LOOKS[number]}
 */
export function lookFor(setting, dark) {
  if (setting === 'glass' || setting === 'moon') return setting;
  return dark ? 'moon' : 'glass';
}

/**
 * The body's outline: a circle that can grow a soft point towards angle `a` (p: 0 round, 1 a full
 * teardrop). The Mac app's companion draws the same shape when it points at things; in the window
 * it stays round.
 * @param {CanvasRenderingContext2D} ctx @param {number} R @param {number} p @param {number} a
 */
export function bodyPath(ctx, R, p, a) {
  ctx.beginPath();
  if (p < 0.02) { ctx.arc(0, 0, R, 0, TAU); return; }
  const tip = R * (1 + 0.72 * p), w = 1.2 - 0.25 * p, c = R * (1 + 0.1 * p);
  ctx.moveTo(Math.cos(a) * tip, Math.sin(a) * tip);
  ctx.quadraticCurveTo(Math.cos(a + 0.5) * c, Math.sin(a + 0.5) * c, Math.cos(a + w) * R, Math.sin(a + w) * R);
  ctx.arc(0, 0, R, a + w, a - w + TAU);
  ctx.quadraticCurveTo(Math.cos(a - 0.5) * c, Math.sin(a - 0.5) * c, Math.cos(a) * tip, Math.sin(a) * tip);
  ctx.closePath();
}

/** Asleep after this long with nothing happening. */
export const SLEEP_AFTER_S = 180;
/** The eyes follow the pointer when it is this close (CSS px from the pearl's edge). */
export const NEAR_PX = 300;
/** Five pokes within this long make it dizzy, for DIZZY_S seconds. */
export const DIZZY_POKES = 5;
export const DIZZY_WINDOW_S = 2;
export const DIZZY_S = 1.7;

/**
 * Which mood shows, from what is true on the page right now. A moment (it was startled, something
 * went right or wrong) wins while it lasts. Then what Echo's voice is doing. A waiting confirmation
 * beats "thinking": Echo is not working then, it is waiting for you. Sleep comes last.
 * @param {{ moment?: string, voice?: string, needs?: boolean, asleep?: boolean, attentive?: boolean, working?: boolean }} s
 *   moment: the mood of the moment still running ('' when none); voice: one of STATES; attentive:
 *   it has just woken and is all ears for a second; working: Echo is doing something on the Mac
 *   (it shows instead of "thinking" then: it isn't pondering, it is busy).
 * @returns {typeof MOODS[number]}
 */
export function moodFor(s) {
  if (s.moment && MOODS.includes(/** @type {any} */ (s.moment))) return /** @type {any} */ (s.moment);
  if (s.voice === 'speaking') return 'speaking';
  if (s.voice === 'listening') return 'listening';
  if (s.needs) return 'needs';
  if (s.voice === 'thinking') return s.working ? 'working' : 'thinking';
  if (s.working) return 'working';
  if (s.attentive) return 'listening';
  return s.asleep ? 'sleepy' : 'idle';
}

/**
 * Where each mood wants the face to be. open: how open the eyes are (1 is normal); happy: smiling
 * eyes; energy: how bright the rim is; dim: how far the light is turned down; tilt (radians),
 * brow, lean: the body; tall: standing taller; wide: the right eye bigger than the left; lx, ly:
 * where the eyes look (-1..1).
 * @param {string} mood
 * @param {{ level?: number, age?: number, t?: number, glance?: { x: number, y: number }, pointer?: { x: number, y: number } | null }} [c]
 *   level: the voice level 0..1; age: seconds in this mood; t: the clock, for the "needs" pulse;
 *   glance: where it is idly looking; pointer: where the pointer is, when it is near.
 */
export function moodTargets(mood, { level = 0, age = 0, t = 0, glance = { x: 0, y: 0 }, pointer = null } = {}) {
  const T = { open: 1, happy: 0, energy: 0.3, dim: 0, tilt: 0, brow: 0, lean: 0, tall: 0, wide: 0, lx: glance.x, ly: glance.y };
  if (mood === 'listening') Object.assign(T, { open: 1.22, energy: 0.55 + level * 0.5, lean: 1, lx: 0, ly: 0.1 });
  if (mood === 'thinking') Object.assign(T, age > THINK_HARD_S ? { open: 0.5, energy: 0.9, lx: 0.4, ly: -0.85 } : { open: 0.8, energy: 0.8, lx: 0.55, ly: -0.6 });
  // Busy on the Mac: the eyes go along what it is doing, side to side.
  if (mood === 'working') Object.assign(T, { open: 0.9, energy: 0.7, lx: Math.sin(t * 2.3) * 0.6, ly: 0.14 });
  if (mood === 'content') Object.assign(T, { happy: 1, energy: 0.75, tall: 1, lx: 0, ly: 0 });
  if (mood === 'curious') Object.assign(T, { open: 1.1, energy: 0.6, tilt: 0.24, wide: 1, lx: 0, ly: -0.05 });
  if (mood === 'speaking') Object.assign(T, { open: 0.92 - level * 0.2, happy: 0.35, energy: 0.6 + level * 0.6, lx: 0, ly: 0 });
  if (mood === 'happy') Object.assign(T, { happy: 1, energy: 1 });
  if (mood === 'surprised') Object.assign(T, { open: age < 0.7 ? 1.5 : 1.2, energy: 0.9, lx: 0, ly: -0.1 });
  if (mood === 'needs') Object.assign(T, { tilt: 0.2, brow: 1, energy: 0.7 + 0.3 * Math.sin(t * 4), lx: 0, ly: 0 });
  if (mood === 'sorry') Object.assign(T, { open: 0.6, dim: 0.6, energy: 0.12, lx: 0, ly: 0.75 });
  if (mood === 'sleepy') Object.assign(T, { open: 0.04, dim: 0.75, energy: 0.08, lx: 0, ly: 0.3 });
  // The pointer wins the eyes when it is near, in the moods that have eyes to spare.
  if (pointer && ['idle', 'listening', 'speaking', 'needs'].includes(mood)) { T.lx = pointer.x; T.ly = pointer.y; }
  return T;
}

/**
 * One step of easing `cur` towards `target`: the same curve whatever the frame rate.
 * @param {number} cur @param {number} target @param {number} rate per second (higher is quicker) @param {number} dt seconds
 */
export function easeStep(cur, target, rate, dt) {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/**
 * When the next blink comes: every two to six seconds, or every five to nine when it keeps still.
 * @param {number} t now, seconds @param {number} rnd 0..1 @param {boolean} [slow]
 */
export function nextBlinkAt(t, rnd, slow = false) {
  return t + (slow ? 5 + rnd * 4 : 2.2 + rnd * 3.5);
}

/**
 * The next idle glance: somewhere a little off centre, held for one and a half to four and a half seconds.
 * @param {number} t now, seconds @param {number} rx 0..1 @param {number} ry 0..1 @param {number} rt 0..1
 */
export function nextGlance(t, rx, ry, rt) {
  return { x: (rx - 0.5) * 1.1, y: (ry - 0.5) * 0.6, at: t + 1.5 + rt * 3 };
}

/**
 * Should a new echo ring leave the pearl? One each time your voice rises while it listens, and
 * never two on top of each other: the last one has to be on its way first.
 * @param {string} mood @param {number} level 0..1 @param {Array<{ r: number, a: number }>} rings
 */
export function ringDue(mood, level, rings) {
  if (mood !== 'listening' || !(level > 0.5)) return false;
  const last = rings[rings.length - 1];
  return !last || last.r > 1.35;
}

/**
 * The rings a moment later: each one wider and fainter; the ones that have faded are gone.
 * @param {Array<{ r: number, a: number }>} rings @param {number} dt seconds
 */
export function stepRings(rings, dt) {
  return rings.map((r) => ({ r: r.r + dt * 0.85, a: r.a - dt * 0.75 })).filter((r) => r.a > 0);
}

/**
 * Where the eyes look for a pointer at (px, py), with the pearl's centre at (cx, cy) and its
 * radius R: -1..1 each way, or null when the pointer is too far away to care about.
 * @param {number} px @param {number} py @param {number} cx @param {number} cy @param {number} R
 */
export function pointerLook(px, py, cx, cy, R, near = NEAR_PX) {
  const dx = px - cx, dy = py - cy;
  if (![dx, dy].every(Number.isFinite) || Math.hypot(dx, dy) > R + near) return null;
  // Full deflection a little way off the pearl, so it looks straight at you when you hover on it.
  const full = R + 90;
  return { x: clamp(dx / full, -1, 1), y: clamp(dy / full, -1, 1) };
}

/**
 * The pokes that still count, with this one added, and whether that makes it dizzy.
 * @param {number[]} pokes times of the recent pokes, seconds @param {number} t now, seconds
 */
export function pokeAt(pokes, t) {
  const recent = [...pokes.filter((p) => t - p < DIZZY_WINDOW_S), t];
  const dizzy = recent.length >= DIZZY_POKES;
  return { pokes: dizzy ? [] : recent, dizzy };
}

/** A second click this soon after the first makes the pair play, not "talk to me". */
export const CLICK_WAIT_MS = 280;
/** Petting: the pointer held down on it for longer than this, and moved at least this far. */
export const PET_HOLD_S = 0.5;
export const PET_MOVE_PX = 4;

/**
 * Tells a click that means "talk to me" from playing with it, without making a click wait. The
 * first click of a run calls `press` at once: the mic opens, or stops, the moment you click. If a
 * second click lands within `wait` it was play after all, so what the first one did is taken back
 * (`press` again: it starts or stops, so the second call undoes the first), and the rest of the
 * run calls nothing.
 * @param {() => void} press starts listening, or stops it
 * @param {{ wait?: number, now?: () => number }} [opts] wait: milliseconds; now: the clock, in milliseconds
 */
export function createClicks(press, { wait = CLICK_WAIT_MS, now = () => performance.now() } = {}) {
  let last = -Infinity;
  let acted = false; // this run's first click called press, and that has not been taken back
  return {
    click() {
      const t = now(), quick = t - last < wait;
      last = t;
      if (quick && !acted) return;
      acted = !quick;
      press();
    },
    /** Forget the run under way: the next click is a first click. */
    cancel() { last = -Infinity; acted = false; },
  };
}

/**
 * The least time between two pictures of it, in seconds (0: every frame the display gives).
 * Keeping still, or asleep, a few a second is plenty (a blink, a slow breath). The little ones in
 * Settings only show a look: about 20 a second. Resting (idle, with nothing playing) it only
 * breathes, blinks and glances: about 30 a second. Listening, thinking, speaking, a moment, a
 * poke or a pet get every frame.
 * @param {{ still?: boolean, preview?: boolean, mood?: string, age?: number, busy?: boolean }} s
 *   age: seconds in this mood; busy: something quick is playing (a hop, a squish, sparkles, rings, a pet)
 */
export function frameGap({ still = false, preview = false, mood = 'idle', age = 0, busy = false } = {}) {
  if (still) return 1 / 12;
  if (preview || (mood === 'sleepy' && age > 2)) return 1 / 20;
  return mood === 'idle' && !busy ? 1 / 30 : 0;
}

/**
 * Is it time for the next picture? `t`: this frame's time, `drawn`: the last picture's, seconds.
 * A display's frames never land exactly on the gap, so one that is within 3 ms of it counts
 * (else 30 a second would come out as 20 on a 60 Hz display).
 * @param {number} t @param {number} drawn @param {number} gap
 */
export const frameDue = (t, drawn, gap) => t - drawn >= gap - 0.003;

/**
 * Is this press a pet? Held for over half a second and stroked a little (a long, still press is
 * just a slow click).
 * @param {number} heldS seconds the pointer has been down @param {number} movedPx how far it has gone from where it went down
 */
export const isPetting = (heldS, movedPx) => heldS > PET_HOLD_S && movedPx >= PET_MOVE_PX;

/** @param {number} lastActive seconds @param {number} t now, seconds */
export const asleepAt = (lastActive, t) => t - lastActive >= SLEEP_AFTER_S;

/**
 * Does it keep still? The reduce-motion setting decides, and 'system' follows macOS.
 * @param {unknown} setting 'system' | 'on' | 'off' @param {boolean} system what macOS says
 */
export const keepsStill = (setting, system) => setting === 'on' || (setting !== 'off' && Boolean(system));

/**
 * Is this the first time Echo is opened today? (Then it waves.)
 * @param {unknown} lastDay what dayKey gave last time @param {Date} [now]
 */
export function firstToday(lastDay, now = new Date()) {
  return lastDay !== dayKey(now);
}
/** @param {Date} [now] the local day, as "2026-10-3" */
export const dayKey = (now = new Date()) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

/**
 * The short line for a sentence the server heard but did not pass on ({type:'dropped', reason}),
 * in the same voice as the listening engine's own drops (public/nativemic.js dropLine). '' for the
 * reasons you should not be told about: you did nothing wrong and nothing of yours was lost (too
 * faint to be meant for Echo, the same sentence arriving twice, Echo choosing to stay quiet).
 * The companion says its small "sorry" exactly when there is a line.
 * @param {unknown} reason
 */
export function sorryLine(reason) {
  switch (String(reason || '')) {
    case '': case 'faint': case 'heard_twice': case 'quiet': return '';
    case 'brief': return 'Too short to catch: say a little more';
    case 'no_speech': return 'I couldn’t make out any words';
    case 'not_for_echo': return 'Not sent: say “Echo” first if that was for me';
    default: return 'Didn’t catch that: nothing was sent';
  }
}

/**
 * @param {HTMLElement} el the .pearl element, holding one canvas
 * @param {{ audio?: () => AnalyserNode | null, level?: () => number | null, hit?: HTMLElement | null,
 *   onPress?: () => void, sleeps?: boolean, reducedMotion?: MediaQueryList | null }} [opts]
 *   audio / level: where the voice level comes from (an analyser, or the Mac app's mic over the
 *   bridge), exactly as the mark took them; hit: the button over the pearl, for talking and for
 *   play; onPress: one click on it, or Space / Enter (never a quick run of clicks, never a pet);
 *   sleeps: false for the little ones in Settings, which stay awake to show themselves.
 */
export function createCompanion(el, { audio = () => null, level = () => null, hit = null, onPress = () => {}, sleeps = true, reducedMotion = matchMedia('(prefers-reduced-motion: reduce)') } = {}) {
  const canvas = /** @type {HTMLCanvasElement} */ (el.querySelector('canvas'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const light = matchMedia('(prefers-color-scheme: light)');
  const clock = () => performance.now() / 1000;

  /** @type {typeof STATES[number]} */
  let state = 'idle';
  let needs = false;
  let working = false;
  let winkUntil = 0;
  let calm = false;
  let motionSetting = 'system';
  /** @type {unknown} the "Companion look" setting; draw() turns it into a body */
  let look = 'auto';
  const still = () => keepsStill(motionSetting, Boolean(reducedMotion?.matches));

  // The creature. Everything the drawing reads; step() eases it towards the mood's targets.
  const S = {
    mood: /** @type {string} */ ('idle'), since: 0, open: 1, happy: 0, lookX: 0, lookY: 0, squash: 0, tilt: 0, lift: 0, energy: 0.25, dim: 0, brow: 0, lean: 0,
    tall: 0, wide: 0, nod: 0, wink: 0, point: 0, aim: 0, blinkAt: 2, blink: 0, glance: { x: 0, y: 0, at: 3 }, level: 0, poke: 0, shake: 0, wave: 0, rest: 0, petX: 0, petY: 0,
    /** @type {Array<{ r: number, a: number }>} */ rings: [],
    /** @type {Array<{ a: number, r: number, v: number, life: number, spin: number, size: number }>} */ sparks: [],
  };
  /** @type {{ mood: string, until: number } | null} */
  let moment = null;
  /** @type {{ x: number, y: number } | null} */
  let pointer = null;
  /** @type {{ x: number, y: number, until: number } | null} */
  let gaze = null; // a glance it was asked for (the composer, the Workers tab)
  /** @type {number[]} */
  let pokes = [];
  /** @type {{ x: number, y: number, at: number } | null} */
  let held = null; // the pointer is down on it: where and when it went down
  /** @type {{ x: number, y: number } | null} */
  let pet = null; // it is being petted: which way the hand is (-1..1 each way)
  let petted = false; // this press became a pet, so the click that ends it is not "talk to me"
  let dizzyUntil = 0;
  let smileUntil = 0; // a happy blink: smiling eyes for a moment, whatever the mood
  let attentiveUntil = 0;
  let lastActive = clock();
  /** @type {Float32Array<ArrayBuffer> | null} */
  let buf = null;

  /** The loudest of the two sources right now, or null when there is none to follow. */
  function heard() {
    const node = audio();
    let a = null;
    if (node) {
      if (!buf || buf.length !== node.fftSize) buf = new Float32Array(node.fftSize);
      node.getFloatTimeDomainData(buf);
      a = levelOf(buf);
    }
    const n = level();
    if (a === null && n == null) return null;
    return Math.max(a ?? 0, clamp(Number(n) || 0, 0, 1));
  }

  /** Something happened: it stays awake, and if it was asleep it wakes with a start, all ears. */
  function touch() {
    const t = clock();
    lastActive = t;
    if (S.mood !== 'sleepy') return;
    begin('wake', t);
    attentiveUntil = t + MOMENTS.wake.seconds + 1.3;
  }

  /** @param {keyof typeof MOMENTS} name @param {number} t */
  function begin(name, t) {
    const m = MOMENTS[name];
    moment = { mood: m.mood, until: t + m.seconds };
    S.squash = m.squash;
    if (m.mood === 'sorry') S.shake = 1;
    if (still() || calm) return;
    S.lift = m.lift;
    sparkle(m.sparks);
  }
  function sparkle(n) {
    for (let i = 0; i < n; i++) S.sparks.push({ a: Math.random() * TAU, r: 1.05, v: 0.9 + Math.random() * 0.9, life: 1, spin: Math.random() * TAU, size: 0.05 + Math.random() * 0.06 });
  }

  /** @param {number} t @param {number} dt */
  function step(t, dt) {
    if (moment && t >= moment.until) moment = null;
    const quiet = still();
    const mood = t < dizzyUntil ? 'idle' : moodFor({ moment: moment?.mood, voice: state, needs, working, asleep: sleeps && asleepAt(lastActive, t), attentive: t < attentiveUntil });
    if (mood !== S.mood) {
      S.mood = mood;
      S.since = t;
      el.dataset.mood = mood;
    }
    // The voice: the real level when there is one. Echo's own voice with nothing to measure (the
    // browser's speech) gets a made-up one, so the rim still moves while it talks.
    let voice = mood === 'listening' || mood === 'speaking' ? heard() : 0;
    if (voice === null) voice = mood === 'speaking' ? clamp(Math.max(0, Math.sin(t * 7.3) * 0.5 + Math.sin(t * 12.1 + 1) * 0.3 + Math.sin(t * 3.1) * 0.35) * (0.6 + 0.4 * Math.sin(t * 1.7)), 0, 1) : 0;
    S.level = follow(S.level, voice, dt, 0.03, 0.12);

    if (gaze && t >= gaze.until) gaze = null;
    const T = moodTargets(mood, { level: S.level, age: t - S.since, t, glance: quiet ? { x: 0, y: 0 } : S.glance, pointer: quiet ? null : pointer });
    // A glance it was asked for wins over the pointer for its moment (never over sleep or sorry).
    if (gaze && !['sleepy', 'sorry', 'thinking'].includes(mood)) { T.lx = gaze.x; T.ly = gaze.y; }
    if (quiet) { T.tilt = 0; T.lean = 0; if (mood === 'working') T.lx = 0; }
    // Working keeps it awake: it never dozes off in the middle of a job.
    if (mood === 'working') lastActive = t;
    if (t < smileUntil && mood !== 'sleepy') T.happy = 1;
    // Being petted: eyes closed happily, whatever else is going on, and it does not doze off.
    if (pet) { T.happy = 1; lastActive = t; }
    for (const [k, target, rate] of /** @type {Array<[keyof typeof S & string, number, number]>} */ ([
      ['open', T.open, 12], ['happy', T.happy, 10], ['energy', T.energy, 6], ['dim', T.dim, 4], ['tilt', T.tilt, 6], ['brow', T.brow, 8], ['lean', T.lean, 6], ['tall', T.tall, 7], ['wide', T.wide, 9], ['nod', 0, 2.4], ['wink', t < winkUntil ? 1 : 0, 16],
      ['lookX', T.lx, 9], ['lookY', T.ly, 9], ['squash', 0, 7], ['lift', 0, 5], ['shake', 0, 3], ['poke', 0, 5], ['wave', 0, 1.6],
      ['rest', mood === 'sleepy' ? 1 : 0, 2], ['petX', pet?.x ?? 0, 8], ['petY', pet?.y ?? 0, 8],
    ])) /** @type {any} */ (S)[k] = easeStep(/** @type {any} */ (S)[k], target, rate, dt);
    if (quiet) S.squash = S.lift = S.shake = S.poke = S.wave = S.petX = S.petY = S.nod = 0;

    // Blinking and glancing happen by themselves.
    if (t > S.blinkAt) { S.blink = 1; S.blinkAt = nextBlinkAt(t, Math.random(), quiet); }
    S.blink = Math.max(0, S.blink - dt * 7);
    if (t > S.glance.at) S.glance = nextGlance(t, Math.random(), Math.random(), Math.random());

    if (!quiet && ringDue(mood, S.level, S.rings)) S.rings.push({ r: 1.02, a: 0.8 });
    S.rings = quiet ? [] : stepRings(S.rings, dt);
    for (const p of S.sparks) { p.r += p.v * dt; p.v *= 1 - dt * 1.6; p.life -= dt * 0.9; p.spin += dt * 3; }
    S.sparks = S.sparks.filter((p) => p.life > 0);
  }

  function star(x, y, r, rot) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = rot + (i * TAU) / 8, q = i % 2 ? r * 0.28 : r; ctx.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
    ctx.closePath();
    ctx.fill();
  }

  /** Draw the creature centred at (cx, cy) with radius R. small: fewer details, bolder eyes. */
  function draw(cx, cy, R, t) {
    const m = S.mood, quiet = still(), small = R < 26, day = light.matches;
    const skin = lookFor(look, !day);
    const dizzy = t < dizzyUntil ? Math.min(1, (dizzyUntil - t) * 3) : 0;
    const lively = !quiet && !calm;
    const breath = quiet ? 0 : Math.sin(t * (m === 'sleepy' ? 0.9 : 1.6)) * 0.018;
    const bounce = m === 'speaking' && lively ? -Math.abs(Math.sin(t * 5.2)) * R * 0.05 * (0.4 + S.level) : 0;
    const nudge = m === 'needs' && !quiet ? Math.sin(t * 9) * R * 0.02 * (Math.sin(t * 1.4) > 0.6 ? 1 : 0) : 0;
    const shakeX = Math.sin(t * 34) * R * 0.05 * S.shake + Math.sin(t * 7) * R * 0.05 * dizzy;
    // petted: it leans into the hand
    // a nod: two small dips of the head, dying away (it heard you)
    const nod = S.nod > 0.01 ? Math.max(0, Math.sin((1 - S.nod) * TAU * 2)) * R * 0.09 * S.nod : 0;
    const y = cy - S.lift * (R / 150) + bounce - S.lean * R * 0.05 + S.petY * R * 0.07 + nod - S.tall * R * 0.03, x = cx + nudge + shakeX + S.petX * R * 0.1;
    // (tall: it stands a little taller and narrower)
    const sq = S.squash + breath - S.poke * 0.18, sx = 1 - sq * 0.6 - S.tall * 0.03, sy = 1 + sq + S.tall * 0.06;
    const turn = quiet ? 0.6 : t * (m === 'thinking' ? 2.4 : m === 'working' ? 1.2 : 0.25);
    const conic = () => { const g = ctx.createConicGradient(turn, 0, 0); [0, 0.25, 0.5, 0.75, 1].forEach((p, i) => g.addColorStop(p, GRAD[i % 4])); return g; };

    // the floor's shadow (the large pearl only: the small one sits in a line of text)
    if (!small) {
      const lift = S.lift * (R / 150) / R;
      ctx.save();
      ctx.globalAlpha = (day ? 0.16 : 0.5) * (1 - Math.min(0.6, lift * 1.5));
      ctx.fillStyle = '#000';
      ctx.filter = `blur(${Math.max(1, R * 0.06)}px)`;
      ctx.beginPath();
      ctx.ellipse(cx, cy + R * 1.16, R * 0.72 * (1 - lift * 0.6), R * 0.075, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y);
    // the wave: a tilt one way and the other, dying away; dizzy: a slow sway
    ctx.rotate(S.tilt + Math.sin(t * 9) * 0.2 * S.wave + Math.sin(t * 5) * 0.1 * dizzy + S.petX * 0.2);
    // echo rings and a soft halo behind
    ctx.save();
    for (const r of S.rings) { ctx.globalAlpha = r.a * 0.8; ctx.strokeStyle = conic(); ctx.lineWidth = R * 0.03; ctx.beginPath(); ctx.arc(0, 0, R * r.r, 0, TAU); ctx.stroke(); }
    ctx.restore();
    const reach = small ? 1.45 : 1.7;
    const halo = ctx.createRadialGradient(0, 0, R * 0.8, 0, 0, R * reach);
    halo.addColorStop(0, `rgba(168,102,255,${(day ? 0.28 : 0.34) * S.energy * (1 - S.dim)})`);
    halo.addColorStop(1, 'rgba(168,102,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, R * reach, 0, TAU);
    ctx.fill();

    ctx.scale(sx, sy);
    // a soft light behind it, so it never disappears into a dark background
    if (skin !== 'moon') { ctx.save(); ctx.shadowColor = 'rgba(255,255,255,.5)'; ctx.shadowBlur = R * 0.3; ctx.fillStyle = '#000'; bodyPath(ctx, R * 0.98, S.point, S.aim); ctx.fill(); ctx.restore(); }
    // the body: smoky glass, or a white pearl
    let body;
    if (skin === 'moon') {
      body = ctx.createRadialGradient(-R * 0.3, -R * 0.4, R * 0.05, 0, 0, R * 1.05);
      body.addColorStop(0, '#ffffff'); body.addColorStop(0.6, '#dcdce6'); body.addColorStop(1, '#9a9aab');
    } else {
      body = ctx.createRadialGradient(-R * 0.35, -R * 0.45, R * 0.1, 0, 0, R * 1.05);
      body.addColorStop(0, '#5a5a66'); body.addColorStop(0.5, '#25252b'); body.addColorStop(1, '#0d0d10');
    }
    ctx.fillStyle = body;
    bodyPath(ctx, R, S.point, S.aim);
    ctx.fill();
    // asleep: its light rests inside it, a faint glow at the centre that slowly comes and goes
    if (S.rest > 0.02) {
      const pulse = quiet ? 0.5 : 0.5 + 0.5 * Math.sin(t * 1.1), a = S.rest * (0.3 + 0.3 * pulse) * (skin === 'moon' ? 1.2 : 1);
      const glow = ctx.createRadialGradient(0, R * 0.12, 0, 0, R * 0.12, R * (0.5 + 0.12 * pulse));
      glow.addColorStop(0, `rgba(255,150,190,${a})`); glow.addColorStop(0.45, `rgba(168,102,255,${a * 0.6})`); glow.addColorStop(1, 'rgba(168,102,255,0)');
      ctx.fillStyle = glow;
      bodyPath(ctx, R, S.point, S.aim);
      ctx.fill();
    }
    // the rim of light: a crescent at rest, a comet while thinking, a full ring when it hears or speaks
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = conic();
    ctx.shadowColor = '#a866ff';
    ctx.shadowBlur = R * 0.22 * S.energy;
    ctx.globalAlpha = Math.min(1, 0.35 + S.energy * 0.8) * (1 - S.dim * 0.7);
    ctx.lineWidth = R * ((small ? 0.07 : 0.035) + 0.05 * S.energy + (m === 'speaking' ? S.level * 0.05 : 0));
    const rr = R * (small ? 0.93 : 0.965);
    ctx.beginPath();
    if (m === 'thinking') { const a = quiet ? -1.9 : t * 3.2; ctx.arc(0, 0, rr, a, a + 1.9); }
    // working: two short lights opposite each other, going round steadily (a job in hand, not a thought)
    else if (m === 'working') { const a = quiet ? -1.2 : t * 1.7; ctx.arc(0, 0, rr, a, a + 1.05); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, rr, a + Math.PI, a + Math.PI + 1.05); }
    else if (m === 'content') ctx.arc(0, 0, rr, 0, TAU);
    else if (m === 'speaking' || m === 'happy' || m === 'listening') ctx.arc(0, 0, rr, 0, TAU);
    else { const span = 1.25 + S.energy * 0.9, mid = 0.9 + (quiet ? 0 : Math.sin(t * 0.5) * 0.25); ctx.arc(0, 0, rr, mid - span / 2, mid + span / 2); }
    ctx.stroke();
    ctx.restore();
    // glass: a soft light at the top, and a hairline edge
    const shine = ctx.createRadialGradient(-R * 0.3, -R * 0.62, 0, -R * 0.3, -R * 0.62, R * 0.7);
    shine.addColorStop(0, 'rgba(255,255,255,.2)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    bodyPath(ctx, R, S.point, S.aim);
    ctx.fill();
    ctx.strokeStyle = skin === 'moon' ? (day ? 'rgba(120,120,140,.55)' : 'rgba(255,255,255,.9)') : 'rgba(255,255,255,.42)';
    ctx.lineWidth = Math.max(1, R * 0.014);
    bodyPath(ctx, R - ctx.lineWidth / 2, S.point, S.aim);
    ctx.stroke();

    // the eyes
    const ex = R * 0.27, ey = -R * 0.06 + S.lookY * R * 0.15, ox = S.lookX * R * 0.19;
    const ew0 = R * (small ? 0.2 : 0.135), eh0 = R * (small ? 0.3 : 0.215) * Math.max(0.05, S.open * (1 - S.blink));
    const ink = skin === 'moon' ? '#0b0b0f' : '#ffffff';
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.lineCap = 'round';
    ctx.shadowColor = skin === 'moon' ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,.6)';
    ctx.shadowBlur = small ? 0 : R * 0.07;
    for (const side of [-1, 1]) {
      const px = side * ex + ox, py = ey;
      // curious: the right eye a little bigger, the left a little smaller
      const big = side === 1 ? 1 + S.wide * 0.34 : 1 - S.wide * 0.1;
      const ew = ew0 * big, eh = eh0 * big;
      if (side === -1 && S.wink > 0.5 && dizzy <= 0.05) { // a wink: this eye shut in a little arch
        ctx.lineWidth = ew * 0.7;
        ctx.beginPath();
        ctx.arc(px, py + ew * 0.45, ew * 0.9, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        continue;
      }
      if (dizzy > 0.05) { // dizzy: each eye is a little spiral, turning
        ctx.lineWidth = ew * 0.3;
        ctx.beginPath();
        for (let i = 0; i <= 26; i++) { const k = i / 26, a = k * TAU * 1.75 - t * 11 * side, q = ew * 1.15 * k; ctx.lineTo(px + Math.cos(a) * q, py + Math.sin(a) * q); }
        ctx.stroke();
      } else if (S.happy > 0.55) { // smiling eyes: little arches
        ctx.lineWidth = ew * 0.75;
        ctx.beginPath();
        ctx.arc(px, py + ew * 0.5, ew * 0.95, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
      } else if (eh < R * 0.04) { // closed
        ctx.lineWidth = ew * 0.5;
        ctx.beginPath();
        ctx.moveTo(px - ew * 0.8, py);
        ctx.lineTo(px + ew * 0.8, py);
        ctx.stroke();
      } else {
        const h = eh * (1 - S.happy * 0.35), w = ew;
        ctx.beginPath();
        ctx.roundRect(px - w / 2, py - h / 2, w, h, w / 2);
        ctx.fill();
        // a tiny glint, so the eyes look wet and alive
        if (!small && h > w) { ctx.save(); ctx.shadowBlur = 0; ctx.fillStyle = skin === 'moon' ? 'rgba(255,255,255,.85)' : 'rgba(20,20,30,.35)'; ctx.beginPath(); ctx.arc(px + w * 0.16, py - h * 0.22, w * 0.16, 0, TAU); ctx.fill(); ctx.restore(); }
      }
      // a raised brow when it needs you (one side only)
      if (S.brow > 0.05 && side === 1 && !small) {
        ctx.globalAlpha = S.brow;
        ctx.lineWidth = ew * 0.38;
        ctx.beginPath();
        ctx.moveTo(px - ew, py - eh * 0.5 - R * 0.14);
        ctx.lineTo(px + ew, py - eh * 0.5 - R * 0.2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.shadowBlur = 0;
    // asleep: a drifting z (it is outside the pearl, so it takes the page's ink)
    if (m === 'sleepy' && !small) {
      const k = quiet ? 0.3 : (t * 0.35) % 1;
      ctx.fillStyle = day ? '#0a0a0b' : '#f5f5f7';
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.font = `600 ${R * (0.16 + k * 0.1)}px -apple-system, system-ui`;
      ctx.fillText('z', R * (0.7 + k * 0.3), -R * (0.75 + k * 0.5));
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // sparkles fly out when something goes right
    ctx.save();
    ctx.translate(x, y);
    for (const p of S.sparks) { ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = GRAD[Math.floor(p.spin) % 4] || '#fff'; star(Math.cos(p.a) * R * p.r, Math.sin(p.a) * R * p.r, R * p.size * (small ? 1.6 : 1), p.spin); }
    ctx.restore();
  }

  /* --- the loop: only while there is something to see --- */
  let raf = 0;
  let last = 0;
  let drawn = 0;
  let onScreen = true;
  let size = { w: 0, h: 0, dpr: 0 };
  /** The canvas keeps one buffer pixel per screen pixel, whatever the display and the pearl's size. */
  function fit() {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
  }
  function frame(ms) {
    raf = 0;
    if (!running()) return;
    raf = requestAnimationFrame(frame);
    const t = ms / 1000;
    // Only as many pictures as what it is doing needs (frameGap): resting is not worth every frame.
    const busy = Boolean(pet) || t < dizzyUntil || S.sparks.length > 0 || S.rings.length > 0 || [S.lift, S.squash * 50, S.poke * 50, S.shake * 50, S.wave * 50].some((v) => Math.abs(v) > 0.5);
    if (!frameDue(t, drawn, frameGap({ still: still(), preview: !sleeps, mood: S.mood, age: t - S.since, busy }))) return;
    drawn = t;
    const dt = Math.min(0.1, last ? t - last : 0.016);
    last = t;
    step(t, dt);
    paint(t);
  }
  /** One picture of it as it is now. */
  function paint(t) {
    fit();
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const R = el.clientWidth / 2;
    if (R > 0) draw(size.w / 2, size.h / 2, R, t);
  }
  const running = () => !document.hidden && onScreen;
  function sync() {
    if (running()) { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } return; }
    cancelAnimationFrame(raf);
    raf = 0;
    // Paused (the window is in the background, or it scrolled away): it stays as a still picture,
    // never a blank space, and picks up from there when it's seen again.
    paint(performance.now() / 1000);
  }
  // Off screen (another tab of the window, Settings over it): no frames at all.
  const seen = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => { onScreen = entries[entries.length - 1].isIntersecting; sync(); }) : null;
  seen?.observe(el);
  document.addEventListener('visibilitychange', sync);
  // The first picture is drawn at once, whether or not the window can be seen yet.
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!raf) paint(performance.now() / 1000); }) : null;
  sized?.observe(el);
  queueMicrotask(sync);

  /* --- what it notices by itself: the pointer, a poke, any key or click (which wakes it) --- */
  const onMove = (/** @type {PointerEvent} */ e) => {
    const r = el.getBoundingClientRect();
    pointer = r.width ? pointerLook(e.clientX, e.clientY, r.left + r.width / 2, r.top + r.height / 2, r.width / 2) : null;
  };
  const onLeave = () => { pointer = null; };
  // The button over it. Every press down is a poke (the squish). A click means "talk to me" at
  // once, unless it ended a pet; a second quick click takes that back (createClicks).
  const clicks = createClicks(() => onPress());
  const onPoke = (/** @type {PointerEvent} */ e) => { api.poke(); held = { x: e.clientX, y: e.clientY, at: clock() }; petted = false; };
  const onStroke = (/** @type {PointerEvent} */ e) => {
    if (!held || !isPetting(clock() - held.at, Math.hypot(e.clientX - held.x, e.clientY - held.y))) return;
    const r = el.getBoundingClientRect(), R = r.width / 2 || 1;
    pet = { x: clamp((e.clientX - (r.left + R)) / R, -1, 1), y: clamp((e.clientY - (r.top + R)) / R, -1, 1) };
    petted = true;
  };
  const onRelease = () => { held = null; pet = null; };
  const onClick = (/** @type {MouseEvent} */ e) => {
    if (e.detail === 0) { clicks.cancel(); onPress(); return; } // the keyboard (Space, Enter): at once
    if (petted) { petted = false; return; }
    clicks.click();
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('keydown', touch, true);
  window.addEventListener('pointerdown', touch, true);
  hit?.addEventListener('pointerdown', onPoke);
  hit?.addEventListener('click', onClick);
  if (hit) {
    window.addEventListener('pointermove', onStroke, { passive: true });
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
  }

  const api = {
    /** @param {string} s one of STATES */
    setState(s) {
      if (!STATES.includes(/** @type {any} */ (s)) || s === state) return;
      state = /** @type {typeof STATES[number]} */ (s);
      el.classList.remove('listen', 'think', 'speak');
      if (STATE_CLASS[state]) el.classList.add(STATE_CLASS[state]);
      if (state !== 'idle') touch();
      else lastActive = clock();
    },
    get state() { return state; },
    get mood() { return S.mood; },
    /** A confirmation card is waiting for you (or no longer). @param {boolean} on */
    setNeeds(on) {
      if (Boolean(on) === needs) return;
      needs = Boolean(on);
      if (needs) touch();
    },
    /** Echo is doing something on the Mac (or no longer). @param {boolean} on */
    setWorking(on) {
      working = Boolean(on);
      if (working) touch();
    },
    /** Something just happened. @param {'happy' | 'proud' | 'celebrate' | 'content' | 'curious' | 'surprised' | 'sorry' | 'wave' | 'nod' | 'wink'} name */
    moment(name) {
      touch();
      const t = clock();
      if (name === 'wave') { smileUntil = t + 1.3; if (!still()) S.wave = 1; return; }
      // A nod (it heard you) and a wink (it put something right) ride on whatever mood it is in.
      if (name === 'nod') { if (!still()) S.nod = 1; return; }
      if (name === 'wink') { winkUntil = t + WINK_S; return; }
      if (Object.hasOwn(MOMENTS, name)) begin(name, t);
    },
    /** A glance towards something on the page, then back. @param {Element | null} target @param {number} [seconds] */
    lookToward(target, seconds = 1.1) {
      const a = target?.getBoundingClientRect(), b = el.getBoundingClientRect();
      if (!a || !a.width || !b.width) return;
      const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      gaze = { x: dx / d, y: dy / d, until: clock() + seconds };
    },
    /** A press on it: a happy squish. Five quick ones and it gets dizzy for a moment. */
    poke() {
      const t = clock();
      if (S.mood === 'sleepy' || t < dizzyUntil) return; // (waking is touch()'s job)
      S.poke = 1;
      smileUntil = t + 0.5;
      const p = pokeAt(pokes, t);
      pokes = p.pokes;
      if (p.dizzy && !still() && !calm) dizzyUntil = t + DIZZY_S;
      else if (!still() && !calm) sparkle(3);
    },
    /** Settings, Companion: calm keeps the eyes and the moods, without hops and sparkles. @param {boolean} on */
    setCalm(on) { calm = Boolean(on); if (calm) S.sparks = []; },
    /** The "Companion look" setting: 'glass', 'moon', or 'auto' (see lookFor). @param {unknown} setting */
    setLook(setting) { look = setting; },
    /** The reduce-motion setting ('system' follows macOS). @param {string} setting */
    setReduced(setting) { motionSetting = String(setting || 'system'); },
    destroy() {
      cancelAnimationFrame(raf);
      seen?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      sized?.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', touch, true);
      window.removeEventListener('pointerdown', touch, true);
      hit?.removeEventListener('pointerdown', onPoke);
      hit?.removeEventListener('click', onClick);
      window.removeEventListener('pointermove', onStroke);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
      clicks.cancel();
    },
  };
  el.dataset.mood = S.mood;
  sync();
  return api;
}
