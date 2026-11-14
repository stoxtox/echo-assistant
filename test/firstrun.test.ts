// The permissions checklist: a native window in the Mac app (macos/Sources/Permissions.swift) with
// one row per Mac permission. Its logic (which rows, their words, what is required, the overall
// state, the buttons) is PermMath's, checked in macos/Tests/main.swift (compiled and run by
// test/macapp.test.js). This pins how the app shows it, the page's one message that opens it,
// and the timeline's line for a permission that changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pageSource } from './helpers.js';

const swift = (f: string): string => fs.readFileSync(new URL(`../macos/Sources/${f}`, import.meta.url), 'utf8');
const timeline = await import('../lib/timeline.ts');
const view = await import('../lib/timelineview.ts');

test('the app shows the checklist the first time, when a required permission is missing, and from the menu bar item', () => {
  const main = swift('main.swift');
  assert.match(main, /PermMath\.showAtLaunch\(firstRun: !Permissions\.shown, Permissions\.model\(\)\) \{ showPermissions\(\) \}/);
  // Never over a test run of the app (--snapshot).
  assert.match(main, /if AppConfig\.snapshotPath == nil, PermMath\.showAtLaunch/);
  const menu = main.slice(main.indexOf('func fillStatusMenu'), main.indexOf('// MARK: actions'));
  // In the menu only while a required one is missing; otherwise from Settings (the page's showPermissions message).
  assert.match(menu, /if missingPermission != nil \{ menu\.addItem\(item\("Fix Permissions…", #selector\(showPermissions\), ""\)\) \}/);
  assert.match(main, /case "showPermissions":\s+showPermissions\(\)/);
  // Back from System Settings: the open window reads the states again.
  const active = main.slice(main.indexOf('func applicationDidBecomeActive'), main.indexOf('func applicationDidResignActive'));
  assert.match(active, /permissionsWindow\.refresh\(\)/);
});

test('the window reads the states again every 2 seconds while it is open, and stops when it closes', () => {
  const win = swift('Permissions.swift');
  assert.match(win, /Timer\.scheduledTimer\(withTimeInterval: 2, repeats: true\) \{ \[weak self\] _ in self\?\.refresh\(\) \}/);
  const close = win.slice(win.indexOf('func windowWillClose'));
  assert.match(close, /timer\?\.invalidate\(\)/);
  // Done is offered only once nothing required is missing.
  assert.match(win, /if model\.overall != \.needs \{\n\s+let b = PermissionsButton\("Done"/);
  // It asks macOS nothing itself: what macOS says and the asking come in from outside, so the
  // render harness draws the same window with made-up states.
  for (const call of ['AXIsProcessTrusted', 'CGRequest', 'CGPreflight', 'AVCaptureDevice', 'SFSpeechRecognizer', 'NSWorkspace']) assert.ok(!win.includes(call), call);
});

test('"Allow" is remembered as asked; "Open Settings" only opens the page', () => {
  const ptt = swift('PushToTalk.swift');
  const act = ptt.slice(ptt.indexOf('static func act('), ptt.indexOf('private static var lastStates'));
  assert.match(act, /guard allow else \{ return openPane\(id\) \}\n\s+asked\.insert\(id\)\n\s+request\(id\)/);
  assert.match(ptt, /"speech": "Privacy_SpeechRecognition"/);
});

test('a permission that changes is noted once on the timeline: its name and new state, nothing else', () => {
  const ptt = swift('PushToTalk.swift');
  assert.match(ptt, /let changed = PermMath\.changes\(from: lastStates, to: now\)\n\s+lastStates = now\n\s+if !changed\.isEmpty \{ BodyLink\.shared\.timeline\("perm\.change", changed\) \}/);
  // The server keeps the five names and drops anything else that rides along.
  assert.deepEqual(timeline.safeFields('perm.change', { microphone: 'allowed', input: 'denied', speech: 'notyet', window: 'Inbox', said: 'hello there' }),
    { input: 'denied', microphone: 'allowed', speech: 'notyet' });
  const row = (f: Record<string, string>) => ({ ts: new Date(0).toISOString(), seq: 1, src: 'app' as const, type: 'perm.change', f });
  assert.equal(view.describe(row({ microphone: 'allowed' })), 'Mac permission changed: microphone allowed');
  assert.equal(view.describe(row({ screen: 'notyet', input: 'denied', speech: 'allowed' })),
    'Mac permission changed: screen recording not allowed yet, input monitoring denied, speech recognition allowed');
  assert.equal(view.describe(row({ microphone: 'whatever' })), 'Mac permission changed: no details');
});

test('the page\'s permission buttons open the checklist in the Mac app, with one message', () => {
  const onboarding = fs.readFileSync(new URL('../public/onboarding.js', import.meta.url), 'utf8');
  const row = onboarding.slice(onboarding.indexOf('function macPermRow'), onboarding.indexOf('async function testMic'));
  assert.match(row, /btn\.onclick = \(\) => deps\.toApp\?\.\(\{ type: 'showPermissions' \}\)/);
  assert.ok(!row.includes('requestPermission'), 'setup no longer asks macOS row by row');
  // The rows a browser tab has (tested through the server) keep their own buttons.
  const tab = onboarding.slice(onboarding.indexOf('function permRow'), onboarding.indexOf('function macPermRow'));
  assert.match(tab, /\/api\/permissions\/open/);
  assert.match(tab, /\/api\/permissions\/test/);
  // Settings: one Permissions row, inside the app only, and its button opens the same window.
  assert.match(pageSource(), /\$\('permsOpen'\)\.onclick = \(\) => toApp\(\{ type: 'showPermissions' \}\);/);
  assert.match(swift('main.swift'), /case "showPermissions":\n\s+showPermissions\(\)/);
});
