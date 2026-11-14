// Settings are read from disk only when the file changed (it used to be read and parsed on every
// call, dozens of times a turn), and an install from before the accent default changed keeps it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('settingscache');
const file = path.join(dirs.data, 'settings.json');
const { getSettings, saveSettings, markFirstRun, defaultAccent } = await import('../lib/settings.js');

test('reads once, then again only when the file changes, edits from outside included', () => {
  saveSettings({ userName: 'Pat' });
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = /** @type {any} */ ((/** @type {any[]} */ ...a) => (String(a[0]) === file && reads++, /** @type {any} */ (read)(...a)));
  try {
    for (let i = 0; i < 50; i++) getSettings();
    assert.ok(reads <= 1, `read ${reads} times for 50 calls`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(read(file, 'utf8')), userName: 'Robin, edited by hand' }));
    assert.equal(getSettings().userName, 'Robin, edited by hand');
  } finally {
    fs.readFileSync = read;
  }
});

test('a caller changing what it got never changes the next caller\'s copy', () => {
  saveSettings({ core: { session: true } });
  const a = getSettings();
  a.userName = 'changed';
  a.core.session = false;
  assert.notEqual(getSettings().userName, 'changed');
  assert.equal(getSettings().core.session, true);
});

test('a fresh install starts from the Mac\'s region; an older install that never chose keeps Indian English', () => {
  fs.rmSync(file, { force: true });
  assert.equal(markFirstRun(), true);
  assert.equal(getSettings().sttLanguage, defaultAccent());
  fs.writeFileSync(file, JSON.stringify({ userName: 'Pat', onboarded: true }));
  assert.equal(markFirstRun(), false);
  assert.equal(getSettings().sttLanguage, 'en-IN');
  saveSettings({ sttLanguage: 'en-US' });
  markFirstRun();
  assert.equal(getSettings().sttLanguage, 'en-US', 'a choice is never overwritten');
});
