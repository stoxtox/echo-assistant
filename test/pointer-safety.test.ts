// Oct 2: a guide step for "Apple" pointed at the Passwords menu bar icon (the menu bar search only
// looked at the status icons on the right), the user clicked it and Passwords opened; the Mac app
// stopped answering and Echo blamed an old app; the guide pill stayed after Stop. (A guide is a
// quick lesson now, lib/teach.js, and its step shows in the activity strip.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

sandbox('pointer-safety');
const { classifyByEffect, PASSWORD_UI } = await import('../lib/policy.ts');
const { uiAdapter, labelAdapter, TeachSession, quickLesson } = await import('../lib/teach.js');
const root = path.resolve(import.meta.dirname, '..');

test('Passwords and the Keychain are never Echo\'s to open or point at (tier 4)', () => {
  for (const s of ['Passwords', 'Apple Passwords', 'Keychain Access', 'keychain']) assert.ok(PASSWORD_UI.test(s), s);
  for (const s of ['Forgot password?', 'Apple', 'Password field', 'System Settings']) assert.ok(!PASSWORD_UI.test(s), s);
  const v = classifyByEffect({ action: 'click', target: 'Apple', resolved: { label: 'Apple Passwords', role: 'AXMenuBarItem', app: 'Passwords' } } as any);
  assert.deepEqual([v.level, v.tier], ['refuse', 4]);
  assert.equal(classifyByEffect({ action: 'click', target: 'Unlock', resolved: { label: 'Unlock', role: 'AXButton', app: 'Keychain Access' } } as any).tier, 4);
});

test('a quick lesson that lands on the Passwords icon stops and says where the step really is', async () => {
  const said: string[] = [], reports: any[] = [];
  const bridge: any = { request: async (kind: string) => (kind === 'point' ? { ok: true, found: true, via: 'menubar', label: 'Apple Passwords', app: 'Passwords' } : { ok: true, found: false }) };
  const { lesson } = quickLesson({ goal: 'turn on light mode', steps: [{ target: 'Apple', say: 'Click the Apple menu.', menu_bar: true }, { target: 'System Settings…', say: 'Click System Settings.' }] });
  const s = new TeachSession({ adapter: labelAdapter(bridge), say: (t: string) => { said.push(t); }, point: (target: string) => bridge.request('point', { target }), report: (r: any) => reports.push(r), autoPoll: false });
  assert.equal(s.start(lesson).ok, true);
  await s.poll();
  assert.deepEqual(reports.map((r) => r.kind), ['off_limits']);
  assert.equal(s.active, false);
  assert.match(reports[0].note, /Apple logo at the far left of the menu bar/);
  assert.deepEqual(said, [], 'the step is not said: the user is never sent to Passwords');
});

test("a lesson tells a Mac app that isn't answering apart from one that's too old", async () => {
  const silent: any = { request: () => new Promise(() => {}) };
  assert.equal(await uiAdapter(silent, { requestMs: 50 }).check(), 'no_answer', 'not answering is not "old"');
  const old: any = { request: async () => ({ ok: false, error: 'unknown request' }) };
  assert.equal(await uiAdapter(old, { requestMs: 50 }).check(), 'old_app');
  const fine: any = { request: async () => ({ ok: true, front: 'Finder' }) };
  assert.equal(await uiAdapter(fine, { requestMs: 50 }).check(), 'ok');
  const src = fs.readFileSync(path.join(root, 'lib/computer.js'), 'utf8');
  assert.match(src, /error: 'no_answer'[^\n]*don't tell them to rebuild anything/);
});

test('the lesson\'s step line: Stop hides it at once; it goes by itself after 75 s with no update', async () => {
  // (The guide pill is gone; the step shows in the activity strip. It imports with browser paths, so it's read, not imported.)
  const src = fs.readFileSync(path.join(root, 'public/ui/activity.js'), 'utf8');
  assert.match(src, /const STALE_MS = 75_000;/);
  assert.match(src, /send\(\{ type: 'computer_stop' \}\);\n\s+\/\/ Stop always works on screen[^\n]*\n\s+now\.guide = null;/);
  assert.match(src, /if \(g\) guideTimer = setTimeout\(clear, g\.finished \? DONE_MS : STALE_MS\);/);
  // Every lesson card feeds it, and the last one says the lesson is over.
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(app, /activity\.guide\(\{ step: msg\.step, total: msg\.total, say: msg\.current, finished: Boolean\(msg\.finished\), done: Boolean\(msg\.complete\) \}\);/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'public/computer.js'), 'utf8'), /guidePill/);
});

test('the Mac app: the menu bar search tries the Apple menu first and never looks at Passwords', () => {
  const swift = fs.readFileSync(path.join(root, 'macos/Sources/MenuBar.swift'), 'utf8');
  assert.match(swift, /static func offLimits\(_ app: NSRunningApplication\) -> Bool/);
  assert.match(swift, /id\.hasPrefix\("com\.apple\.Passwords"\) \|\| id == "com\.apple\.keychainaccess"/);
  assert.match(swift, /guard s >= 45, !offLimitsLabel\(label\)/);
  assert.match(swift, /attr\(root, kAXMenuBarAttribute\)[\s\S]{0,200}consider\(item, app: front\.localizedName \?\? "", bonus: 20\)/);
  assert.match(swift, /NSWorkspace\.shared\.runningApplications\.filter \{ !offLimits\(\$0\) \}/);
});
