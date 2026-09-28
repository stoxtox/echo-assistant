// "Hey Echo": the server's matcher (lib/wake.js) and the page's listener (public/wake.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

sandbox('wake');
const { matchWake, stripWake, wakeThreshold } = await import('../lib/wake.js');
const { WakeListener, frameLevel } = await import('../public/wake.js');
const { getSettings, saveSettings } = await import('../lib/settings.js');

test('wakes on "Hey Echo" and how an accent or Whisper writes it', () => {
  for (const t of ['Hey Echo', 'Hey Echo!', 'Echo.', 'ECHO', 'Hey, Echo.', 'Hay Echo', 'A echo', 'Hey Eko', 'Okay Echo, open Bluebird', 'Heiko, what is the weather?', 'Hey Co!', 'hey ego'])
    assert.equal(matchWake(t).wake, true, t);
});

test('does not wake on other speech, or her name further in', () => {
  for (const t of ['', 'Thank you.', 'The echo of the canyon was loud.', 'Echoes of the past come back.', 'Eco-friendly homes are selling fast.', 'Hey everyone, welcome back.', 'A long time ago', 'Hey Ethan', 'Can you launch that project, Echo?', 'Hey, hey, go.', 'I said hey echo'])
    assert.equal(matchWake(t).wake, false, t);
});

test('keeps what came after the wake word', () => {
  assert.equal(matchWake('Hey Echo, check the build.').rest, 'check the build.');
  assert.equal(stripWake('Hey Echo, check the build.'), 'Check the build.');
  assert.equal(stripWake('Hey Echo.'), '');
  assert.equal(stripWake('What time is it?'), 'What time is it?', 'a follow-up without her name is kept whole');
  assert.equal(stripWake('Ago I went home.'), 'Ago I went home.', 'a near miss alone is never cut off');
});

test('sensitivity: strict needs "Hey", loose takes a near miss alone; a guess counts for less', () => {
  assert.ok(wakeThreshold(0) > wakeThreshold(0.5) && wakeThreshold(0.5) > wakeThreshold(1));
  assert.equal(matchWake('Echo', { sensitivity: 0 }).wake, false);
  assert.equal(matchWake('Hey Echo', { sensitivity: 0 }).wake, true);
  assert.equal(matchWake('Ego', { sensitivity: 0.5 }).wake, false);
  assert.equal(matchWake('Ego', { sensitivity: 1 }).wake, true);
  assert.equal(matchWake('Echo', { lp: -1.5 }).wake, false, 'Whisper guessing');
});

test('settings: wake word on by default, sensitivity kept between 0 and 1', () => {
  assert.equal(getSettings().wakeWord, true);
  assert.equal(getSettings().wakeSensitivity, 0.5);
  assert.equal(saveSettings({ wakeSensitivity: 7 }).wakeSensitivity, 1);
  assert.equal(saveSettings({ wakeSensitivity: 'x' }).wakeSensitivity, 0.5);
  assert.equal(saveSettings({ wakeWord: false }).wakeWord, false);
});

/* ---------- the page's listener ---------- */
const R = 16000;
const quiet = (s) => Float32Array.from({ length: Math.round(s * R) }, () => (Math.random() - 0.5) * 0.002);
const talk = (s) => Float32Array.from({ length: Math.round(s * R) }, (_, i) => Math.sin(i / 5) * 0.2);
/** Feed audio in 20 ms frames, waiting for any check to finish. @param {any} l */
async function play(l, ...parts) {
  for (const p of parts) for (let i = 0; i + 320 <= p.length; i += 320) {
    l.feed(p.subarray(i, i + 320));
    if (l.pending) {
      await l.pending;
      l.pending = null;
    }
  }
}
function listener(answer) {
  const log = { checks: [], woke: 0, turns: [], cancels: [] };
  /** @type {any} */
  const l = new WakeListener({
    rate: R,
    check: (s) => {
      log.checks.push(s.length / R);
      return (l.pending = Promise.resolve(answer(log.checks.length)));
    },
    onWake: () => log.woke++,
    onTurn: (s, info) => log.turns.push({ seconds: s.length / R, ...info }),
    onCancel: (why) => log.cancels.push(why),
  });
  return { l, log };
}

