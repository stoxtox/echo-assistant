// The look's shared parts: the three bars (the logo) and what public/ui/mark.js still gives the
// companion (which voice state shows, the voice level), the activity strip (public/ui/activity.js),
// the greeting (public/ui/home.js), and the markup and styles they need. The companion itself is
// in test/companion.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { vizStateFor, levelOf, follow } from '../public/ui/mark.js';
import { stripLine } from '../public/ui/activity.js';
import { greeting } from '../public/ui/home.js';
import { pageSource } from './helpers.js';

const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('style.css');
/** A sine wave of the given peak, as an analyser would hand it over. */
const wave = (amp) => Float32Array.from({ length: 512 }, (_, i) => amp * Math.sin(i / 5));

test('one voice state at a time: speaking beats listening beats thinking', () => {
  assert.equal(vizStateFor({}), 'idle');
  assert.equal(vizStateFor({ busy: true }), 'thinking');
  assert.equal(vizStateFor({ heard: true }), 'thinking', 'the instant "heard you" cue');
  assert.equal(vizStateFor({ listening: true, busy: true }), 'listening');
  assert.equal(vizStateFor({ speaking: true, listening: true, busy: true }), 'speaking');
});

test('the level follows the voice: silence is zero, a normal voice is most of the way, never past one', () => {
  assert.equal(levelOf(null), 0);
  assert.equal(levelOf(new Float32Array(512)), 0);
  const soft = levelOf(wave(0.05)), normal = levelOf(wave(0.25)), shout = levelOf(wave(1));
  assert.ok(soft > 0.05 && soft < 0.3, `soft ${soft}`);
  assert.ok(normal > 0.6, `normal ${normal}`);
  assert.equal(shout, 1);
});

test('the level rises fast and settles slowly, so the light jumps with a word and does not flicker', () => {
  const up = follow(0, 1, 1 / 60), down = follow(1, 0, 1 / 60);
  assert.ok(up > 0.3, `attack ${up}`);
  assert.ok(1 - down < up, 'release is slower than attack');
  assert.equal(follow(0.4, 0.4, 1 / 60), 0.4);
});

