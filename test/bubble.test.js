// The caption beside Echo's light ("Clicking Send", "Your turn"): the one field the server adds
// to an act request for it (`caption`, docs/firefly-protocol.md), the setting that turns it off,
// and how the Mac app is wired to its pure rules (BubbleMath in macos/Sources/PointMath.swift,
// whose own checks are in macos/Tests/main.swift, compiled and run by test/macapp.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('bubble');
const { ScreenBridge, cleanCaption, CAPTION_MAX } = await import('../lib/screen.js');
const { ComputerUse } = await import('../lib/computer.js');
const { getSettings, saveSettings, setFixedForTest } = await import('../lib/settings.js');

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const swift = (f) => read(`macos/Sources/${f}`);
// A fake secret is put together at run time, so the privacy check doesn't flag this file.
const j = (...parts) => parts.join('');

/** A bridge whose "Mac app" answers every act request. */
function fakeApp() {
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  const seen = [];
  bridge.on('request', (r) => {
    seen.push(r);
    const p = r.params;
    const out = r.kind === 'act' && p.step === 'resolve'
      ? { ok: true, found: true, token: `t${seen.length}`, label: p.target || '', role: 'AXButton', app: 'Notes', window: 'Notes' }
      : r.kind === 'point' ? { found: true, via: 'accessibility', label: p.target } : { ok: true, via: 'accessibility', app: 'Notes', window: 'Notes' };
    setImmediate(() => bridge.deliver(r.id, out));
  });
  return { bridge, seen };
}

