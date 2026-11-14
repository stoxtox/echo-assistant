// Oct 3: with hands-free listening his sentences were cut off after two or three words ("I just",
// "I just think") and each fragment became its own turn. The server's safety net (lib/server/
// speech.js, lib/pipeline/utterance.ts waitsForMore): a hands-free sentence of one to three words
// that isn't whole as it stands waits a moment; if more speech comes, the two are one sentence
// before anything is judged; if not, it goes on alone. Push-to-talk is never held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { sandbox, wait, until } from './helpers.js';

const dirs = sandbox('joinparts');
process.env.ECHO_FLAG_APPLESPEECH = '1';
const { speechIntake } = await import('../lib/server/speech.js');
const { waitsForMore, joinParts, JOIN_MS } = await import('../lib/pipeline/utterance.ts');
const { pcmWav } = await import('../lib/heard.js');
const { saveSettings } = await import('../lib/settings.js');
const { readTimeline } = await import('../lib/timeline.ts');
const { pageSource, serverSource } = await import('./helpers.js');
saveSettings({ wakeWord: true, keepRecordings: false });

function clip(seconds = 2, voiced = 1) {
  const rate = 16000;
  const s = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < Math.round(voiced * rate); i++) s[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.09 * Math.SQRT2;
  return pcmWav(s, rate);
}

let now = 1_000_000;
const sent = [];
const lessonCommands = new Set(['done', 'next']);
const dispatcher = {
  lastSpokeAt: 0, busy: false,
  computer: { driving: false, pending: new Map(), lesson: /** @type {any} */ (null), instruct() {}, isLessonCommand: (t) => lessonCommands.has(String(t).toLowerCase().replace(/\W+$/, '')) },
  routeInput: (t) => (/^stop\b/i.test(t) ? 'stop' : 'turn'), localIntentFor: () => null, heard() {}, prepare() {},
  send(text, meta) { sent.push({ text, meta }); return 'turn'; },
};
const HOLD = 150;
const intake = speechIntake({
  dispatcher: /** @type {any} */ (dispatcher), quick: /** @type {any} */ ({ pendingList: () => [] }),
  screen: /** @type {any} */ ({ native: false }), broadcast: () => {}, clock: () => now, joinMs: HOLD,
});

/** POST /api/utterance with the Mac app's own text. Each clip is placed 30 s after the last, so none is "heard twice". */
function post(text, notes = {}) {
  now += 30_000;
  const req = Object.assign(Readable.from([clip()]), {
    headers: { 'x-echo-clip': encodeURIComponent(JSON.stringify({ mediaPlaying: false, mode: 'run', sinceReplyMs: 3000, ...notes, final: { text, ms: 20, words: [] } })) },
  });
  return new Promise((resolve, reject) => {
    const res = { on() {}, writeHead() { return res; }, end(body) { resolve(JSON.parse(body)); } };
    intake.routes['POST /api/utterance'](req, res).catch(reject);
  });
}
const sttLog = () => fs.readFileSync(path.join(dirs.data, 'stt-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
/** Echo said something that asks nothing, so the window is open and no answer is awaited. */
const echoSaid = (line = 'Type Hello into cell A1.') => intake.logConvo('Assistant', line);

test('what waits for more: his real fragments do; commands, a yes, a question and push-to-talk do not', () => {
  for (const t of ['I just', 'I just think', 'I think.', 'I just need']) {
    for (const listen of /** @type {const} */ (['run', 'window', 'handsfree'])) assert.equal(waitsForMore(t, { listen }), true, `${t} (${listen})`);
    assert.equal(waitsForMore(t, { listen: 'ptt' }), false, `${t}: push-to-talk is never held`);
    assert.equal(waitsForMore(t, { listen: 'wake' }), false, `${t}: after "Hey Echo" neither`);
    assert.equal(waitsForMore(t, { listen: 'run', answering: true }), false, `${t}: an answer to Echo's question goes at once`);
  }
  for (const t of ['yes', 'No.', 'yeah okay', 'no thanks', 'okay', 'What?', 'why not?', 'open Safari', 'Echo', 'thank you', 'never mind']) {
    assert.equal(waitsForMore(t, { listen: 'run' }), false, t);
  }
  assert.equal(waitsForMore('stop', { listen: 'run', command: true }), false, 'a command the server knows');
  assert.equal(waitsForMore('I just think the header', { listen: 'run' }), false, 'four words or more are a sentence');
  assert.equal(joinParts('I just think.', 'the header is too big'), 'I just think the header is too big');
  assert.equal(JOIN_MS, 1600);
});

test('"I just think" then the rest: one sentence reaches Echo, the fragment never does', async () => {
  echoSaid();
  const before = sent.length;
  const first = post('I just think.');
  await wait(30);
  assert.equal(sent.length, before, 'held: nothing has gone to Echo yet');
  intake.onset(); // the app's mic heard speech begin again
  await wait(HOLD + 100);
  assert.equal(sent.length, before, 'still held while the rest is being said, past the short wait');
  const second = await post('the header is too big');
  const a = await first;
  assert.equal(sent.length, before + 1, 'one turn, not two');
  assert.equal(sent.at(-1).text, 'I just think the header is too big');
  assert.equal(second.text, 'I just think the header is too big');
  assert.equal(a.empty, true);
  assert.equal(a.reason, 'joined');
  const dropped = sttLog().filter((l) => l.event === 'dropped' && l.reason === 'joined');
  assert.equal(dropped.length, 1, 'the fragment leaves one dropped line');
  assert.ok(!JSON.stringify(dropped[0]).includes('think'), 'without its words');
  const rows = readTimeline(dirs.data).filter((r) => r.type === 'speech.joined');
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0].f).sort(), ['ms', 'parts', 'words']);
  assert.equal(rows[0].f.parts, 2);
  assert.equal(rows[0].f.words, 8);
});

