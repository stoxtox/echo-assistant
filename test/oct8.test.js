// Oct 8, 2026: a morning relaying answers to another app and a FaceTime screen share. "Was that
// for me?" came up eight times mid-conversation (some other app had sound going), Echo answered
// its own voice coming back through the call, one screen share needed three yeses under a card
// that spoke of sending a message, "99" was answered after "thank you", and "show him what you
// can do" got a list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('oct8');
const { judgeAddressee, LIVE_TALK_MS } = await import('../lib/addressed.js');
const { echoesRecent } = await import('../lib/heard.js');
const { decideUtterance } = await import('../lib/pipeline/utterance.ts');
const { CLOSING } = await import('../lib/session.ts');
const { classifyAction, RISK_WORDS } = await import('../lib/agent/risk.js');
const { classifyByEffect } = await import('../lib/policy.ts');
const { ScreenBridge } = await import('../lib/screen.js');
const { ComputerUse, SHARE_CARRY_MS } = await import('../lib/computer.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

// The owner speaks at about -26 dB on this mic; a clip at 0.05 rms is right there.
const OWNER = { clip: { level: 0.05, voicedMs: 900 }, ownerDb: -26 };

test('in a live conversation, sound from another app does not turn the owner\'s next sentence into "was that for me?"', () => {
  const base = { clarity: /** @type {const} */ ('ok'), followUp: true, mediaPlaying: true, sinceReplyMs: 9000, ...OWNER };
  assert.deepEqual(judgeAddressee({ ...base, text: 'Actually, Claude' }), { confidence: 0.9, decision: 'accept', why: 'follow_up_live' });
  const long = "I think I have given the access to host to disable that, so let's keep it that way, and let's confirm that way as well";
  assert.deepEqual(judgeAddressee({ ...base, text: long }), { confidence: 0.82, decision: 'accept', why: 'follow_up_live' });
  // Not live: long after Echo spoke, unclear words, or a voice not known to be the owner's. As before.
  assert.equal(judgeAddressee({ ...base, text: 'Actually, Claude', sinceReplyMs: LIVE_TALK_MS + 1000 }).decision, 'ask');
  assert.equal(judgeAddressee({ ...base, text: 'Actually, Claude', clarity: 'low' }).decision, 'ask');
  assert.equal(judgeAddressee({ ...base, text: 'Actually, Claude', clip: null, ownerDb: null }).decision, 'ask');
  assert.equal(judgeAddressee({ ...base, text: long, clip: null, ownerDb: null }).why, 'follow_up_long');
  // A far, faint voice is still not the owner, live or not.
  assert.equal(judgeAddressee({ ...base, text: 'Actually, Claude', clip: { level: 0.002, voicedMs: 900 } }).why, 'faint');
});

test('Echo\'s own lines coming back through a call are not the user', async () => {
  const lines = ['Showing him a quick demo now.', 'I opened a live wind map for Sam. It is a spinning globe showing the winds.'];
  assert.equal(echoesRecent('Showing him a quick demo now. Showing him a quick demo now.', lines), true);
  assert.equal(echoesRecent('a spinning globe showing the winds', lines), true);
  assert.equal(echoesRecent('show him the quick demo again please', lines), false, 'the user asking for it again is not an echo');
  assert.equal(echoesRecent('demo now', lines), false, 'too short to tell');
  assert.equal(echoesRecent('Showing him a quick demo now. And then open the calendar.', lines), false, 'new words ride along: theirs');

  const judge = async (o) => judgeAddressee(o);
  /** @param {any} v */
  const why = (v) => v.reply?.reason;
  const c = { recent: ['User: show him what you can do', 'Assistant: Showing him a quick demo now.', 'Assistant: I opened a live wind map for Sam.'], driving: true, busy: false, pendingCards: 0, pendingMessages: 0, lessonActive: false, wakeWord: true, sinceReplyMs: 3000, inCall: true, now: Date.now() };
  const u = (text, more = {}) => ({ text, page: { mode: 'run', sinceReplyMs: 3000 }, clarity: /** @type {const} */ ('ok'), loud: null, quiet: false, mediaPlaying: true, ...more });
  const back = await decideUtterance(u('Showing him a quick demo now. Showing him a quick demo now.'), c, { judge });
  assert.deepEqual([back.kind, why(back)], ['drop', 'own_voice']);
  // On the call, right after Echo spoke, garbled words with no name are the call playing it back…
  const garbled = await decideUtterance(u('Watch the Pericles.'), c, { judge });
  assert.deepEqual([garbled.kind, why(garbled)], ['drop', 'own_voice']);
  // …but its name always gets through, and so does anything said a little later.
  assert.equal((await decideUtterance(u('Echo, stop sharing'), c, { judge })).kind, 'deliver');
  const later = await decideUtterance(u('Open the calendar', { page: { mode: 'run', sinceReplyMs: 9000 } }), { ...c, sinceReplyMs: 9000 }, { judge });
  assert.notEqual(why(later), 'own_voice');
  // With no call on, a quick follow-up is not held back.
  const noCall = await decideUtterance(u('Open the calendar'), { ...c, inCall: false }, { judge });
  assert.notEqual(why(noCall), 'own_voice');
});

test('"go quiet" closes the conversation, and an open driving session no longer keeps Echo listening after it', async () => {
  for (const t of ['Alright, now, go quiet', 'go quiet', 'be quiet please', 'stop listening', 'Thank you']) assert.equal(CLOSING.test(t), true, t);
  for (const t of ['go quiet on the build logs', 'keep quiet about it', 'is it quiet in there?']) assert.equal(CLOSING.test(t), false, t);
  const judge = async (o) => judgeAddressee(o);
  const c = { recent: ['User: Thank you', "Assistant: Hey, Alex. What's up?"], driving: true, busy: false, pendingCards: 0, pendingMessages: 0, lessonActive: false, wakeWord: true, sinceReplyMs: 8000, closed: true, now: Date.now() };
  const u = { text: '99', page: { mode: 'hands-free', sinceReplyMs: 8000 }, clarity: /** @type {const} */ ('ok'), loud: null, quiet: false, mediaPlaying: false };
  assert.equal((await decideUtterance(u, c, { judge })).kind, 'drop', 'a stray "99" after thank you');
  assert.equal((await decideUtterance({ ...u, text: 'Echo, are you there?' }, c, { judge })).kind, 'deliver', 'its name still wakes it');
  // A step under way is different: "stop" and corrections must still get in.
  assert.notEqual((await decideUtterance({ ...u, text: 'stop' }, { ...c, busy: true }, { judge })).kind, 'drop');
});

test('a screen share is its own kind of step, said as what it is', () => {
  const share = (label, app = 'FaceTime') => classifyAction({ action: 'click', target: label, resolved: { label, app, role: 'AXButton' } });
  for (const [label, app] of [['Share My Screen', 'FaceTime'], ['Share Entire Screen', 'Control Center'], ['Share Built-in Retina Display', 'Control Center'], ['Share Screen', 'zoom.us']]) {
    assert.deepEqual(share(label, app), { level: 'risky', category: 'share_screen', reason: RISK_WORDS.share_screen }, label);
    assert.equal(classifyByEffect({ action: 'click', target: label, resolved: { label, app, role: 'AXButton' } }).category, 'share_screen');
  }
  assert.match(RISK_WORDS.share_screen, /show your screen/);
  // Sending is still sending.
  assert.equal(share('Send', 'Messages').category, 'send');
  assert.equal(share('Share', 'Notes').category, 'send');
});

function computer() {
  setFixedForTest({ screenAware: true });
  saveSettings({ computerUse: true, pointer: true, driveMode: 'do' });
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 200 });
  bridge.nativeClients = () => 1;
  return new ComputerUse({ bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
}

test('one yes covers a screen share\'s clicks, across FaceTime and Control Center; asking for it in clear words covers them too', () => {
  const c = computer();
  const run = c.ensureRun();
  const verdict = { level: 'risky', category: 'share_screen' };
  const carry = { id: 'x', run: run.id, app: 'facetime', category: 'share_screen', step: 'click:share my screen', at: c.now() };
  assert.equal(c.carries(carry, verdict, 'click', {}, { app: 'Control Center', label: 'Share Built-in Retina Display' }, run), true, 'the next click, in another app');
  assert.equal(c.carries({ ...carry, at: c.now() - SHARE_CARRY_MS - 1000 }, verdict, 'click', {}, { app: 'Control Center', label: 'Share Entire Screen' }, run), false, 'not for ever');
  assert.equal(c.carries(carry, { level: 'risky', category: 'send' }, 'click', {}, { app: 'Messages', label: 'Send' }, run), false, 'and never a send');
  assert.equal(c.carries(carry, verdict, 'type_text', {}, { app: 'FaceTime', label: 'x' }, run), false);

  c.noteIntent('make a call to Sam, FaceTime call and do a screen share to him');
  assert.ok(c.shareAsked, 'their own words asked for it');
  c.noteIntent("call him but don't share my screen");
  assert.equal(c.shareAsked, null);
  c.noteIntent('share my screen with him', { unsure: ['screen'] });
  assert.equal(c.shareAsked, null, 'words Echo was not sure it heard never count');
  c.noteIntent('share my screen with him', { lowOverall: true });
  assert.equal(c.shareAsked, null);
  c.abort('test over');
});

test('"show him what you can do" is a short show, never a list', async () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  assert.match(d.systemPrompt(), /call demo and do its steps; a spoken list of features is never the answer/);
  const tool = d.allTools().find((t) => t.name === 'demo');
  assert.ok(tool);
  const r = (await tool.handler({ guest: 'Sam' }, {})).content[0].text;
  for (const step of [/1\. SEE\. look_at_screen, then point_at/, /2\. MAKE\. write_file .*hello-sam\.html/, /3\. DO\./, /4\. THE SKY\. show_sky with play true/]) assert.match(r, step);
  assert.match(r, /No list of features/);
  assert.match(r, /"Sam, what should I do next\?"/);
});
