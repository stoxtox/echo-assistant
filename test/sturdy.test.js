// Small things that could take Echo down or leave a mess (the Oct 2 review of patches 0023-0031):
// a folder asked for as a page, a write that fails half way, Esc with a dialog over Settings, the
// Mac app's line to the server after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('sturdy');
const { serveStatic } = await import('../lib/server/http.js');
const { writeFileAtomic } = await import('../lib/atomic.js');
const root = path.resolve(import.meta.dirname, '..');

test('a folder asked for as a page is "not found", and the server stays up', async () => {
  const server = http.createServer((req, res) => serveStatic(res, new URL(String(req.url), 'http://x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {any} */ (server.address()).port;
  try {
    for (const p of ['/ui/', '/ui', '/nope.js', '/../package.json']) assert.equal((await fetch(`http://127.0.0.1:${port}${p}`)).status, 404, p);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200, 'still serving');
  } finally {
    server.close();
  }
});

test('a write that fails leaves no half-written copy behind', () => {
  const file = path.join(dirs.data, 'w.json');
  const real = fs.writeSync;
  // @ts-ignore: a full disk, for this one write
  fs.writeSync = () => {
    throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
  };
  try {
    assert.throws(() => writeFileAtomic(file, '{}'), /no space left/);
  } finally {
    fs.writeSync = real;
  }
  assert.deepEqual(fs.readdirSync(dirs.data).filter((f) => f.endsWith('.tmp')), []);
});

test('Esc closes the dialog on top only; the Mac app reconnects quickly again once its line is up', () => {
  const modal = fs.readFileSync(path.join(root, 'public/ui/modal.js'), 'utf8');
  assert.match(modal, /if \(e\.key !== 'Escape' \|\| els\.modal\.hidden \|\| modalLocked\) return;\s*e\.preventDefault\(\);\s*e\.stopImmediatePropagation\(\);\s*closeModal\(\);/);
  const link = fs.readFileSync(path.join(root, 'macos/Sources/BodyLink.swift'), 'utf8');
  assert.match(link, /t\.sendPing \{ \[weak self, weak t\] error in[\s\S]{0,200}self\.retryDelay = 1/);
});
