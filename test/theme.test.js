import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Keeps the Echo theme readable: every key text/background pair must meet WCAG AA (4.5:1).
const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

/** @param {string} block @returns {Record<string, string>} */
function tokens(block) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [, name, hex] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[name] = hex;
  return out;
}
const dark = tokens(css.slice(0, css.indexOf('@media (prefers-color-scheme: light)')));
const light = { ...dark, ...tokens(css.slice(css.indexOf('@media (prefers-color-scheme: light)'))) };

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const PAIRS = [
  ['ink', 'bg'], ['ink', 'panel'], ['ink', 'panel-2'],
  ['muted', 'bg'], ['muted', 'panel'], ['muted', 'panel-2'],
  ['accent', 'bg'], ['accent', 'panel'],
  ['warn', 'panel'], ['bad', 'panel'], ['ok', 'panel'], ['warn', 'panel-2'], ['accent', 'panel-2'],
  ['on-accent', 'accent-fill'], ['on-warn', 'warn-fill'], ['on-bad', 'bad-fill'],
];

for (const [mode, t] of [['dark', dark], ['light', light]]) {
  test(`${mode} theme text pairs meet WCAG AA`, () => {
    for (const [fg, bg] of PAIRS) {
      assert.ok(t[fg] && t[bg], `missing --${fg} or --${bg} in ${mode} theme`);
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= 4.5, `${mode}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
  });
}

test('dark theme uses the Echo palette: warm graphite with a sunset accent', () => {
  assert.equal(dark.bg.toUpperCase(), '#0E0D10');
  assert.equal(dark.panel.toUpperCase(), '#17151A');
  assert.equal(dark.line.toUpperCase(), '#2A2630');
  assert.equal(dark.coral.toUpperCase(), '#FF6A5B');
  assert.equal(dark.tangerine.toUpperCase(), '#FF9F43');
  assert.equal(dark.accent.toUpperCase(), '#FF7A59');
  assert.equal(dark.warn.toUpperCase(), '#FFD166');
  assert.equal(dark.ok.toUpperCase(), '#7BD389');
  assert.equal(dark.bad.toUpperCase(), '#FF5C7A');
  assert.equal(dark.ink.toUpperCase(), '#F5F1EC');
  assert.equal(dark.muted.toUpperCase(), '#A39E99');
  assert.equal(light.bg.toUpperCase(), '#FAF7F2');
});

test('no mint or navy left in the UI and icons', () => {
  const files = ['../public/style.css', '../public/index.html', '../public/app.js', '../public/voiceviz.js', '../public/manifest.webmanifest',
    ...fs.readdirSync(new URL('../public/icons', import.meta.url)).filter((f) => f.endsWith('.svg')).map((f) => `../public/icons/${f}`)];
  for (const f of files) {
    const text = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/#3EE6C1|#0B1220|#0B7D68/i.test(text), `${f} still uses the old palette`);
  }
});
