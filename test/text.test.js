import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.js';

sandbox('text');
const { nowString, spokenSummary, trimToSentences, speakable } = await import('../lib/text.js');

test('nowString gives the local New York date and time', () => {
  // 02:04 UTC on Sep 25 is 10:04 PM on Thursday Sep 24 in New York.
  const s = nowString(new Date('2026-09-25T02:04:00Z'));
  assert.match(s, /Thursday/);
  assert.match(s, /September 24, 2026/);
  assert.match(s, /10:04\sPM/);
  assert.match(s, /EDT/);
});

test('speakable strips URLs, paths and markdown', () => {
  const s = speakable('**Done!** Saved to /Users/me/Projects/_research/trip-plans/hotels.md, see https://example.com/x?y=1 and `npm test`.');
  assert.equal(s, 'Done! Saved to hotels.md, see a link and npm test.');
});

test('trimToSentences never cuts mid-sentence', () => {
  const long = 'First sentence is here. Second one is a bit longer than the first. Third sentence would overflow the limit for sure.';
  const out = trimToSentences(long, 70);
  assert.equal(out, 'First sentence is here. Second one is a bit longer than the first.');
  assert.ok(!out.includes('Third'));
});

test('trimToSentences handles one giant sentence cleanly', () => {
  const out = trimToSentences('word '.repeat(200), 50);
  assert.ok(out.length <= 52);
  assert.ok(out.endsWith('…'));
});

test('spokenSummary turns a markdown report into speech', () => {
  const out = spokenSummary('## Results\n- Seaside Inn: https://hotels.example.com/1\n- Harbor View Hotel\n\nI saved everything in /tmp/x/hotels.md.');
  assert.ok(!/https?:|\/tmp|##|^-/m.test(out), out);
});

test('shortTitle skips boilerplate and keeps it short', async () => {
  const { shortTitle } = await import('../lib/text.js');
  const t = shortTitle('Small task. Convert trip-plans/weekend-hotel-options.md in this folder into an Excel spreadsheet.');
  assert.match(t, /^Convert weekend-hotel-options\.md into an Excel/);
  assert.ok(t.length <= 65);
  assert.equal(shortTitle('The user wants to see the Foodbowl project running in their web browser. It is static.'), 'See the Foodbowl project running in their web browser');
  assert.ok(shortTitle('word '.repeat(40)).length <= 65);
});
