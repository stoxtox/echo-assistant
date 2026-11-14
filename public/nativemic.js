// The page's side of the one listening engine. In the Mac app, the app's own mic is the only
// microphone (macos/Sources/NativeMic.swift) and one state machine there decides everything
// (ListenMachine in VoiceMath.swift): Space, the mic button, Control + Option, "Hey Echo", the
// conversation window, a driving session and hands-free are all the same engine, armed for
// different reasons. The page tells it what to listen for and draws the state it reports; it
// decides nothing about the sound itself. This file is only decisions (no DOM), so
// test/nativemic.test.js runs it in Node against a fake app:
// - nativeMicPlan: what the app's mic should be armed for right now;
// - AppMic: the app's events (state, onset, live words, a delivered or dropped sentence) turned
//   into what the page does: lower or stop Echo's voice, show your words, send the clip, say why
//   a sentence went nowhere;
// - ringLive, stateLine, dropLine: what the ring and the line under the orb say. "Listening" is
//   shown only when the mic really is armed or hearing.
// In a plain browser tab (or when the app's mic can't be used) the page's own mic is the fallback
// (public/app.js), and nothing here is used but stateLine.

/**
 * What the app's mic should be armed for. Push-to-talk needs no arming: it works whenever the mic
 * may be used at all (`enabled`).
 * @param {{ available?: boolean, setting?: boolean, serverEngine?: boolean, micOff?: boolean,
 *   handsFree?: boolean, blocked?: boolean, driving?: boolean, listenDuringRuns?: boolean,
 *   answerOpen?: boolean, wakeWord?: boolean, engaged?: boolean, speaking?: boolean, bargeIn?: boolean,
 *   duckMedia?: boolean, endSilenceMs?: number, language?: string, windowUntil?: number, handsBusy?: boolean, resting?: boolean }} s
 *   available: this is the Mac app and its mic isn't refused; serverEngine: something can turn a
 *   sentence into text (Echo's server engine, or Apple's model in the app); blocked: a dialog that
 *   mustn't be talked over (first-run setup); answerOpen: Echo asked something and waits for the
 *   answer; engaged: the follow-up window after her reply; windowUntil: when that window runs out
 *   (wall clock, ms; 0: it doesn't), so the app closes it even if this page is asleep.
 * @returns {{ type: 'nativeMic', enabled: boolean, prepare: boolean, linger: boolean, arm: '' | 'wake' | 'window' | 'run' | 'handsfree',
 *   label: '' | 'answer' | 'follow', then: '' | 'wake' | 'handsfree', windowUntil: number, echo: boolean,
 *   bargeIn: boolean, duck: boolean, endSilenceMs: number, liveWords: boolean, language: string, handsBusy: boolean }}
 */
export function nativeMicPlan(s) {
  const enabled = Boolean(s.available && s.setting !== false && s.serverEngine);
  const base = {
    type: /** @type {const} */ ('nativeMic'), enabled,
    // Get Apple's speech model ready even before anything can listen: with no other engine,
    // its being ready is what lets the mic be used at all.
    prepare: Boolean(s.available && s.setting !== false),
    // The mic is open only while something below is armed, or a key is held. After a
    // push-to-talk it may stay open a short while, so a second press is instant. Not with the
    // mic-off switch on: then it opens for a held key and closes again.
    linger: enabled && !s.micOff,
    arm: /** @type {'' | 'wake' | 'window' | 'run' | 'handsfree'} */ (''), label: /** @type {'' | 'answer' | 'follow'} */ (''),
    then: /** @type {'' | 'wake' | 'handsfree'} */ (''), windowUntil: 0,
    echo: Boolean(s.speaking), bargeIn: s.bargeIn !== false, duck: s.duckMedia !== false,
    endSilenceMs: Number(s.endSilenceMs) || 1300, liveWords: true, language: String(s.language || 'en-US'),
    // While Echo drives: is it mid-step, or a lesson on (hands busy: the full pause)? Idle between requests, a finished sentence ends sooner.
    handsBusy: s.handsBusy !== false,
  };
  if (!enabled || s.micOff || s.blocked) return base;
  // What is armed once a window has run out.
  const rest = s.handsFree ? 'handsfree' : s.wakeWord ? 'wake' : '';
  const window = { arm: /** @type {const} */ ('window'), then: /** @type {'' | 'wake' | 'handsfree'} */ (rest), windowUntil: Math.max(0, Math.round(Number(s.windowUntil) || 0)) };
  // Resting (its name only): the mic is not opened for a job under way or for a follow-up, only for an answer Echo asked for.
  if (s.driving && s.listenDuringRuns !== false && !s.resting) return { ...base, arm: 'run' };
  if (s.answerOpen) return { ...base, ...window, label: 'answer' };
  if (s.handsFree) return { ...base, arm: 'handsfree' };
  if (s.wakeWord && s.engaged && !s.resting) return { ...base, ...window, label: 'follow' };
  if (s.wakeWord) return { ...base, arm: 'wake' };
  return base;
}

