// Listening, from sound to a turn (split out of server.js): what the page's mic and the Mac app
// send (POST /api/utterance, the wake check, audio streamed while you talk, the browser
// recognizer's text), how each sentence is judged against the conversation (lib/pipeline/
// utterance.ts) and what goes to the dispatcher. It keeps the listening state between sentences:
// the last few lines said, the conversation window (Talk mode, "thanks"), the clips of the last
// moments (so one sentence recorded by two mics counts once), and how loud the owner usually is.
//
// A sentence that doesn't become a turn is never lost without a trace: every way out writes one
// `dropped` line (why, how it came in, how long; never its words) and tells the page why.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getSettings } from '../settings.js';
import { transcribe, engines, resolveEngine, sttLanguageFor, wakeTranscribe, appleHeard } from '../stt.js';
import { matchWake, stripWake } from '../wake.js';
import { isBlankText, checkHeard, cleanHeard, saveBlankClip, wavStats, heardTwice, sameInSubstance } from '../heard.js';
import { keepRecording, recordingsOn } from '../recordings.js';
import { newTrace } from '../trace.ts';
import { afterSentence, freshListenState } from '../session.ts';
import { decideUtterance, listenMode, waitsForMore, joinParts, JOIN_MS, JOIN_CAP_MS, WAKE_MODES, SURELY_FOR_ECHO } from '../pipeline/utterance.ts';
import { awaitsAnswer } from '../../public/autolisten.js';
import { record as timeline } from '../timeline.ts';
import { voiceLevels, softSpoken } from '../voicelevel.js';
import { said as transcriptSaid } from '../transcript.ts';
import { secondOpinion, secondListenOn } from '../secondlisten.js';
import { selfImproveAccess } from '../devcopy.js';
import { SpeechStreams, parseAudioMessage } from '../sttstream.js';
import { heardClearly, judgeAddressee, nameAnywhere } from '../addressed.js';
import { spokenMode, notToEcho } from '../listenmode.js';
import { clipLoudness, quietRoom } from '../listening.js';
import { mediaWatcher } from '../mediaplaying.js';
import { logDroppedWords } from '../droplog.js';
import { localDirected, settle } from '../localmodel.js';
import { hearAsSaid } from '../correct.js';
import { isStatusQuestion } from '../status.js';
import { loadVocab, vocabularyTerms } from '../vocab.js';
import { resolveAttachments } from '../attachments.js';
import { readJson, readBody, sendJson, headerJson } from './http.js';

/**
 * @param {{ dispatcher: import('../dispatcher.js').Dispatcher, quick: import('../quick.js').QuickActions, screen: import('../screen.js').ScreenBridge, broadcast: (msg: object) => void, clock?: () => number, joinMs?: number, setListenMode?: (mode: 'listening' | 'resting' | 'off', why?: string) => unknown }} deps
 *   clock: when a clip came in (tests set it, to place two clips in time); joinMs: how long a
 *   sentence of one to three words waits for the rest of the thought (tests shorten it);
 *   setListenMode: changes the one listening state (server.js)
 */
