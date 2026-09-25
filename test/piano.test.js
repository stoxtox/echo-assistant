import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AmbientPiano } from '../public/piano.js';

// A tiny fake Web Audio graph: enough to drive AmbientPiano in Node. Params evaluate
// setValueAtTime / setTargetAtTime / linearRamp automation against the fake clock.
class FakeParam {
  constructor(ctx, value = 0) { this.ctx = ctx; this.base = value; this.events = []; }
  get value() { return this.at(this.ctx.currentTime); }
  set value(v) { this.base = v; this.events = []; }
  at(t) {
    let v = this.base;
    for (const e of this.events) {
      if (e.time > t) break;
      if (e.type === 'set') v = e.value;
      else if (e.type === 'target') v = e.value + (v - e.value) * Math.exp(-(t - e.time) / e.tc);
      else if (e.type === 'linear') v = e.value;
    }
    return v;
  }
  add(e) { this.events.push(e); this.events.sort((a, b) => a.time - b.time); return this; }
  setValueAtTime(value, time) { return this.add({ type: 'set', value, time }); }
  linearRampToValueAtTime(value, time) { return this.add({ type: 'linear', value, time }); }
  setTargetAtTime(value, time, tc) {
    // Resolve the start value so later events chain from the right place.
    this.base = this.at(time); this.events = this.events.filter((e) => e.time > time);
    return this.add({ type: 'target', value, time, tc });
  }
  cancelScheduledValues(time) { const v = this.at(time); this.events = this.events.filter((e) => e.time < time); if (!this.events.length) this.base = v; return this; }
  cancelAndHoldAtTime(time) { const v = this.at(time); this.events = []; this.base = v; return this; }
}
class FakeNode {
  /** @param {any} ctx */
  constructor(ctx) { this.ctx = ctx; /** @type {any} */ this.gain = undefined; }
  connect(n) { return n; }
  disconnect() {}
}
class FakeCtx {
  constructor() { this.currentTime = 0; this.state = 'running'; this.sampleRate = 8000; this.destination = new FakeNode(this); this.notes = 0; this.resumes = 0; }
  createGain() { const n = new FakeNode(this); n.gain = new FakeParam(this, 1); return n; }
  createBiquadFilter() { const n = new FakeNode(this); Object.assign(n, { type: '', frequency: new FakeParam(this, 350), Q: new FakeParam(this, 1), gain: new FakeParam(this, 0) }); return n; }
  createConvolver() { return Object.assign(new FakeNode(this), { buffer: null }); }
  createStereoPanner() { return Object.assign(new FakeNode(this), { pan: new FakeParam(this, 0) }); }
  createBuffer(ch, len) { const data = Array.from({ length: ch }, () => new Float32Array(len)); return { getChannelData: (c) => data[c] }; }
  createOscillator() {
    const ctx = this;
    ctx.notes++;
    return Object.assign(new FakeNode(this), {
      type: '', frequency: new FakeParam(this, 440), detune: new FakeParam(this, 0), onended: null,
      start() {}, stop() {},
    });
  }
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
}

/** Build a piano on a fake context with a controllable wall clock. */
function rig() {
  const ctx = new FakeCtx();
  const clock = { ms: 0 };
  const piano = new AmbientPiano(/** @type {any} */ (ctx), /** @type {any} */ (ctx.destination), { clock: () => clock.ms });
  /** Advance both clocks and run the scheduler the way its timer would. */
  const advance = (seconds) => {
    for (let t = 0; t < seconds; t += 0.1) {
      ctx.currentTime += 0.1; clock.ms += 100;
      if (piano._timer) { clearTimeout(piano._timer); piano._tick(); }
    }
  };
  pianos.push(piano);
  return { ctx, clock, piano, advance, duck: () => piano._duck.gain.value, master: () => piano._master.gain.value };
}
const pianos = [];
afterEach(() => { for (const p of pianos.splice(0)) p.dispose(); });

test('ducks while Echo speaks and comes back to full volume afterwards', () => {
  const { piano, advance, duck, master } = rig();
  piano.setPlaying(true);
  advance(3);
  assert.ok(master() > 0.17, 'faded in');
  assert.equal(duck(), 1);
  piano.setDucked(true);
  advance(1);
  assert.ok(duck() < 0.15, `ducked, got ${duck()}`);
  piano.setDucked(false);
  advance(3);
  assert.ok(duck() > 0.97, `restored, got ${duck()}`);
});