/**
 * How the page tells the server which way a sentence came in (X-Echo-Clip mode; the server judges
 * each one from it: lib/pipeline/utterance.ts).
 * @param {string} reason the app's arm reason @param {string} [label] 'answer' or 'follow', for a window
 */
export function clipMode(reason, label = '') {
  if (reason === 'wake' || reason === 'run') return reason;
  if (reason === 'handsfree') return 'hands-free';
  if (reason === 'window') return label === 'answer' ? 'answer' : 'follow';
  return 'push-to-talk';
}

/**
 * Is the mic taking in everything said (not just a held key or "Hey Echo")? Only then does the
 * ring show. The app must say its mic is really open (`running`): armed with a mic that has
 * stopped is not listening.
 * @param {{ state?: string, reason?: string, running?: boolean } | null | undefined} app
 */
export function ringLive(app) {
  return Boolean(app?.running) && (app?.state === 'armed' || app?.state === 'hearing') && ['window', 'run', 'handsfree'].includes(String(app?.reason));
}

/** "I can't hear you": the key is held and nothing is coming from the mic. */
export const CANT_HEAR_LINE = 'I can’t hear you: check the mic';

/** The app's mic couldn't be opened, or stopped delivering sound and a restart didn't help. */
export const MIC_ERROR_LINE = 'The microphone isn’t working: check it in System Settings › Sound';

/** A sentence that couldn't be turned into text (the reply's reason from POST /api/utterance). */
export const NO_TEXT_LINE = 'I couldn’t turn that into text: please say it again';

/** A sentence that never reached Echo's server. */
export const NOT_SENT_LINE = 'Couldn’t send that: Echo isn’t answering. Please say it again in a moment.';

/** How long a finished sentence waits before it's sent once more. */
export const RETRY_MS = 2000;

/**
 * Send a finished sentence. When Echo's server can't be reached (it is restarting) and the
 * sentence's text is already in hand, it's kept and sent once more after 2 s before anything is
 * said about it. An answer from the server, whatever it says, is never sent twice.
 * @template T
 * @param {() => Promise<T>} post the request itself (it rejects only when nothing answered)
 * @param {boolean} hasText the app's own text goes with the clip
 * @param {(ms: number) => Promise<any>} [wait]
 * @returns {Promise<T>}
 */
export async function sendWithRetry(post, hasText, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  try {
    return await post();
  } catch (e) {
    if (!hasText) throw e;
    await wait(RETRY_MS);
    return post();
  }
}

/**
 * The short plain line for a sentence that went nowhere, so a loss is never silent. Empty for
 * sound that was never a sentence for Echo: a cough, or talk that didn't begin with "Hey Echo".
 * @param {string} reason too_short | silent | spoiled | mode | not_wake | cancelled
 * @param {string} arm how the sentence came in
 */
export function dropLine(reason, arm) {
  if (reason === 'not_wake') return '';
  if (arm === 'wake') return reason === 'silent' ? 'I’m here. Say “Hey Echo” and your request.' : reason === 'mode' ? 'Not sent: listening was switched off' : '';
  switch (reason) {
    case 'too_short': return arm === 'ptt' ? 'Too short: hold the key while you talk' : '';
    case 'silent': return 'I couldn’t hear anything: check the mic';
    case 'spoiled': return 'Not sent: another key was pressed with the shortcut';
    case 'mode': return 'Not sent: listening was switched off';
    default: return 'Cancelled: nothing was sent';
  }
}

