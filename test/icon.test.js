// The app icon: rendered by scripts/render-icon.swift (npm run icons), a full .icns for the Mac app
// and matching PNGs for the browser launcher and the web app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const read = (f) => fs.readFileSync(path.join(root, f));

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngInfo(buf) {
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', 'a PNG');
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

test('the web and launcher icons are square PNGs with alpha at the right sizes', () => {
  /** @type {[string, number][]} */
  const icons = [['public/icons/echo-512.png', 512], ['public/icons/echo-192.png', 192], ['public/icons/apple-touch-icon.png', 180]];
  for (const [f, size] of icons) {
    const info = pngInfo(read(f));
    assert.equal(info.width, size, f);
    assert.equal(info.height, size, f);
    assert.equal(info.colorType, 6, `${f} is RGBA`);
  }
});

test('the Mac icon has every size from 16 to 1024', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/iconutil') }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'echo-icon-')), 'Echo.iconset');
  try {
    execFileSync('/usr/bin/iconutil', ['-c', 'iconset', path.join(root, 'macos', 'Echo.icns'), '-o', out]);
    for (const s of [16, 32, 128, 256, 512]) {
      /** @type {[string, number][]} */
      const entries = [[`icon_${s}x${s}.png`, s], [`icon_${s}x${s}@2x.png`, s * 2]];
      for (const [name, px] of entries) {
        const info = pngInfo(fs.readFileSync(path.join(out, name)));
        assert.equal(info.width, px, name);
        assert.equal(info.height, px, name);
      }
    }
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('npm run icons and the app build both render the icon from its Swift source', () => {
  const src = read('scripts/render-icon.swift').toString();
  assert.match(src, /--iconset/);
  assert.match(src, /--web/);
  const icons = read('scripts/build-icons.sh').toString();
  assert.match(icons, /render-icon\.swift/);
  assert.match(icons, /iconutil -c icns/);
  const app = read('scripts/build-app.sh').toString();
  assert.match(app, /render-icon\.swift/, 'the app build renders the icon');
  assert.match(app, /macos\/Echo\.icns/, 'and falls back to the committed one');
});
