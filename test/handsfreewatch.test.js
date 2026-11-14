// Hands-free with a deaf mic (public/handsfreewatch.js): the live preview showed every word, the
// page's loudness detector heard nothing, so the turn never ended and Echo never answered (the
// 2026-09-30 report: words piling up in the caption, no clip ever reached the server). Now a pause
// in the words with a deaf mic sends them as the turn, and a working mic is left to the detector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeQuery, say, result, until, pageSource } from './helpers.js';

sandbox('handsfreewatch');
const { HandsFreeWatch, watchPauseMs, frameLevel, DEAF_LEVEL } = await import('../public/handsfreewatch.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const FRAME_MS = (1024 / 48000) * 1000; // the page's tap: 1024 samples at 48 kHz
const frameOf = (level) => new Float32Array(1024).fill(level);

/** A fake clock and timers, and a watch on them. */
function rig({ endSilenceMs = 1300 } = {}) {
  let now = 0;
  /** @type {Array<{ at: number, fn: () => void, id: number }>} */
  let timers = [];
  let nextId = 1;
  let hearing = false;
  const sent = [];
  let stale = 0;
  const watch = new HandsFreeWatch({
    pauseMs: () => watchPauseMs(endSilenceMs),
    isHearing: () => hearing,
    onDeaf: (text) => sent.push(text),
    onStale: () => stale++,
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
  });
  /** Let `ms` go by; `level` (or null: no frames at all) is what the mic delivers meanwhile. */
  const pass = (ms, level = 0) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + FRAME_MS);
      if (level !== null) watch.frame(frameOf(level));
      for (const t of timers.filter((x) => x.at <= now)) {
        timers = timers.filter((x) => x.id !== t.id);
        t.fn();
      }
    }
  };
  return {
    watch, pass, sent,
    get stale() { return stale; },
    set hearing(v) { hearing = v; },
  };
}

/** The live preview's words arriving over a sentence, while the mic delivers `level`. */
function speak(r, words, level) {
  const list = words.split(' ');
  for (let i = 1; i <= list.length; i++) {
    r.pass(250, level);
    r.watch.words(list.slice(0, i).join(' '));
  }
}

test('the pause before deciding follows the end-of-speech setting, never under 2 s', () => {
  assert.equal(watchPauseMs(1300), 2000);
  assert.equal(watchPauseMs(undefined), 2000);
  assert.equal(watchPauseMs(2600), 2600);
  assert.ok(frameLevel(frameOf(0.05)) > 0.049 && frameLevel(frameOf(0)) === 0);
});

test('the bug: a deaf mic (pure silence) while the preview shows the words; after the pause they are sent', () => {
  const r = rig();
  const said = "on hands-free mode after you listen me you don't reply";
  speak(r, said, 0); // the stream delivers silence: the detector never starts a clip
  r.pass(1500, 0);
  assert.deepEqual(r.sent, [], 'not while the pause is shorter than the end-of-speech wait');
  r.pass(600, 0);
  assert.deepEqual(r.sent, [said], 'the utterance, then silence: submitted once');
  r.pass(10000, 0);
  assert.equal(r.sent.length, 1, 'never sent twice');
});

test('a stalled audio context (no frames at all) counts as deaf too', () => {
  const r = rig();
  speak(r, 'can you hear me now', null);
  r.pass(2100, null);
  assert.deepEqual(r.sent, ['can you hear me now']);
});

test('a working mic: the detector ends the turn; the preview’s late words are tidied, never sent again', () => {
  const r = rig();
  r.pass(300, 0.001);
  r.hearing = true; // the detector heard the voice and is recording the clip
  speak(r, 'what is on my calendar today', 0.05);
  r.pass(1300, 0.001); // the end-of-speech pause: the detector sends the clip
  r.hearing = false;
  r.watch.words('what is on my calendar today'); // the preview finalizes late
  r.pass(2100, 0.001);
  assert.deepEqual(r.sent, [], 'the clip went already');
  assert.equal(r.stale, 1, 'the late words are cleared from the caption');
});

test('a long turn still under way is left to the detector', () => {
  const r = rig();
  r.hearing = true;
  speak(r, 'so the first thing I want you to do is', 0.05);
  r.pass(2100, 0.05);
  assert.deepEqual(r.sent, []);
  assert.equal(r.stale, 0);
});

test('sound the detector judged too quiet for speech (a TV, people nearby) is left alone, as before', () => {
  const r = rig();
  speak(r, 'and now the weather for the weekend', DEAF_LEVEL * 2);
  r.pass(2100, DEAF_LEVEL * 2);
  assert.deepEqual(r.sent, []);
  assert.equal(r.stale, 0);
});

test('a hands-free utterance followed by silence is submitted and answered', async () => {
  // The page: a deaf mic, the words, then silence. What onDeaf sends is what the server's
  // user_text passes on to the assistant (server.js handleUtterance → dispatcher.send).
  const r = rig();
  speak(r, 'what time is it in London', 0);
  r.pass(2100, 0);
  assert.equal(r.sent.length, 1);

  const fq = fakeQuery(() => [say("It's 9:56 in the evening in London."), result('ok')]);
  const d = new Dispatcher(new TaskManager({ queryFn: fakeQuery(() => []).queryFn }));
  d.queryFn = /** @type {any} */ (fq.queryFn);
  d.on('error', () => {});
  const replies = [];
  d.on('say', (t) => replies.push(t));
  d.start();
  d.send(r.sent[0]);
  await until(() => replies.length > 0, 3000, 'the answer');
  assert.match(fq.calls[0].prompts.join('\n'), /what time is it in London/);
  assert.equal(replies[0], "It's 9:56 in the evening in London.");
});

test('the page wires it up: every hands-free frame and the preview’s words reach the watch', () => {
  const app = pageSource();
  assert.match(app, /from '\/handsfreewatch\.js'/);
  assert.match(app, /handsFreeWatch\.frame\(frame\);\n\s*detectSpeech\(frame, frameMs\);/, 'the frames the detector gets');
  assert.match(app, /if \(serverEngine\(\) && els\.handsFree\.checked && listening\) handsFreeWatch\.words\(shown\);/);
  const deaf = app.slice(app.indexOf('onDeaf:'), app.indexOf('onStale:'));
  assert.match(deaf, /sendClip\(null, text, \{ mode: 'hands-free' \}\)/, 'sent as the turn');
  assert.match(deaf, /dropMic\(/, 'the deaf stream is let go');
  assert.match(deaf, /ensureMic\(\)/, 'and a fresh one opened');
  assert.match(deaf, /stopRec\(\)/, 'the recognizer starts over, so the words cannot come back');
  assert.match(deaf, /speaking\) return/, 'never while she speaks');
});
