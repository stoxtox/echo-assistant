// "Is this for me?": which hands-free speech Echo acts on, and which she leaves alone.
//
// - Hands-free with the wake word on (addressedToEcho): her name, a follow-up inside the follow-up
//   window after her last reply (followUpSeconds), or something that clearly carries on the
//   current topic a little later ("open the second one" after she listed videos).
// - While she drives the Mac (midRunGate): only "Echo…"/"stop…"/"wait…", a clear spoken command
//   ("scroll down", "open YouTube"), or an answer to a question she just asked. Room talk and TV
//   fragments ("Memory", "And then what is it?") are ignored and never cancel the step under way.
//   A spoken "stop" always wins.
// - The auto-listen window after she asked something (answerGate): no name needed, but another
//   language, faint talk or a long unrelated stretch (a TV, a call) is left alone.
// - A dropped utterance that looked like a real command (looksLikeCommand) is shown dimmed with a
//   hint to say "Echo", so a drop is never silent.
// - judgeAddressee (addressee v1) puts all of these signals into one confidence: at 0.8 or more
//   it's for Echo, under 0.4 it's left alone, and in between Echo asks "Was that for me?" with a
//   chip you can tap, instead of dropping it silently. Her name anywhere counts (not "Echo Dot"),
//   a short confirmation after she asked ("you can send it", "I think that's perfect") counts,
//   and so does a clear direct question to her ("what can you do?") in a quiet room.
// - The sound of the clip counts too (lib/voicelevel.js): far quieter than the owner usually is
//   is a phone or the room, whatever the window. A blip with no name, answer or command in it is
//   left alone too, but never silently inside an open conversation: a short question ("Why?",
//   "Which one?") or real words at the owner's own level go through, and anything less sure is
//   asked about ("Was that for me?").
import { addressesEcho } from './heard.js';
import { notTheOwner, atOwnerLevel } from './voicelevel.js';
import { oddWords, plainWords } from './secondlisten.js';
import { vocabularyTerms, peopleNames, installedAppNames } from './vocab.js';
import { isStopCommand, isPauseCommand } from './computer.js';

const words = (s) => String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/** A segment's average log-probability at or above this is heard clearly enough for a command. */
export const COMMAND_MIN_LP = -0.6;
/** Word confidences (Deepgram) averaging at least this. */
export const COMMAND_MIN_P = 0.6;
/** How long after her last reply something that carries on the topic still counts as for her. */
export const TOPIC_WINDOW_MS = 3 * 60 * 1000;

/** Verbs a spoken command starts with ("open YouTube", "scroll down", "search for otters"). */
const VERBS = new Set(`open close play pause resume stop wait search find look type click tap press scroll go show tell read
write send check call text email message start run make create add remove delete save turn set put move select choose pick
skip watch listen launch quit try use switch change fix give get bring take zoom mute unmute restart reply answer explain
summarize summarise translate remind schedule book download upload copy paste undo redo refresh reload sign log enter submit
fill hit hold keep help describe list count compare draft edit update cancel back continue repeat navigate visit browse
lower raise increase decrease minimize maximise maximize hide unhide sort filter share print record stream subscribe like
follow join leave accept decline approve reject install uninstall rename`.split(/\s+/));
/** Polite or linking words before the verb: "please open…", "can you scroll…", "okay now go back". */
const LEAD = new Set(['and', 'please', 'now', 'okay', 'ok', 'so', 'just', 'hey', 'also', 'alright', 'right', 'um', 'uh', 'yeah', 'then']);
const ASKS = /^(can|could|would|will) you (please )?/;

/**
 * How clearly the recognizer heard it: 'ok', 'low', or 'unknown' (no scores, e.g. live text).
 * @param {{ segments?: Array<{ lp?: number }>, words?: Array<{ p?: number }> } | null | undefined} heard
 */