/**
 * The line under the orb. One function for both engines (the app's mic and the browser fallback),
 * given only what is true right now.
 * @param {{ transcribing?: boolean, awake?: boolean, hearing?: boolean, ptt?: boolean, pttHint?: boolean,
 *   byShortcut?: boolean, open?: '' | 'answer' | 'run', speaking?: boolean, spaceCuts?: boolean, talkCuts?: boolean,
 *   busy?: boolean, handsFree?: boolean, wake?: boolean, key?: string, mode?: '' | 'listening' | 'resting' | 'off' }} v
 *   key: what the talk key is called here ("Space" in a browser tab, "⌃⌥" in the Mac app); mode: the listening state
 *   awake: "Hey Echo" was heard; hearing: a sentence of yours is under way; ptt: a key or the mic
 *   button is recording; pttHint: still show how to send; byShortcut: held with the Mac shortcut,
 *   not Space; open: the mic is open for an answer or during a run; spaceCuts / talkCuts: holding
 *   Space, or just talking, interrupts Echo now; wake: "Hey Echo" is being listened for.
 */
export function stateLine(v) {
  const key = `<kbd>${v.key || 'Space'}</kbd>`;
  const letGo = v.byShortcut ? 'let go to send' : `release ${key} to send`;
  if (v.transcribing) return 'Transcribing…';
  if (v.awake) return 'Listening';
  if (v.ptt) return v.pttHint ? `Listening<span class="ptt-hint"> · ${letGo}</span>` : 'Listening';
  if (v.hearing) return 'Hearing you…';
  if (v.open && !v.speaking) return `<span class="auto-listen-line">${v.open === 'run' ? 'Listening · say “stop” anytime' : 'Listening'}</span>`;
  if (v.speaking) {
    // Only what really works right now is offered.
    const cut = v.spaceCuts && v.talkCuts ? `, ${key} or just talk to cut in` : v.spaceCuts ? `, ${key} to cut in` : v.talkCuts ? ', or just talk to cut in' : '';
    return `Speaking · <kbd>Esc</kbd> to hush${cut}`;
  }
  if (v.busy) return 'Thinking…';
  // The one listening state (lib/listenmode.js), when the page has it.
  if (v.mode === 'listening') return 'Listening · just talk';
  if (v.mode === 'resting') return `Resting · say “Echo” or hold ${key}`;
  if (v.mode === 'off') return `Mic off · hold ${key} or type`;
  if (v.handsFree) return 'Hands-free: just talk';
  if (v.wake) return 'Say “Hey Echo” or hold <kbd>Space</kbd> · <kbd>Esc</kbd> to hush';
  return 'Hold <kbd>Space</kbd> or click to talk · <kbd>Esc</kbd> to hush';
}

/** How long the live words must stand still before the page says "probably done". */
export const PROBABLY_DONE_MS = 350;

/** Last words that leave a sentence hanging: the app's own list (macos/Sources/VoiceMath.swift TurnEnd.hanging). */
const HANGING = new Set(`and or but so because cause if when then than while until unless although
the a an this that these those my your his her its our their some any every
to of for with in on at by from into about like as onto over under between through
is are was were be been am will would can could should shall might must do does did have has had
i we you he she they it's let's i'm we're you're there's
um uh er hmm which who whose where what how also just very really more most
think need want mean guess feel know kind sort trying going gonna wanna
maybe actually basically well`.split(/\s+/));

/**
 * Do the words so far look like a whole sentence, as the app's TurnEnd sees it: not stopping on a
 * comma, a dash or a word that leaves it hanging ("and", "the", "to", "I think")? Only used to get
 * the server ahead (AppMic `probablyDone`); the app alone decides when the sentence has ended.
 * @param {string} text
 */
export function looksFinished(text) {
  const t = String(text || '').trim();
  if (!t || /(,|…|\.\.\.|-)$/.test(t)) return false;
  const words = t.toLowerCase().replace(/’/g, "'").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')).filter(Boolean);
  if (!words.length) return false;
  if (/[.?!]$/.test(t)) return true;
  return !HANGING.has(/** @type {string} */ (words.at(-1))) && !/^ok(ay)? so$/.test(words.slice(-2).join(' '));
}

/** The longest Echo stays quiet after you cut in, if your words never arrive. */
export const BARGE_HOLD_MS = 15000;

