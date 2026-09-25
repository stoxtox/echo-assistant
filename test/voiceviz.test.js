import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STATES, WARM, PARAM_KEYS, ramp, analyse, follow, targetParams, stepWeights, blendParams, calmParams } from '../public/voiceviz.js';

const SR = 48000;
const BINS = 256; // fftSize 512
const quiet = { level: 0, low: 0, mid: 0, high: 0, centroid: 0.35 };
const loud = { level: 0.9, low: 0.7, mid: 0.8, high: 0.5, centroid: 0.6 };

/** A spectrum with energy around `hz`, and a matching sine waveform. */
function tone(hz, amp = 0.2) {
  const freq = new Uint8Array(BINS);
  const bin = Math.round(hz / (SR / 2 / BINS));
  for (let i = -2; i <= 2; i++) if (freq[bin + i] !== undefined) freq[bin + i] = 230 - Math.abs(i) * 40;
  const wave = new Float32Array(512).map((_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
  return { freq, wave };
}

test('silence reads as silence', () => {
  const a = analyse(new Uint8Array(BINS), new Float32Array(512), SR);
  assert.deepEqual([a.level, a.low, a.mid, a.high, a.centroid], [0, 0, 0, 0, 0]);
});

test('loudness follows the waveform and the bands follow the pitch', () => {
  const soft = analyse(tone(200, 0.05).freq, tone(200, 0.05).wave, SR);
  const strong = analyse(tone(200, 0.2).freq, tone(200, 0.2).wave, SR);
  assert.ok(strong.level > soft.level * 2, 'louder voice, bigger level');
  assert.ok(strong.level <= 1);
  const low = analyse(tone(200).freq, tone(200).wave, SR);
  const high = analyse(tone(4000).freq, tone(4000).wave, SR);
  assert.ok(low.low > low.high, 'a low tone lands in the low band');
  assert.ok(high.high > high.low, 'a high tone lands in the high band');
  assert.ok(high.centroid > low.centroid, 'higher pitch moves the colour towards gold');
});

test('the level follower rises fast and settles slowly', () => {
  const up = follow(0, 1, 1 / 60);
  const down = follow(1, 0, 1 / 60);
  assert.ok(up > 0.3, `attack ${up}`);
  assert.ok(1 - down < up, 'release is slower than attack');
});

test('every state defines every parameter, within sane ranges', () => {
  for (const s of STATES) {
    for (const a of [quiet, loud]) {
      const p = targetParams(s, a, 3.2);
      assert.deepEqual(Object.keys(p).sort(), [...PARAM_KEYS].sort(), s);
      for (const k of PARAM_KEYS) assert.ok(Number.isFinite(p[k]), `${s}.${k}`);
      assert.ok(p.radius > 0.5 && p.radius < 0.7, `${s} radius ${p.radius} keeps the drop inside the canvas`);
    }
  }
});

test('the voice drives speaking: louder means bigger, livelier, brighter', () => {
  const q = targetParams('speaking', quiet, 1), l = targetParams('speaking', loud, 1);
  for (const k of ['radius', 'wobble', 'ripple', 'glow', 'bright', 'speed']) assert.ok(l[k] > q[k], k);
  assert.ok(targetParams('speaking', { ...loud, centroid: 0.9 }, 1).hue > targetParams('speaking', { ...loud, centroid: 0.1 }, 1).hue, 'pitch shifts the hue');
});

test('listening is cooler and calmer than speaking; thinking runs the rim light', () => {
  const lis = targetParams('listening', loud, 1), spk = targetParams('speaking', loud, 1);
  assert.equal(lis.cool, 1);
  assert.equal(spk.cool, 0);
  assert.ok(lis.speed < spk.speed && lis.wobble < spk.wobble);
  assert.equal(targetParams('thinking', quiet, 1).sweep, 1);
  assert.equal(targetParams('idle', quiet, 1).sweep, 0);
});

test('idle breathes: it changes slowly over time', () => {
  const a = targetParams('idle', quiet, 0), b = targetParams('idle', quiet, 1.2);
  assert.notEqual(a.bright, b.bright);
  assert.ok(Math.abs(a.bright - b.bright) < 0.12);
});

test('states morph: no hard cuts between frames', () => {
  let w = Object.fromEntries(STATES.map((s) => [s, s === 'idle' ? 1 : 0]));
  let prev = blendParams(w, quiet, 0);
  const dt = 1 / 60;
  /** @type {Array<[string, number]>} */
  const plan = [['speaking', 60], ['listening', 60], ['thinking', 60], ['idle', 90]];
  for (const [state, frames] of plan) {
    for (let f = 0; f < frames; f++) {
      w = stepWeights(w, state, dt);
      const sum = STATES.reduce((n, s) => n + w[s], 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, 'weights stay normalised');
      const p = blendParams(w, quiet, 0);
      for (const k of PARAM_KEYS) assert.ok(Math.abs(p[k] - prev[k]) < 0.1, `${k} jumped by ${Math.abs(p[k] - prev[k]).toFixed(3)} going to ${state}`);
      prev = p;
    }
    assert.ok(w[state] > 0.9, `${state} is mostly reached after ${frames} frames`);
  }
});

test('reduced motion stands still and only pulses the light', () => {
  const p = calmParams(targetParams('speaking', loud, 2), 2);
  assert.equal(p.speed, 0);
  assert.equal(p.wobble, 0);
  assert.equal(p.ripple, 0);
  assert.equal(p.sweep, 0);
  assert.equal(p.radius, 0.6);
});

test('the palette is the sunset: coral, tangerine and soft gold', () => {
  const hex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  assert.deepEqual(WARM.slice(1).map(hex), ['#FF6A5B', '#FF9F43', '#FFD166']);
  assert.deepEqual(ramp(WARM, 0), WARM[0]);
  assert.deepEqual(ramp(WARM, 1), WARM[3]);
});

test('the old disc is gone', () => {
  assert.ok(!fs.existsSync(new URL('../public/disc.js', import.meta.url)));
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!/disc/i.test(app.replace(/discard/gi, '')), 'app.js no longer mentions the disc');
  assert.match(app, /createVoiceViz/);
});
