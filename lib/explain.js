// Explain by showing: Echo walks the user through something on their screen (a document, a page,
// a settings pane) in small pieces, pointing at each part as it says one sentence about it.
//
// On Oct 6, 2026 Echo "explained" a 13-page document by talking for several long paragraphs while
// the document sat on screen. The user's answer: show the thing as well, one small piece at a
// time. So an explanation is 2 to 6 chunks. For each one, in turn: its part of the screen is
// brought into view (scrolling a page at a time when it has to), the light points at it, the
// one sentence is spoken as the light lands, and a card in the chat shows the outline with this
// chunk's few words large. Then a short beat, and the next.
//
// It never clicks and never types: it looks for the target (`point`, as point_at does), scrolls,
// and points. "next", "back", "again" and "stop" are taken here with no model call; anything
// else the user says ends the explanation and goes to the assistant as usual. This is not a
// lesson (lib/teach.js): nothing is checked and nothing waits for the user to do a step.
//
// Nothing the chunks say is logged: the timeline gets counts only.
import { randomBytes } from 'node:crypto';
import { teachCommand } from './teach.js';
import { lightOf } from './computer.js';
import { getSettings } from './settings.js';
import { record as timeline } from './timeline.ts';

/** An explanation is this many chunks. */
export const CHUNKS_MIN = 2;
export const CHUNKS_MAX = 6;
/** A chunk's sentence is about 20 words; this many is refused (never trimmed: half a sentence explains nothing). */
export const SAY_WORDS_MAX = 24;
/** A chunk's title in the card: a few words. */
export const KEY_WORDS_MAX = 5;
export const KEY_MAX = 48;
/** After a chunk's sentence has been said, how long before the next one starts. */
export const BEAT_MS = 700;
/** How many pages Echo scrolls looking for one target before it gives up (and scrolls back). */
export const VIEW_TRIES = 3;
export const CHUNK_RULE = `Give ${CHUNKS_MIN} to ${CHUNKS_MAX} chunks. Each: say (ONE sentence, ${SAY_WORDS_MAX} words at most), key (1 to ${KEY_WORDS_MAX} words), and target when there is something on screen to point at.`;

const squeeze = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const wordCount = (s) => (s ? s.split(' ').length : 0);

/**
 * The chunks of an explanation, checked. Too many, too few, or a chunk that says too much is
 * refused with the rule, so the assistant writes a shorter one: Echo never trims it to fit.
 * @param {unknown} v
 * @returns {{ chunks?: Array<{ say: string, key: string, target: string }>, error?: string }}
 */
export function cleanChunks(v) {
  if (!Array.isArray(v) || v.length < CHUNKS_MIN || v.length > CHUNKS_MAX) return { error: CHUNK_RULE };
  const chunks = v.map((c) => ({ say: squeeze(c?.say), key: squeeze(c?.key), target: squeeze(c?.target).slice(0, 120) }));
  for (const [i, c] of chunks.entries()) {
    if (!c.say || !c.key) return { error: `Chunk ${i + 1} needs both say and key. ${CHUNK_RULE}` };
    if (wordCount(c.say) > SAY_WORDS_MAX) return { error: `Chunk ${i + 1} says too much (${wordCount(c.say)} words). ${CHUNK_RULE}` };
    if (wordCount(c.key) > KEY_WORDS_MAX || c.key.length > KEY_MAX) return { error: `Chunk ${i + 1}'s key is too long. ${CHUNK_RULE}` };
  }
  return { chunks };
}

/**
 * What the user's words mean to a running explanation, with no model call. The words are the
 * lesson's own (lib/teach.js teachCommand), so "next", "skip", "go back", "say that again" and
 * "that's enough" mean here what they mean there; "go on" moves on.
 * @param {string} said
 * @returns {'next' | 'back' | 'again' | 'stop' | null}
 */
export function explainCommand(said) {
  const c = teachCommand(said);
  return c === 'next' || c === 'resume' ? 'next' : c === 'back' ? 'back' : c === 'repeat' ? 'again' : c === 'stop' ? 'stop' : null;
}

/** Which way the app says a thing it found out of view is ("…scroll down in the list to see it"), or ''. */
export function wayToScroll(answer) {
  const m = answer?.reason === 'scrolled_out_of_view' ? /\bscroll (up|down|left|right)\b/.exec(String(answer.message || '')) : null;
  return m ? /** @type {string} */ (m[1]) : '';
}

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

