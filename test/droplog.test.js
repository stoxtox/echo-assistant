// Debug notes on hands-free drops ("not for Echo"): off by default, first words only, a week at most.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('droplog');
const { logDroppedWords, pruneDroppedWords, firstWords, DROPPED_WORDS_FILE } = await import('../lib/droplog.js');
const { getSettings, saveSettings } = await import('../lib/settings.js');
const { scanFolder } = await import('../lib/privacy.js');

const file = path.join(dirs.data, DROPPED_WORDS_FILE);
const read = () => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const DAY = 24 * 60 * 60 * 1000;

test('the debug setting is off by default and saves as a boolean', () => {
  assert.equal(getSettings().debugDroppedWords, false);
  assert.equal(saveSettings({ debugDroppedWords: 'yes' }).debugDroppedWords, true);
  assert.equal(saveSettings({ debugDroppedWords: 0 }).debugDroppedWords, false);
});

test('nothing is written while the setting is off', () => {
  fs.rmSync(file, { force: true });
  assert.equal(logDroppedWords({ dataDir: dirs.data, enabled: false, text: 'did you watch the game last night' }), false);
  assert.equal(fs.existsSync(file), false);
});

test('only the first few words are kept', () => {
  assert.equal(firstWords('did you watch the game last night'), 'did you watch the game …');
  assert.equal(firstWords('  turn it off  '), 'turn it off');
  assert.equal(firstWords(''), '');
  fs.rmSync(file, { force: true });
  assert.equal(logDroppedWords({ dataDir: dirs.data, enabled: true, text: 'did you watch the game last night', meta: { mode: 'hands-free', clarity: 'high' } }), true);
  const [e] = read();
  assert.equal(e.firstWords, 'did you watch the game …');
  assert.equal(e.mode, 'hands-free');
  assert.ok(!JSON.stringify(e).includes('last night'));
});

test('entries older than 7 days are removed, on write and on a sweep', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  fs.writeFileSync(file, [JSON.stringify({ at: new Date(now - 8 * DAY).toISOString(), firstWords: 'old one' }), 'not json', JSON.stringify({ at: new Date(now - 2 * DAY).toISOString(), firstWords: 'recent one' })].join('\n') + '\n');
  logDroppedWords({ dataDir: dirs.data, enabled: true, text: 'new one', now });
  assert.deepEqual(read().map((e) => e.firstWords), ['recent one', 'new one']);
  // The sweep runs even with the setting off, and deletes the file once everything has expired.
  pruneDroppedWords(dirs.data, now + 8 * DAY);
  assert.equal(fs.existsSync(file), false);
  pruneDroppedWords(dirs.data, now); // no file: nothing to do, no throw
});

test('the notes file never ships in a shared package', () => {
  const pkg = path.join(dirs.root, 'pkg');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, DROPPED_WORDS_FILE), '');
  assert.ok(scanFolder(pkg).some((f) => f.kind === 'personal file' && f.file.endsWith(DROPPED_WORDS_FILE)));
});
