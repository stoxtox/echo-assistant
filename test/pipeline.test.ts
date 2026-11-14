// What happens to a transcribed sentence (lib/pipeline/utterance.ts): one decision, with the
// conversation window as the only way of listening, so it can be tested and replayed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, serverSource } from './helpers.js';

sandbox('pipeline');
const { decideUtterance, listenMode, WAKE_MODES, SURELY_FOR_ECHO } = await import('../lib/pipeline/utterance.ts');
const { sinceReplyAtOnset } = await import('../lib/listening.js');
const { levelDb } = await import('../lib/voicelevel.js');
const { judgeAddressee } = await import('../lib/addressed.js');
type Conv = Parameters<typeof decideUtterance>[1];
type Utt = Parameters<typeof decideUtterance>[0];

/** The rule-based judge alone (no local model), as judgeHere uses it when the rules are sure. */
const NOW = 1_000_000_000;
const judge = async (o: any) => judgeAddressee(o);
const calls: any[] = [];
const spy = async (o: any) => {
  calls.push(o);
  return judgeAddressee(o);
};

const conv = (over: Partial<Conv> = {}): Conv => ({ recent: [], driving: false, busy: false, pendingCards: 0, pendingMessages: 0, lessonActive: false, wakeWord: false, now: NOW, ...over });
const utt = (text: string, mode: string, over: Partial<Utt> = {}): Utt => ({ text, page: { mode }, clarity: 'ok', loud: null, quiet: true, mediaPlaying: false, ...over });

test('modes: which clips may start with "Hey Echo", and which are always for Echo', () => {
  assert.deepEqual([...WAKE_MODES], ['wake', 'answer', 'run', 'follow']);
  assert.deepEqual([...SURELY_FOR_ECHO], ['push-to-talk', 'wake']);
});

test('"Hey Echo" comes off the front; nothing after it is not a turn', async () => {
  const v = await decideUtterance(utt('Hey Echo, open Notes', 'wake'), conv(), { judge });
  assert.equal(v.kind, 'deliver');
  assert.match(v.said, /open notes/i);
  assert.doesNotMatch(v.said, /hey echo/i);
  const only = await decideUtterance(utt('Hey Echo.', 'wake'), conv(), { judge });
  assert.equal(only.kind, 'drop');
  assert.equal(only.kind === 'drop' && only.reply.reason, 'wake_only');
  const ptt = await decideUtterance(utt('Hey Echo, open Notes', 'push-to-talk'), conv(), { judge });
  assert.match(ptt.said, /^Hey Echo/, 'push-to-talk keeps every word');
});

test("Echo's own voice coming back through the mic is left alone", async () => {
  const reply = 'I opened the draft in Gmail and left it for you to check.';
  const v = await decideUtterance(utt(reply, 'hands-free', { live: reply }), conv({ recent: ['User: draft it', `Assistant: ${reply}`] }), { judge });
  assert.equal(v.kind, 'drop');
  assert.equal(v.kind === 'drop' && v.reply.reason, 'own_voice');
  assert.equal(v.kind === 'drop' && v.log.event, 'own_voice');
});

test('push-to-talk and plain hands-free (no wake word) go straight through, with no judge', async () => {
  calls.length = 0;
  for (const mode of ['push-to-talk', 'hands-free']) {
    const v = await decideUtterance(utt('what is the weather tomorrow', mode), conv(), { judge: spy });
    assert.equal(v.kind, 'deliver', mode);
  }
  assert.equal(calls.length, 0);
  const driving = await decideUtterance(utt('make the button bigger', 'push-to-talk'), conv({ driving: true }), { judge: spy });
  assert.equal(driving.kind, 'deliver', 'push-to-talk is meant for Echo even while it drives');
  assert.equal(calls.length, 0);
});

test('while Echo drives: stop gets through, a correction waits for the next step, the TV does not', async () => {
  const c = conv({ driving: true, busy: true });
  // A close, clear voice (what clipLoudness measures on a real clip): it may cut into the step.
  const near = { level: 0.08, floor: 0.002, snrDb: 32 };
  assert.equal((await decideUtterance(utt('stop', 'hands-free', { loud: near }), c, { judge })).kind, 'deliver');
  assert.equal((await decideUtterance(utt('Echo, make the title bigger', 'hands-free'), c, { judge })).kind, 'deliver');
  // A correction while a step is mid-flight is delivered at the next step, never kept back.
  const held = await decideUtterance(utt('no, the other button', 'hands-free'), c, { judge: async () => ({ confidence: 0.85, decision: 'accept', why: 'command' }) });
  assert.ok(held.kind === 'deliver' || (held.kind === 'hold' && held.nextStep === true && held.reply.reason === 'next_step'), JSON.stringify(held));
  const tv = await decideUtterance(utt('and in other news tonight the markets fell sharply', 'hands-free', { mediaPlaying: true }), c, { judge });
  assert.equal(tv.kind, 'drop');
  assert.equal(tv.kind === 'drop' && tv.log.event, 'not_for_echo');
  assert.equal(tv.kind === 'drop' && tv.reply.askForMe, true, 'never silent');
});

