// The companion's personality: the lively/calm setting, the moments the page sends the Mac app
// (Pointer.swift moment), and the signals the pearl is wired to. The drawing's maths is tested in
// Swift (macos/Tests/main.swift PearlMath).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox, pageSource } from './helpers.js';

sandbox('orbpersonality');
const { getSettings, saveSettings } = await import('../lib/settings.js');
const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('eyes are on by default, and the setting is a plain switch', () => {
  assert.equal(getSettings().orbEyes, true);
  assert.equal(saveSettings({ orbEyes: false }).orbEyes, false);
  assert.equal(saveSettings({ orbEyes: 'yes' }).orbEyes, true, 'anything else reads as a switch');
});

test('the page offers no Eyes, size or motion switch; the Mac app is still told the size, the motion and the look', () => {
  const html = src('public/index.html'), app = pageSource();
  assert.doesNotMatch(html, /id="setOrbEyes"/);
  assert.doesNotMatch(app, /setOrbEyes/);
  for (const id of ['setCompanionSize', 'setReduceMotion']) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  // The size (medium) and motion (as macOS says) are the same for everyone, and still told to the Mac app.
  assert.match(app, /toApp\(\{ type: 'prefs',[^}]*orbSize: settings\.orbSize \|\| 'medium', reduceMotion: settings\.reduceMotion \|\| 'system', companionLook: settings\.companionLook \|\| 'auto' \}\)/);
});