test('frameLevel is the RMS of a frame', () => {
  assert.equal(frameLevel(new Float32Array(10)), 0);
  assert.ok(Math.abs(frameLevel(new Float32Array(10).fill(0.5)) - 0.5) < 1e-9);
});

test('silence and clicks are never checked', async () => {
  const { l, log } = listener(() => ({ wake: true }));
  const click = quiet(1);
  click.fill(0.4, 8000, 8200);
  await play(l, quiet(3), click, quiet(1));
  assert.equal(log.checks.length, 0);
});

test('speech that is not the wake word is dropped, and the rest of that burst is not checked again', async () => {
  const { l, log } = listener(() => ({ wake: false }));
  await play(l, quiet(0.5), talk(5), quiet(1));
  assert.equal(log.checks.length, 1);
  assert.ok(log.checks[0] <= 1.81, 'only the first ~1.8 s is checked');
  assert.equal(log.woke, 0);
  assert.equal(l.buf, null, 'no audio kept');
  await play(l, talk(1), quiet(1));
  assert.equal(log.checks.length, 2, 'a new burst after a pause gets its own check');
});

test('"Hey Echo, <request>" in one breath: wakes, records until the pause, sends it all', async () => {
  const { l, log } = listener(() => ({ wake: true, rest: 'check the build' }));
  await play(l, quiet(0.5), talk(3), quiet(2));
  assert.equal(log.woke, 1);
  assert.equal(log.turns.length, 1);
  assert.ok(log.turns[0].seconds > 3 && log.turns[0].seconds < 5, `${log.turns[0].seconds}`);
  assert.equal(log.turns[0].rest, 'check the build');
  assert.equal(l.state, 'idle');
});

test('"Hey Echo" ... pause ... request: waits for the request; nothing said means cancel', async () => {
  const a = listener(() => ({ wake: true, rest: '' }));
  await play(a.l, quiet(0.5), talk(0.7), quiet(2), talk(2), quiet(2));
  assert.equal(a.log.turns.length, 1, 'the pause after "Hey Echo" does not end it');
  assert.ok(a.log.turns[0].seconds > 4);
  const b = listener(() => ({ wake: true, rest: '' }));
  await play(b.l, quiet(0.5), talk(0.7), quiet(7));
  assert.equal(b.log.turns.length, 0);
  assert.deepEqual(b.log.cancels, ['no_request']);
});

test('reset (Echo started talking) drops a check in flight', async () => {
  let release;
  const l = new WakeListener({ rate: R, check: () => new Promise((r) => (release = r)), onWake: () => assert.fail('woke after reset') });
  for (let i = 0; i < 100; i++) l.feed(talk(0.02));
  assert.equal(l.state, 'checking');
  l.reset();
  release({ wake: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(l.state, 'idle');
});

test('a follow-up after her question needs no wake word', async () => {
  const { l, log } = listener(() => assert.fail('no check for a follow-up'));
  l.expectFollowUp();
  await play(l, quiet(0.5), talk(1.5), quiet(2));
  assert.equal(log.turns.length, 1);
  assert.equal(log.turns[0].followUp, true);
  l.expectFollowUp();
  await play(l, quiet(7));
  assert.deepEqual(log.cancels, ['no_follow_up']);
});

test('the page wires the wake word: muted while Echo speaks, a pill for mic off, the settings', () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, '../public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(import.meta.dirname, '../public/index.html'), 'utf8');
  assert.match(app, /if \(wakeListening\(\)\) \{\s*\/\/[^\n]*\n\s*if \(echo\)/, 'no wake audio while Echo is speaking');
  assert.match(app, /fetch\('\/api\/wake'/);
  for (const id of ['wakePill', 'setWake', 'setWakeSens']) assert.match(html, new RegExp(`id="${id}"`));
});
