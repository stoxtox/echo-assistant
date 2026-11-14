import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { wordsOf, wordAlpha, sharedStart, captionWords, trulyEmpty, showPttHint, PTT_HINT_USES, CAPTION_BRIGHT_WORDS, CAPTION_MIN_ALPHA } from '../public/livecaption.js';

const read = (f) => fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('the newest words are brightest; older ones dim, but never vanish before they scroll away', () => {
  for (let i = 0; i < CAPTION_BRIGHT_WORDS; i++) assert.equal(wordAlpha(i), 1);
  let prev = 1;
  for (let i = CAPTION_BRIGHT_WORDS; i < 40; i++) {
    const a = wordAlpha(i);
    assert.ok(a <= prev, `word ${i} is no brighter than a newer one`);
    assert.ok(a >= CAPTION_MIN_ALPHA);
    prev = a;
  }
  assert.equal(wordAlpha(40), CAPTION_MIN_ALPHA);
});

test('only words that changed fade in; the live listener rewriting its guess replaces just the end', () => {
  assert.deepEqual(wordsOf('  open   the\nmail '), ['open', 'the', 'mail']);
  assert.equal(sharedStart(['open', 'the', 'male'], ['open', 'the', 'mail', 'app']), 2);
  const w = captionWords(['open', 'the', 'male'], 'open the mail app');
  assert.deepEqual(w.map((x) => x.fresh), [false, false, true, true]);
  assert.deepEqual(w.map((x) => x.word), ['open', 'the', 'mail', 'app']);
  assert.ok(captionWords([], 'hi there').every((x) => x.fresh));
  assert.deepEqual(captionWords(['a'], ''), []);
});

test('"Didn\'t catch that" is only for a truly empty turn', () => {
  assert.equal(trulyEmpty({ live: '', heard: '' }), true);
  assert.equal(trulyEmpty({ live: ' … ', heard: '.' }), true, 'punctuation is not words');
  assert.equal(trulyEmpty({}), true);
  assert.equal(trulyEmpty({ live: 'open mail' }), false, 'the live caption showed your words');
  assert.equal(trulyEmpty({ heard: 'open mail' }), false);
});

test('the push-to-talk hint shows the first few times, then never again', () => {
  for (let n = 0; n < PTT_HINT_USES; n++) assert.equal(showPttHint(n), true);
  assert.equal(showPttHint(PTT_HINT_USES), false);
  assert.equal(showPttHint(99), false);
  assert.equal(showPttHint(undefined), true);
});

test('the main window names no speech engines and has one caption spot', () => {
  const app = read('app.js');
  const start = app.indexOf('function renderOrb()');
  const orb = app.slice(start, app.indexOf('\n}\n', start));
  assert.doesNotMatch(orb, /Whisper|Deepgram|engineName/, 'the status line is plain words');
  assert.doesNotMatch(app, /els\.interim/, 'the caption only goes through liveCap');
  // The note waits for the words to make way, so it never lands on top of them.
  const send = app.slice(app.indexOf('async function sendClip'), app.indexOf('/* --- browser recognition'));
  assert.ok(send.indexOf('liveCap.clear({ now') < send.indexOf('didntCatch()'), 'the caption clears before the note');
  assert.match(send, /trulyEmpty\(/);
  const html = read('index.html');
  assert.match(html, /class="live" id="live"/);
  assert.match(html, /class="live-note"/);
  assert.doesNotMatch(html, /class="interim"/);
});

test('the caption styles keep it to two lines and respect reduced motion', () => {
  const css = read('style.css');
  assert.match(css, /\.live\[data-mode="caption"\]\[data-lines="2"\] \{ height: calc\(2 \* var\(--cap-line\)/);
  assert.match(css, /\.live-cap \{[^}]*overflow: hidden/);
  assert.match(css, /\.live-words \{[^}]*overflow-wrap: anywhere/);
  const reduced = css.slice(css.indexOf('.live-words .w.fresh { animation: none; }') - 200, css.indexOf('.live-words .w.fresh { animation: none; }'));
  assert.match(reduced, /prefers-reduced-motion: reduce/);
});