/**
 * @typedef {{ id: string, chunks: Array<{ say: string, key: string, target: string }>, app: string, index: number,
 *   missing: Set<number>, cmd: 'next' | 'back' | 'again' | null, ended: '' | 'stopped' | 'interrupted', wake: (() => void) | null,
 *   anchor: string, ownRun: boolean, turn: number, paced: boolean }} Walk
 *   (paced: one piece at a time: after each one Echo waits for "next", however long the user takes to read)
 *   (turn: counts the chunks begun, so words held for one chunk's light are never said once it has moved on)
 */

/** One by one: how long a piece waits for the user's "next" before the walk-through ends where it is. */
export const PACED_WAIT_MS = 3 * 60 * 1000;

export class Explainer {
  /**
   * @param {{ bridge: import('./screen.js').ScreenBridge | null, computer: import('./computer.js').ComputerUse,
   *   hush?: () => void, beatMs?: number, tries?: number, pacedWaitMs?: number }} o hush: Echo stops talking now (the user moved the explanation on)
   */
  constructor({ bridge, computer, hush = () => {}, beatMs = BEAT_MS, tries = VIEW_TRIES, pacedWaitMs = PACED_WAIT_MS }) {
    this.pacedWaitMs = pacedWaitMs;
    this.bridge = bridge;
    this.computer = computer;
    this.hush = hush;
    this.beatMs = beatMs;
    this.tries = tries;
    /** The explanation under way, if any. @type {Walk | null} */
    this.walk = null;
  }

  get active() {
    return Boolean(this.walk && !this.walk.ended);
  }

  /**
   * The user said something while an explanation runs. Its own four commands are taken here
   * (true: nothing goes to the assistant). Anything else ends the explanation, so the assistant
   * can answer it (false: it goes on as any other words do).
   * @param {string} said
   * @returns {boolean}
   */
  hear(said) {
    const w = this.walk;
    if (!w || w.ended || !String(said || '').trim()) return false;
    const cmd = explainCommand(said);
    if (!cmd || cmd === 'stop') w.ended = cmd ? 'stopped' : 'interrupted';
    else w.cmd = cmd;
    // Whatever Echo was saying about this chunk stops: the user has moved on (or asked for it again).
    if (cmd) this.hush();
    w.wake?.();
    return Boolean(cmd);
  }

  /** Stop the explanation under way (the assistant started another, or Echo is told to stop). */
  stop() {
    if (!this.active || !this.walk) return;
    this.walk.ended = 'stopped';
    this.walk.wake?.();
  }

  /** The card in the chat: one per explanation, sent again each time it moves (public/ui/chat.js showExplain). */
  card(w, extra = {}) {
    const c = w.chunks[w.index];
    this.computer.emit('explain_card', { id: w.id, keys: w.chunks.map((x) => x.key), index: w.index, total: w.chunks.length, say: c.say, ...extra });
  }

  /** Resolves when `p` does, or as soon as the user says something to the explanation. */
  unlessHeard(w, p) {
    if (w.cmd || w.ended) return Promise.resolve();
    return Promise.race([p, new Promise((resolve) => (w.wake = () => resolve(undefined)))]).finally(() => (w.wake = null));
  }

  /** Is this explanation over (the user stopped it, said something else, or took back control)? */
  over(w) {
    if (!w.ended && this.computer.blocked) w.ended = 'stopped';
    return Boolean(w.ended);
  }

  /** Ask the app to find the target and fly the light to it: point_at's own request, with the chunk's key as the caption beside the light, and the sentence Echo says about it for the bubble (the app shows the sentence when it can). */
  async point(w, chunk) {
    return /** @type {any} */ (this.bridge).request('point', { target: chunk.target, app: w.app || undefined, useScreen: getSettings().screenAware, intent: 'show', caption: chunk.key, words: String(chunk.say || '').slice(0, 200) })
      .catch(() => ({ ok: false, found: false, error: 'no_answer' }));
  }

