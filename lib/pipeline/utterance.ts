// What happens to a sentence once it has been transcribed: is it a turn for Echo, an instruction
// held for the step under way, or something to leave alone? One function, given the sentence and
// the state of the conversation, returns a verdict; the server does the I/O (transcribing,
// logging, replying, handing the turn on). Because it's a plain function, every past sentence in
// the logs can be replayed through it (scripts/replay, Stage 0) and a change to how Echo listens
// is measured before it ships (ECHO_CORE_PLAN.md, Stage 1).
//
// There is one way of listening: the conversation window (lib/session.ts). While it's open, what
// you say goes to Echo with the conversation in view and is left alone only on evidence; outside
// it, Echo's name, push-to-talk or "Hey Echo" is needed. (The older path, which judged each
// sentence by itself and ignored 128 real requests, is gone, and so is its `session` flag.)
import { stripWake } from '../wake.js';
import { isBlankText, echoesReply, echoesRecent } from '../heard.js';
import { looksLikeCommand, isImperative, nameAnywhere, continuesTopic, answerShaped } from '../addressed.js';
import { midRunDecision, sinceReplyAtOnset } from '../listening.js';
import { onlyDidntCatch } from '../listenmode.js';
import { awaitsAnswer } from '../../public/autolisten.js';
import { sessionWindow, isNoise, RECALL, RECALL_MS, CLOSING, TALK_START, type Talk, type Window } from '../session.ts';

/** Page modes whose clips may open with "Hey Echo" (it comes off the front). */
export const WAKE_MODES: readonly string[] = ['wake', 'answer', 'run', 'follow'];
/** Clips that are meant for Echo before any check: held-down push-to-talk, and the request after "Hey Echo". */
export const SURELY_FOR_ECHO: readonly string[] = ['push-to-talk', 'wake'];

export type Clarity = 'ok' | 'low' | 'unknown';
/** 'accept' | 'ask' | 'ignore' (kept as a string: the local-model judge returns one). */
export type Judged = { confidence: number; decision: string; why: string };
/** The addressee judge (server.js judgeHere: lib/addressed.js rules, then a local model when unsure). */
export type Judge = (o: Record<string, unknown> & { text: string }) => Promise<Judged>;

/** The page's notes on the clip (public/app.js sendClip, X-Echo-Clip). sinceReplyMs is stamped when the clip is sent. */
export type PageNotes = { mode?: string; sinceReplyMs?: unknown; [k: string]: unknown };

/** How the clip sounded: its length, the loudness (rms) of its voiced frames, how far the voice stands above the room, and ms of voiced sound. */
export type ClipSound = { ms: number; level: number; voicedMs: number; snrDb?: number };

export type Utterance = {
  /** The transcript that was picked (Whisper's, or the live listener's). */
  text: string;
  page: PageNotes;
  clarity: Clarity;
  loud: unknown;
  quiet: boolean | undefined;
  mediaPlaying: boolean;
  /** What the live listener showed (logged when Echo hears its own voice). */
  live?: unknown;
  /** Keep the words of a sentence that was left alone (a recording of it is being kept anyway). */
  keepText?: boolean;
  /** The clip's own numbers (none for words from the browser's recognizer). */
  clip?: ClipSound | null;
  /** How loud the owner usually is on this mic, in dB (lib/voicelevel.js); null: not known yet. */
  ownerDb?: number | null;
};

/** How long after Echo spoke its own recent lines, heard again, are taken as its voice coming back. */
export const OWN_VOICE_MS = 20_000;
/** On a call: how long after Echo spoke anything without its name is taken as the call playing it back. */
export const CALL_ECHO_MS = 4_000;