/** Live words that show you're really talking (not a cough, a laugh or "um"). */
export function realWords(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}']+/gu) || [];
  return words.filter((w) => w.length >= 2 && !/^(um+|uh+|hm+|mm+|ah+|oh+|er+|huh)$/.test(w)).length >= 1;
}

/** The longest her voice stays lowered without live words before it stops anyway. */
export const BARGE_CONFIRM_MS = 1200;

/**
 * Barge-in. You start talking over Echo: onset() says 'duck' (her voice drops at once and goes on
 * quietly); words() with real words, or confirm() when none came in time or the sentence arrived,
 * say 'hush' (she stops, and the rest of that reply is held); cancel() says 'resume' (it wasn't
 * speech: she carries on, nothing lost). A voice that can't be lowered (`soft: false`: the
 * browser's own) stops at once instead. Your words being heard, or the time limit, release the hold.
 */
export class BargeIn {
  /** @param {{ now?: () => number, holdMs?: number }} [o] */
  constructor(o = {}) {
    this.now = o.now || Date.now;
    this.holdMs = o.holdMs ?? BARGE_HOLD_MS;
    this.heldAt = 0;
    this.duckedAt = 0;
    this.count = 0;
  }

  /**
   * You started talking (the app's speech onset).
   * @param {{ echo?: boolean, enabled?: boolean, soft?: boolean }} o echo: Echo was speaking at that
   *   moment; soft: her voice can be lowered first
   * @returns {'hush' | 'duck' | 'none'}
   */
  onset({ echo = false, enabled = true, soft = true } = {}) {
    if (!echo || !enabled) return 'none';
    this.count++;
    if (soft) {
      this.duckedAt = this.now();
      return 'duck';
    }
    this.heldAt = this.now();
    return 'hush';
  }

  /** Is her voice lowered, waiting to see whether you're really talking? */
  get ducked() {
    return Boolean(this.duckedAt);
  }

  /**
   * Live words while she's lowered: real words stop her (and hold the rest of the reply).
   * @returns {'hush' | 'none'}
   */
  words(text) {
    if (!this.duckedAt || !realWords(text)) return 'none';
    return this.confirm();
  }

  /** You're talking over her (real words, the sentence arrived, or the time ran out): she stops. @returns {'hush' | 'none'} */
  confirm() {
    if (!this.duckedAt) return 'none';
    this.duckedAt = 0;
    this.heldAt = this.now();
    return 'hush';
  }

  /** It wasn't speech: her voice comes back up, nothing lost. @returns {'resume' | 'none'} */
  cancel() {
    if (!this.duckedAt) return 'none';
    this.duckedAt = 0;
    return 'resume';
  }

  /** Is her voice held (the rest of the reply you cut off stays quiet)? */
  get holding() {
    return this.heldAt > 0 && this.now() - this.heldAt < this.holdMs;
  }

  /** Your words were heard, or it wasn't speech after all: she may talk again. */
  release() {
    this.heldAt = 0;
    this.duckedAt = 0;
  }
}

/**
 * @typedef {{
 *   post?: (msg: object) => void,
 *   now?: () => number,
 *   hush?: () => void, duck?: (on: boolean) => void, sfx?: (name: string) => void, surprised?: () => void,
 *   note?: (text: string) => void, words?: (text: string) => void, clearWords?: () => void, level?: (v: number) => void,
 *   send?: (wav: Uint8Array, live: string, notes: Record<string, any>) => Promise<any> | void,
 *   bargeOn?: () => boolean, canDuck?: () => boolean, confirmMs?: () => number, livePreview?: () => boolean,
 *   sinceReplyMs?: () => number | undefined, followUpMs?: () => number,
 *   heard?: (reason: string) => void, ended?: (reason: string, delivered: boolean, why?: string) => void,
 *   probablyDone?: (text: string, notes: { mode: string, followUp: boolean, sinceReplyMs?: number }) => void,
 *   changed?: () => void,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void,
 * }} AppMicHooks
 *   post: to the app; hush / duck: stop or lower Echo's voice; note: a short line under the orb;
 *   words: your words so far; send: a finished sentence on to the server (public/app.js sendClip);
 *   heard / ended: a sentence began, or ended (delivered, or dropped and why); changed: draw again;
 *   probablyDone: the words so far look finished and have stood still a moment: the server may get ahead.
 */

