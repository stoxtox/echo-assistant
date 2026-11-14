// One way of listening, in three states (lib/listenmode.js): listening, resting (its name only),
// off. What moves it: words ("go quiet", "stop listening", its name), a double-tap of the key, a
// tap on the pearl, the menu, three quiet minutes, the screen locking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('listenmode');
const { spokenMode, toggled, shouldRest, modeLine, listenModeOf, QUIET_REST_MS } = await import('../lib/listenmode.js');
const { nativeMicPlan, stateLine } = await import('../public/nativemic.js');
const { saveSettings, getSettings } = await import('../lib/settings.js');

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const page = read('public/app.js');

test('"go quiet" rests it, "stop listening" turns the mic off, and only as the whole sentence', () => {
  for (const t of ['go quiet', 'Alright, now, go quiet', 'okay be quiet now', "that's all for now", 'Echo, go to sleep', 'goodbye', 'you can rest', "we're done"]) assert.equal(spokenMode(t), 'resting', t);
  for (const t of ['stop listening', 'Echo, stop listening to me', 'mic off', 'turn the microphone off', 'turn off your mic please', 'mute yourself']) assert.equal(spokenMode(t), 'off', t);
  for (const t of ['go quiet on the build logs', 'keep quiet about it', 'is the mic off?', 'stop listening to that podcast and open Mail', "that's all the files I need you to move", 'thank you', 'the rest of the list']) assert.equal(spokenMode(t), null, t);
});

test('a double-tap or a tap on the pearl switches Listening and Resting; from Mic off it is Listening again', () => {
  assert.equal(toggled('listening'), 'resting');
  assert.equal(toggled('resting'), 'listening');
  assert.equal(toggled('off'), 'listening');
  assert.equal(listenModeOf('nonsense'), 'resting');
});

test('Listening rests after three quiet minutes, never in the middle of something', () => {
  const now = 1_000_000_000;
  const quiet = { mode: 'listening', now, lastAt: now - QUIET_REST_MS - 1 };
  assert.equal(shouldRest(quiet), true);
  assert.equal(shouldRest({ ...quiet, lastAt: now - 60_000 }), false, 'someone spoke a minute ago');
  assert.equal(shouldRest({ ...quiet, busy: true }), false, 'Echo is answering');
  assert.equal(shouldRest({ ...quiet, working: true }), false, 'a job is under way');
  assert.equal(shouldRest({ ...quiet, waiting: true }), false, 'a card or a question is open');
  assert.equal(shouldRest({ ...quiet, mode: 'resting' }), false);
  assert.equal(shouldRest({ ...quiet, mode: 'off' }), false);
  assert.equal(modeLine('resting', 'quiet'), 'Resting: three quiet minutes');
  assert.equal(modeLine('listening', 'name'), 'Listening: you said my name');
  assert.equal(modeLine('off', 'asked'), 'Mic off');
});

test('it is one setting, kept, and never anything but the three', () => {
  assert.equal(getSettings().listenMode, 'listening', 'out of the box Echo listens');
  assert.equal(saveSettings({ listenMode: 'off' }).listenMode, 'off');
  assert.equal(saveSettings({ listenMode: 'always' }).listenMode, 'listening');
  assert.equal(saveSettings({ listenMode: 'resting' }).listenMode, 'resting');
});

test('Resting opens the mic for its name only: not for a job under way, not for a follow-up, but for an answer Echo asked for', () => {
  const base = { available: true, setting: true, serverEngine: true, wakeWord: true };
  assert.equal(nativeMicPlan({ ...base, handsFree: true, driving: true }).arm, 'run', 'Listening, while Echo works: always on');
  assert.equal(nativeMicPlan({ ...base, resting: true, driving: true }).arm, 'wake');
  assert.equal(nativeMicPlan({ ...base, resting: true, engaged: true }).arm, 'wake');
  assert.equal(nativeMicPlan({ ...base, engaged: true }).label, 'follow');
  assert.equal(nativeMicPlan({ ...base, resting: true, answerOpen: true }).label, 'answer');
  const off = nativeMicPlan({ ...base, micOff: true, driving: true });
  assert.deepEqual([off.arm, off.linger], ['', false], 'Mic off: nothing armed, and the mic closes after a held key');
});

test('the line under the pearl says the state and the key that works here', () => {
  assert.equal(stateLine({ mode: 'listening', key: '⌃⌥' }), 'Listening · just talk');
  assert.equal(stateLine({ mode: 'resting', key: '⌃⌥' }), 'Resting · say “Echo” or hold <kbd>⌃⌥</kbd>');
  assert.equal(stateLine({ mode: 'off', key: '⌃⌥' }), 'Mic off · hold <kbd>⌃⌥</kbd> or type');
  assert.equal(stateLine({ mode: 'resting', speaking: true, spaceCuts: true, key: '⌃⌥' }), 'Speaking · <kbd>Esc</kbd> to hush, <kbd>⌃⌥</kbd> to cut in', 'what is happening now comes first');
  assert.match(stateLine({ ptt: true, pttHint: true, key: '⌃⌥' }), /release <kbd>⌃⌥<\/kbd> to send/);
});

test('the wiring: the key, the pearl, the menu, the words and the lock all move the same state', () => {
  // In the Mac app Space is a space: the talk key is the shortcut.
  assert.match(page, /if \(e\.code === 'Space' && !typing\(\) && !inApp\(\) && !els\.handsFree\.checked/);
  assert.match(page, /toggleListenMode: \(why = 'key'\) => setListenMode\(listenMode === 'listening' \? 'resting' : 'listening', why\)/);
  assert.match(page, /inApp\(\) \? setListenMode\(listenMode === 'listening' \? 'resting' : listenMode === 'off' \? 'resting' : 'listening', 'pearl'\)/);
  assert.match(page, /case 'listen_mode': applyListenMode\(msg\.mode\);/);
  assert.match(page, /if \(locked && listenMode !== 'off'\) \{ lockedFrom = listenMode; setListenMode\('off', 'lock'\); \}/);
  assert.match(page, /if \(listenMode === 'off'\) setListenMode\('resting', 'unlock'\)/, 'after a lock it comes back resting, never listening');
  const speech = read('lib/server/speech.js');
  assert.match(speech, /const held = String\(mode\) === 'push-to-talk';/);
  assert.match(speech, /if \(asked\) setListenMode\?\.\(asked, 'asked'\);/);
  assert.match(speech, /else if \(!held && getSettings\(\)\.listenMode === 'resting' && \(String\(mode\) === 'wake' \|\| nameAnywhere\(verdict\.said\)\)\) setListenMode\?\.\('listening', 'name'\);/);
  const server = read('server.js');
  assert.match(server, /setListenMode\('resting', 'quiet'\)/);
  const html = read('public/index.html');
  assert.deepEqual([...html.matchAll(/data-mode="(\w+)"/g)].map((m) => m[1]), ['listening', 'resting', 'off']);
  const swift = (f) => read(`macos/Sources/${f}`);
  assert.match(swift('ScreenBridge.swift'), /ptt\.onDoubleTap = \{ \[weak self\] in self\?\.js\("window\.echoNative\?\.toggleListenMode\('key'\)"\) \}/);
  assert.match(swift('main.swift'), /\("Listening", "listening"\), \("Resting: its name only", "resting"\), \("Mic Off", "off"\)/);
  assert.match(swift('HotKey.swift'), /static func menuBarImage\(dimmed: Bool = false, mode: String = ""\)/);
});