test('an act request carries the step\'s own narration as its caption, on the resolve and on the do', async () => {
  (setFixedForTest({ screenAware: true }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do' }));
  const app = fakeApp();
  const c = new ComputerUse({ bridge: app.bridge, logFile: path.join(dirs.data, 'computer-log.jsonl') });
  assert.equal((await c.act('click', { target: 'New Note', say: '  Starting a\nnew note  ' })).done, true);
  assert.deepEqual(app.seen.map((r) => [r.params.step, r.params.caption]), [['resolve', 'Starting a new note'], ['do', 'Starting a new note']]);

  // No narration: no caption (the app words the step itself).
  await c.act('click', { target: 'Bold' });
  assert.ok(app.seen.slice(2).every((r) => !('caption' in r.params)), 'the field is left out, not sent empty');

  // Typing never carries one: the caption says where Echo types, not what.
  await c.act('type_text', { target: 'Title', text: 'Shopping list', say: 'Typing Shopping list' });
  const typing = app.seen.slice(4);
  assert.equal(typing.length, 2);
  assert.ok(typing.every((r) => !('caption' in r.params)));
  assert.ok(!JSON.stringify(typing[0].params).includes('Shopping list'), 'the resolve does not say what will be typed');
  c.abort('test over');
});

test('a caption is one clean line: secrets blacked out, clipped to 60 characters, or nothing', async () => {
  assert.equal(CAPTION_MAX, 60);
  assert.equal(cleanCaption('Opening   Mail…'), 'Opening Mail…');
  assert.equal(cleanCaption('x'.repeat(200)).length, 60);
  for (const no of ['', '   ', '…', '123', null, undefined, 42, { say: 'hi' }]) assert.equal(cleanCaption(no), '', JSON.stringify(no));
  const key = j('sk-', 'ant-', 'api03-', 'A'.repeat(40));
  const cleaned = cleanCaption(`Pasting ${key}`);
  assert.ok(!cleaned.includes('AAAA') && cleaned.includes('[redacted]'), cleaned);

  // Whoever builds the request, the bridge sends a clean caption or none.
  const app = fakeApp();
  await app.bridge.request('point', { target: 'Save', caption: `  Showing\n${key} ` });
  await app.bridge.request('point', { target: 'Save', caption: 7 });
  await app.bridge.request('act', { step: 'resolve', target: 'Save', caption: 'y'.repeat(90) });
  await app.bridge.request('wait', { target: 'Save' });
  const [dirty, bad, long, other] = app.seen.map((r) => r.params);
  assert.ok(dirty.caption.startsWith('Showing [redacted]') && !dirty.caption.includes('AAAA'));
  assert.ok(!('caption' in bad));
  assert.equal(long.caption.length, 60);
  assert.ok(!('caption' in other));
  assert.equal(dirty.target, 'Save', 'everything else in the request is as it was');
});

test('the protocol page documents the caption', () => {
  const doc = read('docs/firefly-protocol.md');
  assert.match(doc, /\| `caption` \|/);
  assert.match(doc, /60 characters/);
});

test('step captions are a setting, on by default, with a row in Settings → Companion that reaches the Mac app', () => {
  assert.equal(getSettings().stepCaptions, true);
  assert.equal(saveSettings({ stepCaptions: false }).stepCaptions, false);
  assert.equal(getSettings().stepCaptions, false, 'it is remembered');
  assert.equal(saveSettings({ stepCaptions: 'yes' }).stepCaptions, true, 'anything else reads as a switch');
  const html = read('public/index.html'), app = read('public/app.js');
  const companion = html.slice(html.indexOf('id="sec-companion"'), html.indexOf('id="sec-mac"'));
  assert.match(companion, /Caption beside the light<\/span>[\s\S]*?<input type="checkbox" id="setStepCaptions" role="switch" \/>/);
  assert.match(app, /setStepCaptions\.checked = settings\.stepCaptions !== false;/);
  assert.match(app, /setStepCaptions\.onchange = \(\) => saveSetting\(\{ stepCaptions: setStepCaptions\.checked \}\);/);
  assert.match(app, /toApp\(\{ type: 'prefs',[^}]*stepCaptions: setStepCaptions\.checked,/, 'it rides the prefs message the companion already uses');
  // The app keeps it (on unless told otherwise), and a caption on screen goes when it is turned off.
  assert.match(swift('Config.swift'), /static var stepCaptions: Bool \{\n\s+get \{ d\.object\(forKey: "StepCaptions"\) as\? Bool \?\? true \}/);
  assert.match(swift('ScreenBridge.swift'), /if let v = body\["stepCaptions"\] as\? Bool \{\n\s+Prefs\.stepCaptions = v\n\s+if !v \{ pointer\.hush\(fade: false\) \}/);
});

test('the app shows the caption when the light arrives, from the request\'s caption or its own words, and never takes the mouse', () => {
  const pointer = swift('Pointer.swift'), driver = swift('Driver.swift'), bridge = swift('ScreenBridge.swift'), math = swift('PointMath.swift');
  // The server's caption reaches the pointer from a point and from an act (resolve, then do).
  assert.match(bridge, /let caption = p\["caption"\] as\? String \?\? ""/);
  assert.match(driver, /let caption = BubbleMath\.phrase\(caption: p\["caption"\] as\? String \?\? "", action: action, target: info\["label"\] as\? String \?\? target,\n\s+to: p\["to"\] as\? String \?\? "", direction: p\["direction"\] as\? String \?\? "", secure: info\["secure"\] as\? Bool \?\? false\)/);
  assert.match(driver, /pointer\?\.point\(at: f, label: verb\(r\.action, r\.label\), caption: r\.caption, pinned: false/);
  // What is typed is never among the words: only names go in.
  assert.doesNotMatch(driver.match(/let caption = BubbleMath\.phrase\([^\n]*\n[^\n]*/)[0], /"text"|kAXValue/);
  // Asking and waiting say their own thing; it is shown after the flight (`arrive`), not during it.
  assert.match(pointer, /let words = long \? BubbleMath\.sentence\(sentence\) : BubbleMath\.phrase\(caption: caption, moment: asks \? \.asking : stepId != nil \? \.waiting : \.step\)/);
  assert.match(pointer, /say\(words, light: dest, around: body, after: arrive, on: screen, avoiding: avoid, stays: long\)/);
  assert.match(pointer, /say\(BubbleMath\.phrase\(target: s\.target, moment: \.searching\)/);
  assert.match(pointer, /say\(BubbleMath\.phrase\(moment: \.asking\), light: beside, around: showing/);
  const say = pointer.slice(pointer.indexOf('  private func say(_ words: String'), pointer.indexOf('  private func fade(_ layer: CALayer'));
  assert.match(say, /guard Prefs\.stepCaptions, !words\.isEmpty, let root = panel\?\.contentView\?\.layer else \{ return hush\(fade: false\) \}/, 'off in Settings: nothing is shown');
  assert.match(say, /BubbleMath\.origin\(target: around, light: light, size: size,\n\s+bounds: screen\.visibleFrame\.offsetBy\(dx: -origin\.x, dy: -origin\.y\), avoiding: avoiding\)/, 'on the screen, off the menu bar and the island');
  assert.match(say, /hush\(fade: false\)\n\s+let size = BubbleArt\.size\(words\)/, 'new words replace the old at once');
  assert.match(say, /asyncAfter\(deadline: \.now\(\) \+ \(stays \? BubbleMath\.speaks\(words\) : BubbleMath\.hold\(words\)\)\)/);
  assert.match(say, /if !Motion\.reduced \{ self\.fade\(b, from: 0, to: 1, over: BubbleMath\.fadeIn\) \}/);
  assert.match(say, /guard fades, !Motion\.reduced, b\.opacity > 0 else \{ return b\.removeFromSuperlayer\(\) \}/, 'reduced motion: no fade');
  assert.match(say, /fade\(b, from: 1, to: 0, over: BubbleMath\.fadeOut\)/);
  // It is a layer of the overlay, which lets every click through; no window of its own.
  assert.match(say, /root\.addSublayer\(b\)/);
  assert.match(pointer, /p\.ignoresMouseEvents = true \/\/ clicks go straight through/);
  // It goes when the light leaves.
  assert.match(pointer, /private func goHome\(why: String = "over"\) \{\n\s+stopTyping\(\)\n\s+hush\(\)/);
  assert.match(math, /static let maxChars = 40/);
  assert.match(math, /static let fadeIn = 0\.12, fadeOut = 0\.25/);
  // The old label beside the pearl (only without the island) is gone: the caption took its place.
  assert.doesNotMatch(pointer, /addLabel/);
});