export function speechIntake({ dispatcher, quick, screen, broadcast, clock = Date.now, joinMs = JOIN_MS, setListenMode = undefined }) {
  /* ---------- conversation log (for reviewing and improving Echo) ---------- */
  const convoDir = path.join(config.dataDir, 'conversations');
  fs.mkdirSync(convoDir, { recursive: true });
  const recent = []; // last few lines, as context for judging who a sentence is for
  /**
   * The clips of the last minute: which mic, when the speech in each ended, how long it was, and
   * what became of it, to tell one sentence recorded by two mics (lib/heard.js heardTwice). A
   * delivered one keeps its words here (in memory, for that minute, never logged), so push-to-talk
   * for the same moment is dropped only when it says the same thing.
   * @typedef {{ mode?: string, mic: string, endAt: number, ms: number, ptt: boolean, said: string, fate: Promise<'delivered' | 'dropped'>, done: '' | 'delivered' | 'dropped', settle: (f: 'delivered' | 'dropped', said?: string) => void, rival: Clip | null }} Clip
   * @type {Clip[]}
   */
  const recentClips = [];
  /** How loud the owner usually is, per mic (lib/voicelevel.js). */
  const voice = voiceLevels(config.dataDir);
  /** The conversation window between sentences (lib/session.ts): Talk mode, a "thanks" that closed it, the last set-aside sentence. */
  let listenState = freshListenState();

  /**
   * Where the conversation stands, for deciding what a sentence is (lib/pipeline/utterance.ts).
   * @param {ReturnType<typeof getSettings>} s
   */
  function conversationNow(s) {
    const last = dispatcher.lastSpokeAt;
    return {
      recent,
      driving: dispatcher.computer.driving,
      busy: dispatcher.busy,
      pendingCards: dispatcher.computer.pending.size,
      pendingMessages: quick.pendingList().length,
      lessonActive: Boolean(dispatcher.computer.lesson?.active),
      wakeWord: Boolean(s.wakeWord),
      inCall: Date.now() - (quick.callAt || 0) < 90 * 60 * 1000,
      // The page measures from when Echo's voice actually stopped; this is the fallback.
      ...(last ? { sinceReplyMs: Date.now() - last } : {}),
      talk: listenState.talk,
      closed: listenState.closed,
      lastSetAside: listenState.lastSetAside,
      now: Date.now(),
    };
  }

  /**
   * Remember what a sentence did to the window (Talk mode, "thanks", the last one set aside), and
   * tell the page so it can show the window.
   * @param {{ kind: 'deliver' | 'hold' | 'drop', said: string, recalled?: boolean }} verdict @param {string | undefined} mode
   */
  function noteSentence(verdict, mode) {
    listenState = afterSentence(listenState, verdict, { surely: SURELY_FOR_ECHO.includes(String(mode)) });
    // The one listening state (lib/listenmode.js): "go quiet" rests it, "stop listening" turns the
    // mic off, and its name wakes it from Resting. A held key never changes it.
    if (verdict.kind === 'deliver') {
      const held = String(mode) === 'push-to-talk';
      const asked = spokenMode(verdict.said);
      if (asked) setListenMode?.(asked, 'asked');
      // "I wasn't talking to you": what Echo picked up just before was someone else's talk. It is not work to remember.
      if (notToEcho(verdict.said)) dispatcher.noteForNext('(The user says the last things you heard were not said to you: they were talking to someone else. Forget them: no task, name or question from that stretch is yours to follow up, now or later. Say one short line at most.)');
      else if (!held && getSettings().listenMode === 'resting' && (String(mode) === 'wake' || nameAnywhere(verdict.said))) setListenMode?.('listening', 'name');
    }
    broadcast({ type: 'listen_state', talk: listenState.talk, closed: listenState.closed });
  }

  /**
   * A clip has come in. If the other microphone recorded the same moment (the same speech, at
   * the same time, of about the same length), one of them is the rival it loses to: push-to-talk
   * wins over a clip still on its way (you pressed the key on purpose), and otherwise the first
   * one in. A clip that loses is dropped only once its rival has really gone through (clipLost),
   * and push-to-talk only when it also says the same thing (the route below).
   * @param {{ mode?: string, mic: string, endAt: number, ms: number }} c endAt, ms: when the speech in it ended and how long it was
   * @returns {Clip}
   */
  function noteClip({ mode, mic, endAt, ms }) {
    let resolve = /** @type {(f: 'delivered' | 'dropped') => void} */ (() => {});
    /** @type {Clip} */
    const me = { mode, mic, endAt, ms, ptt: mode === 'push-to-talk', said: '', fate: new Promise((r) => { resolve = r; }), done: '', rival: null, settle: (f, said = '') => { if (!me.done) { me.done = f; me.said = said; resolve(f); } } };
    while (recentClips.length && endAt - recentClips[0].endAt > 60_000) recentClips.shift();
    for (const other of recentClips) {
      if (!heardTwice(other, me)) continue;
      // Push-to-talk wins over a clip still on its way; one already answered stays answered.
      if (me.ptt && other.done !== 'delivered') other.rival = me;
      else me.rival = other;
    }
    recentClips.push(me);
    return me;
  }
  /** The clip this one is a second recording of, once that one has gone through; else null. @param {Clip} me */
  const clipLost = async (me) => (me.rival && (await me.rival.fate) === 'delivered' ? me.rival : null);

  /* ---------- the start of a thought waits for the rest ("I just think" … "the header is too big") ---------- */
  /**
   * The one short sentence being held (lib/pipeline/utterance.ts waitsForMore), in memory only
   * and never logged. `by`: the clip that came in after it and will take its words.
   * @type {{ text: string, parts: number, at: number, by: Clip | null, timer: NodeJS.Timeout, done: (joined: boolean) => void } | null}
   */
  let waiting = null;
  /** The held sentence goes on alone (nothing more came), or its words have been taken (joined). @param {boolean} joined */
  function letGo(joined) {
    const w = waiting;
    if (!w) return;
    waiting = null;
    clearTimeout(w.timer);
    w.done(joined);
  }
  /**
   * Hold a short sentence for the rest of the thought: true when a later clip took its words.
   * @param {string} text @param {number} parts how many clips it is made of already
   * @returns {Promise<boolean>}
   */
  function holdForMore(text, parts) {
    letGo(false); // one at a time: an earlier one still held goes on now
    return new Promise((done) => {
      waiting = { text, parts, at: Date.now(), by: null, done, timer: setTimeout(() => letGo(false), joinMs) };
    });
  }
  /**
   * The page says speech has begun again (the app's `onset`), so the rest is on its way: the held
   * sentence waits for that clip. `over`: it came to nothing (a cough), so the wait is over.
   * @param {{ over?: boolean }} [msg]
   */
  function onset(msg = {}) {
    if (!waiting || waiting.by) return;
    clearTimeout(waiting.timer);
    if (msg.over) return letGo(false);
    waiting.timer = setTimeout(() => letGo(false), JOIN_CAP_MS);
  }

  /**
   * The sentence the assistant may stay quiet on (in memory only). When it does (the dispatcher's
   * `dropped` with reason `quiet`), the page shows "Not sure that was for me · Send anyway", and
   * saying "yes, that was for you" sends the same words on as a sure sentence: they become the
   * last sentence set aside, which the recall delivers without judging it again.
   * @type {{ trace: string, text: string } | null}
   */
  let maybeQuiet = null;
  dispatcher.on?.('dropped', (/** @type {{ reason?: string, trace?: string }} */ d) => {
    if (d?.reason !== 'quiet' || !maybeQuiet || maybeQuiet.trace !== d.trace) return;
    listenState = { ...listenState, lastSetAside: { text: maybeQuiet.text, at: Date.now() } };
    maybeQuiet = null;
  });

  const media = mediaWatcher(); // is something else playing sound on this Mac? (lib/mediaplaying.js)
  const wakeCounts = { checks: 0, wakes: 0 }; // "Hey Echo" checks since start (never what was said)
  function logConvo(who, textIn) {
    if (who === 'User' || who === 'Assistant') {
      recent.push(`${who}: ${String(textIn).slice(0, 300)}`);
      if (recent.length > 8) recent.shift();
    }
    const d = new Date();
    const file = path.join(convoDir, `${d.toLocaleDateString('en-CA', { timeZone: config.timezone })}.md`);
    const time = d.toLocaleTimeString('en-US', { timeZone: config.timezone });
    fs.appendFileSync(file, `**[${time}] ${who}:** ${String(textIn).replace(/\n+/g, ' ')}\n\n`);
  }

  /* ---------- speech: log, dispatch ---------- */
  const sttLog = path.join(config.dataDir, 'stt-log.jsonl');
  const RECENT_CLIPS = 20;
  /** The developer copy keeps voice recordings unless you turn it off (lib/recordings.js). */
  const DEV_COPY = selfImproveAccess().allowed;
  const recordingOn = () => recordingsOn(getSettings().keepRecordings, DEV_COPY);

  /**
   * Addressee v1 (lib/addressed.js), and when its rules are unsure, a local model on this Mac
   * (lib/localmodel.js: Apple's on-device model or a local Qwen) settles it if it's confident.
   * @param {Parameters<typeof judgeAddressee>[0]} o
   */
  async function judgeHere(o) {
    const judged = judgeAddressee(o);
    if (judged.decision !== 'ask') return judged;
    // Already asked while the user was finishing the sentence (probablyDone): only what is left of
    // that wait is on the clock now.
    const head = headStart && headStart.local && headStart.key === sameWords(o.text) && Date.now() - headStart.at < HEAD_START_MS ? headStart : null;
    if (!head) return settle(judged, await askLocal(o));
    const asked = Date.now();
    const local = await head.local;
    const waitMs = Date.now() - asked;
    headUsed = { leadMs: asked - head.at, waitMs, savedMs: Math.max(0, (head.doneAt || Date.now()) - head.at - waitMs) };
    return settle(judged, local);
  }
  /** The local model's say on an unsure sentence (lib/localmodel.js). @param {Parameters<typeof judgeAddressee>[0]} o */
  const askLocal = (o) => localDirected({ ...o, context: o.context || recent.slice(-6) }, { bridge: screen });

  /* ---------- a head start while the sentence is ending ("probably done") ---------- */
  /** What the rules decide from the words alone, however the clip sounds (lib/addressed.js): the local model is never asked about these. */
  const SETTLED_BY_WORDS = new Set(['empty', 'stop', 'pause', 'name']);
  /** A head start older than this is for some other sentence. */
  const HEAD_START_MS = 10_000;
  /** A sentence's words alone (no case, no punctuation), to tell the finished sentence is the one prepared for. @param {unknown} t */
  const sameWords = (t) => (String(t || '').toLowerCase().replace(/[’']/g, '').match(/[\p{L}\p{N}]+/gu) || []).join(' ');
  /**
   * What was got ready for the sentence being finished (in memory only, never logged): its words
   * as a key, when, and the local model's answer on its way if the rules were unsure.
   * @type {{ key: string, at: number, doneAt: number, local: Promise<Awaited<ReturnType<typeof localDirected>>> | null } | null}
   */
  let headStart = null;
  /** What the head start saved on the sentence being judged now, for the timeline (ms only). @type {{ leadMs: number, waitMs: number, savedMs: number } | null} */
  let headUsed = null;
  /**
   * The page says the sentence so far looks finished and a short pause has passed (public/
   * nativemic.js probablyDone), with the live words. Everything that commits to nothing is done
   * now, while the app is still making sure the user has stopped: who it is for is judged as the
   * finished clip will be, and the model this turn will use is switched to. The slow part of the
   * judging is the local model, asked when the rules are unsure; whether they will be depends on
   * how the clip sounds, which isn't known yet, so it is asked now for any sentence the rules
   * can't settle by its words alone ("Echo", "stop") and its answer kept. Nothing is sent, said,
   * logged or remembered: the finished clip goes through every check as before (POST
   * /api/utterance), and uses the answer only when it says the same words and the rules do turn
   * out unsure. If the user carries on, it is thrown away.
   * @param {{ text?: string, mode?: string, followUp?: boolean, sinceReplyMs?: number }} msg
   */
  async function probablyDone(msg) {
    try {
      const mode = String(msg?.mode || '');
      const text = String(msg?.text || '').slice(0, 500);
      const said = WAKE_MODES.includes(mode) ? stripWake(text) : text;
      if (isBlankText(said) || dispatcher.routeInput(said) !== 'turn' || dispatcher.localIntentFor(said)) return;
      const mine = (headStart = { key: sameWords(said), at: Date.now(), doneAt: 0, local: null });
      const mediaPlaying = await media.playing();
      // The page's notes as the finished clip will carry them (public/nativemic.js delivered).
      const page = { mode, native: true, inApp: true, followUp: Boolean(msg?.followUp), ...(Number.isFinite(msg?.sinceReplyMs) ? { sinceReplyMs: Number(msg.sinceReplyMs) } : {}) };
      const verdict = await decideUtterance({ text, page, clarity: 'unknown', loud: null, quiet: undefined, mediaPlaying }, conversationNow(getSettings()), {
        judge: async (o) => {
          const judged = judgeAddressee(o);
          if (!SETTLED_BY_WORDS.has(judged.why) && !mine.local) {
            mine.local = askLocal(o).catch(() => null).finally(() => { mine.doneAt = Date.now(); });
          }
          return judged;
        },
      });
      // Still the sentence being finished, idle, and on its way to Echo: its model is ready when it lands.
      if (headStart === mine && verdict.kind === 'deliver' && !dispatcher.busy) dispatcher.prepare(verdict.said);
    } catch (e) {
      console.error('[stt] getting ahead:', /** @type {Error} */ (e).message);
    }
  }

  /**
   * @param {string} raw
   * @param {{ uncertain?: Array<{ word: string, confidence: number }>, engine?: string, sttMs?: number, lowOverall?: boolean, audio?: object, stages?: object, rec?: string, trace?: string, mayNotBeForEcho?: boolean, soft?: boolean }} [opts]
   */
  async function handleUtterance(raw, { uncertain = [], engine, sttMs = 0, lowOverall = false, audio = undefined, stages = undefined, rec = '', trace = '', mayNotBeForEcho = false, soft = false } = {}) {
    trace ||= newTrace();
    if (isBlankText(raw)) {
      fs.appendFileSync(sttLog, JSON.stringify({ at: new Date().toISOString(), event: 'dropped', reason: 'blank', engine, trace, ...(rec ? { rec } : {}) }) + '\n');
      return { empty: true, engine, reason: 'blank' };
    }
    // While Echo drives the Mac: a spoken "stop" (or "that's all") ends the run at once.
    const route = dispatcher.routeInput(raw);
    if (route === 'stop' || route === 'end' || route === 'pause') {
      broadcast({ type: 'heard', text: raw, engine, trace });
      logConvo('User', raw);
      fs.appendFileSync(sttLog, JSON.stringify({ at: new Date().toISOString(), engine, sttMs, event: route === 'stop' ? 'run_stop' : route === 'pause' ? 'run_pause' : 'run_end', text: raw, trace, ...(rec ? { rec } : {}) }) + '\n');
      dispatcher.send(raw, { trace });
      return { engine, text: raw, routed: route };
    }
    // Instant commands ("pause", "next song", "volume up"; "scroll down" while driving) skip the
    // model: done on the Mac in well under a second (lib/intent.js).
    if (route === 'turn' && dispatcher.localIntentFor(raw)) {
      broadcast({ type: 'heard', text: raw, engine, trace });
      logConvo('User', raw);
      fs.appendFileSync(sttLog, JSON.stringify({ at: new Date().toISOString(), engine, sttMs, event: 'local', text: raw, trace, ...(rec ? { rec } : {}) }) + '\n');
      dispatcher.send(raw, { trace });
      return { engine, text: raw, routed: 'local' };
    }
    // Show at once that she heard (the pearl's thinking state), while the reply is written. Nothing is spoken: her first words are the model's own.
    if (route === 'turn') dispatcher.heard();
    // As heard, with the names it may be as hints for the assistant (lib/correct.js hearAsSaid):
    // nothing is rewritten, and no model is waited on.
    const fixed = hearAsSaid(raw, { uncertain });
    const entry = { at: new Date().toISOString(), trace, ...(rec ? { rec } : {}), engine, sttMs, fixMs: fixed.ms, raw, text: fixed.text, changes: fixed.changes, unsure: fixed.unsure, ...(fixed.hints.length ? { hints: fixed.hints } : {}), ...(audio ? { audio } : {}), ...(stages ? { stages } : {}) };
    fs.appendFileSync(sttLog, JSON.stringify(entry) + '\n');
    broadcast({ type: 'heard', text: fixed.text, raw: fixed.text !== raw ? raw : null, unsure: fixed.unsure, engine, ms: sttMs + fixed.ms, trace });
    logConvo('User', fixed.text !== raw ? `${fixed.text}  _(heard: "${raw}")_` : raw);
    // Echo may stay quiet on this one: its words are kept (in memory) in case it does, for "that was for you".
    if (mayNotBeForEcho) maybeQuiet = { trace, text: fixed.text };
    const routed = dispatcher.send(fixed.text, { raw, unsure: fixed.unsure, lowOverall, trace, hints: fixed.hints, ...(mayNotBeForEcho ? { mayNotBeForEcho: true } : {}), ...(soft ? { soft: true } : {}) });
    return { ...entry, ...(routed && routed !== 'turn' ? { routed } : {}) };
  }

  /**
   * The second listen came back. When it is clearly the better transcript, the turn is done again
   * with it if the assistant hasn't said or done anything yet (dispatcher.rehear); otherwise the
   * assistant is told with its next message. Logged either way, so the rule can be measured.
   * @param {{ apple: string, whisper: any, trace: string, rec: string }} o
   */
  function secondHeard({ apple, whisper, trace, rec }) {
    if (!whisper) return;
    const opinion = secondOpinion(apple, whisper);
    const outcome = opinion.use === 'whisper' ? dispatcher.rehear(trace, opinion.text) : 'kept';
    timeline('server', 'speech.second', { why: opinion.why, ms: whisper.ms, outcome }, trace);
    fs.appendFileSync(sttLog, JSON.stringify({ at: new Date().toISOString(), event: 'second_listen', trace, ...(rec ? { rec } : {}), why: opinion.why, outcome, ms: whisper.ms, apple, whisper: whisper.text, segments: whisper.segments }) + '\n');
    if (outcome === 'restarted') {
      broadcast({ type: 'heard_fix', trace, text: opinion.text, was: apple });
      logConvo('User', `${opinion.text}  _(first heard as: "${apple}")_`);
    }
  }

  /* ---------- transcribe while talking (lib/sttstream.js, public/sttstream.js) ---------- */
  /** ECHO_STREAM_STT=off: back to transcribing only once you've stopped. */
  const STREAM_ON = process.env.ECHO_STREAM_STT !== 'off';
  const streams = new SpeechStreams({ transcribe });
  /** @param {unknown} owner @param {object} msg */
  const sendTo = (owner, msg) => {
    const ws = /** @type {any} */ (owner);
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  };
  // What's been said so far, for the live caption (never logged).
  streams.on('partial', ({ owner, id, text }) => {
    const mode = streams.get(owner, id)?.mode || '';
    const shown = WAKE_MODES.includes(mode) ? stripWake(text) : text;
    if (!isBlankText(shown)) sendTo(owner, { type: 'stt_partial', id, text: shown.slice(0, 500) });
  });
  // You paused, and the words so far are known: get the turn ready while the page makes sure you've
  // finished. An instant command ("stop", "scroll down", "pause") needs nothing more, so the page may
  // end the clip now; anything else gets the model it will use switched to. Nothing acts yet: the
  // finished clip still goes through every check (POST /api/utterance).
  streams.on('ready', ({ owner, id, heard }) => {
    try {
      const mode = streams.get(owner, id)?.mode || '';
      const cleaned = cleanHeard(heard, { live: '', livePreview: false });
      const said = WAKE_MODES.includes(mode) ? stripWake(cleaned.text) : cleaned.text;
      if (isBlankText(said)) return;
      const route = dispatcher.routeInput(said);
      const instant = route === 'stop' || route === 'end' || route === 'pause' || (route === 'turn' && Boolean(dispatcher.localIntentFor(said)));
      // Only for speech that's surely for Echo (push-to-talk, or after "Hey Echo"). Hands-free talk
      // is judged first, when the clip is in.
      if (!instant && route === 'turn' && SURELY_FOR_ECHO.includes(mode)) dispatcher.prepare(said);
      sendTo(owner, { type: 'stt_ready', id, instant, words: said.split(/\s+/).length });
    } catch (e) {
      console.error('[stt] preparing the turn:', /** @type {Error} */ (e).message);
    }
  });

  /* ---------- HTTP: POST /api/utterance and the rest of listening ---------- */
  const routes = {
    'POST /api/utterance': async (req, res) => {
      // Audio from the page (16 kHz mono WAV) -> text -> Echo.
      const s = getSettings();
      // What the live listener showed, and the page's notes on the mic (public/app.js sendClip).
      const live = headerJson(req, 'x-echo-live') ?? '';
      const page = headerJson(req, 'x-echo-clip') || {};
      // Apple's text, made in the Mac app while you talked (macOS 26+): no wait for Whisper.
      // Empty means it understood nothing, and Whisper has a go as before.
      const apple = appleHeard(page.final);
      const engine = apple ? 'apple' : resolveEngine(s.sttEngine);
      // The app's mic with Apple's speech and the browser's recognition picked: there's no second
      // engine here to ask. When Apple understood nothing it's a blank sentence, not an error.
      // When Apple's text never came (it took too long: `timedOut`, and no `final`), the clip
      // can't be transcribed here either, and the reply says that, not "blank".
      const appleOnly = engine === 'browser' && Boolean(page.native);
      const appleBlank = appleOnly && page.final && typeof page.final === 'object' && !page.final.timedOut && !page.timedOut;
      if (engine === 'browser' && !appleOnly) return sendJson(res, { error: 'Browser recognition runs in the page' }, 400);
      const wav = await readBody(req);
      // Kept on this Mac with an id, whatever happens to it next (lib/recordings.js), and every
      // line written about it below carries that id, so listening can be measured on real speech.
      const rec = keepRecording(wav, { enabled: recordingOn() });
      // One id for this sentence's whole turn, in every log (lib/trace.ts).
      const trace = newTrace();
      const logStt = (e) => fs.appendFileSync(sttLog, JSON.stringify({ ...e, trace, ...(rec ? { rec } : {}) }) + '\n');
      // The clip's own numbers: how long, how loud, how much voiced sound (lib/heard.js wavStats).
      const stats = wavStats(wav);
      const sure = SURELY_FOR_ECHO.includes(String(page.mode));
      // Which microphone it came from: the Mac app's own, or the window's.
      const mic = page.native ? 'app' : 'page';
      // When the speech in it ended and how long it lasted, to tell one sentence recorded by two
      // mics. The clip ended now (the page sends it the moment it ends); the quiet it begins and
      // ends with is left out, so a hands-free clip's trailing second can't overlap what's said next.
      const clipMs = Math.round(stats.seconds * 1000);
      const me = noteClip({ mode: page.mode, mic, endAt: clock() - Math.round((stats.seconds - stats.speechEndSec) * 1000), ms: Math.round((stats.speechEndSec - stats.speechStartSec) * 1000) });
      // Its loudness is that of its voiced frames (the whole clip's when none stood out).
      const sound = { ms: clipMs, level: stats.voicedRms || stats.rms, voicedMs: stats.voicedMs };
      let sttMs = 0;
      /**
       * The one line for a sentence that didn't become a turn: why, how it came in, how long.
       * Never its words. Returns the reply for the page, which always carries the reason.
       * @param {string} reason @param {object} [reply]
       */
      const dropped = (reason, reply = {}) => {
        // This clip came to nothing: a sentence that was waiting for it goes on alone.
        if (waiting?.by === me) letGo(false);
        me.settle('dropped');
        logStt({ at: new Date().toISOString(), event: 'dropped', reason, listenMode: listenMode({ page, clip: sound }, conversationNow(s)), engine, clipMs, voicedMs: stats.voicedMs, sttMs });
        return sendJson(res, { empty: true, engine, ms: sttMs, reason, ...reply });
      };
      /**
       * A second recording of a sentence that has gone through: dropped without a word. `heard`
       * is there for the page, which says "Didn't catch that" only when a reply carries no words.
       * @param {Clip} first
       */
      const twice = (first) => {
        logStt({ at: new Date().toISOString(), event: 'heard_twice', engine, mode: page.mode, first: first.mode, ms: Math.abs(me.endAt - first.endAt) });
        return dropped('heard_twice', { heard: 'heard twice' });
      };
      // Whatever happens to this clip (an error too), a clip waiting on it is let go when the reply closes.
      res.on('close', () => me.settle('dropped'));
      if (appleBlank) return dropped('blank', { engine: 'apple' });
      if (appleOnly) return dropped(page.timedOut || page.final?.timedOut ? 'stt_timeout' : 'stt_unavailable', { engine: 'apple' });
      // The other mic's recording of this sentence has gone through: nothing more to do with this
      // one. Push-to-talk is never dropped unheard: its words are compared first (below).
      const first = me.ptt ? null : await clipLost(me);
      if (first) return twice(first);
      // A short sentence is waiting for the rest of the thought, and this is it arriving (never
      // push-to-talk or "Hey Echo", which are sentences of their own): it waits for these words.
      if (waiting && !waiting.by && !sure) {
        clearTimeout(waiting.timer);
        waiting.by = me;
      }
      // Checked while the clip is transcribed (cached for a few seconds, never slower than 1.5 s).
      const mediaNow = media.playing();
      // Transcribe while talking (lib/sttstream.js): the page streamed this clip as it was said,
      // and when a transcription made at your last pause holds all of it, it's used at once.
      const streamId = String(req.headers['x-echo-stream'] || '').slice(0, 40);
      const streamed = !apple && streamId && engine === 'whisper' ? await streams.final(streamId, wav) : null;
      const heard = apple || streamed?.heard || (await transcribe(wav, { engine, language: s.sttLanguage }));
      // A second listen (lib/secondlisten.js): Apple's words start the turn at once, and local
      // Whisper hears the same clip meanwhile. Started here so it runs alongside everything below.
      const second = apple && secondListenOn(s) && engines().whisper.available ? transcribe(wav, { engine: 'whisper' }).catch(() => null) : null;
      sttMs = heard.ms;
      const { pick, cleaned, entry: blank } = checkHeard({ wav, heard, live, livePreview: s.livePreview, page, clipDir: path.join(config.dataDir, 'stt-blank-clips'), stats, sure });
      if (blank) {
        // Kept for finding the cause: the clip, its loudness, and the page's notes on the mic.
        logStt(blank);
        // Lengths and reasons only: what was heard never goes to the console (or logs/echo.log).
        console.log(`[stt] ${blank.event}: final ${String(heard.text || '').length} chars, used ${pick.source}; ${blank.cause} (${blank.stats.seconds}s, peak ${blank.stats.peak})`);
      }
      if (pick.source === 'none') {
        if (!blank) logStt({ at: new Date().toISOString(), event: 'no_text', engine, reason: cleaned.reason || 'blank' });
        return dropped(cleaned.reason || 'blank');
      }
      const clarity = pick.source === 'final' ? heardClearly(heard) : 'unknown';
      // How close the voice is (vs. the room's own sound), whether something else is playing on
      // the Mac, and whether the room is quiet: a TV must not cancel a step or start a turn.
      // Only in the Mac app: in a browser tab, Echo's own page shares the browser's sound with a video.
      const mediaPlaying = typeof page.mediaPlaying === 'boolean' ? page.mediaPlaying : page.inApp === true ? await mediaNow : false;
      const loud = clipLoudness(wav);
      const quiet = quietRoom({ pageQuiet: page.quiet, loud, mediaPlaying });
      // How the clip sounded, and how loud the owner usually is on the mic it came from (the
      // window's or the Mac app's own): a phone in the room is far quieter (lib/voicelevel.js).
      const clip = { ...sound, ...(loud ? { snrDb: loud.snrDb } : {}) };
      // The rest of a thought whose start is being held: one sentence, before anything is judged.
      // (From here `pick.text` is the whole sentence.)
      let parts = 1;
      if (waiting?.by === me) {
        pick.text = joinParts(waiting.text, WAKE_MODES.includes(String(page.mode)) ? stripWake(pick.text) : pick.text);
        parts = waiting.parts + 1;
        timeline('server', 'speech.joined', { parts, words: pick.text.split(/\s+/).length, ms: Date.now() - waiting.at }, trace);
        letGo(true);
      }
      // One to three words, hands-free, and not whole as it stands ("I just think"): it waits up
      // to 1.6 s for the rest. If more speech comes, that clip takes these words with it and this
      // one ends here; if not, it goes on alone. Push-to-talk is never held.
      {
        const now = conversationNow(s);
        const alone = WAKE_MODES.includes(String(page.mode)) ? stripWake(pick.text) : pick.text;
        const route = dispatcher.routeInput(alone);
        const command = route !== 'turn' || Boolean(dispatcher.localIntentFor(alone)) || Boolean(now.lessonActive && dispatcher.computer.isLessonCommand?.(alone));
        const answering = now.pendingCards > 0 || now.pendingMessages > 0 || awaitsAnswer(recent.findLast((l) => l.startsWith('Assistant: '))?.slice(11) || '');
        if (waitsForMore(alone, { listen: listenMode({ page, clip: sound }, now), command, answering }) && (await holdForMore(alone, parts))) {
          // Its words went on inside the next clip: the other mic's recording of it has nothing to add.
          me.settle('delivered', alone);
          return dropped('joined', { heard: 'joined' });
        }
      }
      // Is it a turn for Echo, an instruction for the step under way, or not for Echo at all?
      // (lib/pipeline/utterance.ts: the same decision, replayable from the logs.)
      headUsed = null;
      let verdict = await decideUtterance({ text: pick.text, page, clarity, loud, quiet, mediaPlaying, live, keepText: Boolean(rec), clip, ownerDb: voice.ownerDb(mic) }, conversationNow(s), { judge: judgeHere });
      // The judging had a head start (probablyDone): how much of its wait was over before the sentence came in.
      if (headUsed) timeline('server', 'speech.head_start', headUsed, trace);
      headUsed = null;
      headStart = null;
      const said = verdict.said;
      // Push-to-talk came in for the same moment while this was being judged: it wins. And a
      // push-to-talk clip of a sentence already answered goes through unless it says the same thing.
      const late = await clipLost(me);
      if (late && (!me.ptt || sameInSubstance(said, late.said))) return twice(late);
      noteSentence(verdict, page.mode);
      // "Can you hear me?" mid-step isn't for the next step: it's answered now (lib/status.js).
      if (verdict.kind === 'hold' && dispatcher.busy && isStatusQuestion(said)) verdict = { ...verdict, kind: 'deliver', noWake: null };
      // Mid-step: it's delivered at the next step, never kept back.
      if (verdict.kind === 'hold') dispatcher.computer.instruct(said, {});
      if (verdict.kind !== 'deliver') {
        logStt({ at: new Date().toISOString(), engine, ...verdict.log });
        // Heard and not passed on: in the conversation log with why, so a session reads back whole.
        transcriptSaid('you', 'unanswered', said, { trace, reason: String(verdict.reply.why || verdict.reply.reason), mode: String(page.mode || ''), engine });
        if (verdict.kind === 'drop' && verdict.dropped) logDroppedWords({ dataDir: config.dataDir, enabled: s.debugDroppedWords, text: said, meta: verdict.dropped });
        return dropped(String(verdict.reply.why || verdict.reply.reason), verdict.reply);
      }
      const noWake = verdict.noWake;
      // Certainly the owner's voice (push-to-talk, "Hey Echo", or Echo's name in it): it teaches
      // how loud the owner usually is on this mic.
      if (sure || noWake?.why === 'name' || nameAnywhere(said)) voice.learn(mic, stats);
      // Every turn that got through without her name is noted (why, how sure, how many words), so
      // a looser gate that lets in the TV shows up in the log.
      if (noWake && noWake.why !== 'name') {
        logStt({ at: new Date().toISOString(), event: 'no_wake_turn', mode: page.mode, engine, why: noWake.why, confidence: noWake.confidence, words: said.split(/\s+/).length, clarity, quiet, mediaPlaying });
      }
      // The newest clips are kept with their loudness and the mic's settings (echo cancellation
      // on?), so a misheard sentence can be played back and checked later.
      let kept = null;
      try {
        kept = path.basename(saveBlankClip(path.join(config.dataDir, 'stt-clips'), wav, RECENT_CLIPS));
      } catch {}
      const audio = { ...stats, loud, quiet, mediaPlaying, clip: kept, aec: page.aec, echoTailMs: page.echoTailMs, mode: page.mode, speechMs: heard.speechMs, keptSeconds: heard.keptSeconds };
      // Every stage, so a misheard turn can be traced: the live listener, Whisper as it came back
      // (with each segment's confidence), what the clean-up dropped, and which one was used.
      // stream: whether the text was made while you talked (reused), and if not, why not.
      const stream = streamed ? { reused: Boolean(streamed.heard), why: streamed.why, waitedMs: streamed.waitedMs, runs: streamed.runs, ...(streamed.specMs !== undefined ? { specMs: streamed.specMs } : {}) } : undefined;
      const stages = { live: typeof live === 'string' ? live : '', whisper: heard.text, segments: heard.segments, dropped: cleaned.dropped, source: pick.source, reason: pick.reason || cleaned.reason, ...(stream ? { stream } : {}) };
      // From here it's on its way to Echo: a second recording of it is dropped (clipLost).
      me.settle('delivered', said);
      // Live text has no word confidences, so nothing is flagged as uncertain.
      const out = await handleUtterance(said, { uncertain: pick.source === 'final' ? heard.uncertain : [], engine: pick.source === 'live' ? `${engine}+live` : engine, sttMs: heard.ms, audio, stages, rec, trace, mayNotBeForEcho: Boolean(verdict.mayNotBeForEcho), soft: softSpoken(clip, voice.ownerDb(mic), String(page.mode || '')) });
      // One whole sentence that went to the assistant as Apple wrote it: Whisper's version may replace it.
      if (second && parts === 1 && pick.source === 'final' && !out.routed) second.then((w) => secondHeard({ apple: said, whisper: w, trace, rec })).catch(() => {});
      return sendJson(res, { ...out, source: pick.source });
    },
    'POST /api/wake': async (req, res) => {
      // A wake-word check from the page (public/wake.js): the first ~1.8 s of a burst of speech.
      // Local Whisper only; the audio and the words are never logged or saved.
      const s = getSettings();
      if (!s.wakeWord || !engines().whisper.available) return sendJson(res, { wake: false, off: true });
      const heard = await wakeTranscribe(await readBody(req, 512 * 1024));
      const m = matchWake(heard.text, { sensitivity: s.wakeSensitivity, lp: heard.lp });
      wakeCounts.checks++;
      if (m.wake) wakeCounts.wakes++;
      return sendJson(res, { wake: m.wake, rest: m.wake ? m.rest : '', ms: heard.ms });
    },
    'GET /api/stt': async (req, res) => {
      const s = getSettings();
      const active = resolveEngine(s.sttEngine);
      // browserLang: what the page sets recognition.lang to (always English).
      // wake: the "Hey Echo" listener needs local Whisper; counts since Echo started, never the words.
      // stream: transcribe-while-talking since Echo started (clips whose early text was used, or not).
      return sendJson(res, { wake: { available: engines().whisper.available, on: s.wakeWord, ...wakeCounts }, stream: { on: STREAM_ON && active === 'whisper', ...streams.counts }, engines: engines(), active, choice: s.sttEngine, language: s.sttLanguage, browserLang: sttLanguageFor('browser', s.sttLanguage), engineLang: sttLanguageFor(active, s.sttLanguage) });
    },
    'GET /api/vocabulary': async (req, res) => sendJson(res, { ...loadVocab(), terms: vocabularyTerms() }),
  };

  /* ---------- the window: speech and typed text over its WebSocket ---------- */
  /** A user_text message: typed (with any images), or said and heard by the browser's own recognizer. @param {any} ws @param {any} msg */
  async function userText(ws, msg) {
    // Typed text (with any attached images) goes straight through; browser-recognized
    // speech goes the way a clip's text does (handleUtterance).
    const images = msg.typed ? resolveAttachments(msg.images) : [];
    const typedText = String(msg.text || '').trim();
    if (msg.typed && (typedText || images.length)) {
      broadcast({ type: 'heard', text: typedText, typed: true, images: images.map((i) => i.url) });
      logConvo('User', typedText + (images.length ? ` _(attached: ${images.map((i) => i.path).join(', ')})_` : ''));
      dispatcher.send(typedText, { trace: newTrace() }, images);
    } else if (!msg.typed && msg.text?.trim()) {
      // Spoken words with no clip to measure (the browser's recognizer, or a clip cut too
      // short): while Echo is mid-step they may only cut in with her name (lib/listening.js).
      // A tap on "Was that for me?" and push-to-talk are the user's own say-so.
      const said = msg.text.trim();
      const lowOverall = typeof msg.confidence === 'number' && msg.confidence < 0.6;
      // The same decision as clips (lib/pipeline/utterance.ts), whichever recognizer heard it. A
      // tap on "Was that for me?" is the user's own say-so.
      if (!msg.tapped) {
        const s = getSettings();
        const clarity = typeof msg.confidence === 'number' ? (msg.confidence >= 0.8 ? 'ok' : msg.confidence < 0.6 ? 'low' : 'unknown') : 'unknown';
        const page = { mode: msg.mode };
        let v = await decideUtterance({ text: said, page, clarity, loud: null, quiet: undefined, mediaPlaying: false }, conversationNow(s), { judge: judgeHere });
        noteSentence(v, msg.mode);
        if (v.kind === 'hold' && dispatcher.busy && isStatusQuestion(said)) v = { ...v, kind: 'deliver', noWake: null };
        if (v.kind === 'hold') dispatcher.computer.instruct(v.said, {});
        if (v.kind !== 'deliver') {
          const trace = newTrace();
          const reason = String(v.reply.why || v.reply.reason);
          fs.appendFileSync(sttLog, JSON.stringify({ at: new Date().toISOString(), trace, engine: 'browser', ...v.log }) + '\n');
          fs.appendFileSync(sttLog, JSON.stringify({ at: new Date().toISOString(), trace, event: 'dropped', reason, listenMode: listenMode({ page }, conversationNow(s)), engine: 'browser' }) + '\n');
          // Never silent: the chip when Echo wasn't sure, and otherwise the reason for the page to show.
          if (v.kind === 'drop' && v.reply.askForMe) ws.send(JSON.stringify({ type: 'set_aside', heard: v.reply.heard || v.said }));
          else ws.send(JSON.stringify({ type: 'dropped', reason }));
          return;
        }
        await handleUtterance(v.said, { engine: 'browser', lowOverall, mayNotBeForEcho: Boolean(v.mayNotBeForEcho) });
        return;
      }
      await handleUtterance(said, { engine: 'browser', lowOverall });
    }
  }

  /** A stt_stream message (public/sttstream.js). @param {any} ws @param {any} msg */
  function streamMessage(ws, msg) {
    // Transcribe while talking: a clip starts, pauses, carries on, or is dropped.
    const id = String(msg.id || '');
    if (msg.op === 'open') {
      if (!STREAM_ON) return;
      const s = getSettings();
      streams.open(ws, id, { mode: String(msg.mode || ''), engine: resolveEngine(s.sttEngine), language: s.sttLanguage });
    } else if (msg.op === 'pause') streams.pause(ws, id);
    else if (msg.op === 'resume') {
      streams.resume(ws, id);
    } else if (msg.op === 'tick') streams.tick(ws, id);
    else if (msg.op === 'close') {
      streams.close(ws, id);
    }
  }

  /** Audio streamed while you talk (public/sttstream.js), a binary WebSocket message. @param {any} ws @param {Buffer} raw */
  function audio(ws, raw) {
    const m = parseAudioMessage(raw);
    if (m) streams.audio(ws, m.id, m.pcm);
  }

  /** A page went away: its streams go with it. @param {any} ws */
  function closed(ws) {
    streams.closeAll(ws);
  }

  return {
    routes,
    handleUtterance,
    logConvo,
    recordingOn,
    userText,
    streamMessage,
    audio,
    closed,
    onset,
    probablyDone,
    /** The conversation window between sentences, for GET /api/settings. */
    get listenState() {
      return listenState;
    },
  };
}