test('the three bars are the logo and nothing else: they hold still, and the WebGL voice stays gone', () => {
  const app = pageSource();
  assert.match(html, /<span class="mark brand-mark" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span>/);
  assert.match(css, /\.mark i:nth-child\(3\) \{ width: 44%; background: var\(--grad\)/);
  assert.doesNotMatch(css, /\.mark\.(listen|think|speak)/, 'the bars no longer act out the voice: the companion does');
  assert.doesNotMatch(read('ui/mark.js'), /createMark|classList/);
  assert.match(app, /import \{ vizStateFor \} from '\/ui\/mark\.js';/);
  assert.equal(fs.existsSync(new URL('../public/voiceviz.js', import.meta.url)), false);
  assert.doesNotMatch(app + html, /voiceviz|getContext\('webgl/);
  assert.equal(html.split('<canvas').length, 6, 'the only canvases: the companion, the three in its look picker (Settings, Companion), and the Sky');
  assert.equal(html.split('<span class="pearl" aria-hidden="true"><canvas>').length, 4);
});

test('the greeting follows the time of day and the name from Settings', () => {
  assert.equal(greeting('Sam', 8), 'Good morning, Sam.');
  assert.equal(greeting('Sam', 13), 'Good afternoon, Sam.');
  assert.equal(greeting('Sam', 20), 'Good evening, Sam.');
  assert.equal(greeting('Sam', 2), 'Good evening, Sam.', 'the small hours are still the evening');
  assert.equal(greeting('', 20), 'Good evening.');
  assert.equal(greeting('  ', 9), 'Good morning.');
  assert.equal(greeting(undefined, 12), 'Good afternoon.');
  assert.match(html, /<h1 class="hello" id="greeting">/);
  assert.match(pageSource(), /\$\('greeting'\)\.textContent = greeting\(settings\.userName\);/);
});

test('Home keeps the hint, the ideas and the live words in the elements the page already writes to', () => {
  const hero = html.slice(html.indexOf('<div class="hero" id="hero">'), html.indexOf('<form id="typeForm"'));
  for (const id of ['viz', 'mic', 'chatEmpty', 'greeting', 'state', 'convWindow', 'cwLeft', 'cwLabel', 'live', 'interim', 'liveNote', 'suggestions', 'actText', 'actProg', 'actStop']) {
    assert.equal(hero.split(`id="${id}"`).length, 2, `exactly one #${id} in the hero`);
  }
  // The hero's shape follows what is on the page: the empty state (Home) and live words (Talking).
  assert.match(css, /\.convo:has\(#chatEmpty:not\(\[hidden\]\)\) \.suggestions \{ display: flex/);
  // Only on Home: over a conversation nothing takes the window over (test/talkview.test.js).
  assert.match(css, /\.convo:has\(#chatEmpty:not\(\[hidden\]\)\):has\(\.live\[data-mode="caption"\]\)[^{]*\.composer \{ visibility: hidden; \}/, 'on Home the composer gives way to the Listening bar');
  assert.match(css, /grid-template-rows: auto minmax\(0, 1fr\) var\(--strip-h\) auto/, 'the strip has a fixed slot: nothing jumps');
});

test('the strip says what Echo is doing: a step of a known number, a drive with no known end, or a tool', () => {
  assert.deepEqual(stripLine({}), { text: '', progress: null, stop: false });
  assert.deepEqual(stripLine({ activity: 'Reading the notes' }), { text: 'Reading the notes', progress: null, stop: false });
  assert.deepEqual(stripLine({ driving: true, app: 'Numbers', steps: 3 }), { text: 'Numbers · step 3', progress: null, stop: true });
  assert.deepEqual(stripLine({ driving: true }), { text: 'Working on your Mac', progress: null, stop: true });
  assert.deepEqual(stripLine({ driving: true, app: 'Numbers', steps: 3, guide: { step: 1, total: 5 } }), { text: 'Numbers · step 1 of 5', progress: 0.2, stop: true });
  assert.deepEqual(stripLine({ guide: { step: 2, total: 4, say: 'Click Save' } }), { text: 'Step 2 of 4 · Click Save', progress: 0.5, stop: true });
  assert.deepEqual(stripLine({ guide: { step: 9, total: 4 } }).progress, 1, 'never past the end');
  // A finished guide says so, with nothing left to stop; driving wins over a stale tool line.
  assert.deepEqual(stripLine({ guide: { step: 4, total: 4, finished: true, done: true } }), { text: 'All steps shown', progress: 1, stop: false });
  assert.deepEqual(stripLine({ guide: { step: 2, total: 4, finished: true } }), { text: 'Stopped at step 2 of 4', progress: null, stop: false });
  assert.equal(stripLine({ activity: 'Reading', driving: true, app: 'Numbers' }).text, 'Numbers');
});

test('the strip stands in for the old tool rows, the Driving chip and the guide pill', () => {
  const app = pageSource();
  assert.match(app, /case 'activity': gapFiller\.activity\(msg\.text\); activity\.say\(msg\.text\); break;/);
  assert.doesNotMatch(app, /addMsg\('activity'/, 'no more "→ tool" rows in the chat');
  assert.match(app, /computerClient\.state\(msg\);\s*activity\.driving\(msg\);/);
  assert.match(app, /case 'lesson_card': \{[\s\S]{0,200}activity\.guide\(\{ step: msg\.step, total: msg\.total, say: msg\.current,/, 'a lesson\'s step (quick or not) is the strip\'s');
  assert.doesNotMatch(app, /guideStep|guide_step/);
  assert.match(app, /if \(!b\) \{ heardCue\(false\); activity\.say\(''\); \}/, 'the tool line goes when the turn ends');
  assert.match(app, /send\(\{ type: 'computer_stop' \}\)/);
  assert.match(css, /\.drive-banner \{ display: none; \}/);
});

test('your words are a white bubble, Echo\'s are plain text beside the line of colour, and a worker is one card', () => {
  assert.match(css, /\.msg\.you \{[^}]*background: var\(--ink\); color: var\(--on-ink\)/);
  assert.match(css, /\.msg\.ai::before \{[^}]*width: 3px;[^}]*background: var\(--grad\)/);
  assert.doesNotMatch(css.match(/\.msg\.ai \{[^}]*\}/)[0], /background|border:/);
  assert.match(css, /\.status\.running \{ color: var\(--on-ink\); background: var\(--ink\)/);
  assert.match(css, /\.status\.waiting \{ background: linear-gradient\(var\(--panel\), var\(--panel\)\) padding-box, var\(--grad\) border-box/);
  const tpl = html.slice(html.indexOf('<template id="taskTpl">'));
  // Every part the Workers code fills, and every action, is still in the card.
  for (const cls of ['status', 'status-text', 'task-kind', 'task-title', 'task-meta', 'task-live', 'live-text', 'live-ago', 'approval', 'approval-title', 'approval-text',
    'task-summary', 'task-files', 'review', 'review-checks', 'review-stat', 'task-log', 'task-instruction', 'activity-summary',
    'act-stop', 'act-term', 'act-allow', 'act-allow-similar', 'act-deny', 'act-diff', 'act-merge', 'act-discard']) {
    assert.match(tpl, new RegExp(`class="[^"]*\\b${cls}\\b`), cls);
  }
  assert.match(read('ui/tasks.js'), /waiting_approval: 'Needs your OK'/);
});

test('keyboard users see where they are, and narrow windows keep their words', () => {
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--ink\); outline-offset: 2px; \}/);
  assert.match(css, /\.switch input:focus-visible \+ \.track \{ outline: 2px solid var\(--ink\)/, 'a switch hides its checkbox, so the ring goes on the track');
  assert.match(css, /@media \(max-width: 600px\) \{\n  :root \{ --t-l: 24px; \}/);
});