  /**
   * One page that way. With something this explanation already pointed at, the scroll is aimed at
   * it (so it lands in the document, not on whatever the mouse is over); if that isn't on screen
   * any more, a plain scroll. False when nothing could be scrolled (computer use is off, the Mac
   * app is away, the user took over): then looking further is pointless.
   * @param {Walk} w @param {string} way
   */
  async scroll(w, way) {
    const c = this.computer;
    const had = Boolean(c.run);
    const kept = c.run ? { history: c.run.history, steps: c.run.steps } : null;
    const args = { direction: way, amount: 1, ...(w.app ? { app: w.app } : {}) };
    let r = w.anchor ? await c.act('scroll', { ...args, target: w.anchor }).catch(() => null) : null;
    if (!r || r.found === false) r = await c.act('scroll', args).catch(() => null);
    // These scrolls are not steps of a job. A scroll is often not seen to move (in Word it never
    // is), and a few of those in a row would count as "stuck" and end the session.
    if (c.run) Object.assign(c.run, kept || { history: [], steps: 0 });
    // Scrolling opened a driving session only for this: it closes with the explanation (run()).
    if (!had && c.run) w.ownRun = true;
    return Boolean(r && !r.error && r.found !== false);
  }

  /** One move that brings the chunk's words to rest near the top of its scroll area. False when it couldn't. */
  async intoView(w, chunk) {
    const c = this.computer;
    const had = Boolean(c.run);
    const kept = c.run ? { history: c.run.history, steps: c.run.steps } : null;
    const args = { direction: 'down', scrollTo: { into: chunk.target }, ...(w.app ? { app: w.app } : {}) };
    // Aimed at what the light last found, so it is that document that moves (as scroll() does).
    let r = w.anchor ? await c.act('scroll', { ...args, target: w.anchor }).catch(() => null) : null;
    if (!r || r.error) r = await c.act('scroll', args).catch(() => null);
    if (c.run) Object.assign(c.run, kept || { history: [], steps: 0 });
    if (!had && c.run) w.ownRun = true;
    return Boolean(r && !r.error && r.done !== false && r.scroll?.broughtIntoView !== undefined);
  }

  /**
   * Bring the chunk's target into view and point at it. Not there: scroll a page (the way the app
   * says it is, else `way`) and look again, `tries` times at most. Still not there: give up, and
   * `back` says how to put the view back where it was.
   * (The Mac app has no "scroll this into view" of its own yet: see the report with this change.)
   * @param {Walk} w @param {{ target: string, key: string }} chunk @param {'up' | 'down'} way
   * @returns {Promise<{ answer: any, back: string[] }>}
   */
  async show(w, chunk, way) {
    let answer = await this.point(w, chunk);
    // Out of view: ask the app to bring it to rest near the top in one move (the scroll tool's
    // "into_view"), and point again. Only when that fails is it looked for a page at a time.
    if (!answer.found && answer.ok !== false && !answer.error && !w.cmd && !this.over(w) && (await this.intoView(w, chunk))) {
      answer = await this.point(w, chunk);
    }
    /** @type {string[]} */
    const moved = [];
    // Only a plain "it isn't on screen" is worth scrolling for: not a missing permission or a silent app.
    const lookFurther = (/** @type {any} */ r) => !r.found && r.ok !== false && !r.error;
    while (lookFurther(answer) && moved.length < this.tries && !w.cmd && !this.over(w)) {
      const dir = wayToScroll(answer) || way;
      if (!(await this.scroll(w, dir))) break;
      moved.push(dir);
      answer = await this.point(w, chunk);
    }
    return { answer, back: answer.found ? [] : moved.reverse().map((d) => OPPOSITE[d]) };
  }