/** The app's listening state, as last reported. `known`: it has reported at all. */
const START = { known: false, engine: 0, state: 'idle', reason: '', since: 0, windowLeftMs: 0, running: false, permission: 'ask', appleReady: false, voiceProcessing: false, at: 0 };

/**
 * The page's half of the engine: what to ask of the app, and what to do with what it says.
 * It holds no listening rules of its own; the app's state is the only truth it draws from.
 */
export class AppMic {
  /** @param {AppMicHooks} [h] */
  constructor(h = {}) {
    const nothing = () => {};
    /** @type {Required<AppMicHooks>} */
    this.h = {
      post: nothing, now: Date.now, hush: nothing, duck: nothing, sfx: nothing, surprised: nothing, note: nothing, words: nothing,
      clearWords: nothing, level: nothing, send: nothing, bargeOn: () => true, canDuck: () => true, confirmMs: () => BARGE_CONFIRM_MS,
      livePreview: () => true, sinceReplyMs: () => undefined, followUpMs: () => 45000, heard: nothing, ended: nothing, probablyDone: nothing, changed: nothing,
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (t) => clearTimeout(t), ...h,
    };
    /** @type {typeof START} */
    this.app = { ...START };
    this.barge = new BargeIn({ now: this.h.now });
    /** @type {any} */
    this.bargeTimer = null;
    this.bargeWords = false; // live words came since she was lowered: they decide, not the timer
    this.awake = false; // "Hey Echo" was heard for the sentence under way
    this.pressed = false; // Space is down here, before the app has said it's recording
    this.pttOn = false; // a key is recording, and Echo has been hushed for it
    this.clicked = false; // it was the mic button (it ends on your pause; there's no key to let go)
    this.lastPlan = '';
    this.planLabel = ''; // 'answer' or 'follow' while a window is armed, for the mode of a head start
    /** @type {any} */
    this.doneTimer = null; // runs while the live words stand still (probablyDone)
    this.doneSaid = ''; // the words last sent as "probably done": the same ones aren't sent twice
  }

  /** The app's engine is there and its mic is allowed: it owns listening, the page's mic stays shut. */
  get usable() {
    return this.app.engine >= 1 && this.app.permission === 'allowed';
  }

  /** A key or the mic button is recording. */
  get ptt() {
    return this.pressed || (this.app.state === 'hearing' && this.app.reason === 'ptt');
  }

  /** A sentence of yours is under way (talk still waiting on "Hey Echo" isn't one yet). */
  get hearing() {
    return this.app.state === 'hearing' && (this.app.reason !== 'wake' || this.awake);
  }

  /** The mic takes in everything said: a window, a run or hands-free. */
  get live() {
    return ringLive(this.app);
  }

  /** How long the app's conversation window has left (0: no limit, or none). */
  windowLeftMs() {
    if (this.app.state !== 'armed' || this.app.reason !== 'window' || !this.app.windowLeftMs) return 0;
    return Math.max(0, this.app.windowLeftMs - (this.h.now() - this.app.at));
  }

  /** Tell the app what to listen for (only when it changed). @param {Parameters<typeof nativeMicPlan>[0]} s */
  plan(s, force = false) {
    const p = nativeMicPlan(s);
    const key = JSON.stringify(p);
    if (key === this.lastPlan && !force) return p;
    this.lastPlan = key;
    this.planLabel = p.label;
    this.h.post(p);
    return p;
  }

  /**
   * Space went down (`held`), or the mic button was clicked: the app records, from any state.
   * With its mic closed (nothing armed), the mic opens for the key and that takes a moment: Echo
   * is hushed at once, but the "go ahead" chime waits for the app to say it's recording (its
   * onset), so the chime never invites a first word the mic isn't open for yet.
   */
  pttBegin(held = true) {
    if (this.pressed) return;
    this.pressed = held;
    this.clicked = !held;
    if (this.app.running) this.pttStarted();
    else this.h.hush();
    this.h.post({ type: 'nativePtt', action: 'begin', held });
    this.h.changed();
  }

