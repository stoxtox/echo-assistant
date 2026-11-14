// The companion (public/ui/companion.js): Echo's face in the window. Its pure parts (which mood
// wins, each mood's targets, the easing, blinking and glancing, the echo rings, the pointer, the
// pokes, the "sorry" lines) and how the page drives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MOODS, STATES, STATE_CLASS, MOMENTS, LOOKS, SLEEP_AFTER_S, NEAR_PX, DIZZY_POKES, DIZZY_WINDOW_S, CLICK_WAIT_MS, PET_HOLD_S, PET_MOVE_PX,
  lookFor, createClicks, frameGap, frameDue, isPetting, moodFor, moodTargets, easeStep, nextBlinkAt, nextGlance, ringDue, stepRings, pointerLook, pokeAt, asleepAt, keepsStill, firstToday, dayKey, sorryLine, bodyPath,
} from '../public/ui/companion.js';
import { sandbox, pageSource, wait } from './helpers.js';

sandbox('companion');
const { getSettings, saveSettings } = await import('../lib/settings.js');
const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('style.css');
const src = read('ui/companion.js');
const app = pageSource();

test('one mood at a time: a moment wins, then the voice, then a waiting question, then sleep', () => {
  assert.equal(moodFor({}), 'idle');
  assert.equal(moodFor({ voice: 'thinking' }), 'thinking');
  assert.equal(moodFor({ voice: 'listening' }), 'listening');
  assert.equal(moodFor({ voice: 'speaking', needs: true }), 'speaking', 'it still talks and listens while a card waits');
  assert.equal(moodFor({ voice: 'listening', needs: true }), 'listening');
  assert.equal(moodFor({ voice: 'thinking', needs: true }), 'needs', 'with a card waiting Echo is not working, it is waiting for you');
  assert.equal(moodFor({ voice: 'idle', needs: true, asleep: true }), 'needs', 'it never sleeps on a question');
  assert.equal(moodFor({ voice: 'idle', asleep: true }), 'sleepy');
  assert.equal(moodFor({ voice: 'thinking', asleep: true }), 'thinking');
  assert.equal(moodFor({ voice: 'idle', attentive: true, asleep: true }), 'listening', 'just woken: all ears for a moment');
  for (const m of ['happy', 'surprised', 'sorry']) assert.equal(moodFor({ moment: m, voice: 'speaking', needs: true }), m, m);
  assert.equal(moodFor({ moment: 'nonsense', voice: 'thinking' }), 'thinking', 'an unknown moment changes nothing');
  assert.deepEqual([...STATES], ['idle', 'listening', 'thinking', 'speaking']);
  assert.deepEqual(STATES.map((s) => STATE_CLASS[s]), ['', 'listen', 'think', 'speak']);
  assert.equal(MOODS.length, 12);
  for (const m of Object.values(MOMENTS)) assert.ok(MOODS.includes(/** @type {any} */ (m.mood)) && m.seconds > 0 && m.seconds <= 3.2);
});

test('each mood has its own face: wide eyes to listen, a look up to think, a smile when it goes right, eyes down when it does not', () => {
  const idle = moodTargets('idle', { glance: { x: 0.3, y: -0.1 } });
  assert.deepEqual([idle.open, idle.happy, idle.lx, idle.ly], [1, 0, 0.3, -0.1], 'at rest the eyes wander where the glance says');
  const listening = moodTargets('listening', { level: 0 });
  assert.ok(listening.open > 1 && listening.lean === 1);
  assert.ok(moodTargets('listening', { level: 1 }).energy > listening.energy, 'the rim brightens with your voice');
  const thinking = moodTargets('thinking');
  assert.ok(thinking.ly < 0 && thinking.lx > 0, 'it looks up and away');
  const speaking = moodTargets('speaking', { level: 1 });
  assert.ok(speaking.energy > moodTargets('speaking', { level: 0 }).energy && speaking.open < 1);
  assert.equal(moodTargets('happy').happy, 1);
  assert.ok(moodTargets('surprised', { age: 0.1 }).open > moodTargets('surprised', { age: 1 }).open, 'widest at the start');
  const needs = moodTargets('needs');
  assert.ok(needs.tilt > 0 && needs.brow === 1);
  const sorry = moodTargets('sorry');
  assert.ok(sorry.ly > 0.5 && sorry.dim > 0.5 && sorry.open < 1);
  const sleepy = moodTargets('sleepy');
  assert.ok(sleepy.open < 0.1 && sleepy.energy < 0.1);
  // every mood gives every number, so nothing eases towards undefined
  for (const m of MOODS) for (const v of Object.values(moodTargets(m, { level: 0.5, age: 1, t: 3 }))) assert.ok(Number.isFinite(v), m);
});