export function heardClearly(heard) {
  const lps = (heard?.segments || []).map((s) => s.lp).filter((x) => typeof x === 'number');
  if (lps.length) return lps.reduce((a, b) => a + b, 0) / lps.length >= COMMAND_MIN_LP ? 'ok' : 'low';
  const ps = (heard?.words || []).map((w) => w.p).filter((x) => typeof x === 'number');
  if (ps.length) return ps.reduce((a, b) => a + b, 0) / ps.length >= COMMAND_MIN_P ? 'ok' : 'low';
  return 'unknown';
}

/**
 * In the user's language (Echo's recognition is locked to English): Latin letters, and not a
 * spelled-out string of single letters ("Q. A. L. A.").
 * @param {string} text
 */
export function inUserLanguage(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return false;
  const latin = letters.filter((c) => /[a-z]/i.test(c)).length;
  const w = words(text);
  // Single letters (not digits: "5 minutes" is English).
  const singles = w.filter((x) => x.length === 1 && /\p{L}/u.test(x) && x !== 'a' && x !== 'i').length;
  return latin / letters.length >= 0.9 && singles * 2 < w.length;
}

/**
 * Sounds written down as words: another language heard by a recogniser locked to English
 * ("Kabadi Paji Amar Kaam karo zaroori Ne", "Saru Chalo", "Barabar"). Oct 8, 2026: a talk in
 * another language beside the Mac got twenty answers. Half or more of the words (two at least)
 * are in no English dictionary, or a word or two that are all like that. Names the user is known
 * to use (their vocabulary, contacts, apps, and what was just said in the conversation) are not
 * odd: "Stoxtox daily errors" and "tell Mira" are English.
 * @param {string} text @param {string[]} [context] the last few lines of the conversation
 */
export function soundsForeign(text, context = []) {
  const w = plainWords(text);
  if (!w.length) return false;
  const known = new Set([...vocabularyTerms(), ...peopleNames(), ...installedAppNames(), ...context].flatMap((x) => plainWords(String(x))));
  const real = w.filter((x) => !/^\d/.test(x) && x.length > 1);
  const odd = oddWords(w).filter((x) => !known.has(x) && !/^(echo|eko|ekko|ok|okay|yeah|yep|nope|hmm|uh|um|mm)$/.test(x));
  if (!real.length || !odd.length) return false;
  if (real.length <= 2) return odd.length === real.length;
  return odd.length >= 2 && odd.length / real.length >= 0.5;
}

/**
 * The words of a sentence no English dictionary has and nothing here explains (the user's
 * vocabulary, contacts, apps, the conversation), beside how many real words it has.
 * @param {string} text @param {string[]} [context]
 * @returns {{ real: number, odd: string[] }}
 */
export function unknownWords(text, context = []) {
  const w = plainWords(text);
  const known = new Set([...vocabularyTerms(), ...peopleNames(), ...installedAppNames(), ...context].flatMap((x) => plainWords(String(x))));
  return {
    real: w.filter((x) => !/^\d/.test(x) && x.length > 1).length,
    odd: oddWords(w).filter((x) => !known.has(x) && !/^(echo|eko|ekko|eco|ecco|ok|okay|yeah|yep|nope|hmm|uh|um|mm|webpage|website)$/.test(x)),
  };
}

/**
 * A clear spoken command: verb-led, at least two words ("open YouTube", "can you scroll down").
 * @param {string} text
 */
export function isImperative(text) {
  let t = words(text).join(' ').replace(ASKS, '');
  let w = t.split(' ').filter(Boolean);
  while (w.length && LEAD.has(w[0])) w = w.slice(1);
  if (w.length < 2 || w.length > 30) return false;
  t = w.join(' ');
  // "and then what is it?", "look who's here" are chatter, not commands.
  if (/^(look who|go figure|get this|tell me about it$)/.test(t)) return false;
  return VERBS.has(w[0]);
}