test('lesson steps and cutting in reach the orb as moments, once each', () => {
  const app = pageSource();
  assert.match(app, /const moment = msg\.step >= msg\.total \? 'celebrate' : 'proud';\s*viz\.moment\(moment\);\s*toApp\(\{ type: 'companion', moment \}\);/, 'the face in the window and the orb on the desktop both react');
  assert.match(app, /key !== lessonMoment/, 'the last step\'s card comes twice: one celebration');
  assert.match(app, /moment: 'surprised'/);
  const bridge = src('macos/Sources/ScreenBridge.swift');
  assert.match(bridge, /if let m = body\["moment"\] as\? String \{ pointer\.moment\(m\) \}/);
  assert.match(bridge, /Prefs\.orbEyes = v/);
  assert.match(src('macos/Sources/Pointer.swift'), /func moment\(_ name: String\) \{\n    CaptionBar\.shared\.moment\(name\)/, 'every moment reaches the pearl in the island');
});

test('the pearl is the presence: every mood has a real signal behind it', () => {
  const bar = src('macos/Sources/Caption.swift'), pointer = src('macos/Sources/Pointer.swift'), pearl = src('macos/Sources/Companion.swift');
  // Listening, thinking, speaking: Echo's voice and its level, as the island was already told.
  assert.match(bar, /pearl\.voice = voice != "idle" \? voice : fromMode/);
  assert.match(bar, /if let level \{ pearl\.setLevel\(level, now: CACurrentMediaTime\(\)\) \}/);
  assert.match(pearl, /var heard = mood == "listening" \|\| mood == "speaking" \? levelIn : 0/, 'the level moves it while she speaks too');
  // Working on the Mac: it thinks. A card waiting for an OK: it needs you.
  assert.match(bar, /pearl\.working = driving \|\| doing != nil/);
  assert.match(bar, /pearl\.asking = content\.card != nil \|\| lightNeeds/, 'a card, or its light asking or searching');
  // The page's moments, and "sorry" for a failed step or a lost sentence.
  for (const [name, call] of [['proud', 'proud'], ['celebrate', 'celebrate'], ['surprised', 'surprised'], ['sorry', 'miss'], ['landed', 'landed']]) {
    assert.match(bar, new RegExp(`case "${name}": pearl\\.${call}\\(now: now\\)`), name);
  }
  assert.match(pointer, /if firefly, !ok \{ CaptionBar\.shared\.moment\("sorry"\) \}/, 'a failed step reaches the pearl in the island');
  assert.match(pearl, /func celebrate\(now: Double\) \{\n    play\("happy", now: now\)\n    burst\(\)/, 'celebrate is happy with sparkles');
  // Asleep after three quiet minutes; anything happening (or the mouse moving nearby) wakes it.
  assert.match(src('macos/Sources/PointMath.swift'), /static let sleepAfter = 180\.0/);
  assert.match(pearl, /if pointer != lastPointer \{ lastPointer = pointer; if pointer != nil \{ activeAt = now \} \}/);
  assert.match(bar, /pearl\.wake\(now: CACurrentMediaTime\(\)\) \/\/ it arrives awake/);
});

test('its eyes follow the mouse near the island, read on the display tick: nothing watches the mouse', () => {
  const bar = src('macos/Sources/Caption.swift');
  assert.match(bar, /pearl\.pointer = showing && awayGoal == 0 \? PearlMath\.gaze\(from: center, to: mouse, reach: 300\) : nil/);
  assert.match(bar, /let mouse = NSEvent\.mouseLocation\n    stepPearl\(now, dt: dt, at: PillMath\.slotCenter\(pill\), mouse: mouse\)/);
  for (const f of ['Caption.swift', 'Companion.swift', 'Pointer.swift']) {
    assert.doesNotMatch(src(`macos/Sources/${f}`), /CGEvent\.tapCreate|CGEventTapCreate|addGlobalMonitorForEvents\(matching: (?!\.keyDown,)/, `${f}: no event tap, and nothing watching the mouse`);
  }
  // The one thing watched: the Escape key, and only while the light is in your hand (test/fireflymac.test.js).
  for (const f of ['Caption.swift', 'Companion.swift']) assert.doesNotMatch(src(`macos/Sources/${f}`), /addGlobalMonitorForEvents/, `${f}: no monitor at all`);
});

test('calm or lively, reduced motion, the look and the size all reach the pearl', () => {
  const bar = src('macos/Sources/Caption.swift'), bridge = src('macos/Sources/ScreenBridge.swift'), pointer = src('macos/Sources/Pointer.swift');
  assert.match(bar, /pearl\.lively = Prefs\.orbEyes/, 'the old Eyes key is the lively switch');
  assert.match(bar, /pearl\.reduced = Motion\.reduced/);
  assert.match(bar, /let skin = CompanionLook\.wear\(\)/, 'auto, glass or moon');
  assert.match(bar, /pearl\.skin = skin/);
  assert.match(pointer, /orb\.art\.diameter = diameter/);
  assert.match(pointer, /orb\.art\.lively = Prefs\.orbEyes/);
  assert.match(bridge, /pointer\.setStyle\(size: Prefs\.orbSize, look: Prefs\.companionLook\)/);
  const pearl = src('macos/Sources/Companion.swift');
  assert.match(pearl, /guard lively, !reduced else \{ return \}/, 'calm or reduced: no hops');
  assert.match(pearl, /if reduced \{ squash = 0; squashSpeed = 0; lift = 0; shake = 0; rings = \[\]; sparks = \[\] \}/);
});

test('Echo points with the pearl\'s light: the firefly is the way, and reach stays behind the same switch', () => {
  const pointer = src('macos/Sources/Pointer.swift'), bar = src('macos/Sources/Caption.swift'), math = src('macos/Sources/PointMath.swift');
  assert.match(math, /static let ways = \["firefly", "reach"\]/);
  assert.match(pointer, /get \{ PearlMath\.way\(UserDefaults\.standard\.string\(forKey: "PointingWay"\)\) \}/);
  assert.match(src('macos/Sources/ScreenBridge.swift'), /if let v = body\["pointingWay"\] as\? String \{ PointerOverlay\.way = v \}/);
  // It leaves from the rim, flies a curve to the thing's edge, and the pearl never leaves the island.
  assert.match(pointer, /start = firefly \? PearlMath\.rim\(of: d\.point, radius: PillMath\.mark \/ 2, toward:/);
  assert.match(pointer, /: firefly \? PearlMath\.orbit\(local, laps: 0\) : PearlMath\.stand\(beside: local/);
  assert.match(pointer, /CaptionBar\.shared\.setMarkAway\(!firefly\)/);
  // The pearl watches its light, glances at you once, and is pleased when it is home.
  assert.match(pointer, /CaptionBar\.shared\.setLight\(screenPoint\(ahead \?\? shown\), seeYou: seeYou\)/);
  assert.match(bar, /pearl\.target = light\.flatMap \{ PearlMath\.gaze\(from: center, to: lightSeeYou \? mouse : \$0\) \}/);
  assert.match(bar, /pearl\.lightAway = light != nil/);
  assert.match(bar, /if back \{ pearl\.lightHome\(now: CACurrentMediaTime\(\)\) \}/);
  // A click is a dive with a burst; a drag carries; typing hops; a scroll rides. White showing, colour acting.
  assert.match(pointer, /self\.fly\(to: CGPoint\(x: r\.midX, y: r\.midY\), now: now, quick: true\)/);
  assert.match(pointer, /self\.fly\?\.art\.burst\(now: CACurrentMediaTime\(\)\)/);
  assert.match(pointer, /if action == "drag", let to \{\n\s+self\.showing = to\n\s+self\.fly\(to: CGPoint\(x: to\.midX, y: to\.midY\), now: now\)/);
  assert.match(pointer, /PearlMath\.ride\(elapsed: now - ridingAt/);
  assert.match(pointer, /let why = PearlMath\.intent\(intent \?\? \(pinned \? "show" : "act"\)\)/, 'white showing, colour acting (and whatever the request says)');
  assert.match(pointer, /fly\?\.art\.intent = why/);
  assert.match(src('macos/Sources/Driver.swift'), /pointer\?\.point\(at: f, label: verb\(r\.action, r\.label\), caption: r\.caption, pinned: false, action: r\.action, dragTo: r\.to\)/, 'the pointer is told what Echo is about to do');
});
