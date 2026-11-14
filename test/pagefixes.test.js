// Oct 3, the small things and the silence: Echo stayed quiet on six sentences and the page showed
// nothing at all (now a chip: "Not sure that was for me · Send anyway", and "yes, that was for
// you" sends the same words on, not judged again); a "Looking" chip stayed up after the look had
// finished; "Hands-free: just talk" sat under a conversation that was going on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { sandbox, pageSource } from './helpers.js';

const dirs = sandbox('pagefixes');
process.env.ECHO_FLAG_APPLESPEECH = '1';
const { speechIntake } = await import('../lib/server/speech.js');
const { pcmWav } = await import('../lib/heard.js');
const { saveSettings } = await import('../lib/settings.js');
saveSettings({ wakeWord: true, keepRecordings: false });

/* ---------- the quiet chip ---------- */

test('the page shows "Not sure that was for me · Send anyway" under your words when Echo stays quiet', () => {
  const app = pageSource();
  // The words of the last spoken sentence are kept for the chip (never typed text).
  assert.match(app, /lastSaid = msg\.typed \? '' : String\(msg\.text \|\| ''\);/);
  assert.match(app, /else if \(msg\.reason === 'quiet' && lastSaid\) \{ notSureForMe\(lastSaid\); lastSaid = ''; \}/);
  const chip = app.slice(app.indexOf('function notSureForMe'), app.indexOf('function notSureForMe') + 400);
  assert.match(chip, /words: 'Not sure that was for me', button: 'Send anyway'/);
  assert.match(chip, /ms: NOT_SURE_MS, remove: true/, 'gone after its time');
  assert.match(app, /const NOT_SURE_MS = 8000;/);
  // One code path with the "Was that for me?" chip: a tap sends the words as the user's own say-so.
  const shared = app.slice(app.indexOf('function forMeChip'), app.indexOf('function wasThatForMe'));
  assert.match(shared, /send\(\{ type: 'user_text', text: heard, confidence: 0\.9, tapped: true \}\)/);
  assert.match(app.slice(app.indexOf('function wasThatForMe'), app.indexOf('function notSureForMe')), /forMeChip\(heard, \{ kind: '', button: 'Was that for me\? ✓'/);
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /\.msg\.missed\.ask\.quiet \{/);
});

function clip() {
  const rate = 16000;
  const s = new Float32Array(3 * rate);
  for (let i = 0; i < 2 * rate; i++) s[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.09 * Math.SQRT2;
  return pcmWav(s, rate);
}

test('"yes, that was for you" after Echo stayed quiet sends the same words on as a sure sentence', async () => {
  let now = 1_000_000;
  const sent = [];
  const dispatcher = Object.assign(new EventEmitter(), {
    lastSpokeAt: 0, busy: false,
    computer: { driving: false, pending: new Map(), lesson: null, instruct() {} },
    routeInput: () => 'turn', localIntentFor: () => null, heard() {}, prepare() {},
    send(text, meta) { sent.push({ text, meta }); return 'turn'; },
  });
  // A judge that is never sure: the sentence goes to the assistant, which may stay quiet.
  const intake = speechIntake({
    dispatcher: /** @type {any} */ (dispatcher), quick: /** @type {any} */ ({ pendingList: () => [] }),
    screen: /** @type {any} */ ({ native: false }), broadcast: () => {}, clock: () => now, joinMs: 20,
  });
  const post = (text, notes = {}) => {
    now += 30_000;
    const req = Object.assign(Readable.from([clip()]), { headers: { 'x-echo-clip': encodeURIComponent(JSON.stringify({ mediaPlaying: false, mode: 'hands-free', sinceReplyMs: 3000, ...notes, final: { text, ms: 20, words: notes.mumbled ? text.split(' ').map((word) => ({ word, p: 0.3 })) : [] } })) } });
    return new Promise((resolve, reject) => {
      const res = { on() {}, writeHead() { return res; }, end(body) { resolve(JSON.parse(body)); } };
      intake.routes['POST /api/utterance'](req, res).catch(reject);
    });
  };
  intake.logConvo('Assistant', 'Sunny, 24 degrees.');
  const unsure = 'he said the meeting moved to Thursday afternoon';
  await post(unsure, { mumbled: true }); // heard unclearly: the judge can't tell
  const turn = sent.at(-1);
  assert.equal(turn.text, unsure);
  assert.equal(turn.meta.mayNotBeForEcho, true, 'the assistant may stay quiet on it');
  assert.equal(intake.listenState.lastSetAside, null);
  // A quiet ending for some other turn changes nothing; for this one, its words are set aside.
  dispatcher.emit('dropped', { reason: 'quiet', trace: 'someone-else' });
  assert.equal(intake.listenState.lastSetAside, null);
  dispatcher.emit('dropped', { reason: 'quiet', trace: turn.meta.trace });
  assert.equal(intake.listenState.lastSetAside?.text, unsure);
  const r = await post('yes that was for you');
  assert.equal(r.text, unsure, 'the same words go on');
  assert.equal(sent.at(-1).text, unsure);
  assert.equal(sent.at(-1).meta.mayNotBeForEcho, undefined, 'as a sure sentence: Echo may not stay quiet on it again');
  assert.equal(intake.listenState.lastSetAside, null, 'used up');
});

/* ---------- the "Looking" chip ---------- */

test('the "Looking" chip clears on screen_done, when a new turn starts, and by itself', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const made = [];
  const node = () => {
    const on = new Set();
    const n = { className: '', innerHTML: '', setAttribute() {}, classList: { toggle: (c, v) => (v ? on.add(c) : on.delete(c)), has: (c) => on.has(c) } };
    made.push(n);
    return n;
  };
  const g = /** @type {any} */ (globalThis);
  g.window = {};
  g.document = { createElement: node, body: { append() {} } };
  t.after(() => { delete g.window; delete g.document; });
  const { createScreenClient } = await import('../public/screen.js');
  const client = createScreenClient({ addNode() {}, toast() {}, send() {} });
  const up = () => made[0].classList.has('on');

  client.request({ id: 'a', kind: 'look', notice: true });
  assert.equal(up(), true, 'up while Echo looks');
  client.done('a');
  assert.equal(up(), false, 'gone on screen_done');

  client.request({ id: 'b', kind: 'look', notice: true });
  client.clearLooks(); // a new turn starts and b's screen_done never came
  assert.equal(up(), false, 'gone when a new turn starts');

  client.request({ id: 'c', kind: 'look', notice: true });
  t.mock.timers.tick(14_999);
  assert.equal(up(), true);
  t.mock.timers.tick(1);
  assert.equal(up(), false, 'and never outlives the look');

  const app = pageSource();
  assert.match(app, /case 'heard': \{\n\s*screenClient\.clearLooks\(\);/);
  assert.match(app, /case 'thinking': screenClient\.clearLooks\(\);/);
  assert.match(app, /case 'screen_done': screenClient\.done\(msg\.id\);/);
});

/* ---------- the hands-free hint ---------- */

test('"Hands-free: just talk" shows on Home only, never under a conversation', () => {
  assert.match(pageSource(), /if \(els\.chatEmpty\.hidden && els\.state\.textContent === stateLine\(\{ handsFree: true \}\)\) els\.state\.textContent = '';/);
});