test('the next clip arriving within the wait is enough, with no onset reported', async () => {
  echoSaid();
  const before = sent.length;
  const first = post('I just');
  await wait(20);
  const second = await post('wanted to see the whole formula');
  await first;
  assert.equal(sent.length, before + 1);
  assert.equal(second.text, 'I just wanted to see the whole formula');
});

test('nothing more comes: it goes on alone after the wait', async () => {
  echoSaid();
  const before = sent.length;
  const t0 = Date.now();
  const r = await post('nice one there');
  assert.ok(Date.now() - t0 >= HOLD - 10, 'it waited');
  assert.equal(r.text, 'nice one there');
  assert.equal(sent.length, before + 1);
});

test('speech began but came to nothing (a cough): the held sentence goes on at once', async () => {
  echoSaid();
  const before = sent.length;
  const first = post('I think');
  await wait(20);
  intake.onset();
  await wait(20);
  intake.onset({ over: true });
  const r = await first;
  assert.equal(r.text, 'I think');
  assert.equal(sent.length, before + 1);
});

test('the clip that came next was blank: the held sentence still goes on alone', async () => {
  echoSaid();
  const before = sent.length;
  const first = post('I just need');
  await wait(20);
  const blank = await post('.');
  assert.equal(blank.empty, true);
  const r = await first;
  assert.equal(r.text, 'I just need');
  assert.equal(sent.length, before + 1);
});

test('never held: push-to-talk, a command, a yes, an answer to an open question, a lesson command', async () => {
  const quick = async (text, notes) => {
    const t0 = Date.now();
    const r = await post(text, notes);
    assert.ok(Date.now() - t0 < HOLD - 30, `${text}: not held (${Date.now() - t0} ms)`);
    return r;
  };
  echoSaid();
  assert.equal((await quick('I just think', { mode: 'push-to-talk' })).text, 'I just think');
  echoSaid();
  assert.equal((await quick('stop')).routed, 'stop');
  echoSaid();
  assert.equal((await quick('yes')).text, 'yes');
  echoSaid('Which cell did you type it into?');
  assert.equal((await quick('A five')).text, 'A five');
  echoSaid();
  dispatcher.computer.lesson = { active: true };
  assert.equal((await quick('done')).text, 'done');
  dispatcher.computer.lesson = null;
});

test('push-to-talk said while a fragment is held does not take its words', async () => {
  echoSaid();
  const before = sent.length;
  const first = post('I just');
  await wait(20);
  const ptt = await post('what time is it', { mode: 'push-to-talk' });
  assert.equal(ptt.text, 'what time is it');
  assert.equal((await first).text, 'I just');
  assert.equal(sent.length, before + 2);
});

test('the page tells the server when speech begins, and the socket passes it on', () => {
  assert.match(pageSource(), /send\(\{ type: 'onset' \}\)/);
  assert.match(pageSource(), /send\(\{ type: 'onset', over: true \}\)/);
  assert.match(serverSource(), /case 'onset':\s*\n[^\n]*\n\s*speech\.onset\(msg\)/);
});