export type Conversation = {
  /** The last few lines, "User: …" / "Assistant: …", oldest first. */
  recent: readonly string[];
  /** Echo is in a computer-use session (lib/computer.js driving). */
  driving: boolean;
  /** A turn is under way (lib/dispatcher.js busy). */
  busy: boolean;
  /** Confirmation cards waiting for a yes (computer use), and messages waiting to be confirmed (quick actions). */
  pendingCards: number;
  pendingMessages: number;
  lessonActive: boolean;
  wakeWord: boolean;
  /** A call Echo placed is likely still on (lib/quick.js callAt): its own voice may come back through it. */
  inCall?: boolean;
  /** For the conversation window (lib/session.ts): since Echo last spoke, when the page didn't say. */
  sinceReplyMs?: number;
  talk?: Talk;
  closed?: boolean;
  /** The last sentence set aside, for "that was for you". */
  lastSetAside?: { text: string; at: number } | null;
  now?: number;
};

const words = (s: string) => s.split(/\s+/).length;

type LogFields = Record<string, unknown>;
type Reply = Record<string, unknown> & { reason: string };

export type Verdict =
  | { kind: 'deliver'; said: string; noWake: Judged | null; mayNotBeForEcho?: boolean; recalled?: boolean; window?: Window['why'] }
  | { kind: 'hold'; said: string; log: LogFields; reply: Reply; /** Stage 1: delivered at the next step, never kept back. */ nextStep?: boolean }
  | {
      kind: 'drop';
      said: string;
      log: LogFields;
      reply: Reply;
      /** For the dropped-words debug log (lib/droplog.js), when the setting is on. */
      dropped?: { mode: string | undefined; clarity: Clarity; sinceReplyMs?: number; confidence: number };
    };

/** Which way of listening a sentence came in by, for the `dropped` log line (lib/server/speech.js). */
export type ListenMode = 'ptt' | 'wake' | 'run' | 'window' | 'handsfree';

/** The conversation window for this sentence, timed from when the sentence BEGAN. */
function windowFor(u: Pick<Utterance, 'page' | 'clip'>, c: Conversation, lastReply: string): { w: Window; sinceReplyMs: number | undefined; asked: boolean; now: number } {
  const now = c.now ?? Date.now();
  // A reply that only said "I didn't catch that" is no part of a conversation: it asks nothing
  // that counts, and it opens no window for more of what Echo could not follow (Oct 8, 2026).
  const unclear = onlyDidntCatch(lastReply);
  const asked = !unclear && awaitsAnswer(lastReply);
  const pageSince = Number(u.page.sinceReplyMs);
  const sinceReplyMs = unclear ? undefined : sinceReplyAtOnset(Number.isFinite(pageSince) ? pageSince : c.sinceReplyMs, u.clip?.ms);
  // (After "thanks" or "go quiet" an open driving session no longer keeps Echo listening: only a step under way does.)
  const working = (c.driving && (!c.closed || c.busy)) || c.lessonActive || c.pendingCards > 0 || c.pendingMessages > 0;
  const w = sessionWindow({ working, ...(sinceReplyMs !== undefined ? { sinceReplyMs } : {}), asked, talk: c.talk ?? null, closed: Boolean(c.closed), now });
  return { w, sinceReplyMs, asked, now };
}

const lastReplyOf = (c: Conversation) => c.recent.findLast((l) => l.startsWith('Assistant: '))?.slice(11) || '';

/**
 * How the sentence came in: held push-to-talk, after "Hey Echo", while Echo drives the Mac, inside
 * the conversation window, or plain hands-free.
 */
export function listenMode(u: Pick<Utterance, 'page' | 'clip'>, c: Conversation): ListenMode {
  const mode = String(u.page.mode || '');
  if (mode === 'push-to-talk') return 'ptt';
  if (mode === 'wake') return 'wake';
  if (mode === 'run' || c.driving) return 'run';
  if (mode === 'answer' || mode === 'follow') return 'window';
  return windowFor(u, c, lastReplyOf(c)).w.open ? 'window' : 'handsfree';
}