  /** A key is recording (Space here, or Control + Option from anywhere): Echo stops at once. The key is never judged, and never waits. */
  pttStarted() {
    if (this.pttOn) return;
    this.pttOn = true;
    this.h.hush();
    this.h.sfx('listen');
  }

  /** Space was let go (or the mic button clicked again). */
  pttEnd() {
    this.pressed = false;
    this.h.post({ type: 'nativePtt', action: 'end' });
    this.h.changed();
  }

  /** Drop what's being recorded; the app answers with `dropped`, which says so on screen. */
  pttCancel() {
    this.pressed = false;
    this.h.post({ type: 'nativePtt', action: 'cancel' });
    this.h.changed();
  }

  /** She may talk again; a voice still lowered comes back up. */
  releaseBarge() {
    if (this.barge.ducked) {
      this.h.clearTimer(this.bargeTimer);
      this.h.duck(false);
    }
    this.barge.release();
  }

  /** You really are talking over her: she stops. */
  cutIn() {
    this.h.clearTimer(this.bargeTimer);
    this.h.hush();
    this.h.duck(false);
    this.h.surprised();
  }

  /** @param {any} e what the app's mic says (macos/Sources/NativeMic.swift) */
  on(e) {
    switch (e?.event) {
      case 'state':
        this.app = { ...START, ...e, known: true, at: this.h.now() };
        if (e.state !== 'hearing') this.awake = false;
        // Also when the key took over a sentence already under way (no new onset then).
        if (e.state === 'hearing' && e.reason === 'ptt') this.pttStarted();
        else this.pttOn = false;
        break;
      case 'onset': {
        this.awake = false;
        // Shown at once; the app's own state report follows.
        this.app = { ...this.app, state: 'hearing', reason: String(e.reason || ''), at: this.h.now() };
        if (e.reason === 'ptt') {
          this.pttStarted();
          break;
        }
        // Talk that may be "Hey Echo" leaves her be until it's confirmed (the 'wake' event).
        if (e.reason === 'wake') break;
        this.bargeOnset(Boolean(e.bargeIn ?? e.echo));
        this.h.heard(String(e.reason));
        break;
      }
      case 'wake':
        this.awake = true;
        this.h.hush();
        this.h.sfx('wake');
        break;
      case 'partial':
        this.wordsSoFar(String(e.text || ''));
        if (this.barge.ducked && String(e.text || '').trim()) this.bargeWords = true;
        if (this.barge.words(e.text) === 'hush') this.cutIn();
        if (this.h.livePreview()) this.h.words(String(e.text || ''));
        break;
      case 'level':
        // Your voice level (~12 a second): the orb swells with it. Nothing else changes.
        this.h.level(Number(e.level) || 0);
        return;
      case 'warn':
        if (e.what === 'cant_hear') this.h.note(CANT_HEAR_LINE);
        break;
      case 'utterance':
        this.delivered(e);
        break;
      case 'dropped': {
        const arm = String(e.arm || '');
        this.sentenceOver(arm);
        // It wasn't you talking over her: her voice comes back up where it is.
        this.releaseBarge();
        this.h.clearWords();
        const line = dropLine(String(e.reason || ''), arm);
        if (line) this.h.note(line);
        this.h.ended(arm, false, String(e.reason || ''));
        break;
      }
      case 'error':
        // The mic couldn't be opened or went dead: said, and a key shown as recording is let go.
        console.warn('[native mic]', e.message);
        this.pressed = false;
        this.pttOn = false;
        this.h.note(MIC_ERROR_LINE);
        break;
    }
    this.h.changed();
  }

  /** @param {boolean} overEcho the sentence began over Echo's voice */
  bargeOnset(overEcho) {
    const act = this.barge.onset({ echo: overEcho, enabled: this.h.bargeOn(), soft: this.h.canDuck() });
    if (act === 'hush') {
      this.h.hush();
      this.h.surprised();
    }
    if (act !== 'duck') return;
    this.h.duck(true);
    this.h.clearTimer(this.bargeTimer);
    this.bargeWords = false;
    // No words in time: you're talking over her. The wait is longer than a pause, so a cough has
    // ended (and been let go) before it; while live words come, they decide instead.
    this.bargeTimer = this.h.setTimer(() => !this.bargeWords && this.barge.confirm() === 'hush' && this.cutIn(), this.h.confirmMs());
  }

