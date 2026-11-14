import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Keeps the Echo theme readable (every key text/background pair must meet WCAG AA, 4.5:1) and
// quiet (colour only where it means something).
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
  ['bad', 'bg'], ['bad', 'panel'],
  // the primary action and your own words are an --ink fill; a destructive button is a --bad fill
  ['on-ink', 'ink'], ['on-bad', 'bad-fill'],
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

test('the palette is black, white and quiet: near-black surfaces, white ink, grey secondary text', () => {
  assert.equal(dark.bg.toUpperCase(), '#0A0A0B');
  assert.equal(dark.panel.toUpperCase(), '#131315');
  assert.equal(dark.ink.toUpperCase(), '#F5F5F7');
  assert.equal(dark.muted.toUpperCase(), '#9A9AA2');
  assert.equal(dark['on-ink'], '#000000');
  assert.equal(light.bg.toUpperCase(), '#FFFFFF');
  assert.equal(light.ink.toUpperCase(), '#0A0A0B');
});

test('colour is one gradient, and it is only for the answer, a switch that is on, and "needs you"', () => {
  assert.match(css, /--grad: linear-gradient\(90deg, #4780FF, #A866FF 38%, #FF669E 70%, #FFB866\);/);
  // Every rule that paints with the gradient, by its selector.
  const users = [...css.matchAll(/([^{}]+)\{[^{}]*var\(--grad\)[^{}]*\}/g)].map((m) => m[1].trim().split('\n').pop().trim());
  const allowed = [
    /^\.mark/,                                   // the mark's colour bar: the answer
    /^\.msg\.ai::before$/,                        // the line beside Echo's words: the answer
    /^\.act-prog b$/,                            // how far along Echo's work is
    /^\.switch \.track::before$/,                 // a switch that is on
    /^\.look-choice:has\(input:checked\)$/,       // the companion look that is picked (on, like a switch)
    /\.state$/,                                  // the Listening bar's hairline
    // Echo is hearing you (the same meaning as the Listening bar, over a conversation: the approved round-2 design)
    /^\.msg\.you\.live-bubble$/, /^\.lvl i$/, /\.composer$/,
    /^\.tl-turn\.flagged::before$/,              // the thin edge of a turn that was slow or went wrong (Settings, What happened)
    // needs you: confirmations, approvals, a worker waiting for your OK, self-improve unlocked
    /^\.msg\.confirm-card$/, /^\.msg\.task-card\.waiting$/, /^\.msg\.screen-card$/, /^\.approval-group$/, /^\.status\.waiting$/, /^\.self-badge$/, /\.tab-count\.attention$/,
  ];
  for (const sel of users) assert.ok(allowed.some((re) => re.test(sel)), `colour used outside its three meanings: ${sel}`);
  assert.ok(users.length >= 10, `found ${users.length} uses`);
});

test('the old sunset accent is gone from the page, with the old mint and navy', () => {
  const dir = (d) => fs.readdirSync(new URL(`../public/${d}`, import.meta.url));
  const files = ['style.css', 'index.html', 'app.js', 'settings.js', 'onboarding.js', 'manifest.webmanifest', ...dir('ui').map((f) => `ui/${f}`),
    ...dir('icons').filter((f) => f.endsWith('.svg')).map((f) => `icons/${f}`)];
  for (const f of files) {
    const text = fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
    assert.ok(!/#3EE6C1|#0B1220|#0B7D68/i.test(text), `${f} still uses the mint and navy palette`);
    if (f.startsWith('icons/')) continue; // the app icon is drawn elsewhere
    assert.ok(!/#FF6A5B|#FF9F43|#FF7A59|#FFD166|#FFB45E|#0E0D10|#FAF7F2/i.test(text), `${f} still uses a sunset colour`);
    assert.ok(!/sunsetSend|url\(#sunset\)|var\(--(sunset|coral|tangerine|gold|accent)[),-]/.test(text), `${f} still uses a sunset token or gradient id`);
  }
});