  /**
   * Walk the chunks. Resolves when the last one has been said, or the user ended it.
   * @param {Array<{ say: string, key: string, target: string }>} chunks
   * @param {{ app?: string, paced?: boolean, startAt?: number, onMove?: (index: number) => void }} [o]
   *   paced: wait for "next" after each piece (PACED_WAIT_MS at most, then it ends as 'waiting');
   *   startAt: the piece to begin with (going on after the user asked something); onMove: told each piece it reaches
   * @returns {Promise<{ shown: number, total: number, ended: 'finished' | 'stopped' | 'interrupted' | 'waiting', at: number, notFound: string[] }>}
   */
  async run(chunks, { app = '', paced = false, startAt = 0, onMove = undefined } = {}) {
    this.stop();
    const c = this.computer;
    /** @type {Walk} */
    const w = { id: randomBytes(4).toString('hex'), chunks, app: String(app || '').slice(0, 60), index: 0, missing: new Set(), cmd: null, ended: '', wake: null, anchor: '', ownRun: false, turn: 0, paced: Boolean(paced) };
    this.walk = w;
    const canPoint = Boolean(this.bridge && getSettings().pointer);
    const seen = new Set();
    let i = Math.min(Math.max(0, Math.floor(Number(startAt) || 0)), chunks.length - 1);
    let waited = false;
    let from = -1;
    /** @type {'finished' | 'stopped' | 'interrupted' | 'waiting'} */
    let ended = 'finished';
    try {
      while (i < chunks.length && !this.over(w)) {
        const chunk = /** @type {{ say: string, key: string, target: string }} */ (chunks[i]);
        w.index = i;
        onMove?.(i);
        const turn = ++w.turn;
        seen.add(i);
        // The card moves first: the outline shows where this piece sits while Echo finds it.
        this.card(w);
        let light = '';
        /** @type {string[]} */
        let back = [];
        if (chunk.target && canPoint) {
          const r = await this.show(w, chunk, i < from ? 'up' : 'down');
          back = r.back;
          if (r.answer.found) {
            w.missing.delete(i);
            w.anchor = chunk.target;
            light = lightOf(r.answer);
            // What Echo is pointing at is what "it" means in the user's next words.
            c.noteReferent?.(String(r.answer.label || chunk.target), String(r.answer.app || w.app));
          } else {
            w.missing.add(i);
            this.card(w, { found: false });
          }
        }
        // Not found is still explained: the sentence is said and the card shows it. (The view goes
        // back to where it was meanwhile.)
        if (!w.cmd && !this.over(w)) {
          const said = (async () => {
            // The sentence starts as the light lands (docs/firefly-protocol.md, section 5).
            if (light && !(await c.lightLands(light))) timeline('server', 'speech.unsynced', { kind: 'explain' });
            if (w.turn !== turn || w.cmd || this.over(w)) return;
            await c.voice.whenDone(c.speak(chunk.say));
          })();
          const restored = (async () => {
            for (const dir of back) if (!(await this.scroll(w, dir))) break;
          })();
          await this.unlessHeard(w, Promise.all([said, restored]));
          await restored;
          if (!w.cmd && !this.over(w)) {
            // One by one: the next piece waits for the user's "next" (or "back", "again", "stop"),
            // for as long as they take to read this one. Left alone for minutes, it ends where it is.
            if (w.paced && i < chunks.length - 1) {
              let timer;
              await this.unlessHeard(w, new Promise((r) => { timer = setTimeout(r, this.pacedWaitMs); timer.unref?.(); }));
              clearTimeout(timer);
              if (!w.cmd && !this.over(w)) { waited = true; break; }
            } else await this.unlessHeard(w, new Promise((r) => setTimeout(r, this.beatMs)));
          }
        }
        const cmd = w.cmd;
        w.cmd = null;
        from = i;
        i = cmd === 'back' ? Math.max(0, i - 1) : cmd === 'again' ? i : i + 1;
      }
    } finally {
      ended = w.ended || (waited ? 'waiting' : 'finished');
      this.card(w, { done: true, ...(ended === 'finished' ? {} : { stopped: true }) });
      if (w.ownRun && c.run) c.end('done', 'explained');
      if (this.walk === w) this.walk = null;
      timeline('server', 'explain.end', { chunks: chunks.length, shown: seen.size, missing: w.missing.size, ended });
    }
    return { shown: seen.size, total: chunks.length, ended, at: w.index + 1, notFound: [...w.missing].sort().map((n) => /** @type {any} */ (chunks[n]).target) };
  }
}

/**
 * The dispatcher's explainer (one per dispatcher, made on first use). While an explanation runs,
 * the user's words reach it first: "next", "back", "again" and "stop" never become a turn.
 * (The dispatcher's send is wrapped here, the one place every spoken and typed line comes
 * through. A check at the top of Dispatcher.send, where the lesson's is, would say the same.)
 * @param {any} d the dispatcher (lib/dispatcher.js)
 * @returns {Explainer}
 */
export function explainerFor(d) {
  if (d.explain) return d.explain;
  const ex = new Explainer({ bridge: d.screen, computer: d.computer, hush: () => d.emit('hush') });
  d.explain = ex;
  const send = d.send.bind(d);
  d.send = (textIn, speech = {}, images = []) =>
    (!images.length && !speech.pointed && ex.hear(String(textIn || '')) ? 'local' : send(textIn, speech, images));
  return ex;
}