test('the pointer takes the eyes in the moods with eyes to spare, and only when it is near', () => {
  const pointer = { x: -0.8, y: 0.4 };
  for (const m of ['idle', 'listening', 'speaking', 'needs']) assert.deepEqual([moodTargets(m, { pointer }).lx, moodTargets(m, { pointer }).ly], [-0.8, 0.4], m);
  for (const m of ['thinking', 'sorry', 'sleepy', 'surprised']) assert.notEqual(moodTargets(m, { pointer }).lx, -0.8, m);
  // the pearl is at (100, 100) with radius 50
  assert.deepEqual(pointerLook(100, 100, 100, 100, 50), { x: 0, y: 0 });
  const right = pointerLook(300, 100, 100, 100, 50);
  assert.ok(right && right.x === 1 && right.y === 0, 'full deflection well before the edge of its range');
  const upLeft = pointerLook(60, 30, 100, 100, 50);
  assert.ok(upLeft && upLeft.x < 0 && upLeft.y < 0 && upLeft.x > -1);
  assert.ok(pointerLook(100 + 50 + NEAR_PX - 1, 100, 100, 100, 50), 'just inside 300 px of its edge');
  assert.equal(pointerLook(100 + 50 + NEAR_PX + 1, 100, 100, 100, 50), null, 'past that it stops caring');
  assert.equal(pointerLook(NaN, 0, 100, 100, 50), null);
});

test('easing gets there smoothly, the same whatever the frame rate, and never overshoots', () => {
  assert.equal(easeStep(0.4, 0.4, 9, 0.016), 0.4);
  const one = easeStep(0, 1, 6, 0.1);
  let two = 0;
  for (let i = 0; i < 10; i++) two = easeStep(two, 1, 6, 0.01);
  assert.ok(Math.abs(one - two) < 1e-9, 'ten small frames land where one long frame does');
  assert.ok(one > 0 && one < 1);
  assert.ok(easeStep(0, 1, 12, 0.1) > one, 'a higher rate is quicker');
  assert.ok(easeStep(1, 0, 6, 5) >= 0 && easeStep(1, 0, 6, 5) < 0.001, 'a long pause settles on the target');
});

test('it blinks every few seconds (slowly when it keeps still) and glances a little off centre', () => {
  assert.equal(nextBlinkAt(10, 0), 12.2);
  assert.equal(nextBlinkAt(10, 1), 15.7);
  assert.ok(nextBlinkAt(10, 0, true) >= 15 && nextBlinkAt(10, 1, true) <= 19, 'reduced motion: every five to nine seconds');
  for (const r of [0, 0.5, 1]) {
    const g = nextGlance(4, r, r, r);
    assert.ok(Math.abs(g.x) <= 0.55 && Math.abs(g.y) <= 0.3, 'never a hard stare at the edge');
    assert.ok(g.at >= 5.5 && g.at <= 8.5);
  }
});

test('echo rings leave the pearl when your voice rises while it listens, one after another', () => {
  assert.equal(ringDue('listening', 0.8, []), true);
  assert.equal(ringDue('listening', 0.4, []), false, 'a quiet room sends nothing');
  assert.equal(ringDue('speaking', 0.9, []), false, 'only your voice makes rings');
  assert.equal(ringDue('idle', 0.9, []), false);
  assert.equal(ringDue('listening', 0.8, [{ r: 1.1, a: 0.7 }]), false, 'the last ring is still close');
  assert.equal(ringDue('listening', 0.8, [{ r: 1.4, a: 0.5 }]), true);
  const later = stepRings([{ r: 1.02, a: 0.8 }, { r: 1.8, a: 0.05 }], 0.1);
  assert.equal(later.length, 1, 'a faded ring is gone');
  assert.ok(later[0].r > 1.02 && later[0].a < 0.8, 'wider and fainter');
});

