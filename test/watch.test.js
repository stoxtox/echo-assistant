// "Keep an eye on it" (lib/watch.js): Echo checks a window by itself and says when it finishes,
// fails, stops changing or runs out of time. Read-only, and the window's words are never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

const dirs = sandbox('watch');
const { Watcher, watchEvent, QUIET_MS, STILL_FROM_START_MS, WATCH_MOST, MISSES_MOST } = await import('../lib/watch.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { readTimeline } = await import('../lib/timeline.ts');

/** A watcher over a made-up window, with time and its timer in the test's hands. */
function rig(screens) {
  let now = 1_000_000, pending = null, i = 0;
  const ended = [];
  const w = new Watcher({
    read: async () => { const s = screens[Math.min(i++, screens.length - 1)]; return s === null ? { ok: false } : { ok: true, text: s }; },
    onEnd: (watch, why, detail) => ended.push({ why, detail, checks: watch.checks }),
    now: () => now, everyMs: 6000,
    setTimer: (fn) => (pending = fn), clearTimer: () => (pending = null),
  });
  /** Let `ms` pass and the next look happen. */
  const tick = async (ms = 6000) => { now += ms; const fn = pending; pending = null; if (fn) fn(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  return { w, ended, tick };
}

test('a phrase it was told to wait for ends the watch; one already on screen from before is not news', async () => {
  const { w, ended, tick } = rig(['$ npm test\ntests passed (yesterday)\nrunning…', 'running… 40%', 'running… 90%', 'tests passed\ntypecheck passed\n$ ']);
  assert.ok(w.start({ what: 'the rebuild', app: 'Terminal', until: ['tests passed'], fail: ['FAILED', 'not ok'] }).id);
  await tick(); // the first look is the baseline
  await tick();
  await tick();
  assert.deepEqual(ended, []);
  await tick();
  assert.deepEqual(ended, [{ why: 'found', detail: 'tests passed', checks: 4 }]);
  assert.equal(w.watches.size, 0);
});

test('a phrase that means failure wins, and says which', async () => {
  const { w, ended, tick } = rig(['building…', 'building… step 2', 'not ok 12 - something\ntests FAILED']);
  w.start({ what: 'the build', app: 'Terminal', until: ['tests passed'], fail: ['failed', 'not ok'] });
  await tick(); await tick(); await tick();
  assert.deepEqual([ended[0].why, ended[0].detail], ['failed', 'failed']);
  assert.match(watchEvent(/** @type {any} */ ({ what: 'the build', app: 'Terminal', startedAt: Date.now() }), 'failed', 'failed'), /looks like it failed\. Look at that app once/);
});

test('another assistant\'s reply: it ends when the window stops changing after it was seen changing', async () => {
  const { w, ended, tick } = rig(['Claude is writing', 'Claude is writing more', 'Claude is writing more and more', 'The whole answer.', 'The whole answer.', 'The whole answer.', 'The whole answer.']);
  w.start({ what: "Claude's reply", app: 'Claude', quiet: true });
  for (let k = 0; k < 4; k++) await tick();
  assert.deepEqual(ended, [], 'still changing');
  await tick(); await tick();
  assert.equal(ended.length, 0, `not yet: quiet for less than ${QUIET_MS} ms`);
  await tick();
  assert.equal(ended[0]?.why, 'stopped_changing');
  // A window that never changes at all was already finished: said after a little longer.
  const still = rig(['Done.']);
  still.w.start({ what: 'a download', app: 'Safari' });
  for (let k = 0; k < Math.floor(STILL_FROM_START_MS / 6000); k++) await still.tick();
  assert.equal(still.ended.length, 0);
  await still.tick();
  assert.equal(still.ended[0]?.why, 'stopped_changing');
});

test('it gives up when its time is up or the window can no longer be read, and can be stopped', async () => {
  const slow = rig(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
  slow.w.start({ what: 'a long job', app: 'Terminal', until: ['done'], minutes: 1 });
  for (let k = 0; k < 11 && !slow.ended.length; k++) await slow.tick();
  assert.equal(slow.ended[0]?.why, 'time_up');
  assert.match(watchEvent(/** @type {any} */ ({ what: 'a long job', app: 'Terminal', startedAt: Date.now() - 61_000 }), 'time_up', ''), /it is still going\. Tell them so in one line and ask if you should keep watching/);
  const gone = rig(['a', null, null, null, null, null]);
  gone.w.start({ what: 'it', app: 'Terminal', until: ['done'] });
  for (let k = 0; k < MISSES_MOST + 1; k++) await gone.tick();
  assert.equal(gone.ended[0]?.why, 'lost');
  const many = rig(['a']);
  for (let k = 0; k < WATCH_MOST; k++) assert.ok(many.w.start({ app: `App ${k}` }).id);
  assert.match(String(many.w.start({ app: 'One more' }).error), /already watching 3 things/);
  assert.match(String(many.w.start({ app: '' }).error), /which app/);
  assert.match(many.w.note(), /^\(watching for them: the App 0 window in App 0, 1 min so far;/);
  assert.equal(many.w.stop('app 1'), 1);
  assert.equal(many.w.stop(), 2);
  assert.deepEqual(many.ended.map((e) => e.why), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(watchEvent(/** @type {any} */ ({ what: 'x', app: 'y', startedAt: 0 }), 'cancelled', ''), '', 'stopping it yourself is not news');
});

test('the assistant can start one, is told when it ends, and a light goes to that window', async () => {
  let text = 'npm run build-app\ncompiling…';
  const screen = /** @type {any} */ ({ request: async (kind, p) => (kind === 'state' && p.text === true && p.app === 'Terminal' ? { ok: true, text } : { ok: false }), on() {}, nativeClients: () => 1 });
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, undefined, screen);
  d.watcher.everyMs = 15;
  d.input = /** @type {any} */ ({ push() {}, size: 0, close() {} });
  const lights = [], events = [];
  d.on('watch_light', (w) => lights.push([w.on, w.done === true]));
  d.notify = /** @type {any} */ ((line) => events.push(line));
  const tools = Object.fromEntries(d.allTools().map((t) => [t.name, t]));
  const r = await tools.keep_watch.handler({ what: 'the Echo rebuild', app: 'Terminal', done_text: ['signed into Applications', 'Build succeeded'], fail_text: ['error:'] }, {});
  assert.match(r.content[0].text, /Watching the Echo rebuild in Terminal/);
  assert.deepEqual(lights, [[true, false]]);
  d.send('what else is open?');
  await new Promise((res) => setTimeout(res, 60));
  text += '\nBuild succeeded. Echo.app signed into Applications';
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(events.length, 1);
  assert.match(events[0], /^\[watch\] You were keeping an eye on the Echo rebuild in Terminal for the user\. "signed into applications" has just appeared, so it looks finished\./);
  assert.deepEqual(lights.at(-1), [false, true]);
  const rows = readTimeline(dirs.data).filter((e) => e.type.startsWith('watch.'));
  assert.deepEqual(rows.map((e) => e.type), ['watch.start', 'watch.end']);
  assert.ok(!JSON.stringify(rows).includes('compiling'), 'the window\'s words never reach the timeline');
  assert.match(d.systemPrompt(), /Never tell them to ask you again in a minute\./);
  assert.match((await tools.stop_watch.handler({}, {})).content[0].text, /Nothing was being watched/);
});

test('the Mac app reads a window\'s words without a picture, and parks a light on it', () => {
  const src = (f) => fs.readFileSync(new URL(`../macos/Sources/${f}`, import.meta.url), 'utf8');
  const driver = src('Driver.swift');
  assert.match(driver, /let wantsText = p\["text"\] as\? Bool \?\? false/);
  assert.match(driver, /if role == "AXSecureTextField" \|\| string\(el, kAXSubroleAttribute\) == "AXSecureTextField" \{ continue \}/, 'never a password field');
  assert.match(src('TalkLayer.swift'), /p\.ignoresMouseEvents = true\n\s+p\.hasShadow = false\n\s+let root = NSView\(frame: CGRect\(x: 0, y: 0, width: 20, height: 20\)\)/);
  assert.match(src('main.swift'), /case "watchLight":/);
  assert.match(fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), /case 'watch_light': toApp\(\{ type: 'watchLight',/);
});
