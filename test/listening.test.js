// Conversation mode and "background can't cancel" (build plan: Listening). The engaged window and
// the open question let plain answers through; a TV's "stop" or "go back" never cuts into a step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, serverSource, pageSource } from './helpers.js';

const dirs = sandbox('listening');
const { clipLoudness, isNear, quietRoom, interruptGate, interruptKind, midRunDecision, NEAR_MIN_SNR_DB } = await import('../lib/listening.js');
const { judgeAddressee, answerShaped, inUserLanguage } = await import('../lib/addressed.js');
const { parseAudioAssertions, isEchoOwnAudio, mediaWatcher, MEDIA_CACHE_MS } = await import('../lib/mediaplaying.js');
const { runListening, NEAR, NEAR_OVER_MEDIA, TV, ACROSS } = await import('../lib/listenreplay.js');
const { nativeMicPlan, clipMode } = await import('../public/nativemic.js');
const { ComputerUse } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { pcmWav } = await import('../lib/heard.js');

/** A 16 kHz clip: `pad` seconds of room sound, a second of "voice" (a 220 Hz tone), the room again. */
function clip({ voice, room, pad = 0.4 }) {
  const rate = 16000;
  const n = Math.round(rate * (1 + 2 * pad));
  const s = new Float32Array(n);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const speaking = t >= pad && t < pad + 1;
    s[i] = noise() * room * 1.7 + (speaking ? Math.sin(2 * Math.PI * 220 * t) * voice * 1.414 : 0);
  }
  return pcmWav(s, rate);
}

test('clip loudness: a close voice stands well above a quiet room; a voice inside TV sound does not', () => {
  const close = clipLoudness(clip({ voice: 0.08, room: 0.002 }));
  assert.ok(close && close.snrDb > 20, JSON.stringify(close));
  assert.equal(isNear(close), true);
  assert.equal(quietRoom({ loud: close }), true, 'no TV under the voice: a quiet room');
  const tv = clipLoudness(clip({ voice: 0.03, room: 0.02 }));
  assert.ok(tv && tv.snrDb < NEAR_MIN_SNR_DB, JSON.stringify(tv));
  assert.equal(isNear(tv), false);
  assert.equal(quietRoom({ loud: tv }), false);
  assert.equal(clipLoudness(Buffer.from('nope')), null);
  assert.equal(isNear(null), null, 'no clip: unknown, not near');
  // The page's own measure wins; media playing is never a quiet room.
  assert.equal(quietRoom({ pageQuiet: true, loud: tv }), true);
  assert.equal(quietRoom({ pageQuiet: true, loud: close, mediaPlaying: true }), false);
  assert.equal(quietRoom({}), undefined);
});

test('an interruption needs all four: addressed, clear, short, near', () => {
  const g = (o) => interruptGate({ text: 'stop', accepted: true, clarity: 'ok', loud: NEAR, ...o });
  assert.deepEqual(g({}), { pass: true, why: 'ok' });
  assert.equal(g({ accepted: false }).why, 'not_addressed');
  assert.equal(g({ clarity: 'low' }).why, 'unclear');
  assert.equal(g({ clarity: 'unknown' }).why, 'unclear', 'no confidence scores: only with her name');
  assert.equal(g({ text: 'Echo, stop', clarity: 'unknown' }).pass, true);
  assert.equal(g({ text: 'no stop doing that and go back to the other page please' }).why, 'long');
  assert.equal(g({ text: 'Echo, no, go back to the other page please now' }).pass, true, '"Echo, …" may be longer');
  assert.equal(g({ loud: TV }).why, 'far');
  assert.equal(g({ loud: ACROSS }).why, 'far', 'across the room is too faint');
  assert.equal(g({ loud: null }).why, 'far', 'no clip to measure: needs her name');
  assert.equal(g({ text: 'Echo stop', loud: null }).pass, true);
  // While a video plays, "stop" alone needs a clearly closer voice; "Echo, stop" the usual one.
  assert.equal(g({ loud: NEAR_OVER_MEDIA, mediaPlaying: true }).why, 'far');
  assert.equal(g({ text: 'Echo, stop', loud: NEAR_OVER_MEDIA, mediaPlaying: true }).pass, true);
  assert.equal(g({ loud: NEAR, mediaPlaying: true }).pass, true);
});