test('five quick pokes make it dizzy; slow ones never do', () => {
  let pokes = [], dizzy = false;
  for (let i = 0; i < DIZZY_POKES; i++) ({ pokes, dizzy } = pokeAt(pokes, 10 + i * 0.2));
  assert.equal(dizzy, true);
  assert.deepEqual(pokes, [], 'and the count starts again');
  pokes = [];
  for (let i = 0; i < 12; i++) { ({ pokes, dizzy } = pokeAt(pokes, i * (DIZZY_WINDOW_S / 3))); assert.equal(dizzy, false); }
  assert.ok(pokes.length < DIZZY_POKES);
});

test('it falls asleep after three quiet minutes, waves once a day, and keeps still when asked', () => {
  assert.equal(SLEEP_AFTER_S, 180);
  assert.equal(asleepAt(100, 100 + 179), false);
  assert.equal(asleepAt(100, 100 + 180), true);
  const today = new Date(2026, 9, 3, 9, 0);
  assert.equal(dayKey(today), '2026-10-3');
  assert.equal(firstToday('', today), true);
  assert.equal(firstToday('2026-10-2', today), true);
  assert.equal(firstToday(dayKey(today), new Date(2026, 9, 3, 23, 59)), false, 'later the same day: no second wave');
  assert.equal(keepsStill('on', false), true);
  assert.equal(keepsStill('off', true), false, 'the setting can overrule macOS');
  assert.equal(keepsStill('system', true), true);
  assert.equal(keepsStill('system', false), false);
  assert.equal(keepsStill(undefined, true), true, 'before settings load it follows macOS');
});

test('a dropped sentence gets a short plain line only when you should know about it', () => {
  for (const quiet of ['faint', 'heard_twice', 'quiet', '', undefined]) assert.equal(sorryLine(quiet), '', String(quiet));
  for (const seen of ['brief', 'no_speech', 'not_for_echo', 'something_new']) {
    const line = sorryLine(seen);
    assert.ok(line.length > 8 && line.length < 60, `${seen}: ${line}`);
    assert.doesNotMatch(line, /_|undefined/, 'plain words, never the reason code');
  }
  assert.notEqual(sorryLine('brief'), sorryLine('no_speech'));
  // The page shows the line and the companion says sorry, together or not at all.
  assert.match(app, /case 'dropped': \{\s*const line = sorryLine\(msg\.reason\);\s*if \(line\) \{ liveCap\.note\(line\); viz\.moment\('sorry'\); \}/);
});

test('the body is a circle that can grow a soft point (the Mac app points with the same shape)', () => {
  const calls = [];
  const ctx = /** @type {any} */ (new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }));
  bodyPath(ctx, 10, 0, 0);
  assert.deepEqual(calls.map((c) => c[0]), ['beginPath', 'arc'], 'round at rest');
  calls.length = 0;
  bodyPath(ctx, 10, 1, 0);
  assert.deepEqual(calls.map((c) => c[0]), ['beginPath', 'moveTo', 'quadraticCurveTo', 'arc', 'quadraticCurveTo', 'closePath']);
  assert.ok(Math.abs(calls[1][1] - 17.2) < 1e-9 && Math.abs(calls[1][2]) < 1e-9, 'the tip reaches 1.72 R towards the aim');
});

test('two bodies, Glass and Moon; Auto wears Moon on a dark background and Glass on a light one', () => {
  assert.deepEqual([...LOOKS], ['glass', 'moon']);
  assert.equal(lookFor('auto', true), 'moon');
  assert.equal(lookFor('auto', false), 'glass');
  for (const dark of [true, false]) {
    assert.equal(lookFor('glass', dark), 'glass');
    assert.equal(lookFor('moon', dark), 'moon');
    assert.equal(lookFor('sunset', dark), lookFor('auto', dark), 'an old look is Auto');
    assert.equal(lookFor(undefined, dark), lookFor('auto', dark));
  }
  assert.doesNotMatch(src, /aurora/i, 'the all-colour body is gone from the drawing');
  assert.match(src, /const skin = lookFor\(look, !day\);/, 'in the window the page\'s theme decides');
});

