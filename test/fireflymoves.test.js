// The light's moves (echo-talk-design.html, "Firefly moves"): each one used when it fits, and
// kept small. The motions themselves are checked in macos/Tests/main.swift; this is the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('fireflymoves');
const { yesOrNo } = await import('../public/yesno.js');
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const pointer = read('macos/Sources/Pointer.swift'), math = read('macos/Sources/PointMath.swift');

test('Echo\'s own yes or no: only a plain one at the very start', () => {
  for (const t of ['Yes, it is saved.', 'Yep.', 'Of course, opening it now.', 'Exactly. That one.']) assert.equal(yesOrNo(t), 'yes', t);
  for (const t of ['No, that file is gone.', 'Nope.', 'Not yet, it is still uploading.', "I'm afraid not."]) assert.equal(yesOrNo(t), 'no', t);
  for (const t of ['No worries, here it is.', 'Right, so the file is open.', 'Sure thing.', 'Opening Mail now.', 'Now the eyes.', 'Yesterday you asked about this.', '']) assert.equal(yesOrNo(t), '', t);
  const page = read('public/app.js');
  assert.match(page, /case 'speak': gapFiller\.stop\(\); tagTurn\(liveBubble, msg\.trace\); nodWith\(msg\);/);
  assert.match(page, /if \(!msg\.trace \|\| msg\.trace === saidYesNoFor\) return;\n\s+saidYesNoFor = msg\.trace;\n\s+const m = yesOrNo\(msg\.text\);\n\s+if \(m\) toApp\(\{ type: 'companion', moment: m \}\);/, 'once per reply, at its first words');
  assert.match(pointer, /if name == "yes" \|\| name == "no" \{\n\s+guard firefly, mode == \.out, flight == nil, gesture == nil, !Motion\.reduced else \{ return \}/, 'only a light that is out and at rest');
});

test('each move has its moment, and none of them when motion is reduced', () => {
  // A step worked or didn't: a nod (not more than every few seconds) or a shake.
  assert.match(pointer, /if firefly, mode == \.out, !Motion\.reduced, !ok \|\| now - noddedAt >= PearlMath\.nodEvery \{/);
  // The job is over and went well: the spiral, then home.
  assert.match(pointer, /if firefly, mode == \.out, lastStepOk, !Motion\.reduced, CaptionBar\.shared\.dock\(\) != nil, flight == nil \{/);
  assert.match(pointer, /if g\.kind == "spiral" \{ fly\.art\.move\(to: shown, now: now\); fly\.art\.burst\(now: now\) \}/);
  // Thinking: the figure of eight. Resting: slower. Asking: it only hovers, and its halo beats.
  assert.match(pointer, /let d = voice == "thinking" && intent != "ask" \? PearlMath\.thinkingEight\(elapsed: rested\)/);
  assert.match(pointer, /asksNow && !reduce \? 0\.85 \* PearlMath\.heartbeat\(elapsed: now - arrivedAt\) : 0/);
  // Curious: a lean, and one small loop per visit.
  assert.match(pointer, /if !peeked, now - \(nearSince \?\? now\) >= PearlMath\.peekAfter \{ peeked = true; gesture = \("peek", now\) \}/);
  // A long flight: the comet. A route: numbered stops.
  assert.match(pointer, /fly\.art\.comet = hypot\(f\.to\.x - f\.from\.x, f\.to\.y - f\.from\.y\) >= PearlMath\.cometFrom && mode == \.out/);
  assert.match(pointer, /if walking, firefly \{ addStone\(at: dest, in: layer, scale: screen\.backingScaleFactor\) \}/);
  // Everything is cleared when the light moves on or goes home.
  assert.equal((pointer.match(/clearStones\(\)\n\s+clearTwin\(\)\n\s+gesture = nil/g) || []).length, 2);
  assert.match(math, /static let nodEvery = 6\.0/);
});

test('two lights: point_at may name a second thing, and a second, smaller light goes to it', () => {
  const tool = read('lib/tools/screen.js'), bridge = read('macos/Sources/ScreenBridge.swift');
  assert.match(tool, /also: z\.string\(\)\.optional\(\)/);
  assert.match(tool, /\.\.\.\(also && !route \? \{ also: String\(also\)\.slice\(0, 120\) \} : \{\}\)/, 'not with a route through menus');
  assert.match(bridge, /guard case \.hit\(let hit\) = AXFinder\.find\(also, in: app, displays: displays\) else \{ return \}/, 'not found: only the first is shown');
  assert.match(bridge, /if screen != nil \{ twin\(\) \}/);
  assert.match(pointer, /func twin\(at frame: CGRect\) \{\n\s+guard firefly, mode == \.out,/);
});