test('what counts as cutting in: stop, wait, a correction; a new request only queues', () => {
  assert.equal(interruptKind('stop'), 'stop');
  assert.equal(interruptKind("that's all"), 'stop', '"that\'s all" mid-step ends it');
  assert.equal(interruptKind('wait'), 'pause');
  assert.equal(interruptKind('no, the other one'), 'now');
  assert.equal(interruptKind('go back'), 'now');
  assert.equal(interruptKind('then open Spotify'), null);
  assert.equal(interruptKind('then open Spotify', { answering: true }), 'now', 'with a card waiting, everything answers it');
  assert.equal(interruptKind('wait', { busy: false }), null, 'between requests nothing is under way');
});

test('mid-run: the TV never cancels; the user at the Mac always can', () => {
  const d = (text, o = {}) => {
    const judged = judgeAddressee({ text, clarity: 'ok', driving: true, mediaPlaying: Boolean(o.mediaPlaying) });
    return midRunDecision({ text, decision: judged.decision, clarity: 'ok', ...o }).action;
  };
  // Close to the mic: straight in.
  assert.equal(d('stop', { loud: NEAR }), 'cut');
  assert.equal(d('wait', { loud: NEAR }), 'cut');
  assert.equal(d('no, the other one', { loud: NEAR }), 'cut');
  assert.equal(d('Echo, stop', { loud: NEAR_OVER_MEDIA, mediaPlaying: true }), 'cut');
  // The TV: a stop asks ("Was that for me?"), a correction is held for the next step.
  assert.equal(d('stop', { loud: TV, mediaPlaying: true }), 'ask');
  assert.equal(d('Wait!', { loud: TV, mediaPlaying: true }), 'ask');
  // A correction from a speaker the Mac can't see playing (a TV, another device): held.
  assert.equal(d('go back', { loud: TV }), 'hold');
  assert.equal(d('no, the other one', { loud: TV }), 'hold');
  // With a video playing on the Mac, addressee v1 is already unsure: the chip, never a cut.
  assert.equal(d('go back', { loud: TV, mediaPlaying: true }), 'ask');
  // A new request is queued as before, however it was heard.
  assert.equal(d('then open Spotify', { loud: TV }), 'go');
  // Not for her at all.
  assert.equal(d('And the award goes to', { loud: TV, mediaPlaying: true }), 'ignore');
});

test('held speech never becomes a turn, a yes, or a request of its own; the assistant sees it as maybe not for it', async () => {
  (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true }));
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  bridge.on('request', (r) => {
    const p = r.params;
    let out;
    if (r.kind === 'act' && p.step === 'resolve') out = { ok: true, found: true, token: 't1', label: p.target || '', role: 'AXButton', app: 'Google Chrome', window: 'YouTube' };
    else if (r.kind === 'act' && p.step === 'do') out = { ok: true, via: 'accessibility', app: 'Google Chrome', window: 'YouTube', verified: true, changes: ['content'] };
    if (out) setImmediate(() => bridge.deliver(r.id, out));
  });
  const c = new ComputerUse({ bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
  c.isBusy = () => true;
  await c.act('click', { target: 'Search' });
  const turns = c.turns;
  c.instruct('go back', { held: true });
  assert.equal(c.turns, turns, 'held speech is not a user turn (it can never be the yes to a card)');
  const r = await c.act('click', { target: 'First video' });
  assert.equal(r.done, true, 'the step went ahead: ' + JSON.stringify(r));
  assert.deepEqual(r.heardNearby, ['go back']);
  assert.match(r.heardNote, /may be a video/);
  assert.equal(r.userSaidMidRun, undefined);
  c.instruct('no, the other one', { held: true });
  assert.deepEqual(c.takeInstructions(), [], 'left over at the end of the run, it is dropped, not sent as a new request');
  c.end('done');
});

test('conversation mode: her open question takes a plain answer however long ago she asked', () => {
  const q = 'I wrote the email to Sam. Should I send it?';
  const j = (text, o = {}) => judgeAddressee({ text, clarity: 'ok', awaitingAnswer: true, question: q, sinceReplyMs: 5 * 60 * 1000, ...o });
  assert.equal(j('yeah').decision, 'accept');
  assert.equal(j('yeah').why, 'answer');
  assert.equal(j('no, not yet').decision, 'accept');
  // Only answer-shaped replies count for the open question.
  assert.notEqual(j('Did you watch the game last night').decision, 'accept');
  assert.notEqual(j('I left my keys on the counter again').decision, 'accept');
  // Without the open question, a bare "yeah" five minutes later isn't for her.
  assert.notEqual(judgeAddressee({ text: 'yeah', clarity: 'ok', sinceReplyMs: 5 * 60 * 1000 }).decision, 'accept');
  // A TV's "yes" while a video plays, or a badly heard one, only asks.
  assert.equal(j('yes', { mediaPlaying: true }).decision, 'ask');
  assert.equal(j('yes', { clarity: 'low' }).decision, 'ask');
});