test('while Echo works, the judge is told about the conversation (128 real requests were ignored when it was not)', async () => {
  calls.length = 0;
  const c = conv({ driving: true, recent: ['User: make it look better', 'Assistant: I added a soft shadow to the cards. Want me to keep going?'] });
  const v = await decideUtterance(utt('what is this blue line in the middle of the page', 'hands-free'), c, { judge: spy });
  assert.equal(v.kind, 'deliver');
  const o = calls.at(-1);
  assert.equal(o.followUp, true);
  assert.deepEqual(o.context, c.recent);
  assert.equal(o.awaitingAnswer, true);
});

test('the answer window: an answer goes through; room talk with something playing is set aside with a chip', async () => {
  const c = conv({ recent: ['User: book it', 'Assistant: Which day works, Tuesday or Wednesday?'], sinceReplyMs: 3000 });
  assert.equal((await decideUtterance(utt('Tuesday', 'answer'), c, { judge })).kind, 'deliver');
  const room = await decideUtterance(utt('yeah I told him the game starts at eight', 'answer', { clarity: 'low', mediaPlaying: true }), c, { judge: async () => ({ confidence: 0.1, decision: 'ignore', why: 'not_for_echo' }) });
  assert.equal(room.kind, 'drop');
  if (room.kind === 'drop') {
    assert.equal(room.log.event, 'not_for_echo');
    assert.equal(room.log.mode, 'answer');
    assert.equal(room.reply.askForMe, true);
    assert.deepEqual(room.dropped, { mode: 'answer', clarity: 'low', sinceReplyMs: 3000, confidence: 0.1 });
  }
  // Outside the window, room talk is only counted; its words are kept only with its recording.
  const late = conv({ recent: c.recent, sinceReplyMs: 60_000, wakeWord: true });
  const counted = await decideUtterance(utt('yeah I told him the game starts at eight', 'hands-free', { clarity: 'low' }), late, { judge });
  assert.equal(counted.kind === 'drop' && counted.log.text, undefined, 'room talk is only counted');
  const kept = await decideUtterance(utt('yeah I told him the game starts at eight', 'hands-free', { clarity: 'low', keepText: true }), late, { judge });
  assert.equal(kept.kind === 'drop' && kept.log.text, 'yeah I told him the game starts at eight', 'kept when its recording is kept');
});

test('the follow-up window: inside it, a follow-up needs no name; the judge sees the timing and the conversation', async () => {
  calls.length = 0;
  const c = conv({ wakeWord: true, recent: ['User: weather?', 'Assistant: Sunny, 24 degrees.'] });
  const v = await decideUtterance(utt('and tomorrow', 'follow', { page: { mode: 'follow', sinceReplyMs: 4000 } }), c, { judge: spy });
  assert.equal(v.kind, 'deliver');
  const o = calls.at(-1);
  assert.equal(o.followUp, true);
  assert.equal(o.sinceReplyMs, 4000);
  assert.deepEqual(o.context, c.recent);
  assert.equal(o.question, 'Sunny, 24 degrees.');
  // During a lesson, the user talking about the step is a follow-up too.
  await decideUtterance(utt('where is that button', 'hands-free'), conv({ wakeWord: true, lessonActive: true }), { judge: spy });
  assert.equal(calls.at(-1).followUp, true);
  // A confirmation card waiting makes "yes" an answer.
  await decideUtterance(utt('yes', 'hands-free'), conv({ wakeWord: true, pendingMessages: 1 }), { judge: spy });
  assert.equal(calls.at(-1).pendingQuestion, true);
});

