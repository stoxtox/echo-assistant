// The task card's "View changes" and "Merge & restart" (public/ui/tasks.js). Oct 10, 2026: both
// did nothing, because a variable inside upsertTask had the same name as the module's review
// actions, so the buttons called .merge() on a piece of the page instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('nothing inside the card code hides the review actions its buttons call', () => {
  const src = readFileSync(new URL('../public/ui/tasks.js', import.meta.url), 'utf8');
  assert.match(src, /\.act-merge'\)\.onclick = \(\) => review\.merge\(t\.id\)/);
  assert.match(src, /\.act-diff'\)\.onclick = \(\) => review\.diff\(t\.id\)/);
  assert.equal([...src.matchAll(/\b(?:const|let|var)\s+review\b/g)].length, 1, 'one "review": the module\'s actions');
  assert.doesNotMatch(src, /function \w+\([^)]*\breview\b[^)]*\)/, 'nor a parameter by that name');
});