test('answer-shaped: yes/no, a number, one of her choices, a name when she asked who', () => {
  const which = 'I found lofi beats, jazz for work and rainy day piano. Which one?';
  for (const t of ['yeah', 'Yes please', 'nope', 'the second one', 'do it', '5 minutes', 'ten', 'Twenty']) assert.equal(answerShaped(t, 'How long?'), true, t);
  for (const t of ['jazz', 'the jazz one', 'rainy day piano']) assert.equal(answerShaped(t, which), true, t);
  assert.equal(answerShaped('Sam', 'Who should I send it to?'), true);
  assert.equal(answerShaped('to Priya Shah', 'Who should I send it to?'), true);
  assert.equal(answerShaped('memory', 'Who should I send it to?'), false, 'a lower-case fragment is not a name');
  assert.equal(answerShaped('Sam', which), false, 'a name only when she asked who');
  assert.equal(answerShaped('pizza', which), false, 'not one of her choices');
  assert.equal(answerShaped('I think we need to talk about what happened last night', which), false);
  assert.equal(inUserLanguage('5 minutes'), true, 'digits are not spelled-out letters');
  assert.equal(inUserLanguage('Q. A. L. A.'), false);
});

test('the follow-up window: short replies pass; a long unrelated stretch only asks', () => {
  const j = (text) => judgeAddressee({ text, clarity: 'ok', followUp: true, sinceReplyMs: 20000, context: ['Assistant: I opened your calendar.'] });
  assert.equal(j('and the next one').decision, 'accept');
  assert.equal(j('open the second meeting').decision, 'accept');
  const long = j('I think we need to talk about what happened last night at the party and why nobody called me back after that');
  assert.equal(long.decision, 'ask');
  assert.equal(long.why, 'follow_up_long');
});

test('a clear direct question passes the wake gate in a quiet room, not with the TV on', () => {
  for (const t of ['What time is it?', "What's the weather like today?", 'Do I have any new emails?', 'What can you do for me?', 'Can you open my calendar?']) {
    assert.equal(judgeAddressee({ text: t, clarity: 'ok', quiet: true }).decision, 'accept', t);
    assert.notEqual(judgeAddressee({ text: t, clarity: 'ok', quiet: false, mediaPlaying: true }).decision, 'accept', t);
  }
  assert.notEqual(judgeAddressee({ text: 'My mom called earlier about the weekend', clarity: 'ok', quiet: true }).decision, 'accept');
});

test("the Mac app's mic stays open during an exchange, then waits for \"Hey Echo\" again", () => {
  const base = { available: true, setting: true, serverEngine: true, wakeWord: true };
  const open = nativeMicPlan({ ...base, engaged: true, windowUntil: 5000 });
  assert.deepEqual([open.arm, open.label, open.then, open.windowUntil], ['window', 'follow', 'wake', 5000], 'the window, then "Hey Echo" again when it runs out');
  assert.equal(nativeMicPlan({ ...base, engaged: false }).arm, 'wake');
  assert.equal(nativeMicPlan({ ...base, wakeWord: false, engaged: true }).arm, '', 'no wake word: nothing changes');
  assert.equal(nativeMicPlan({ ...base, engaged: true, driving: true }).arm, 'run', 'a run still wins');
  assert.equal(nativeMicPlan({ ...base, engaged: true, answerOpen: true }).label, 'answer');
  assert.equal(clipMode('window', 'follow'), 'follow');
  // The page: the window resets when she finishes speaking, and her open question keeps it open.
  const app = pageSource();
  assert.match(app, /const w = convWindow\(\);[\s\S]{0,600}engaged: w\.open,/, 'the same window the server decides with');
  assert.match(app, /questionOpen = false; \/\/ answered/);
  assert.match(app, /tapped: true/, 'a tap on "Was that for me?" is the user\'s own say-so');
});