test('the window is timed from when the sentence BEGAN, not from when its clip was sent', async () => {
  // An 8 s window, a 4 s sentence and the 1.3 s of quiet that ends a clip: sent 11 s after the
  // reply, it began at 5.7 s. Before, it had to begin within about 2.7 s.
  const c = conv({ wakeWord: true, recent: ['User: weather?', 'Assistant: Sunny, 24 degrees.'] });
  const page = { mode: 'hands-free', sinceReplyMs: 11_000 };
  const clip = { ms: 5300, level: 0.06, voicedMs: 3200 };
  calls.length = 0;
  const v = await decideUtterance(utt('and what about the day after that', 'hands-free', { page, clip }), c, { judge: spy });
  assert.equal(v.kind, 'deliver');
  assert.equal(v.kind === 'deliver' && v.window, 'follow');
  assert.equal(calls.at(-1).sinceReplyMs, 5700, 'the judge gets the onset too');
  const noClip = await decideUtterance(utt('and what about the day after that', 'hands-free', { page }), c, { judge });
  assert.equal(noClip.kind, 'drop', 'with no clip length, the send time is all there is');
  const began = await decideUtterance(utt('and what about the day after that', 'hands-free', { page: { mode: 'hands-free', sinceReplyMs: 14_000 }, clip }), c, { judge });
  assert.equal(began.kind, 'drop', 'began 8.7 s after the reply: the window had closed');
  // The server's own clock (no time from the page) is moved back the same way.
  const server = await decideUtterance(utt('and what about the day after that', 'hands-free', { clip }), conv({ ...c, sinceReplyMs: 11_000 }), { judge });
  assert.equal(server.kind, 'deliver');
  assert.equal(sinceReplyAtOnset(11_000, 5300), 5700);
  assert.equal(sinceReplyAtOnset(2000, 5300), 0, 'began while Echo was still speaking');
  assert.equal(sinceReplyAtOnset(undefined, 5300), undefined);
  assert.equal(sinceReplyAtOnset(4000), 4000);
});

test('a phone in the room is not the user: far quieter than the owner, or a blip, is left alone in any window', async () => {
  // Oct 2: the owner at rms 0.047-0.076; a phone at 0.005-0.009 with 160-1,140 ms voiced, 6 of 20
  // clips in 7 minutes, every one delivered as a follow-up.
  const ownerDb = levelDb(0.06);
  const c = conv({ wakeWord: true, recent: ['User: weather?', 'Assistant: Sunny, 24 degrees.'] });
  const page = { mode: 'hands-free', sinceReplyMs: 3000 };
  for (const [level, voicedMs] of [[0.005, 160], [0.007, 640], [0.009, 1140]] as const) {
    const v = await decideUtterance(utt('your order has shipped and will arrive on Thursday', 'hands-free', { page, clip: { ms: 2500, level, voicedMs }, ownerDb }), c, { judge });
    assert.equal(v.kind, 'drop', `phone at ${level}`);
    if (v.kind !== 'drop') continue;
    assert.equal(v.reply.reason, 'not_for_echo');
    assert.equal(v.reply.why, 'faint');
    assert.equal(v.reply.askForMe, undefined, 'no chip for every sentence of a phone call');
    assert.equal(v.log.text, undefined, 'its words are not written down');
    assert.equal(v.log.level, level);
  }
  // The owner, in the same window, at either end of how loud they were.
  for (const level of [0.047, 0.076]) {
    const v = await decideUtterance(utt('and what about tomorrow', 'hands-free', { page, clip: { ms: 3000, level, voicedMs: 1500 }, ownerDb }), c, { judge });
    assert.equal(v.kind, 'deliver', `owner at ${level}`);
  }
  // A blip with no word in it.
  const blip = await decideUtterance(utt('Hmm hmm.', 'hands-free', { page, clip: { ms: 1700, level: 0.05, voicedMs: 300 }, ownerDb }), c, { judge });
  assert.equal(blip.kind === 'drop' && blip.reply.why, 'brief');
  // A short clip with real words, in the open window: never dropped without a sign. A question
  // goes through ("Why?" was ignored), and so do words as loud as the owner; words Echo can't
  // place by their sound raise the "Was that for me?" chip.
  for (const text of ['Why?', 'Which one?', 'And then?']) {
    const q = await decideUtterance(utt(text, 'hands-free', { page, clip: { ms: 1400, level: 0.02, voicedMs: 300 }, ownerDb }), c, { judge });
    assert.equal(q.kind, 'deliver', text);
  }
  assert.equal((await decideUtterance(utt('Okay so.', 'hands-free', { page, clip: { ms: 1700, level: 0.05, voicedMs: 300 }, ownerDb }), c, { judge })).kind, 'deliver');
  const unsure = await decideUtterance(utt('Okay so.', 'hands-free', { page, clip: { ms: 1700, level: 0.02, voicedMs: 300 }, ownerDb }), c, { judge });
  assert.deepEqual(unsure.kind === 'drop' && [unsure.reply.reason, unsure.reply.askForMe, unsure.reply.heard], ['not_for_echo', true, 'Okay so.']);
  // The same when the local model had its say and still thought it wasn't for Echo.
  const settled = await decideUtterance(utt('Okay so.', 'hands-free', { page, clip: { ms: 1700, level: 0.02, voicedMs: 300 }, ownerDb }), c, { judge: async (o: any) => ({ ...judgeAddressee(o), decision: 'ignore', why: 'brief_unsure+local' }) });
  assert.equal(settled.kind === 'drop' && settled.reply.askForMe, true);
  // Echo's name always gets through, however quiet or short.
  assert.equal((await decideUtterance(utt('Echo, stop the music', 'hands-free', { page, clip: { ms: 1500, level: 0.007, voicedMs: 400 }, ownerDb }), c, { judge })).kind, 'deliver');
  // While it works on the Mac too, where everything else is delivered.
  const working = await decideUtterance(utt('your order has shipped and will arrive on Thursday', 'hands-free', { clip: { ms: 2500, level: 0.007, voicedMs: 900 }, ownerDb }), conv({ driving: true, busy: true }), { judge });
  assert.equal(working.kind === 'drop' && working.reply.why, 'faint');
  // No estimate yet: as before.
  const before = await decideUtterance(utt('your order has shipped and will arrive on Thursday', 'hands-free', { page, clip: { ms: 2500, level: 0.007, voicedMs: 160 }, ownerDb: null }), c, { judge });
  assert.equal(before.kind, 'deliver');
});