  /**
   * The live words changed. When they look like a whole sentence and nothing more comes for
   * PROBABLY_DONE_MS, the server is told "probably done" with them, so it can get ahead while the
   * app makes sure you've stopped (lib/server/speech.js probablyDone). More words start the wait
   * again; nothing is sent to Echo by this.
   * @param {string} text
   */
  wordsSoFar(text) {
    this.h.clearTimer(this.doneTimer);
    this.doneTimer = null;
    const reason = this.app.reason;
    // Talk still waiting on "Hey Echo" isn't a sentence for Echo yet.
    if (this.app.state !== 'hearing' || (reason === 'wake' && !this.awake) || text === this.doneSaid || !looksFinished(text)) return;
    this.doneTimer = this.h.setTimer(() => {
      this.doneTimer = null;
      if (this.app.state !== 'hearing') return;
      this.doneSaid = text;
      // The notes the finished sentence will carry (delivered), as far as they are known now.
      const since = this.h.sinceReplyMs();
      const sinceReplyMs = typeof since === 'number' && Number.isFinite(since) ? Math.max(0, Math.round(since)) : undefined;
      this.h.probablyDone(text, { mode: clipMode(reason, this.planLabel), followUp: ['run', 'window'].includes(reason) || (sinceReplyMs !== undefined && sinceReplyMs < this.h.followUpMs()), ...(sinceReplyMs !== undefined ? { sinceReplyMs } : {}) });
    }, PROBABLY_DONE_MS);
  }

  /** The sentence under way is over (either way): the local marks of it go. @param {string} reason */
  sentenceOver(reason) {
    this.h.clearTimer(this.doneTimer);
    this.doneTimer = null;
    this.doneSaid = '';
    this.awake = false;
    if (reason === 'ptt') {
      this.pressed = false;
      this.pttOn = false;
      this.clicked = false;
      this.h.sfx('stop');
    }
    if (this.app.state === 'hearing') this.app = { ...this.app, state: 'finishing', reason: '', at: this.h.now() };
  }

  /** A finished sentence: on to the server with what it carries. @param {any} e */
  delivered(e) {
    const reason = String(e.reason || 'ptt');
    this.sentenceOver(reason);
    if (this.barge.confirm() === 'hush') this.cutIn();
    this.h.ended(reason, true);
    // How long after Echo's reply the sentence ENDED (its text may have taken a moment since).
    const since = this.h.sinceReplyMs();
    const lag = Number.isFinite(e.endAt) ? Math.max(0, this.h.now() - e.endAt) : 0;
    const sinceReplyMs = typeof since === 'number' && Number.isFinite(since) ? Math.max(0, Math.round(since - lag)) : undefined;
    const timedOut = Boolean(e.timedOut || e.final?.timedOut);
    const notes = {
      seconds: e.seconds, peak: e.peak, rate: 16000, mode: clipMode(reason, String(e.label || '')), native: true, aec: Boolean(e.aec), echoTailMs: 0,
      bargeIn: Boolean(e.bargeIn), followUp: ['run', 'window'].includes(reason) || (sinceReplyMs !== undefined && sinceReplyMs < this.h.followUpMs()), sinceReplyMs,
      inApp: true,
      // What every sentence carries: when it began, how loud it was, how much of it was voice.
      ...(Number.isFinite(e.onsetAt) ? { onsetAt: e.onsetAt } : {}), ...(Number.isFinite(e.level) ? { level: e.level } : {}), ...(Number.isFinite(e.voicedMs) ? { voicedMs: e.voicedMs } : {}),
      // Apple's text for it, made in the app while you talked (macOS 26+). When Apple took too
      // long there is none (an empty one would read as "nothing was said"): the server
      // transcribes the clip itself, and is told why.
      ...(timedOut ? { timedOut: true } : e.final && typeof e.final.text === 'string' ? { final: { text: e.final.text, ms: e.final.ms, words: (e.final.words || []).slice(0, 120) } } : {}),
    };
    const wav = Uint8Array.from(atob(String(e.wav || '')), (c) => c.charCodeAt(0));
    Promise.resolve(this.h.send(wav, String(e.live || ''), notes)).catch(() => {}).finally(() => this.releaseBarge());
  }
}