test('the server: follow clips are judged like hands-free, mid-run cuts go through the gate, every no-wake turn is logged', () => {
  const server = serverSource();
  // The gates live in lib/pipeline/utterance.ts (the server hands every sentence to it).
  const pipeline = fs.readFileSync(new URL('../lib/pipeline/utterance.ts', import.meta.url), 'utf8');
  assert.match(pipeline, /\(mode === 'hands-free' && c\.wakeWord\) \|\| mode === 'follow'/);
  assert.match(pipeline, /export const WAKE_MODES: readonly string\[\] = \['wake', 'answer', 'run', 'follow'\];/);
  assert.match(pipeline, /WAKE_MODES\.includes\(String\(mode\)\) \? stripWake/);
  assert.match(pipeline, /midRunDecision\(\{ text: said, decision: judged\.decision/);
  assert.match(server, /dispatcher\.computer\.instruct\(said, \{\}\)/);
  assert.match(server, /event: 'no_wake_turn'/);
  assert.match(pipeline, /awaitingAnswer: asked, question: lastReply/);
  // Clip-less speech mid-step (the browser's recognizer, a clip cut short) goes through the gate too.
  assert.match(server, /if \(!msg\.tapped\) \{[\s\S]{0,600}let v = await decideUtterance\(/);
});

test('media playing: parsed from the power assertions, Echo\'s own voice left out, cached', async () => {
  const pmset = [
    'Listed by owning process:',
    '   pid 753(coreaudiod): [0x0000ab8d00018a55] 00:01:33 PreventUserIdleSystemSleep named: "com.apple.audio.CC-22:output.context.preventuseridlesleep"  ',
    '\tCreated for PID: 72215. ',
    '\tResources: audio-out CC-22:output ',
    '   pid 753(coreaudiod): [0x0000ab8d00018a56] 00:00:10 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInMic.context.preventuseridlesleep"  ',
    '\tCreated for PID: 500. ',
    '\tResources: audio-in BuiltInMic ',
    '   pid 753(coreaudiod): [0x0000ab8d00018a57] 00:02:00 PreventUserIdleSystemSleep named: "com.apple.audio.CC-22:output.context.preventuseridlesleep"  ',
    '\tCreated for PID: 8888. ',
    '\tResources: audio-out CC-22:output ',
    '   pid 951(sharingd): [0x0000abc300018b2c] 00:00:39 PreventUserIdleSystemSleep named: "Handoff"  ',
  ].join('\n');
  assert.deepEqual(parseAudioAssertions(pmset).map((a) => a.pid), [72215, 8888], 'output only, not the mic');
  assert.equal(isEchoOwnAudio('/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU'), true);
  assert.equal(isEchoOwnAudio('/Applications/Echo.app/Contents/MacOS/Echo'), true);
  assert.equal(isEchoOwnAudio('/Applications/Spotify.app/Contents/MacOS/Spotify'), false);
  let t = 0;
  let calls = 0;
  const ps = { 72215: '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU', 8888: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper' };
  let only = [72215, 8888];
  const exec = async (file) => {
    calls++;
    if (file.endsWith('pmset')) return pmset;
    return only.map((p) => `${p} ${ps[p]}`).join('\n');
  };
  const w = mediaWatcher({ platform: 'darwin', now: () => t, exec });
  assert.equal(await w.playing(), true, 'Chrome is playing sound');
  const before = calls;
  assert.equal(await w.playing(), true);
  assert.equal(calls, before, 'cached');
  only = [72215];
  t += MEDIA_CACHE_MS + 1;
  assert.equal(await w.playing(), false, 'only Echo\'s own window: nothing else is playing');
  assert.equal(await mediaWatcher({ platform: 'linux', exec }).playing(), false);
  assert.equal(await mediaWatcher({ platform: 'darwin', exec: async () => { throw new Error('no pmset'); } }).playing(), false, 'a failed check reads as not playing');
});

test('the listening replay meets the bar: 95% of answers in, at most 1% of background, no run cancelled by a TV', () => {
  const r = runListening();
  assert.ok(r.answers.n >= 60 && r.background.n >= 60 && r.runs.n === 10);
  assert.ok(r.answers.rate >= 0.95, `answers accepted: ${(r.answers.rate * 100).toFixed(1)}% · missed ${JSON.stringify(r.answers.missed)}`);
  assert.ok(r.background.rate <= 0.01, `background that triggered: ${(r.background.rate * 100).toFixed(1)}% · ${JSON.stringify(r.background.which)}`);
  assert.equal(r.runs.cancelled, 0, JSON.stringify(r.runs.which));
});
