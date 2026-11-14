// The floating caption bar (Mac app: macos/Sources/Caption.swift). While Echo drives, or her
// window is hidden or behind other apps, a small bar at the bottom of the screen shows what you're
// saying (the live listener's words), what Echo is saying, and a tiny status ("Listening…",
// "Driving: Chrome", "Waiting for you to confirm"). It floats over full-screen apps too, so you can
// follow along without the Echo window.
//
// This file only decides what the bar says and when the page tells the app; the app decides where
// it goes and whether the Echo window is in front. Pure (no DOM), so test/caption.test.js runs it.

/** The longest line the bar shows, per side. */
export const CAPTION_MAX_CHARS = 160;

/**
 * How long the pill offers its reply field after Echo ends a reply with a question (you might be
 * in another app, or unable to talk): then it closes back to the orb if you didn't answer.
 */
export const CAPTION_ASK_MS = 120000;

/**
 * While the page wants the pill shown, it says so again this often. The app forgets what the page
 * said after about 10 s without hearing from it (Caption.swift), so a page that reloaded, crashed
 * or lost its server can never leave the pill stuck on screen.
 */
export const CAPTION_BEAT_MS = 4000;

/**
 * The bar's status line.
 * @param {{ driving?: boolean, app?: string, waitingForConfirm?: boolean, hearing?: boolean,
 *   listening?: boolean, speaking?: boolean, busy?: boolean, windowLabel?: string }} s
 *   windowLabel: the conversation window, when it's open ("Listening · 6 s", "Talk mode · just talk")
 */
export function captionStatus(s) {
  if (s.waitingForConfirm) return 'Waiting for you to confirm';
  if (s.hearing) return 'Hearing you…';
  if (s.windowLabel && !s.speaking && !s.busy) return s.windowLabel;
  if (s.speaking) return s.driving && s.app ? `Driving: ${s.app}` : 'Speaking…';
  if (s.busy) return s.driving && s.app ? `Driving: ${s.app}` : 'Thinking…';
  if (s.listening) return s.driving ? 'Listening… say “stop” anytime' : 'Listening…';
  if (s.driving) return s.app ? `Driving: ${s.app}` : 'Driving';
  return '';
}

/**
 * What's going on, for the pill: 'hearing' | 'speaking' | 'thinking' | 'listening' | ''.
 * @param {{ hearing?: boolean, listening?: boolean, speaking?: boolean, busy?: boolean }} s
 */
export function captionMode(s) {
  if (s.hearing) return 'hearing';
  if (s.speaking) return 'speaking';
  if (s.busy) return 'thinking';
  if (s.listening) return 'listening';
  return '';
}

/**
 * When each word of Echo's line is said, for the pill: `at` is the wall clock (ms) when the
 * audio starts, `starts` each word's start in ms from then. From the voice's own word timings
 * (seconds from the start), or null when there are none.
 * @param {Array<{ s: number }> | null | undefined} times @param {number} at
 */
export function captionTimes(times, at) {
  if (!Array.isArray(times) || !times.length || !Number.isFinite(at)) return null;
  return { at: Math.round(at), starts: times.map((t) => Math.max(0, Math.round((Number(t.s) || 0) * 1000))) };
}

/** The end of a long line (the newest words are what matter), on one line. */
export function captionLine(text, max = CAPTION_MAX_CHARS) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return '…' + t.slice(t.length - max + 1).replace(/^\S*\s/, '');
}

/**
 * Keeps the bar's state and posts it to the app when it changes (at most every `throttleMs`).
 * @param {{ post: (msg: object) => void, enabled?: () => boolean, throttleMs?: number, askMs?: number, beatMs?: number,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void, now?: () => number }} o
 */
