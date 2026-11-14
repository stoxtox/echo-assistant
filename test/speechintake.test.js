// The speech intake end to end (lib/server/speech.js), with the Mac app's own text so no speech
// engine runs: a phone in the room is left alone once the owner's level is known, one sentence
// recorded by two mics counts once (push-to-talk wins, without a word), a near-silent clip yields
// nothing, and every sentence that doesn't become a turn leaves one `dropped` line without its words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sandbox } from './helpers.js';

const dirs = sandbox('speechintake');
process.env.ECHO_FLAG_APPLESPEECH = '1';
const { speechIntake } = await import('../lib/server/speech.js');
const { pcmWav } = await import('../lib/heard.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { OWNER_MIN_CLIPS } = await import('../lib/voicelevel.js');
saveSettings({ wakeWord: true, keepRecordings: false });

/**
 * A clip: after `lead` seconds of quiet, `voiced` seconds of a tone whose frames sit at `frameRms`, then quiet up to `seconds`.
 * @param {{ seconds?: number, lead?: number, voiced?: number, frameRms?: number }} shape
 */
function clipOf({ seconds = 3, lead = 0, voiced = 2, frameRms = 0.09 }) {
  const rate = 16000;
  const s = new Float32Array(Math.round(seconds * rate));
  const from = Math.round(lead * rate);
  for (let i = from; i < from + Math.round(voiced * rate); i++) s[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * frameRms * Math.SQRT2;
  return pcmWav(s, rate);
}
/** Push-to-talk ends on the key coming up: no quiet after the words. */
const KEY = { seconds: 2.1, voiced: 2, frameRms: 0.09 };
const OWNER = { seconds: 3, voiced: 2, frameRms: 0.09 }; // whole-clip rms about 0.073
const PHONE = { seconds: 3, voiced: 1.1, frameRms: 0.012 }; // whole-clip rms about 0.007, 1,100 ms voiced

let now = 1_000_000;
const sent = [];
/** The local model that settles an unsure sentence: held open by a test to keep a clip in flight. */
let localModel = async () => ({ ok: false });
const dispatcher = {
  lastSpokeAt: 0, busy: false,
  computer: { driving: false, pending: new Map(), lesson: null, instruct() {} },
  routeInput: () => 'turn', localIntentFor: () => null, heard() {}, prepare() {},
  send(text, meta) { sent.push({ text, meta }); return 'turn'; },
};
const intake = speechIntake({
  dispatcher: /** @type {any} */ (dispatcher), quick: /** @type {any} */ ({ pendingList: () => [] }),
  screen: /** @type {any} */ ({ native: true, request: () => localModel() }), broadcast: () => {}, clock: () => now,
});

/** POST /api/utterance: a clip with the page's notes and the text the Mac app made for it. */
async function post(text, notes, /** @type {Parameters<typeof clipOf>[0]} */ shape = OWNER) {
  const req = Object.assign(Readable.from([clipOf(shape)]), {
    headers: { 'x-echo-clip': encodeURIComponent(JSON.stringify({ mediaPlaying: false, ...notes, final: { text, ms: 20, words: [] } })) },
  });
  return new Promise((resolve, reject) => {
    const res = { on() {}, writeHead() { return res; }, end(body) { resolve(JSON.parse(body)); } };
    intake.routes['POST /api/utterance'](req, res).catch(reject);
  });
}
const log = () => fs.readFileSync(path.join(dirs.data, 'stt-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const droppedLines = () => log().filter((l) => l.event === 'dropped');
/** Echo has just answered: the follow-up window is open. */
function echoReplied(line = 'Sunny, 24 degrees.') {
  intake.logConvo('Assistant', line);
}
const HANDS_FREE = { mode: 'hands-free', sinceReplyMs: 3000 };
const PHONE_SAID = 'your order has shipped and will arrive on Thursday';

test('before the owner\'s level is known, a quiet follow-up goes through as it always did', async () => {
  echoReplied();
  now += 20_000;
  const r = await post(PHONE_SAID, HANDS_FREE, PHONE);
  assert.equal(r.text, PHONE_SAID);
  assert.equal(sent.at(-1).text, PHONE_SAID);
});

test('push-to-talk teaches the owner\'s level; then the phone is left alone and the owner is not', async () => {
  for (let i = 0; i < OWNER_MIN_CLIPS; i++) {
    now += 20_000;
    const r = await post(`what is on my calendar for day ${i + 1}`, { mode: 'push-to-talk' });
    assert.equal(r.empty, undefined, 'push-to-talk goes through');
  }
  const levels = JSON.parse(fs.readFileSync(path.join(dirs.data, 'voice-level.json'), 'utf8'));
  assert.equal(levels.mics.page.length, OWNER_MIN_CLIPS, 'learned from push-to-talk only, not from the quiet clip');

  echoReplied();
  const before = sent.length;
  now += 20_000;
  const phone = await post(PHONE_SAID, HANDS_FREE, PHONE);
  assert.deepEqual([phone.empty, phone.reason, phone.why], [true, 'not_for_echo', 'faint'], 'a reason the page can show');
  assert.equal(phone.askForMe, undefined);
  assert.equal(sent.length, before, 'nothing reached Echo');
  const line = droppedLines().at(-1);
  assert.deepEqual([line.reason, line.listenMode, line.clipMs, line.voicedMs], ['faint', 'window', 3000, 1100]);
  assert.ok(line.trace && line.at);

  // The Mac app's mic is another microphone: nothing is known about the owner there yet.
  now += 20_000;
  assert.equal((await post(PHONE_SAID, { ...HANDS_FREE, mode: 'follow', native: true }, PHONE)).text, PHONE_SAID);

  now += 20_000;
  echoReplied();
  const owner = await post('and what about tomorrow', HANDS_FREE);
  assert.equal(owner.text, 'and what about tomorrow');

  // Push-to-talk is never judged by its sound, however quiet.
  now += 20_000;
  const soft = await post('remind me to call the dentist', { mode: 'push-to-talk' }, PHONE);
  assert.equal(soft.text, 'remind me to call the dentist');
});

test('one sentence recorded by two mics: push-to-talk goes through, the other is dropped without a word', async () => {
  now += 20_000;
  const before = sent.length;
  const ptt = await post('open the budget sheet', { mode: 'push-to-talk', native: true }, KEY);
  assert.equal(ptt.text, 'open the budget sheet');
  // The window's mic heard it too, wrote it differently, and its clip ended 1.3 s later (the
  // quiet a hands-free clip waits for).
  now += 1300;
  echoReplied('Opening it.');
  const second = await post('Open the budgets, eat.', HANDS_FREE, { seconds: 3.4, lead: 0.1, voiced: 2 });
  assert.deepEqual([second.empty, second.reason], [true, 'heard_twice']);
  assert.match(String(second.heard), /\p{L}/u, 'the page says "Didn\'t catch that" only for a reply with no words in it');
  assert.equal(sent.length, before + 1, 'answered once');
  const lines = log().slice(-2);
  assert.deepEqual(lines.map((l) => l.event), ['heard_twice', 'dropped']);
  assert.deepEqual([lines[0].mode, lines[0].first, lines[1].reason], ['hands-free', 'push-to-talk', 'heard_twice']);

  // A real second sentence, said after the first, is not a duplicate.
  now += 9000;
  assert.equal((await post('and email it to the team', HANDS_FREE)).text, 'and email it to the team');
});

test('push-to-talk wins even when the hands-free clip came in first and is still being judged', async () => {
  now += 20_000;
  echoReplied();
  const before = sent.length;
  let release = () => {};
  localModel = () => new Promise((r) => { release = () => r({ ok: false }); });
  // Unsure (a long stretch in the window): the local model is asked, and the clip waits.
  const long = 'so I was saying to him the other day that the whole plan for the trip to the lake with the cousins and the dog needed a rethink';
  const handsFree = post(long, HANDS_FREE);
  await new Promise((r) => setTimeout(r, 50));
  const ptt = await post('what is the plan for the trip', { mode: 'push-to-talk', native: true });
  assert.equal(ptt.text, 'what is the plan for the trip', 'the deliberate one is never the duplicate');
  release();
  localModel = async () => ({ ok: false });
  const hf = await handsFree;
  assert.deepEqual([hf.empty, hf.reason], [true, 'heard_twice']);
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).text, 'what is the plan for the trip');
});

test('a hands-free clip holding two sentences is not "the same" as push-to-talk for the second: the first is not lost', async () => {
  now += 20_000;
  const before = sent.length;
  // The key was held for the second sentence only (2 s); the window's mic caught both (5 s of speech).
  assert.equal((await post('and email it to the team', { mode: 'push-to-talk', native: true }, KEY)).text, 'and email it to the team');
  now += 1300;
  echoReplied('Sending it.');
  const both = await post('print the budget sheet for me. and email it to the team', HANDS_FREE, { seconds: 6.4, lead: 0.1, voiced: 5 });
  assert.equal(both.text, 'print the budget sheet for me. and email it to the team');
  assert.equal(sent.length, before + 2);

  // Push-to-talk begun in the last second of a hands-free clip (its trailing quiet) is said after it.
  now += 20_000;
  echoReplied();
  assert.equal((await post('what is on for tomorrow', HANDS_FREE, { seconds: 3, voiced: 2 })).text, 'what is on for tomorrow');
  now += 600;
  assert.equal((await post('and Friday', { mode: 'push-to-talk', native: true }, { seconds: 1, voiced: 0.9 })).text, 'and Friday');
});

test('push-to-talk is never dropped unheard: after a hands-free clip of the same moment was answered, only the same words are', async () => {
  // The hands-free clip came in first and went through; the key came up half a second later.
  const heldLonger = { seconds: 3.6, lead: 0.1, voiced: 2 };
  now += 20_000;
  echoReplied();
  const before = sent.length;
  assert.equal((await post('open the budget sheet', HANDS_FREE, { seconds: 3.1, lead: 0.1, voiced: 2 })).text, 'open the budget sheet');
  now += 500;
  const same = await post('Open the budgets sheet.', { mode: 'push-to-talk', native: true }, heldLonger);
  assert.deepEqual([same.empty, same.reason], [true, 'heard_twice'], 'the same words: answered once, nothing said');
  assert.equal(sent.length, before + 1);
  assert.deepEqual(log().slice(-2).map((l) => l.event), ['heard_twice', 'dropped']);
  assert.doesNotMatch(JSON.stringify(log().slice(-2)), /budget/i, 'no words in either line');

  // Other words in that moment (someone else was talking; the key was for this): it goes through.
  now += 20_000;
  echoReplied();
  assert.equal((await post('I think the game starts at eight', HANDS_FREE, { seconds: 3.1, lead: 0.1, voiced: 2 })).text, 'I think the game starts at eight');
  now += 500;
  assert.equal((await post('remind me to call the dentist', { mode: 'push-to-talk', native: true }, heldLonger)).text, 'remind me to call the dentist');

  // By microphone, not by how the clip was started: the window's own push-to-talk (Space) after
  // its own hands-free clip is one mic, so never one sentence twice.
  now += 20_000;
  echoReplied();
  assert.equal((await post('open the budget sheet', HANDS_FREE, { seconds: 3.1, lead: 0.1, voiced: 2 })).text, 'open the budget sheet');
  now += 500;
  assert.equal((await post('open the budget sheet', { mode: 'push-to-talk' }, heldLonger)).text, 'open the budget sheet');
});

test('the owner hands-free reads as loud as on the key; a short question goes through; an unsure short clip raises the chip', async () => {
  // Learned from push-to-talk clips with no quiet after the words (above). The same voice
  // hands-free, with a second of quiet after it, is at the same level: its voiced part is measured.
  now += 20_000;
  echoReplied();
  const before = sent.length;
  assert.equal((await post('and what about the day after', HANDS_FREE, { seconds: 3.5, lead: 0.2, voiced: 1.2, frameRms: 0.09 })).text, 'and what about the day after');
  // "Why?": 400 ms of voice, leaning back (a third as loud). It was ignored as a blip.
  now += 20_000;
  echoReplied();
  assert.equal((await post('Why?', HANDS_FREE, { seconds: 1.6, lead: 0.2, voiced: 0.4, frameRms: 0.03 })).text, 'Why?');
  assert.equal(sent.length, before + 2);
  // Short, not a question, and not clearly the owner by its sound: never silent, the page asks.
  now += 20_000;
  echoReplied();
  const unsure = await post('Okay so.', HANDS_FREE, { seconds: 1.6, lead: 0.2, voiced: 0.4, frameRms: 0.03 });
  assert.deepEqual([unsure.empty, unsure.reason, unsure.askForMe, unsure.heard], [true, 'not_for_echo', true, 'Okay so.']);
  assert.equal(sent.length, before + 2);
  assert.equal(droppedLines().at(-1).reason, 'not_for_echo');
  // The phone, in the same window, is still left alone without a chip.
  now += 20_000;
  echoReplied();
  const phone = await post(PHONE_SAID, HANDS_FREE, PHONE);
  assert.deepEqual([phone.reason, phone.why, phone.askForMe], ['not_for_echo', 'faint', undefined]);
});

test('a near-silent clip yields nothing, whatever text came with it; held push-to-talk with real words is kept', async () => {
  const breath = { seconds: 1.6, voiced: 0.1, frameRms: 0.02 };
  now += 20_000;
  echoReplied();
  const before = sent.length;
  const r = await post('The phase of the world is the data of the bodies.', HANDS_FREE, breath);
  assert.deepEqual([r.empty, r.reason], [true, 'no_speech']);
  assert.equal(sent.length, before);
  assert.equal(droppedLines().at(-1).reason, 'no_speech');
  now += 20_000;
  assert.equal((await post('open my calendar', { mode: 'push-to-talk' }, breath)).text, 'open my calendar');
  // A quick word on the key, 0.3 s long: always delivered.
  now += 20_000;
  assert.equal((await post('Yes.', { mode: 'push-to-talk' }, { seconds: 0.3, voiced: 0.1, frameRms: 0.02 })).text, 'Yes.');
  now += 20_000;
  assert.equal((await post('So?', { mode: 'push-to-talk' }, { seconds: 0.5, voiced: 0.3, frameRms: 0.02 })).text, 'So?');
});

test('the app\'s text never came and nothing here can transcribe the clip: said so with a reason, not "blank"', async () => {
  /** A clip from the app's mic with exactly these notes (no text unless they carry one). */
  const postNotes = (notes) => new Promise((resolve, reject) => {
    const req = Object.assign(Readable.from([clipOf(OWNER)]), { headers: { 'x-echo-clip': encodeURIComponent(JSON.stringify({ mediaPlaying: false, ...notes })) } });
    const res = { on() {}, writeHead(code) { res.code = code; return res; }, end(body) { resolve({ code: res.code, ...JSON.parse(body) }); } };
    intake.routes['POST /api/utterance'](req, res).catch(reject);
  });
  // The browser's recognition is the engine picked: there is no engine on the server to ask.
  setFixedForTest({ sttEngine: 'browser' });
  try {
    now += 20_000;
    let r = await postNotes({ mode: 'push-to-talk', native: true, timedOut: true });
    assert.deepEqual([r.empty, r.reason, r.engine], [true, 'stt_timeout', 'apple'], "Apple took too long: that is the reason, and it isn't an error");
    assert.equal(droppedLines().at(-1).reason, 'stt_timeout');
    // An older app said it inside an empty text: the same, not "blank".
    now += 20_000;
    r = await postNotes({ mode: 'push-to-talk', native: true, final: { text: '', timedOut: true } });
    assert.equal(r.reason, 'stt_timeout');
    // No text and no word of why (Apple's model couldn't start for this sentence).
    now += 20_000;
    assert.equal((await postNotes({ mode: 'push-to-talk', native: true })).reason, 'stt_unavailable');
    // Apple answered, and heard nothing: that is still a blank sentence.
    now += 20_000;
    assert.equal((await postNotes({ mode: 'push-to-talk', native: true, final: { text: '', ms: 40, words: [] } })).reason, 'blank');
    // A clip from the window's own mic has no business here with this engine, as before.
    r = await postNotes({ mode: 'push-to-talk' });
    assert.equal(r.error, 'Browser recognition runs in the page');
  } finally {
    setFixedForTest({ sttEngine: 'auto' });
  }
});

test('every sentence that did not become a turn left one dropped line: a reason, how it came in, how long, never its words', async () => {
  // Outside the window with no name: left alone.
  now += 120_000;
  const r = await post('I think the game starts at eight tonight', { mode: 'hands-free', sinceReplyMs: 120_000 });
  assert.deepEqual([r.empty, r.reason], [true, 'not_for_echo']);
  assert.equal(droppedLines().at(-1).listenMode, 'handsfree');
  // Words from the browser's recognizer (no clip): the same, and the page is told.
  const got = [];
  await intake.userText({ send: (m) => got.push(JSON.parse(m)) }, { text: 'I think the game starts at eight tonight', mode: 'hands-free', confidence: 0.9 });
  assert.deepEqual(got, [{ type: 'dropped', reason: 'not_for_echo' }]);
  // Just "Hey Echo".
  now += 20_000;
  assert.equal((await post('Hey Echo.', { mode: 'wake' })).reason, 'wake_only');
  assert.deepEqual([droppedLines().at(-1).reason, droppedLines().at(-1).listenMode], ['wake_only', 'wake']);
  // Nothing typed or said at all.
  assert.deepEqual(await intake.handleUtterance(' . ', { engine: 'browser' }), { empty: true, engine: 'browser', reason: 'blank' });

  const all = droppedLines();
  const reasons = new Set(['stt_timeout', 'stt_unavailable', 'blank', 'no_speech', 'invented', 'low_confidence', 'wake_only', 'noise', 'own_voice', 'not_for_echo', 'faint', 'brief', 'heard_twice', 'next_step']);
  assert.ok(all.length >= 7);
  for (const l of all) {
    assert.ok(reasons.has(l.reason), l.reason);
    assert.equal(l.text, undefined);
    assert.equal(l.heard, undefined);
    assert.doesNotMatch(JSON.stringify(l), /order|budget|game|trip|phase|okay|Echo\./i, 'no words in a dropped line');
    if (l.clipMs !== undefined) assert.ok(['ptt', 'wake', 'run', 'window', 'handsfree'].includes(l.listenMode), l.listenMode);
  }
  // Each clip that came back empty has exactly one dropped line under its trace.
  assert.equal(new Set(all.map((l) => l.trace)).size, all.length);
});
