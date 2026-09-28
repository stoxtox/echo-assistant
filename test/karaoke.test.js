import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, syllables, pauseAfter, estimateTimings, speechBounds, alignTimings, wordAt, wordAtChar } from '../public/karaoke.js';
import { alignmentWords, wordsHeader } from '../lib/voice.js';

test('tokenize keeps char offsets of every word', () => {
  const t = tokenize('  Hi there,  friend!');
  assert.deepEqual(t.map((x) => x.word), ['Hi', 'there,', 'friend!']);
  assert.deepEqual(t.map((x) => [x.start, x.end]), [[2, 4], [5, 11], [13, 20]]);
});

test('syllables are roughly right, with acronyms spelled out and numbers weighted', () => {
  assert.equal(syllables('cat'), 1);
  assert.equal(syllables('make'), 1);
  assert.equal(syllables('assistant'), 3);
  assert.equal(syllables('API'), 3);
  assert.ok(syllables('2026') >= 4);
});

test('punctuation adds pauses, sentence ends more than commas', () => {
  assert.equal(pauseAfter('word'), 0);
  assert.ok(pauseAfter('done.') > pauseAfter('first,'));
  assert.ok(pauseAfter('first,') > 0);
  assert.ok(pauseAfter('wait…') > 0);
});

test('estimated timings fill the speech span in order, longer words taking longer', () => {
  const times = estimateTimings('I checked everything, and the build passes.', 3, { lead: 0.2, tail: 0.3 });
  assert.equal(times.length, 7);
  assert.ok(Math.abs(times[0].s - 0.2) < 1e-9, 'starts after the lead silence');
  assert.ok(Math.abs(times.at(-1).e - 2.7) < 1e-9, 'ends before the tail silence');
  for (let i = 1; i < times.length; i++) assert.ok(times[i].s >= times[i - 1].e - 1e-9, 'ordered, no overlap');
  const len = (i) => times[i].e - times[i].s;
  assert.ok(len(2) > len(0), '"everything" takes longer than "I"');
  // the comma after "everything," leaves a gap before "and"
  assert.ok(times[3].s - times[2].e > 0.05);
  assert.deepEqual(estimateTimings('', 2), []);
  assert.deepEqual(estimateTimings('hi', 0), []);
});

test('speech bounds find the silence around a clip', () => {
  const sr = 1000;
  const samples = new Float32Array(1000);
  for (let i = 200; i < 900; i++) samples[i] = Math.sin(i) * 0.5;
  const { lead, tail } = speechBounds(samples, sr);
  assert.ok(lead > 0.15 && lead <= 0.2, `lead ${lead}`);
  assert.ok(tail > 0.05 && tail <= 0.1, `tail ${tail}`);
  assert.deepEqual(speechBounds(new Float32Array(500), sr), { lead: 0, tail: 0 });
});

test('real word timings map onto the shown words, even when the spoken text differs a little', () => {
  const spoken = [
    { w: 'See', s: 0.1, e: 0.3 }, { w: 'a', s: 0.35, e: 0.4 }, { w: 'link', s: 0.4, e: 0.6 }, { w: 'for', s: 0.7, e: 0.8 }, { w: 'details.', s: 0.8, e: 1.2 },
  ];
  const times = alignTimings('See **https://x.io/abc** for details.', spoken);
  assert.equal(times.length, 4);
  assert.equal(times[0].s, 0.1);
  assert.equal(times[2].s, 0.7);
  assert.ok(times[1].s >= 0.3 && times[1].e <= 0.7, 'the URL gets the gap between its neighbours');
  assert.equal(alignTimings('Totally different words here', spoken), null);
});

test('wordAt and wordAtChar find the current word', () => {
  const times = [{ s: 0.1, e: 0.3 }, { s: 0.4, e: 0.6 }, { s: 0.7, e: 1 }];
  assert.equal(wordAt(times, 0), -1);
  assert.equal(wordAt(times, 0.2), 0);
  assert.equal(wordAt(times, 0.35), 0);
  assert.equal(wordAt(times, 0.5), 1);
  assert.equal(wordAt(times, 5), 2);
  const tokens = tokenize('one two three');
  assert.equal(wordAtChar(tokens, 0), 0);
  assert.equal(wordAtChar(tokens, 4), 1);
  assert.equal(wordAtChar(tokens, 8), 2);
});

test('ElevenLabs character alignment becomes word timings for the header', () => {
  const chars = [...'Hi there.'];
  const starts = chars.map((_, i) => i * 0.1);
  const ends = chars.map((_, i) => i * 0.1 + 0.1);
  const words = alignmentWords({ characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends });
  assert.deepEqual(words.map((w) => w.w), ['Hi', 'there.']);
  assert.equal(words[1].s, 0.3);
  assert.equal(words[1].e, 0.9);
  assert.equal(alignmentWords(null), null);
  const header = wordsHeader(words);
  assert.match(header, /^[\x20-\x7e]+$/, 'ASCII-safe');
  assert.deepEqual(JSON.parse(decodeURIComponent(header)), words);
  assert.equal(wordsHeader([]), null);
});

test('pieces join with a natural pause: a breath after a sentence, less after a comma, trimmed padding', async () => {
  const { pieceGap, playPlan } = await import('../public/karaoke.js');
  assert.equal(pieceGap(''), 0, 'nothing before the first piece');
  const sentence = pieceGap('The build passed.');
  const question = pieceGap('Want the list?');
  const comma = pieceGap('and every page loads fine on my end,');
  assert.ok(sentence >= 0.2 && sentence <= 0.35, String(sentence));
  assert.ok(question >= sentence && comma < sentence && comma > 0);
  assert.ok(pieceGap('The build passed.', 1.25) < sentence, 'faster voice, shorter pauses');
  // Kokoro pads each clip with ~0.25s before and ~0.35s after: nearly all of it is cut.
  const p = playPlan({ lead: 0.23, tail: 0.33 }, 2);
  assert.equal(p.offset, 0.23);
  assert.ok(Math.abs(p.length - (2 - 0.23 - 0.3)) < 1e-9);
  assert.deepEqual(playPlan({ lead: 0, tail: 0 }, 1), { offset: 0, length: 1 });
  assert.ok(playPlan({ lead: 5, tail: 5 }, 1).length > 0, 'never trims everything');
});