test('one click talks at once, a second quick click takes it back and plays, and a pet is never a click', async () => {
  // The real clock and the real 280 ms: what the page does with a click on the companion.
  let listening = false;
  const log = [];
  const clicks = createClicks(() => { listening = !listening; log.push(listening ? 'start' : 'stop'); });
  // One click: the mic opens in that same instant, with no wait for a second click.
  const t0 = performance.now();
  clicks.click();
  assert.equal(listening, true, 'listening before click() has even returned');
  assert.ok(performance.now() - t0 < 50, 'at once (it used to take 280 ms)');
  await wait(CLICK_WAIT_MS + 60);
  assert.deepEqual(log, ['start'], 'and nothing more happens afterwards');
  // One click while it listens: it stops, as immediately.
  clicks.click();
  assert.equal(listening, false, 'stopping never waits');
  await wait(CLICK_WAIT_MS + 60);
  assert.deepEqual(log, ['start', 'stop']);
  // Two quick clicks are play: the second takes back what the first started.
  clicks.click();
  assert.equal(listening, true);
  await wait(60);
  clicks.click();
  assert.equal(listening, false, 'what the first click started is stopped again');
  await wait(CLICK_WAIT_MS + 60);
  assert.deepEqual(log, ['start', 'stop', 'start', 'stop'], 'nothing left behind');
  // And when the first click stopped it: the second starts it again.
  clicks.click();
  await wait(CLICK_WAIT_MS + 60);
  log.length = 0;
  clicks.click();
  await wait(40);
  clicks.click();
  assert.deepEqual(log, ['stop', 'start'], 'play while it listens leaves it listening');
  assert.equal(listening, true);
  // Five quick ones (the dizzy spin): only the first two reach the mic, and they cancel out.
  await wait(CLICK_WAIT_MS + 60);
  log.length = 0;
  for (let i = 0; i < 5; i++) { clicks.click(); await wait(40); }
  assert.deepEqual(log, ['stop', 'start']);
  // A click slower than 280 ms after the last is a click of its own.
  await wait(CLICK_WAIT_MS + 60);
  clicks.click();
  assert.equal(listening, false);
  // cancel() forgets the run: the next click is a first click, however soon it comes.
  clicks.cancel();
  clicks.click();
  assert.equal(listening, true);
  assert.equal(CLICK_WAIT_MS, 280);

  assert.equal(isPetting(PET_HOLD_S + 0.1, PET_MOVE_PX), true, 'held and stroked');
  assert.equal(isPetting(PET_HOLD_S + 0.1, 0), false, 'a long still press is a slow click');
  assert.equal(isPetting(0.2, 40), false, 'a quick drag is not a pet');
  assert.match(src, /if \(e\.detail === 0\) \{ clicks\.cancel\(\); onPress\(\); return; \}/, 'Space and Enter talk at once');
  assert.match(src, /if \(petted\) \{ petted = false; return; \}\s*clicks\.click\(\);/, 'the click that ends a pet is not a press');
  assert.match(src, /if \(pet\) \{ T\.happy = 1; lastActive = t; \}/, 'petted: its eyes close happily');
});

test('it draws only as often as what it is doing needs: resting about 30 a second, the Settings previews about 20', () => {
  /** Pictures drawn in one second of a display's frames at `hz`. */
  const drawn = (hz, state) => {
    let last = -1, n = 0;
    for (let i = 0; i < hz; i++) {
      const t = 5 + i / hz;
      if (!frameDue(t, last, frameGap(state))) continue;
      last = t;
      n++;
    }
    return n;
  };
  for (const hz of [60, 120]) {
    assert.equal(drawn(hz, { mood: 'idle' }), 30, `resting on a ${hz} Hz display`);
    assert.equal(drawn(hz, { mood: 'idle', preview: true }), 20, 'a look in Settings');
    assert.equal(drawn(hz, { mood: 'speaking', preview: true }), 20, 'whatever it shows');
    assert.equal(drawn(hz, { mood: 'sleepy', age: 10 }), 20, 'asleep');
    assert.equal(drawn(hz, { mood: 'idle', still: true }), 12, 'keeping still');
    for (const mood of ['listening', 'thinking', 'speaking', 'happy', 'surprised', 'needs', 'sorry']) assert.equal(drawn(hz, { mood }), hz, `${mood}: every frame`);
    assert.equal(drawn(hz, { mood: 'idle', busy: true }), hz, 'a poke, a hop, sparkles or a pet while idle: every frame');
    assert.equal(drawn(hz, { mood: 'sleepy', age: 1 }), hz, 'falling asleep is seen whole');
  }
  // The window's companion sleeps; the three in Settings do not, and that is what marks them.
  assert.match(app, /createCompanion\([^\n]*\{ sleeps: false \}\)/);
  assert.match(src, /frameGap\(\{ still: still\(\), preview: !sleeps, mood: S\.mood, age: t - S\.since, busy \}\)/);
});