test('push-to-talk and "Hey Echo" are never judged by how they sound', async () => {
  calls.length = 0;
  const ownerDb = levelDb(0.06);
  for (const mode of ['push-to-talk', 'wake']) {
    const v = await decideUtterance(utt('what is on my calendar', mode, { clip: { ms: 900, level: 0.004, voicedMs: 120 }, ownerDb }), conv({ wakeWord: true }), { judge: spy });
    assert.equal(v.kind, 'deliver', mode);
  }
  assert.equal(calls.length, 0, 'no judge at all');
});

test('push-to-talk with any real word in it is delivered, even one that would be noise hands-free', async () => {
  for (const text of ['So?', 'Oh.', 'And', 'The']) {
    const v = await decideUtterance(utt(text, 'push-to-talk'), conv({ wakeWord: true }), { judge });
    assert.equal(v.kind, 'deliver', text);
    const hf = await decideUtterance(utt(text, 'hands-free'), conv({ wakeWord: true }), { judge });
    assert.equal(hf.kind === 'drop' && hf.reply.reason, 'noise', `${text} hands-free`);
  }
  // No word at all is still nothing, on the key too.
  for (const text of ['[BLANK_AUDIO]', '(music)', 'Um.', 'Hmm']) {
    const v = await decideUtterance(utt(text, 'push-to-talk'), conv(), { judge });
    assert.equal(v.kind === 'drop' && v.reply.reason, 'noise', text);
  }
});

test('how a sentence came in, for the dropped log', () => {
  const c = conv({ wakeWord: true, recent: ['Assistant: Sunny.'] });
  assert.equal(listenMode({ page: { mode: 'push-to-talk' } }, c), 'ptt');
  assert.equal(listenMode({ page: { mode: 'wake' } }, c), 'wake');
  assert.equal(listenMode({ page: { mode: 'hands-free' } }, conv({ driving: true })), 'run');
  assert.equal(listenMode({ page: { mode: 'hands-free', sinceReplyMs: 3000 } }, c), 'window');
  assert.equal(listenMode({ page: { mode: 'answer' } }, c), 'window');
  assert.equal(listenMode({ page: { mode: 'hands-free', sinceReplyMs: 60_000 } }, c), 'handsfree');
});

test('the server hands every transcribed sentence to decideUtterance', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = serverSource();
  assert.match(src, /let verdict = await decideUtterance\(/);
  assert.match(src, /\{ judge: judgeHere \}/);
  assert.doesNotMatch(src, /event: 'run_ignored', engine, text: said/, 'the gate lives in lib/pipeline/utterance.ts now');
});
