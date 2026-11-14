// The first look at the screen after a restart or a long quiet spell (macos/Sources/Screen.swift).
// Oct 7, 2026: the first look timed out, and so did the two retries, because the screen reader had
// gone cold, each retry started a second read racing the first, and nothing said which half was slow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('firstlook');
const { ScreenBridge } = await import('../lib/screen.js');
const swift = (/** @type {string} */ f) => readFileSync(new URL(`../macos/Sources/${f}`, import.meta.url), 'utf8');

test('the Mac app keeps the screen reader awake, and a retry joins the look still being read', () => {
  const screen = swift('Screen.swift');
  assert.match(swift('main.swift'), /ScreenLook\.keepWarm\(\)/);
  assert.match(screen, /NSWorkspace\.didWakeNotification/, 'woken again when the Mac wakes');
  assert.match(screen, /LookMath\.cold\(sinceUse: .*\{ warmUp\(capture: false\) \}/, 'idle: only the text reader is woken, no picture is taken');
  assert.match(screen, /LookMath\.joins\(startedAgo:[\s\S]{0,120}waiting\.append\(done\)/, 'the retry waits for the running look');
  // Still nothing of the screen is written anywhere, and a late look reports numbers only.
  assert.doesNotMatch(screen, /\.write\(to:|writeToFile|FileManager\.default\.createFile/);
  assert.match(screen, /timeline\("look\.late", \["captureMs": took\.capture, "readMs": took\.read\]\)/);
});

test('a look is logged with how long it took, and each half when the Mac app says', async () => {
  const logFile = path.join(dirs.data, 'screen-log.jsonl');
  const bridge = new ScreenBridge({ logFile, timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  bridge.on('request', (r) => setImmediate(() => bridge.deliver(r.id, { ok: true, source: 'native', text: 'Hello', app: 'Notes', window: 'Note', captureMs: 180.4, readMs: 420, redactions: 0 })));
  const r = await bridge.request('look', {});
  assert.equal(r.ok, true);
  const row = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.event === 'screen_looked');
  assert.equal(row.captureMs, 180);
  assert.equal(row.readMs, 420);
  assert.ok(row.ms >= 0);
  assert.equal(JSON.stringify(row).includes('Hello'), false, 'never what was on the screen');
});

test('the square round what was circled does not outstay the work', () => {
  const talk = swift('TalkLayer.swift');
  assert.match(talk, /func fadeOutline\(\)/);
  assert.match(talk, /matching: \.scrollWheel/, 'the page scrolls: it goes');
  assert.match(talk, /DrawMath\.outlineMost/, 'and never longer than that');
  assert.match(swift('Pointer.swift'), /DrawLight\.shared\.voice\(was: voice, now: next\)/, 'Echo has answered: it goes');
  assert.match(swift('Pointer.swift'), /keepOutline = !pinned && finishedAt == nil && actionPending/, 'a ring stays only while a yes is awaited');
});