/** How long a sentence of one to three words waits for the rest of the thought (ms). */
export const JOIN_MS = 1600;
/** Once more speech is known to be under way, the longest the first part waits for it (ms). */
export const JOIN_CAP_MS = 15_000;
/** Whole in a word or three: a yes, a no, a thank-you. */
const YES_NO = /^(?:\W*(?:yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|right|correct|exactly|fine|good|great|cool|alright|please|thanks|thank you|got it|not yet)\b\W*){1,3}$/i;

/**
 * Is this the start of a thought that may go on ("I just", "I just think")? People pause
 * mid-thought, and each fragment used to become its own turn. A sentence of one to three words
 * heard hands-free (never push-to-talk or after "Hey Echo") waits a moment for the rest, unless
 * it is whole as it stands: a command, a yes or no, a question, or the answer to one Echo asked.
 * @param o command: Echo acts on it by itself ("stop", "next", "scroll down": the server knows);
 *   answering: Echo asked something, or a card is waiting for a yes
 */
export function waitsForMore(said: string, o: { listen: ListenMode; command?: boolean; answering?: boolean }): boolean {
  const t = String(said || '').trim();
  if (o.listen === 'ptt' || o.listen === 'wake' || o.command || o.answering) return false;
  if (isBlankText(t) || isNoise(t) || words(t) > 3) return false;
  if (/\?\s*$/.test(t) || YES_NO.test(t) || nameAnywhere(t) || isImperative(t)) return false;
  return !(CLOSING.test(t) || RECALL.test(t) || TALK_START.test(t));
}

/** Two parts of one thought as one sentence: "I just think." + "the header is too big" */
export function joinParts(first: string, rest: string): string {
  return `${String(first).trim().replace(/[.!…,]+$/, '')} ${String(rest).trim()}`.trim();
}

/**
 * Why a sentence in an open window may still be left alone: real evidence it isn't for Echo, or a
 * short clip Echo couldn't place by its sound (brief_unsure). Shown as "Was that for me?".
 */
const NOT_FOR_ECHO_WHY = new Set(['media', 'not_english', 'device', 'brief_unsure']);
/** A sound made while thinking, or a recognizer's note ("[BLANK_AUDIO]", "(music)"): no word in it, even on push-to-talk. */
const NO_WORD = /^(?:[*[(].*[*\])]|\W*(?:um+|uh+|hm+|mm+|mhm|ah+|eh|er+)\W*)$/i;
/** The same from the clip's sound (lib/voicelevel.js): a phone or the room, left alone without a chip. */
const NOT_THE_OWNER_WHY = new Set(['faint', 'brief']);

/**
 * Shaped like something said to Echo: its name, a request, "you", a question, an answer to its
 * question, or more on what they were just talking about. TV narration ("and in other news…")
 * is none of these. Used when something is playing and the judge isn't sure.
 */