test('back-to-back sentence chunks never leave it ducked', () => {
  const { ctx, piano, advance, duck } = rig();
  piano.setPlaying(true);
  advance(2);
  for (let i = 0; i < 8; i++) {
    piano.setDucked(true);
    advance(0.3);
    piano.setDucked(true); // re-asserted on every render
    if (i % 2) { piano.setDucked(false); advance(0.1); } // brief gap between chunks
  }
  piano.setDucked(false);
  const before = ctx.notes;
  advance(4);
  assert.ok(duck() > 0.97, `restored, got ${duck()}`);
  assert.ok(ctx.notes > before, 'notes keep being scheduled');
});

test('an idle open mic only ducks lightly', () => {
  const { piano, advance, duck } = rig();
  piano.setPlaying(true);
  piano.setDucked('light');
  advance(3);
  assert.ok(duck() > 0.65 && duck() < 0.75, `light duck, got ${duck()}`);
  assert.equal(piano.sounding, true);
  piano.setDucked(true);
  advance(1);
  assert.equal(piano.sounding, false);
});

test('notes keep being scheduled over a long run', () => {
  const { ctx, piano, advance } = rig();
  piano.setPlaying(true);
  let last = ctx.notes;
  for (let s = 0; s < 6; s++) {
    advance(10); // longest chord in any mood is ~8s
    assert.ok(ctx.notes > last, `notes scheduled in window ${s}`);
    last = ctx.notes;
  }
});

test('watchdog restores a duck gain that got stuck', () => {
  const { piano, advance, duck } = rig();
  piano.setPlaying(true);
  advance(3);
  // Simulate lost automation: gain pinned low though nothing asked for a duck.
  piano._duck.gain.value = 0.12;
  assert.deepEqual(piano.watchdog(), ['duck']);
  advance(1);
  assert.ok(duck() > 0.97, `restored, got ${duck()}`);
  assert.deepEqual(piano.watchdog(), []);
});

test('watchdog does not undo a duck that is still wanted', () => {
  const { piano, advance } = rig();
  piano.setPlaying(true);
  piano.setDucked(true);
  advance(4);
  assert.deepEqual(piano.watchdog(), []);
});

test('watchdog restarts a stalled scheduler and a lost timer', () => {
  const { ctx, clock, piano, advance } = rig();
  piano.setPlaying(true);
  advance(1);
  // Timer silently stopped (e.g. throttled away): no ticks for 3 seconds.
  clearTimeout(piano._timer);
  ctx.currentTime += 3; clock.ms += 3000;
  const before = ctx.notes;
  assert.deepEqual(piano.watchdog(), ['scheduler']);
  advance(10);
  assert.ok(ctx.notes > before, 'scheduling resumed');
  clearTimeout(piano._timer); piano._timer = null;
  assert.deepEqual(piano.watchdog(), ['timer']);
});

test('watchdog resumes a suspended context', () => {
  const { ctx, piano, advance } = rig();
  piano.setPlaying(true);
  advance(3);
  ctx.state = 'suspended';
  assert.ok(piano.watchdog().includes('resume'));
  assert.equal(ctx.state, 'running');
});

test('watchdog leaves a stopped piano alone and a pending mood applies', () => {
  const { piano, advance } = rig();
  piano.setPlaying(true);
  advance(1);
  piano.setMood('mellow');
  assert.equal(piano.mood, 'mellow');
  advance(20);
  assert.equal(piano._moodId, 'mellow');
  piano.setPlaying(false);
  advance(4);
  assert.equal(piano._timer, null, 'scheduler stopped after fade-out');
  assert.deepEqual(piano.watchdog(), []);
});

test('a throttled timer gets a longer lookahead', () => {
  const { ctx, clock, piano } = rig();
  piano.setPlaying(true);
  for (let i = 0; i < 5; i++) {
    ctx.currentTime += 1; clock.ms += 1000; // background tab: one tick a second
    clearTimeout(piano._timer); piano._tick();
  }
  assert.ok(piano._lookahead >= 1.4, `lookahead ${piano._lookahead}`);
});