/** A request put another way: "can you…", "I want to…", "let's…". */
const REQUEST = /^(?:(?:hey|okay|ok|so|um|uh) )*(?:(?:can|could|would|will) you|i (?:want|wanna|need|would like|'d like)|i'd like|let's|lets|please) /;

/**
 * Did a dropped utterance look like a real command (worth showing "say 'Echo'…")? A clear command
 * or request ("can you…"), heard clearly, in the user's language.
 * @param {string} text @param {'ok' | 'low' | 'unknown'} [clarity]
 */
export function looksLikeCommand(text, clarity = 'unknown') {
  if (clarity === 'low' || !inUserLanguage(text)) return false;
  return isImperative(text) || (words(text).length >= 3 && REQUEST.test(words(text).join(' ')));
}

const STOPWORDS = new Set(`the and that this with from have what when where which there their them they then than your you yours
about into just like some more most much very will would could should been being were was are is it its it's for not but
can can't don't doesn't did does okay yeah yes please thanks thank here also only over under again still even really
something anything everything thing things one ones want need know think make made going gonna echo`.split(/\s+/));
const contentWords = (s) => new Set(words(s).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));

/**
 * Does this clearly carry on the current topic? It shares two content words with the recent
 * conversation, or one plus being a clear command ("open the lofi playlist" after she listed
 * playlists).
 * @param {string} text @param {string[]} context recent lines ("User: …", "Assistant: …")
 */
export function continuesTopic(text, context = []) {
  if (!inUserLanguage(text)) return false;
  const mine = contentWords(text);
  if (!mine.size) return false;
  const ctx = contentWords(context.map((l) => String(l).replace(/^(User|Assistant): /, '')).join(' '));
  const shared = [...mine].filter((w) => ctx.has(w)).length;
  return shared >= 2 || (shared >= 1 && isImperative(text));
}

/**
 * Hands-free with the wake word on: is this speech meant for Echo?
 * @param {{ text: string, followUp?: boolean, sinceReplyMs?: number, context?: string[], clarity?: 'ok' | 'low' | 'unknown' }} o
 * @returns {{ ok: boolean, why: 'name' | 'follow_up' | 'topic' | 'not_for_echo' }}
 */
export function addressedToEcho({ text, followUp = false, sinceReplyMs, context = [], clarity = 'unknown' }) {
  if (addressesEcho(text)) return { ok: true, why: 'name' };
  if (followUp) return { ok: true, why: 'follow_up' };
  const recentReply = typeof sinceReplyMs === 'number' && sinceReplyMs >= 0 && sinceReplyMs < TOPIC_WINDOW_MS;
  if (recentReply && clarity !== 'low' && continuesTopic(text, context)) return { ok: true, why: 'topic' };
  return { ok: false, why: 'not_for_echo' };
}

/** A short reply to a question: "yes", "no thanks", "the second one", "sure, go ahead". */
const SHORT_ANSWER = /^(?:(?:um|uh|oh|well|hmm) )*(?:yes|yeah|yep|yup|no|nope|nah|sure|okay|ok|alright|fine|please|definitely|absolutely|of course|go ahead|do it|send it|not now|later|maybe|both|neither|none|either|all of them|the (?:first|second|third|fourth|last|other|top|bottom)(?: one| option)?|(?:first|second|third|last) one|one|two|three|four|five)\b/;
/** Past this many words, clear speech that neither says her name nor touches the topic is someone else talking. */
export const ANSWER_MAX_WORDS = 20;

const NUMBER = /^(?:(?:um|uh|the|number|option|about|maybe) )*(?:\d+(?:[.:]\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|a hundred|half)(?: (?:\d+|minutes?|hours?|pm|am|o'clock|percent|of them|please|thanks))*$/;
/** Echo's question asks for a person: "who should I send it to?", "which contact?". */
const ASKS_WHO = /\b(who|whom|whose|which (?:contact|person|one of them)|what(?:'s| is) (?:the|their|his|her) name|send (?:it|this|that) to|to whom)\b/i;

/** Echo asked to be told when something is ready, or to be shown it. */
const ASKS_WHEN = /\b(?:tell me|let me know|say) when\b|\bwhenever you'?re ready\b|\bgo ahead\b|\bshow me\b|\bwhen you(?:'ve| have| are|'re)\b/i;
/** "It's ready": what people say as they hand something over. */
const READY = /^(?:(?:okay|ok|alright|all right|so|yeah|yes|echo|and|now) )*(?:(?:there|here) (?:you go|it is|they are|we go|you are|are the \w+|is the \w+)|(?:it'?s|that'?s|this is) (?:it|open|up|ready|done|there|here)|got it|done|ready|look|see|now|take a look|have a look|can you see (?:it|that|this))\b/;

/**
 * Is this shaped like an answer to Echo's question? Yes / no / a confirmation, a number, one of
 * the choices she offered ("jazz" to "lofi or jazz?"), or a name when she asked who. Short only.
 * @param {string} text @param {string} [question] her reply that asked it
 */
export function answerShaped(text, question = '') {
  const w = words(text);
  if (!w.length || w.length > 8 || !inUserLanguage(text)) return false;
  const t = w.join(' ');
  if (SHORT_ANSWER.test(t) || CONFIRM.test(t)) return true;
  // She asked to be told when ("tell me when you've got it open"): "there you go", "here it is".
  if (ASKS_WHEN.test(String(question)) && READY.test(t)) return true;
  if (w.length > 4) return false;
  if (NUMBER.test(t)) return true;
  const q = new Set(words(question));
  const content = w.filter((x) => x.length >= 3 && !STOPWORDS.has(x) && !['the', 'one', 'that', 'this', 'please'].includes(x));
  // A choice she offered: every content word was in her question.
  if (content.length && content.every((x) => q.has(x))) return true;
  // A name when she asked who: "Sam", "to Alex Chen". Written with capitals by the recognizer.
  if (ASKS_WHO.test(String(question)) && w.length <= 3) {
    const raw = String(text).replace(/[.,!?]/g, ' ').trim().split(/\s+/).filter((x) => !/^(to|uh|um|the)$/i.test(x));
    return raw.length > 0 && raw.every((x) => /^\p{Lu}/u.test(x));
  }
  return false;
}

/**
 * The auto-listen window after Echo asked something (public/autolisten.js): the mic opened by
 * itself, so no "Echo" is needed, but a TV or someone else talking must not become a turn.
 * Accepted: her name or "stop", a short answer, a clear command, or anything that carries on
 * the topic. Dropped: another language, something heard only faintly that isn't a short answer,
 * or a long stretch of talk that has nothing to do with her question.
 * @param {{ text: string, clarity?: 'ok' | 'low' | 'unknown', context?: string[] }} o
 * @returns {{ accept: boolean, why: 'stop' | 'name' | 'answer' | 'command' | 'topic' | 'not_for_echo' }}
 */
export function answerGate({ text, clarity = 'unknown', context = [] }) {
  if (isStopCommand(text)) return { accept: true, why: 'stop' };
  if (addressesEcho(text)) return { accept: true, why: 'name' };
  const w = words(text);
  if (!w.length || !inUserLanguage(text)) return { accept: false, why: 'not_for_echo' };
  const short = SHORT_ANSWER.test(w.join(' ')) && w.length <= 8;
  if (short) return { accept: true, why: 'answer' };
  if (clarity === 'low') return { accept: false, why: 'not_for_echo' };
  if (isImperative(text)) return { accept: true, why: 'command' };
  if (continuesTopic(text, context)) return { accept: true, why: 'topic' };
  if (w.length > ANSWER_MAX_WORDS) return { accept: false, why: 'not_for_echo' };
  return { accept: true, why: 'answer' };
}

/**
 * While Echo drives the Mac: is this a command for her, or talk around the mic to leave alone?
 * @param {{ text: string, clarity?: 'ok' | 'low' | 'unknown', pendingQuestion?: boolean }} o
 * @returns {{ accept: boolean, why: 'stop' | 'name' | 'answer' | 'command' | 'not_a_command' }}
 */
export function midRunGate({ text, clarity = 'unknown', pendingQuestion = false }) {
  if (isStopCommand(text)) return { accept: true, why: 'stop' };
  const w = words(text);
  let i = 0;
  while (i < w.length - 1 && ['hey', 'ok', 'okay', 'oh', 'no'].includes(w[i])) i++;
  if (/^(echo|eko|ekko|ekho|eco|ecco|stop|wait)$/.test(w[i] || '') || addressesEcho(text)) return { accept: true, why: 'name' };
  if (pendingQuestion && clarity !== 'low' && w.length) return { accept: true, why: 'answer' };
  if (clarity !== 'low' && inUserLanguage(text) && isImperative(text)) return { accept: true, why: 'command' };
  return { accept: false, why: 'not_a_command' };
}

/* ---------- addressee v1: one confidence for "is this for me?" ---------- */

/** In a long stretch of talk, words that turn it toward Echo ("let's keep it that way", "can you…"), where "I was saying to him…" is to someone else. */
const TO_ECHO = /\b(?:you|your|you're|let's|lets|please|we should|go ahead)\b/;
/** A conversation is live for this long after Echo's last word: what the owner says next, clearly and at their usual level, is for Echo. */
export const LIVE_TALK_MS = 75 * 1000;
/** At or above: for Echo. */
export const ACCEPT_AT = 0.8;
/** At or above (and under ACCEPT_AT): ask "Was that for me?". Under: left alone. */
export const ASK_AT = 0.4;

/** "Echo" as a device or a thing, not her: the Echo Dot, an echo chamber. */
const NOT_HER = /\b(echo|eko|eco)\s+(dot|show|studio|pop|auto|buds|chamber|park|location|sounder|cardiogram|ultrasound|boomers?|generation)\b|\b(an|the|that|this|of) echo\b(?!,)(?! (?:app|application|window|session|chat|project|tab|settings|menu|conversation|log|build|icon)\b)/;

/**
 * Her name anywhere in what was said ("Sam, Echo, open it", "can you do that, Echo"), not a
 * device ("turn on the Echo Dot") or the word used as a word ("there's an echo in here").
 * @param {string} text
 */
export function nameAnywhere(text) {
  const t = words(text).join(' ');
  if (addressesEcho(text)) return !NOT_HER.test(t) || /^(hey |ok |okay )?(echo|eko|ekko|eco)\b/.test(t);
  return /(^| )(echo|eko|ekko|ekho)( |$)/.test(t) && !NOT_HER.test(t);
}

/** A confirmation of what Echo just did or proposed ("you can send it", "I think that's perfect"). */
const CONFIRM = /^(?:(?:um|uh|oh|okay|ok|yeah|yes|so|and|well|i think|i guess) )*(?:you can (?:send|go|do|post|submit|click|press|close|open|save|play|stop)\b|go ahead\b|send it\b|do it\b|that'?s (?:perfect|great|good|fine|right|correct|it|the one)\b|that (?:looks|sounds|is) (?:good|great|perfect|right|fine)\b|looks (?:good|great|perfect|right|fine)\b|sounds (?:good|great|perfect)\b|perfect\b|great\b|correct\b|exactly\b|yes\b|yeah\b|yep\b|no\b|nope\b|not that one\b|the other one\b|wrong one\b)/;

/** Lines from a video or the TV that sound like commands ("subscribe and hit the bell"). */
const MEDIA = /\b(subscribe|hit the bell|smash (?:that|the) like|like and subscribe|link in the description|in the description below|coming up next|stay tuned|after the break|brought to you by|this video is sponsored|don'?t forget to)\b/;

/** A question put straight to her: "what can you do?", "can you open my calendar", "tell me…". */
const DIRECT = /(?:^|[.?!] )(?:(?:hey|okay|ok|so|um|uh|and) )*(?:(?:can|could|would|will|do|did|are|have) you\b|what (?:can|do|did|are|have) you\b|tell me\b|show me\b|remind me\b|help me\b|how do i\b|how can i\b|what'?s (?:on )?my\b|what (?:is|are) my\b|where'?s my\b|when is my\b|read me\b|what time is it\b|what day is it\b|what(?:'s| is) the (?:time|date|weather|temperature)\b|how(?:'s| is) the weather\b|is it (?:going to|gonna) rain\b|do i have (?:any )?(?:new )?(?:emails?|messages?|meetings?|anything)\b|did i get (?:any )?(?:emails?|messages?)\b)/;

/** A short question in a conversation: "Why?", "Really?", "Which one?", "And then?". */
const QUESTION = /^(?:(?:and|so|but|oh|ok|okay|wait|um|uh) )*(?:what|why|how|where|when|who|whom|whose|which|really|can|could|would|will|should|shall|do|does|did|is|are|was|were|am|have|has)\b/;
/** Sounds made while thinking, not words. */
const HESITATION = /^(?:um+|uh+|hm+|mm+|mhm|ah+|eh|er+)$/;

/**
 * Addressee v1: how sure is Echo that this speech is meant for her, and what to do about it.
 * @param {{ text: string, clarity?: 'ok' | 'low' | 'unknown', driving?: boolean, pendingQuestion?: boolean,
 *   followUp?: boolean, sinceReplyMs?: number, context?: string[], quiet?: boolean, mediaPlaying?: boolean,
 *   awaitingAnswer?: boolean, question?: string,
 *   clip?: { level?: number, snrDb?: number, voicedMs?: number } | null, ownerDb?: number | null }} o
 *   awaitingAnswer: her last reply asked something and nothing has answered it yet (no time
 *   limit); only answer-shaped replies count for it (answerShaped). question: that reply.
 *   sinceReplyMs: from the end of her reply to when the sentence BEGAN (lib/listening.js sinceReplyAtOnset).
 *   clip: how the clip sounded (the loudness of its voiced frames, how far above the room, ms of voiced sound), and
 *   ownerDb: how loud the owner usually is on that mic (lib/voicelevel.js; null: not known yet).
 * @returns {{ confidence: number, decision: 'accept' | 'ask' | 'ignore', why: string }}
 */
export function judgeAddressee({ text, clarity = 'unknown', driving = false, pendingQuestion = false, followUp = false, sinceReplyMs, context = [], quiet, mediaPlaying = false, awaitingAnswer = false, question = '', clip = null, ownerDb = null }) {
  const w = words(text);
  const t = w.join(' ');
  const out = (confidence, why) => {
    const c = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
    return { confidence: c, decision: /** @type {'accept' | 'ask' | 'ignore'} */ (c >= ACCEPT_AT ? 'accept' : c >= ASK_AT ? 'ask' : 'ignore'), why };
  };
  if (!w.length) return out(0, 'empty');
  if (isStopCommand(text)) return out(1, 'stop');
  if (driving && isPauseCommand(text)) return out(1, 'pause');
  if (NOT_HER.test(t)) return out(0.5, 'device');
  if (nameAnywhere(text)) return out(0.97, 'name');
  // Not the owner's voice by its sound, whatever window is open: a phone on the desk was taken
  // as the user six times in seven minutes because a follow-up scored 0.9 "whatever the sound".
  // "stop" and her name (above) never depend on it. A short clip still counts when it answers
  // her question ("yes", "the second one") or is a clear command ("go back").
  const sound = notTheOwner(clip, ownerDb);
  if (sound === 'faint') return out(0.1, 'faint');
  if (sound === 'brief' && !isImperative(text) && !((pendingQuestion || awaitingAnswer) && answerShaped(text, question))) {
    // In an open conversation a short clip is not a blip by its length alone: "Why?", "Really?",
    // "Which one?" and "And then?" were ignored. A question, or real words as loud as the owner
    // usually is, carries on below as any follow-up does; real words Echo can't place by their
    // sound are asked about (the "Was that for me?" chip), never dropped without a sign.
    const inWindow = followUp || pendingQuestion || awaitingAnswer;
    const real = inUserLanguage(text) && w.some((x) => x.length >= 2 && !HESITATION.test(x));
    const asking = /\?\s*$/.test(String(text).trim()) || QUESTION.test(t);
    if (!inWindow || !real) return out(0.1, 'brief');
    if (!asking && !atOwnerLevel(clip, ownerDb)) return out(0.5, 'brief_unsure');
  }
  if (!inUserLanguage(text)) return out(0.05, 'not_english');
  // Sounds written as words (another language): left alone, unless Echo is waiting for a name or a word it asked for.
  if (!(pendingQuestion || awaitingAnswer) && soundsForeign(text, context)) return out(0.05, 'not_english');
  if (MEDIA.test(t)) return out(0.1, 'media');
  const low = clarity === 'low';
  // Sentences kept apart ("I said something to you. Can you copy that?"), punctuation dropped.
  const sentences = String(text || '').toLowerCase().replace(/[’‘]/g, "'").split(/[.?!]+/).map((x) => words(x).join(' ')).filter(Boolean);
  const direct = sentences.some((x) => DIRECT.test(x));
  const damp = (c) => (low ? c * 0.7 : c) - (mediaPlaying ? 0.15 : 0);
  const short = w.length <= 8;
  // Replies to her question, and confirmations while she works: "You can send it" was dropped.
  if (pendingQuestion && short && (SHORT_ANSWER.test(t) || CONFIRM.test(t))) return out(damp(0.95), 'answer');
  if ((pendingQuestion || driving) && w.length <= 10 && CONFIRM.test(t)) return out(damp(0.9), 'confirm');
  if (pendingQuestion && !driving) {
    const g = answerGate({ text, clarity, context });
    // A reply that's not a short answer, a command or on the topic: likely, not certain.
    if (g.accept) return out(damp(g.why === 'answer' ? (w.length <= 5 ? 0.85 : 0.65) : 0.88), g.why);
  }
  // Her question is still open, however long ago she asked: "yeah", "the second one", "Sam".
  if (awaitingAnswer && answerShaped(text, question)) return out(damp(0.92), 'answer');
  // Inside the follow-up window: a long stretch that's not on the topic, not a command and not a
  // question to her is more likely a call or the TV (the window is open longer now: conversation mode).
  // A live conversation (Oct 8, 2026: "Actually, Claude" and a 23-word answer were asked about
  // because some other app had sound going): Echo spoke less than LIVE_TALK_MS before this began,
  // the words are clear, and the voice is as loud as the owner usually is. Sound from elsewhere
  // does not lower the bar then, and a long answer is still an answer.
  const live = followUp && !low && typeof sinceReplyMs === 'number' && sinceReplyMs >= 0 && sinceReplyMs < LIVE_TALK_MS && atOwnerLevel(clip, ownerDb);
  if (followUp && w.length > ANSWER_MAX_WORDS && !isImperative(text) && !direct && !continuesTopic(text, context)) return live && TO_ECHO.test(t) ? out(0.82, 'follow_up_live') : out(damp(0.6), 'follow_up_long');
  if (followUp) return live ? out(0.9, 'follow_up_live') : out(damp(0.9), 'follow_up');
  const command = isImperative(text);
  if (driving && command && clarity !== 'low') return out(damp(0.85), 'command');
  if (driving && direct && !low && w.length <= 20) return out(damp(0.85), 'command');
  const recent = typeof sinceReplyMs === 'number' && sinceReplyMs >= 0 && sinceReplyMs < TOPIC_WINDOW_MS;
  if (recent && !low && continuesTopic(text, context)) return out(damp(0.85), 'topic');
  // A clear question straight to her in a quiet room ("Tell me what you can do").
  if (direct && w.length <= 20 && clarity !== 'low' && quiet === true && !mediaPlaying) return out(0.82, 'direct');
  if (direct && w.length <= 20) return out(damp(0.6), 'direct_unsure');
  if (looksLikeCommand(text, clarity)) return out(damp(0.55), 'command_unsure');
  return out(damp(recent ? 0.2 : 0.1), 'not_for_echo');
}