export function addressedShape(text: string, { question = '', context = [] as readonly string[] } = {}): boolean {
  const t = String(text || '').trim();
  return (
    nameAnywhere(t) ||
    isImperative(t) ||
    /\b(?:you|your|you're|yours)\b/i.test(t) ||
    /\?\s*$/.test(t) ||
    /^(?:what|why|how|where|when|who|which|can|could|would|will|should|do|does|did|is|are|was|were)\b/i.test(t) ||
    answerShaped(t, question) ||
    continuesTopic(t, [...context])
  );
}

/**
 * Decide what to do with a transcribed sentence. Order: "Hey Echo" off the front (nothing left:
 * not a turn), "that was for you", push-to-talk and "Hey Echo" (always for Echo), noise, Echo
 * hearing its own voice, then the conversation window.
 *
 * Inside the window everything real goes to Echo with the conversation in view; it's left alone
 * only on evidence (the TV or a video playing, another language, talk about some other device:
 * shown as a "Was that for me?" chip; or a clip that doesn't sound like the owner: a phone, a
 * blip). When the judge isn't sure, the assistant gets the sentence with a note and may stay
 * quiet. Outside the window: its name, push-to-talk or "Hey Echo".
 */
export async function decideUtterance(u: Utterance, c: Conversation, { judge }: { judge: Judge }): Promise<Verdict> {
  const mode = u.page.mode;
  const said = WAKE_MODES.includes(String(mode)) ? stripWake(u.text) : u.text;
  if (isBlankText(said)) return { kind: 'drop', said, log: { event: 'wake_only' }, reply: { reason: 'wake_only' } };

  const lastReply = lastReplyOf(c);
  const { clarity, loud, quiet, mediaPlaying } = u;
  const short = said.slice(0, 200);
  const { w, sinceReplyMs, asked, now } = windowFor(u, c, lastReply);
  // "That was for you": the last sentence set aside goes through as it was said.
  if (RECALL.test(said) && c.lastSetAside && now - c.lastSetAside.at <= RECALL_MS) {
    return { kind: 'deliver', said: c.lastSetAside.text, noWake: null, recalled: true };
  }
  // Push-to-talk and "Hey Echo" are the user's own say-so (and Echo isn't talking then): even
  // "you can delete it", echoing Echo's own question back, is an answer, not Echo's voice. They
  // are never judged, by words or by sound, and this comes BEFORE the noise check: a held-key
  // "So?" or "Oh" is a real word said on purpose, where hands-free it would be a stray sound.
  if (SURELY_FOR_ECHO.includes(String(mode)) && !NO_WORD.test(said.trim())) return { kind: 'deliver', said, noWake: null };
  if (isNoise(said)) return { kind: 'drop', said, log: { event: 'noise', text: short, mode }, reply: { reason: 'noise' } };
  if (echoesReply(said, lastReply)) return { kind: 'drop', said, log: { event: 'own_voice', text: said, live: u.live }, reply: { reason: 'own_voice' } };
  // Its last few lines coming back (a call or a screen share plays Echo's voice to the other
  // side and some of it returns): within a short while of Echo speaking, not long after.
  const echoLines = c.recent.filter((l) => l.startsWith('Assistant: ')).slice(-4).map((l) => l.slice(11));
  if ((sinceReplyMs === undefined || sinceReplyMs < OWN_VOICE_MS) && echoesRecent(said, echoLines)) return { kind: 'drop', said, log: { event: 'own_voice', text: said, live: u.live, why: 'recent' }, reply: { reason: 'own_voice' } };
  // On a call with sound still going, what arrives right after Echo spoke is most likely Echo
  // (garbled by the call, so its words can't be matched) or the other person: only its name gets through.
  if (c.inCall && u.mediaPlaying && sinceReplyMs !== undefined && sinceReplyMs < CALL_ECHO_MS && !nameAnywhere(u.text)) return { kind: 'drop', said, log: { event: 'own_voice', text: short, why: 'call' }, reply: { reason: 'own_voice' } };

  // How the clip sounded goes to the judge with every question it's asked.
  const sound = u.clip ? { clip: { level: u.clip.level, voicedMs: u.clip.voicedMs, ...(u.clip.snrDb !== undefined ? { snrDb: u.clip.snrDb } : {}) }, ownerDb: u.ownerDb ?? null } : {};
  /** Left alone because it doesn't sound like the owner: no chip (a phone would raise one every sentence), its words kept only with its recording. */
  const notTheOwner = (judged: Judged, window: Window['why']): Verdict => ({
    kind: 'drop', said,
    log: { event: 'not_for_echo', mode, window, words: words(said), clarity, confidence: judged.confidence, why: judged.why, ...u.clip, ownerDb: u.ownerDb, ...(u.keepText ? { text: short } : {}) },
    reply: { reason: 'not_for_echo', why: judged.why },
    dropped: { mode, clarity, ...(sinceReplyMs !== undefined ? { sinceReplyMs } : {}), confidence: judged.confidence },
  });

  if (w.open) {
    // Mid-step on the Mac: "stop" / "wait" / "no, the other one" cut in when clear and close;
    // anything else is delivered at the next step boundary, never dropped.
    if (c.driving && c.busy) {
      const judged = await judge({ text: said, clarity, driving: true, followUp: true, pendingQuestion: c.pendingCards > 0, quiet, mediaPlaying, ...sound });
      if (NOT_THE_OWNER_WHY.has(judged.why)) return notTheOwner(judged, w.why);
      const d = midRunDecision({ text: said, decision: judged.decision === 'ignore' && !mediaPlaying ? 'accept' : judged.decision, busy: true, answering: c.pendingCards > 0, clarity, loud: loud as any, mediaPlaying });
      if (d.action === 'cut' || d.action === 'go') return { kind: 'deliver', said, noWake: judged, window: w.why };
      if (d.action === 'hold' || (d.action === 'ask' && !mediaPlaying)) {
        return { kind: 'hold', said, nextStep: true, log: { event: 'run_next_step', text: short, clarity, mode, confidence: judged.confidence, why: d.why }, reply: { reason: 'next_step', heard: short } };
      }
    }
    const judged = await judge({
      text: said, clarity, followUp: true, ...(sinceReplyMs !== undefined ? { sinceReplyMs } : {}),
      pendingQuestion: c.pendingCards > 0 || c.pendingMessages > 0, awaitingAnswer: asked, question: lastReply,
      context: c.recent.slice(-6), quiet, mediaPlaying, ...sound,
    });
    if (judged.decision === 'accept') return { kind: 'deliver', said, noWake: judged, window: w.why };
    if (NOT_THE_OWNER_WHY.has(judged.why)) return notTheOwner(judged, w.why);
    // Left alone only on evidence: the judge's own (another language, a device, a video) or, with
    // something playing, a sentence that isn't shaped like one said to Echo.
    const playingAndNotToEcho = mediaPlaying && !addressedShape(said, { question: lastReply, context: c.recent.slice(-6) });
    // (The local model may have had its say on an unsure one: "brief_unsure+local".)
    if (NOT_FOR_ECHO_WHY.has(judged.why.replace(/\+local$/, '')) || playingAndNotToEcho) {
      return {
        kind: 'drop', said,
        log: { event: 'not_for_echo', mode, window: w.why, words: words(said), clarity, confidence: judged.confidence, why: judged.why, text: short },
        reply: { reason: 'not_for_echo', heard: short, askForMe: true },
        dropped: { mode, clarity, ...(sinceReplyMs !== undefined ? { sinceReplyMs } : {}), confidence: judged.confidence },
      };
    }
    return { kind: 'deliver', said, noWake: judged, mayNotBeForEcho: true, window: w.why };
  }

  // Window closed: its name, a clear question to it in a quiet room, or nothing.
  if ((mode === 'hands-free' && c.wakeWord) || mode === 'follow' || mode === 'answer' || mode === 'run') {
    const judged = await judge({ text: said, clarity, context: c.recent.slice(-6), quiet, mediaPlaying, ...sound });
    if (judged.decision === 'accept') return { kind: 'deliver', said, noWake: judged, window: 'closed' };
    if (NOT_THE_OWNER_WHY.has(judged.why)) return notTheOwner(judged, 'closed');
    const command = looksLikeCommand(said, clarity) || judged.decision === 'ask';
    return {
      kind: 'drop', said,
      log: { event: 'not_for_echo', mode, window: 'closed', words: words(said), clarity, confidence: judged.confidence, ...(command || u.keepText ? { text: short } : {}) },
      reply: { reason: 'not_for_echo', ...(command ? { looksLikeCommand: true, heard: short } : {}), ...(judged.decision === 'ask' ? { askForMe: true } : {}) },
      dropped: { mode, clarity, ...(sinceReplyMs !== undefined ? { sinceReplyMs } : {}), confidence: judged.confidence },
    };
  }
  return { kind: 'deliver', said, noWake: null, window: 'closed' };
}
