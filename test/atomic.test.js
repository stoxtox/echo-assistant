// Crash-safe state files (lib/atomic.js): written whole or not at all, the last good copy kept,
// and a file cut off by a crash read from that copy instead of starting over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('atomic');
const { writeJson, readJson, writeFileAtomic } = await import('../lib/atomic.js');
const f = (name) => path.join(dirs.data, name);

test('written whole, read back; missing is the fallback', () => {
  assert.deepEqual(readJson(f('none.json'), { empty: true }), { empty: true });
  writeJson(f('a.json'), { n: 1 });
  assert.deepEqual(readJson(f('a.json'), null), { n: 1 });
  assert.deepEqual(fs.readdirSync(dirs.data).filter((n) => n.endsWith('.tmp')), [], 'no temp files left');
});

test('a file cut off by a crash is read from its last good copy', () => {
  writeJson(f('state.json'), { turns: 1 });
  writeJson(f('state.json'), { turns: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f('state.json.bak'), 'utf8')), { turns: 1 });
  fs.writeFileSync(f('state.json'), '{"turns": 3, "summ'); // what an old in-place write left behind
  assert.deepEqual(readJson(f('state.json'), {}), { turns: 1 });
});

test('a broken file never replaces a good backup', () => {
  writeJson(f('s.json'), { good: true });
  writeJson(f('s.json'), { good: 'still' });
  fs.writeFileSync(f('s.json'), 'garbage');
  writeJson(f('s.json'), { good: 'new' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f('s.json.bak'), 'utf8')), { good: true }, 'the garbage was not kept as the good copy');
  assert.deepEqual(readJson(f('s.json'), null), { good: 'new' });
});

test('secrets stay readable by this user only, with no backup copy', () => {
  writeFileAtomic(f('token'), 'abc\n', { mode: 0o600, backup: false });
  writeFileAtomic(f('token'), 'def\n', { mode: 0o600, backup: false });
  assert.equal(fs.statSync(f('token')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(f('token.bak')), false);
});

test('a failed write leaves the old file and no temp file', () => {
  writeJson(f('keep.json'), { v: 1 });
  fs.mkdirSync(f('dir.json'));
  fs.writeFileSync(path.join(f('dir.json'), 'x'), 'x'); // rename onto a non-empty folder fails
  assert.throws(() => writeJson(f('dir.json'), { v: 2 }));
  assert.deepEqual(fs.readdirSync(dirs.data).filter((n) => n.endsWith('.tmp')), []);
  assert.deepEqual(readJson(f('keep.json'), null), { v: 1 });
});

test('every state file Echo keeps is written this way', () => {
  const root = path.resolve(import.meta.dirname, '..');
  for (const file of ['lib/settings.js', 'lib/dispatcher.js', 'lib/tasks.js', 'lib/costs.js', 'lib/vocab.js', 'lib/projects.js', 'lib/quick.js', 'lib/voicebudget.js', 'lib/updater.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(src, /fs\.writeFileSync\([^)]*JSON\.stringify/, `${file} writes JSON in place`);
  }
});