test('asleep, its light rests inside it', () => {
  assert.match(src, /\['rest', mood === 'sleepy' \? 1 : 0, 2\]/, 'the glow fades in as it falls asleep and out as it wakes');
  assert.match(src, /if \(S\.rest > 0\.02\) \{\s*const pulse = quiet \? 0\.5 : 0\.5 \+ 0\.5 \* Math\.sin\(t \* 1\.1\)/, 'a slow pulse, and none with reduced motion');
});

test('the companion is the presence in the window: same place and calls as the mark had, and the bars stay as the logo', () => {
  assert.match(html, /<div class="pearl" id="viz" aria-hidden="true"><canvas><\/canvas><\/div>\s*<button id="mic" class="orb" aria-label="Talk">/);
  assert.match(html, /<span class="mark brand-mark" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span>/, 'the top-left logo is still the three bars');
  assert.match(app, /import \{ createCompanion, sorryLine, firstToday, dayKey \} from '\/ui\/companion\.js';/);
  // A click on it switches Listening and Resting in the Mac app; in a browser tab (no key to hold) it still starts and stops a sentence.
  assert.match(app, /const viz = createCompanion\(els\.viz, \{\s*hit: els\.mic,[^]*?onPress: \(\) => \(inApp\(\) \? setListenMode\([^]*?'pearl'\) : pttOn\(\) \? stopListening\(\) : startListening\(\)\),\s*audio: \(\) =>/, 'one click on it switches how Echo listens');
  assert.match(app, /viz\.setState\(vizState\(\)\);\s*viz\.setNeeds\(asks\.size > 0\);/);
  assert.doesNotMatch(app, /els\.mic\.onclick/, 'the companion decides what a click means, so quick clicks never reach the mic');
  assert.match(src, /hit\?\.addEventListener\('pointerdown', onPoke\)/, 'the poke only listens: it never swallows the click');
  assert.doesNotMatch(src, /preventDefault|stopPropagation/);
  assert.match(css, /\.pearl canvas \{[^}]*pointer-events: none/, 'the canvas never takes a click from the button');
  assert.match(css, /\.hero:is\(:has\(\.pearl\.think\), :has\(\.pearl\.speak\), :has\(\.act-text:not\(:empty\)\)\)/, 'the strip is still a card while Echo works');
});

test('real things move it: cutting in, a lesson step, a finished worker, an answered card, an error', () => {
  assert.match(app, /surprised: \(\) => \{ viz\.moment\('surprised'\);/, 'you talked over Echo');
  assert.match(app, /const cutIn = speaking;[^\n]*\n/);
  assert.match(app, /hush\(\);\s*if \(cutIn\) viz\.moment\('surprised'\);/, 'and in a browser tab, starting to talk while it speaks');
  assert.match(app, /const moment = msg\.step >= msg\.total \? 'celebrate' : 'proud';\s*viz\.moment\(moment\);\s*toApp\(\{ type: 'companion', moment \}\);/);
  assert.match(app, /if \(msg\.task\.status === 'done'\) \{ sfx\('done'\); viz\.moment\('happy'\); viz\.lookToward\(document\.querySelector\('\.tab\[data-view="tasks"\]'\), 1\.4\); \}/);
  assert.match(app, /msg\.task\.status === 'failed'\) \{ sfx\('error'\); viz\.moment\('sorry'\); \}/);
  assert.match(app, /case 'error': addMsg\('error', msg\.text\); sfx\('error'\); viz\.moment\('sorry'\); break;/);
  // Every kind of confirmation card counts as "needs you", and stops counting when it is answered.
  for (const re of [/case 'computer_confirm': [^\n]*asks\.add\(msg\.request\.id\)/, /case 'message_confirm': [^\n]*asks\.add\(msg\.request\.id\)/, /if \(msg\.event\.approvalId\) asks\.add\(msg\.event\.approvalId\)/,
    /answered\(msg\.id, msg\.allowed\)/, /answered\(msg\.id, msg\.sent\)/, /answered\(msg\.approvalId, msg\.allowed\)/, /answered\(msg\.approvalId, null\)/]) assert.match(app, re);
  assert.match(app, /if \(asks\.delete\(id\) && yes === true\) viz\.moment\('content'\);/, 'only a yes pleases it (no hop: it can be many in a minute)');
  assert.match(app, /asks\.clear\(\);\s*for \(const r of \[\.\.\.\(msg\.messageConfirms \|\| \[\]\), \.\.\.\(msg\.computerConfirms \|\| \[\]\)\]\) asks\.add\(r\.id\);/, 'a reconnect starts the count again');
  assert.match(app, /if \(els\.typeInput\.value\.length === 1\) viz\.lookToward\(els\.typeInput\)/, 'a glance at the box as you start typing');
  assert.match(app, /if \(firstToday\(pref\.get\('companionDay', ''\)\)\) \{\s*pref\.set\('companionDay', dayKey\(\)\);/);
});

test('it stops drawing when nobody can see it, and keeps still with reduced motion', () => {
  assert.match(src, /const running = \(\) => !document\.hidden && onScreen;/);
  assert.match(src, /new IntersectionObserver\(/);
  assert.match(src, /Math\.min\(3, window\.devicePixelRatio \|\| 1\)/, 'one buffer pixel per screen pixel');
  assert.match(src, /if \(quiet\) S\.squash = S\.lift = S\.shake = S\.poke = S\.wave = S\.petX = S\.petY = S\.nod = 0;/, 'no hops, shakes, squishes, nods or leaning into a pet');
  assert.match(src, /S\.rings = quiet \? \[\] : stepRings\(S\.rings, dt\);/, 'no rings');
  assert.match(src, /nextBlinkAt\(t, Math\.random\(\), quiet\)/, 'it still blinks, slowly');
  assert.match(src, /if \(still\(\) \|\| calm\) return;\s*S\.lift = m\.lift;\s*sparkle\(m\.sparks\);/, 'calm: no hops, no sparkles');
  assert.match(app, /viz\.setCalm\(settings\.companionLively === false\);\s*viz\.setReduced\(settings\.reduceMotion\);/);
});

test('Settings has one switch for a calmer companion, lively unless you say so', () => {
  assert.equal(getSettings().companionLively, true);
  assert.equal(saveSettings({ companionLively: false }).companionLively, false);
  assert.equal(getSettings().companionLively, false, 'it is remembered');
  assert.equal(saveSettings({ companionLively: 'yes' }).companionLively, true, 'anything else reads as a switch');
  assert.equal(html.split('id="setLively"').length, 2);
  const row = html.slice(html.lastIndexOf('<label class="set-row"', html.indexOf('id="setLively"')), html.indexOf('id="setLively"'));
  assert.match(row, />Lively</);
  assert.doesNotMatch(row, /data-mac-only/, 'it is about this window, so it works in a browser too');
  assert.match(app, /setLively\.onchange = \(\) => saveSetting\(\{ companionLively: setLively\.checked \}\);/);
  assert.match(app, /setLively\.checked = settings\.companionLively !== false;/);
});

test('Home never runs into the top bar: the pearl and the spacing follow the window height', () => {
  const home = css.match(/\.hero \{\s*\/\* The pearl and the space under it[^}]*\}/)?.[0] || '';
  assert.match(home, /--pearl: clamp\(52px, 19vh, 124px\)/);
  assert.match(home, /justify-content: safe center/, 'if it ever does not fit, it overflows downwards, never up under the bar');
  assert.match(home, /gap: clamp\(12px, 4\.4vh, 34px\)/);
});

test('Settings, Companion: a look picker with the real companion in each choice, alive only while Settings is open', () => {
  const picker = html.slice(html.indexOf('id="setLook"'), html.indexOf('id="setLively"'));
  assert.match(html, /<div class="look-picker" id="setLook" role="radiogroup" aria-labelledby="setLookLabel">/);
  assert.deepEqual([...picker.matchAll(/<input type="radio" name="companionLook" value="(\w+)" \/><span class="pearl" aria-hidden="true"><canvas><\/canvas><\/span><span class="look-name">(\w+)<\/span>/g)].map((m) => [m[1], m[2]]),
    [['auto', 'Auto'], ['glass', 'Glass'], ['moon', 'Moon']], 'real radios (arrow keys work), each with its own canvas');
  assert.match(css, /\.look-choice:has\(input:checked\) \{[^}]*var\(--grad\) border-box/, 'the picked one wears the hairline of colour');
  assert.match(css, /\.look-choice:has\(input:focus-visible\) \{ outline:/);
  assert.match(app, /const face = createCompanion\([^\n]*\{ sleeps: false \}\);\s*face\.setLook\(c\.value\);/);
  assert.match(app, /onOpen: \(\) => \{[^\n]*showLooks\(\); \},\s*onClose: \(\) => \{[^\n]*hideLooks\(\); \},/, 'made when Settings opens, gone when it closes');
  assert.match(app, /function hideLooks\(\) \{\s*for \(const f of lookFaces\) f\.destroy\(\);\s*lookFaces = \[\];/);
  assert.match(app, /c\.onchange = \(\) => \{ viz\.setLook\(c\.value\); saveSetting\(\{ companionLook: c\.value \}\); \};/);
  assert.match(app, /for \(const c of lookChoices\) c\.checked = c\.value === settings\.companionLook;/);
  assert.equal(getSettings().companionLook, 'auto');
});

test('it is never a blank space: paused (window in the background), it stays as a still picture', () => {
  const src = fs.readFileSync(new URL('../public/ui/companion.js', import.meta.url), 'utf8');
  assert.match(src, /function sync\(\) \{[\s\S]{0,400}cancelAnimationFrame\(raf\);[\s\S]{0,300}paint\(performance\.now\(\) \/ 1000\);/, 'pausing paints once');
  assert.match(src, /queueMicrotask\(sync\);/, 'and the first picture does not wait to be seen');
});

test('more expressions on the same face: working, content, curious, a nod, a wink, and thinking hard', async () => {
  const { moodFor, moodTargets, MOMENTS, THINK_HARD_S, WINK_S } = await import('../public/ui/companion.js');
  // Working shows instead of thinking while Echo is busy on the Mac, and never over its voice or a question for you.
  assert.equal(moodFor({ voice: 'thinking', working: true }), 'working');
  assert.equal(moodFor({ voice: 'idle', working: true }), 'working');
  assert.equal(moodFor({ voice: 'speaking', working: true }), 'speaking');
  assert.equal(moodFor({ voice: 'thinking', working: true, needs: true }), 'needs');
  assert.equal(moodFor({ voice: 'thinking' }), 'thinking');
  // Its eyes go along the work, side to side.
  const a = moodTargets('working', { t: 0.2 }), b = moodTargets('working', { t: 0.9 });
  assert.notEqual(a.lx, b.lx);
  assert.ok(Math.abs(a.lx) <= 0.6 && Math.abs(b.lx) <= 0.6);
  // Content: smiling eyes and standing tall, with no hop. Curious: a tilt and one eye bigger.
  assert.equal(MOMENTS.content.lift, 0);
  assert.ok(MOMENTS.content.sparks <= 1);
  assert.deepEqual([moodTargets('content').happy, moodTargets('content').tall], [1, 1]);
  assert.ok(moodTargets('curious').tilt > 0.15 && moodTargets('curious').wide === 1);
  assert.equal(moodTargets('idle').wide, 0);
  // Thinking for a long time, it concentrates: narrower eyes, looking further up.
  assert.ok(moodTargets('thinking', { age: THINK_HARD_S + 1 }).open < moodTargets('thinking', { age: 1 }).open);
  assert.ok(moodTargets('thinking', { age: THINK_HARD_S + 1 }).ly < moodTargets('thinking', { age: 1 }).ly);
  assert.ok(WINK_S > 0.3 && WINK_S < 1.5);
  // What sets them off on the page.
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /viz\.setWorking\(Boolean\(msg\.driving\)\)/);
  assert.match(app, /if \(msg\.awaitsReply\) viz\.moment\('curious'\)/);
  assert.match(app, /heardCue\(true\); gapFiller\.start\(\); viz\.moment\('nod'\)/);
  assert.match(app, /viz\.moment\('wink'\)/);
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'ui', 'companion.js'), 'utf8');
  for (const want of ["if (name === 'nod')", "if (name === 'wink')", 'setWorking(on)']) assert.ok(src.includes(want), want);
});
