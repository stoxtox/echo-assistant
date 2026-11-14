// The recognizers are told what the conversation is about (lib/recentterms.js). On Oct 4, 2026 a
// folder Echo had named five times came back as "lemon X" and "luminous", and "pivot tables" as
// "pi tables": neither recognizer had been given those words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, serverSource } from './helpers.js';

sandbox('recentterms');
const { namesIn, RecentTerms, recentTerms, RECENT_MAX, RECENT_TTL_MS, APP_TERMS } = await import('../lib/recentterms.js');
const { vocabularyTerms, whisperPrompt } = await import('../lib/vocab.js');

test("the names in Echo's replies are picked out, and sentence starts are not", () => {
  assert.deepEqual(namesIn("Did you mean your Lumora Studio folder, where the photos are? Say yes and I'll go through it."), ['Lumora Studio']);
  assert.deepEqual(namesIn('Which stock site—Adobe Stock, Shutterstock, or both?'), ['Adobe Stock', 'Shutterstock']);
  const found = namesIn('Found them: Cali Trip, then Wallpaper, then pics. The photos are in the Stock Ready folder, and the Golden Gate one leads.');
  for (const want of ['Cali Trip', 'Stock Ready', 'Golden Gate']) assert.ok(found.includes(want), want);
  assert.deepEqual(namesIn('Sorry, say that again? I can do that. The table looks cleaner now. Yes, it is open.'), []);
  assert.deepEqual(namesIn('It is at /Users/someone/Desktop and costs 30 cents.'), []);
});

test('the newest names are kept, a stale one is dropped, and the app adds its own words', () => {
  let t = 1_000_000;
  const r = new RecentTerms({ now: () => t });
  r.noteReply('The Lumora Studio folder has 22 photos.');
  t += 1000;
  r.noteReply('The Cali Trip folder is inside it.');
  assert.deepEqual(r.names(), ['Lumora Studio', 'Cali Trip']);
  r.noteReply('Back to Lumora Studio.');
  assert.deepEqual(r.names(), ['Cali Trip', 'Lumora Studio'], 'said again: newest');
  r.setApp('Microsoft Excel');
  assert.ok(r.all().includes('pivot table'));
  assert.ok(APP_TERMS.Numbers.includes('pivot table'));
  r.setApp('');
  assert.equal(r.all().includes('pivot table'), false);
  for (let i = 0; i < RECENT_MAX + 5; i++) r.noteReply(`The Zorblat${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} Project is next.`);
  assert.equal(r.names().length, RECENT_MAX);
  t += RECENT_TTL_MS + 1;
  assert.deepEqual(r.names(), []);
});

test('both recognizers get them: first in the list for Apple, last in the prompt for Whisper', () => {
  recentTerms.noteReply('Did you mean your Lumora Studio folder? The Cali Trip photos are inside.');
  recentTerms.setApp('Microsoft Excel');
  const terms = vocabularyTerms();
  assert.ok(terms.indexOf('pivot table') >= 0 && terms.indexOf('pivot table') < 20);
  assert.ok(terms.indexOf('Lumora Studio') >= 0 && terms.indexOf('Lumora Studio') < 30);
  const prompt = whisperPrompt({ extra: [] });
  assert.match(prompt, /Lumora Studio/);
  assert.match(prompt, /Cali Trip, Lumora Studio\.$|Lumora Studio, Cali Trip\.$/, 'nearest the audio');
  recentTerms.setApp('');
  const src = serverSource();
  assert.match(src, /recentTerms\.noteReply\(replyBuf\)/);
  assert.match(src, /recentTerms\.setApp\(/);
});