export function createCaptionFeed({ post, enabled = () => true, throttleMs = 120, askMs = CAPTION_ASK_MS, beatMs = CAPTION_BEAT_MS, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), now = Date.now }) {
  /** @type {{ driving: boolean, app: string, waitingForConfirm: boolean, question: string, hearing: boolean, listening: boolean, speaking: boolean, busy: boolean, user: string, echo: string, echoTimes: { at: number, starts: number[] } | null, asks: boolean, windowLabel: string, chips: string }} */
  const state = { chips: '', driving: false, app: '', waitingForConfirm: false, question: '', hearing: false, listening: false, speaking: false, busy: false, user: '', echo: '', echoTimes: null, asks: false, windowLabel: '' };
  let last = '';
  let lastAt = 0;
  let timer = null;
  let askTimer = null;
  /** @type {any} */
  let beatTimer = null;

  function message() {
    const on = enabled();
    // Something is really happening (not just the conversation window being open).
    const busy = state.driving || state.hearing || state.speaking || state.busy || state.waitingForConfirm || state.asks;
    return {
      type: 'caption',
      enabled: on,
      driving: state.driving,
      // Something is going on (the app shows the bar then if Echo's window isn't in front).
      active: busy || Boolean(state.windowLabel),
      // Only the open conversation window (talk mode) keeps it up: the app lets the pill leave
      // after a few seconds with nothing new, instead of pinning it for as long as talk mode is on.
      quiet: !busy && Boolean(state.windowLabel),
      status: captionStatus(state),
      // Which line the pill leads with (your words while you talk, Echo's while she speaks), and
      // whether she's waiting for your yes (the companion then breathes in honey in the pill).
      mode: captionMode(state),
      confirm: state.waitingForConfirm,
      // The question itself ("Click “Send” in Mail?"): the pill asks it with Yes and No.
      question: state.waitingForConfirm ? captionLine(state.question, 90) : '',
      user: captionLine(state.user),
      echo: captionLine(state.echo),
      // Echo ended her reply with a question: the pill offers its reply field (shown, not focused),
      // so you can answer by typing from any app.
      asks: state.asks,
      // The likely answers to her question, as chips under the reply field ("Yes", "No").
      ...(state.asks && state.chips ? { chips: state.chips.split('\n') } : {}),
      // When each of Echo's words is said, so the pill lights them up in step with her voice.
      ...(state.echo && state.echoTimes ? { echoTimes: state.echoTimes } : {}),
    };
  }

  function flush() {
    timer = null;
    const m = message();
    const key = JSON.stringify(m);
    if (key === last) return;
    last = key;
    lastAt = now();
    post(m);
    beat(m);
  }

  /**
   * While the pill is wanted, the same state goes again every `beatMs` (marked `beat`: nothing
   * new). Its own plain timer, not the throttle's: it has to keep going whatever else is pending.
   */
  function beat(m) {
    clearTimeout(beatTimer);
    beatTimer = null;
    if (!m.enabled || !(m.active || m.driving)) return;
    beatTimer = setTimeout(() => {
      const again = message();
      post({ ...again, beat: true });
      beat(again);
    }, beatMs);
    // Under Node (tests) a waiting heartbeat never keeps the process alive.
    /** @type {any} */ (beatTimer).unref?.();
  }

  /** @param {Partial<typeof state> & { offerMs?: number }} patch offerMs: how long this offer of the reply field lasts (not kept) */
  function update(patch) {
    let changed = false;
    // A new line of Echo's starts without timings until her voice has them.
    if ('echo' in patch && patch.echo !== state.echo && !('echoTimes' in patch)) state.echoTimes = null;
    // You started answering (speaking, or a new turn is under way): the question is answered.
    if (state.asks && !('asks' in patch) && ((patch.hearing === true && !state.hearing) || (patch.busy === true && !state.busy))) patch = { ...patch, asks: false };
    if (patch.asks === false && !('chips' in patch)) patch = { ...patch, chips: '' };
    if ('asks' in patch) {
      if (askTimer) clearTimer(askTimer);
      // (offerMs: the field is offered only because you typed last, not for a question: it goes sooner.)
      askTimer = patch.asks ? setTimer(() => { askTimer = null; update({ asks: false }); }, Number(patch.offerMs) || askMs) : null;
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in state) || state[k] === v) continue;
      state[k] = v;
      changed = true;
    }
    if (!changed) return;
    // A new session starts clean.
    if (patch.driving === true) {
      state.user = patch.user ?? '';
      state.echo = patch.echo ?? '';
      state.echoTimes = null;
    }
    if (timer) return;
    const wait = throttleMs - (now() - lastAt);
    if (wait <= 0) flush();
    else timer = setTimer(flush, wait);
  }

  /** The setting changed: tell the app now. */
  function refresh() {
    if (timer) clearTimer(timer);
    last = '';
    flush();
  }

  return { update, refresh, get state() { return { ...state }; } };
}
