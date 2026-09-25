/**
 * Echo ambient piano: a generative background piano built on the Web Audio API.
 *
 * Nothing is sampled and no existing melodies are used. Every note comes from
 * scales, chord-progression pools and randomness: random walks through
 * progressions, key changes every few phrases, voice-led inversions, short
 * motifs that mutate over time, and humanized timing and velocity. The piano
 * voice is synthesized: a few detuned partials, a pitch-dependent exponential
 * decay and a low-pass filter that closes as the note fades, which gives a
 * soft felt/Rhodes-like tone.
 *
 * Signal chain:
 *   voices -> bus -> low-pass -> high-shelf -> (dry + convolver reverb) -> master -> duck -> destination
 *
 * Scheduling uses a lookahead loop (setTimeout every ~100ms, notes queued
 * ~0.3s ahead on ctx.currentTime; further ahead when the browser throttles the
 * timer, as in a background tab). The timer stops completely once playback
 * has faded out.
 *
 * Ducking has three levels: none, light (the mic is open but idle between
 * turns) and full (Echo speaks or you're talking). `watchdog()` repairs a
 * stalled scheduler, a suspended context or a duck/fade that never recovered;
 * the app calls it about once a second.
 *
 * @example
 *   import { AmbientPiano, PIANO_MOODS } from '/piano.js';
 *   const piano = new AmbientPiano(audioCtx);
 *   piano.setMood('mellow');
 *   piano.setPlaying(true);
 */

const LOOKAHEAD = 0.3;      // seconds of audio scheduled ahead of currentTime
const MAX_LOOKAHEAD = 2;    // cap when the timer is throttled
const TICK_MS = 100;        // scheduler period
const MAX_VOICES = 24;      // polyphony cap (oldest voice is stolen)
const MASTER_LEVEL = 0.18;  // background level; Echo's voice sits on top
const DUCK_LEVEL = 0.12;    // fraction of volume kept while Echo speaks or you talk
const LIGHT_DUCK_LEVEL = 0.7;  // mic open but idle (hands-free between turns)
const STALL_MS = 2000;      // watchdog: scheduler silent this long counts as stalled
const FADE_IN = 2, FADE_OUT = 2.5, DUCK_IN = 0.25, DUCK_OUT = 1.2;

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Chord qualities as semitone intervals above the root. */
const CHORDS = {
  maj: [0, 4, 7], min: [0, 3, 7], sus2: [0, 2, 7], add9: [0, 4, 7, 14],
  six9: [0, 4, 7, 9, 14], maj7: [0, 4, 7, 11], maj9: [0, 4, 7, 11, 14],
  m7: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], m11: [0, 3, 7, 10, 14, 17],
  dom9: [0, 4, 10, 14],
};

/** Optional "color" substitutions applied at random for variety. */
const COLORS = {
  maj: ['add9', 'sus2', 'six9'], min: ['m7'], m7: ['m9'], maj7: ['maj9'], m9: ['m11'], sus2: ['add9'],
};

const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10] };

/** Semitone paths through the arpeggio notes for each arp style. */
const ARP_PATHS = {
  updown: [0, 1, 2, 3, 2, 1], shuffle: [0, 2, 1, 3, 2, 1], ostinato: [0, 1, 2, 1], up: [0, 1, 2, 3],
};

/** Oscillator partials: [frequency ratio, waveform, gain, detune in cents]. @type {Array<[number, OscillatorType, number, number]>} */
const PARTIALS = [[1, 'triangle', 0.5, 0], [1, 'sine', 0.42, 6], [2, 'sine', 0.16, -4], [3, 'sine', 0.05, 3]];

/**
 * @typedef {Object} Mood
 * @property {string} label
 * @property {string} hint
 * @property {[number, number]} bpm      tempo range
 * @property {number[]} keys             allowed tonic pitch classes
 * @property {number[]} modMoves         semitone moves used for key changes
 * @property {keyof typeof SCALES} scale
 * @property {Array<Array<[number, string]>>} progressions  [root offset, quality] per chord
 * @property {number} beats              beats per chord
 * @property {number} swing              0.5 = straight, ~0.6 = swung eighths
 * @property {number} center             MIDI note the voicings gravitate around
 * @property {'block'|'roll'|'stab'} chordStyle
 * @property {number} chordVel
 * @property {number} chordDur           chord length in beats
 * @property {number} arpDensity         probability per eighth-note step
 * @property {keyof typeof ARP_PATHS | 'random'} arpPath
 * @property {number} arpOctave          semitones added to arpeggio notes
 * @property {number} offbeatBias        weight of downbeats vs offbeats (syncopation)
 * @property {number} motifProb
 * @property {number} motifScale         rhythm stretch for motifs
 * @property {number} bassProb
 * @property {number} colorProb
 * @property {number} sustain            multiplier on the natural decay time
 */

/** @type {Record<string, Mood>} */
const MOODS = {
  upbeat: {
    label: 'Upbeat & professional', hint: 'Bright major keys, light syncopated arpeggios',
    bpm: [96, 108], keys: [0, 2, 4, 5, 7, 9], modMoves: [5, 7], scale: 'major',
    progressions: [
      [[0, 'add9'], [7, 'maj'], [9, 'm7'], [5, 'add9']],
      [[9, 'm7'], [5, 'maj7'], [0, 'add9'], [7, 'sus2']],
      [[0, 'maj'], [5, 'add9'], [9, 'm7'], [7, 'sus2']],
      [[5, 'maj7'], [7, 'maj'], [4, 'm7'], [9, 'm7']],
      [[0, 'six9'], [2, 'm7'], [5, 'add9'], [7, 'sus2']],
    ],
    beats: 4, swing: 0.52, center: 62, chordStyle: 'block', chordVel: 0.42, chordDur: 2,
    arpDensity: 0.55, arpPath: 'updown', arpOctave: 12, offbeatBias: 0.7,
    motifProb: 0.45, motifScale: 1, bassProb: 0.45, colorProb: 0.35, sustain: 0.8,
  },
  mellow: {
    label: 'Mellow', hint: 'Slow maj7 and min9 chords with lots of space',
    bpm: [60, 70], keys: [0, 3, 5, 7, 8, 10], modMoves: [5, 7, 3, 9], scale: 'major',
    progressions: [
      [[0, 'maj7'], [5, 'maj7']],
      [[0, 'maj9'], [9, 'm9'], [5, 'maj7'], [7, 'sus2']],
      [[2, 'm9'], [0, 'maj7']],
      [[4, 'm7'], [5, 'maj9'], [9, 'm9'], [5, 'maj7']],
    ],
    beats: 8, swing: 0.5, center: 58, chordStyle: 'roll', chordVel: 0.36, chordDur: 7.5,
    arpDensity: 0.1, arpPath: 'random', arpOctave: 12, offbeatBias: 1,
    motifProb: 0.35, motifScale: 2, bassProb: 0.8, colorProb: 0.3, sustain: 1.6,
  },
  nineties: {
    label: '90s feel', hint: 'R&B / lo-fi minor 9ths, ii-V moves, swung shuffle',
    bpm: [80, 90], keys: [0, 2, 4, 5, 7, 9], modMoves: [5, 7, 3, 9], scale: 'dorian',
    progressions: [
      [[0, 'm9'], [5, 'dom9'], [0, 'm9'], [5, 'dom9']],
      [[5, 'm9'], [10, 'dom9'], [3, 'maj9'], [0, 'm9']],
      [[8, 'maj7'], [7, 'm7'], [0, 'm9'], [10, 'dom9']],
      [[0, 'm9'], [10, 'dom9'], [8, 'maj9'], [7, 'm7']],
    ],
    beats: 4, swing: 0.6, center: 58, chordStyle: 'stab', chordVel: 0.44, chordDur: 1.5,
    arpDensity: 0.5, arpPath: 'shuffle', arpOctave: 0, offbeatBias: 1,
    motifProb: 0.3, motifScale: 1, bassProb: 0.5, colorProb: 0.3, sustain: 0.9,
  },
  focus: {
    label: 'Deep focus', hint: 'Minimal slow ostinatos, open sus and maj9 colors',
    bpm: [72, 80], keys: [2, 4, 7, 9], modMoves: [5, 7], scale: 'major',
    progressions: [
      [[0, 'maj9'], [0, 'sus2'], [9, 'm9'], [5, 'maj7']],
      [[0, 'sus2'], [5, 'maj9']],
      [[9, 'm9'], [5, 'maj9'], [0, 'sus2'], [7, 'sus2']],
    ],
    beats: 8, swing: 0.5, center: 60, chordStyle: 'roll', chordVel: 0.3, chordDur: 7,
    arpDensity: 0.35, arpPath: 'ostinato', arpOctave: 12, offbeatBias: 0.8,
    motifProb: 0.1, motifScale: 2, bassProb: 0.6, colorProb: 0.2, sustain: 1.3,
  },
};

/** Public mood list for UI pickers. @type {ReadonlyArray<{id: string, label: string, hint: string}>} */
export const PIANO_MOODS = Object.freeze(
  Object.entries(MOODS).map(([id, m]) => Object.freeze({ id, label: m.label, hint: m.hint })),
);

/** A short melodic cell: gaps between notes (eighths) and scale-step moves. */
function newMotif() {
  const n = 3 + Math.floor(Math.random() * 3);
  return {
    gaps: Array.from({ length: n }, () => pick([1, 1, 2, 1, 3])),
    moves: Array.from({ length: n }, (_, i) => (i === 0 ? 0 : pick([-2, -1, -1, 1, 1, 2, 0, 3]))),
  };
}

export class AmbientPiano {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} [destination] defaults to ctx.destination
   */
  constructor(ctx, destination = ctx.destination, { clock = () => performance.now() } = {}) {
    this.ctx = ctx;
    /** Wall clock in ms (injectable for tests). */
    this._clock = clock;
    this._lastTickWall = 0;
    this._lastScheduledWall = 0;
    this._lookahead = LOOKAHEAD;
    this._duckLevel = 1;          // requested duck gain
    this._duckChangedAt = 0;      // ctx time of the last duck change
    this._fadeChangedAt = 0;      // ctx time of the last fade in/out
    this._playing = false;
    this._disposed = false;
    this._timer = null;
    this._stopAt = 0;
    /** @type {Array<{time: number, midi: number, vel: number, dur: number, sustain: number}>} */
    this._queue = [];
    /** @type {Array<{env: GainNode, oscs: OscillatorNode[], nodes: AudioNode[], start: number}>} */
    this._voices = [];
    this._nextChordTime = 0;
    this._pendingMood = null;
    this._applyMood(PIANO_MOODS[0].id);

    // Master chain: gentle tone shaping, light reverb, fade and duck stages.
    this._bus = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5200; lp.Q.value = 0.3;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf'; shelf.frequency.value = 3000; shelf.gain.value = -4;
    const dry = ctx.createGain(); dry.gain.value = 0.8;
    const wet = ctx.createGain(); wet.gain.value = 0.25;
    const verb = ctx.createConvolver();
    verb.buffer = this._impulse(2.5);
    this._master = ctx.createGain(); this._master.gain.value = 0;
    this._duck = ctx.createGain(); this._duck.gain.value = 1;
    this._bus.connect(lp); lp.connect(shelf);
    shelf.connect(dry); shelf.connect(verb); verb.connect(wet);
    dry.connect(this._master); wet.connect(this._master);
    this._master.connect(this._duck); this._duck.connect(destination);
    this._chain = [this._bus, lp, shelf, dry, wet, verb, this._master, this._duck];
  }

  /** @returns {boolean} */
  get playing() { return this._playing; }

  /** True when it should actually be heard: playing, context running and not fully ducked. */
  get sounding() { return this._playing && this.ctx.state === 'running' && this._duckLevel > DUCK_LEVEL; }

  /** Requested duck gain: 1 (none), LIGHT_DUCK_LEVEL or DUCK_LEVEL. */
  get duckLevel() { return this._duckLevel; }

  /** The requested mood (a pending switch is reported immediately). */
  get mood() { return this._pendingMood || this._moodId; }

  /** Switch style; takes effect at the next chord boundary so sustains overlap smoothly. */
  setMood(id) {
    if (!MOODS[id] || this._disposed) return;
    if (!this._timer) { this._applyMood(id); this._pendingMood = null; return; }
    this._pendingMood = id === this._moodId ? null : id;
  }

  /** Fade in/out. When faded out the scheduler stops completely. */
  setPlaying(on) {
    if (this._disposed || on === this._playing) return;
    this._playing = on;
    this._fadeChangedAt = this.ctx.currentTime;
    this._glide(this._master.gain, on ? MASTER_LEVEL : 0, on ? FADE_IN : FADE_OUT);
    if (on) {
      this._resume();
      if (!this._timer) this._tick();
    } else {
      this._stopAt = this.ctx.currentTime + FADE_OUT + 0.4;
    }
  }

  /**
   * Duck under Echo's voice (fast) and restore (slow).
   * @param {boolean | 'light'} on true = full duck, 'light' = partial, false = full volume
   */
  setDucked(on) {
    if (this._disposed) return;
    const level = on === 'light' ? LIGHT_DUCK_LEVEL : on ? DUCK_LEVEL : 1;
    if (level === this._duckLevel) return; // re-asserting must not restart the glide
    this._duckLevel = level;
    this._duckChangedAt = this.ctx.currentTime;
    this._glide(this._duck.gain, level, level < 1 && level < this._duck.gain.value ? DUCK_IN : DUCK_OUT);
  }

  /**
   * Self-heal. Call about once a second. Restarts a stopped or stalled scheduler,
   * resumes a suspended context, and forces the duck and fade gains to their
   * requested levels if the automation never got there.
   * @returns {string[]} what was repaired (empty when healthy)
   */
  watchdog() {
    const fixed = [];
    if (this._disposed || !this._playing) return fixed;
    const ctx = this.ctx;
    if (ctx.state !== 'running') { this._resume(); fixed.push('resume'); }
    if (!this._timer) { this._tick(); fixed.push('timer'); }
    else if (ctx.state === 'running' && this._clock() - this._lastScheduledWall > STALL_MS) {
      clearTimeout(this._timer);
      this._nextChordTime = 0; // re-anchor on the current time
      this._tick();
      fixed.push('scheduler');
    }
    const now = ctx.currentTime;
    const off = (param, target) => Math.abs(param.value - target) > Math.max(0.02, target * 0.1);
    if (now - this._duckChangedAt > DUCK_OUT + 1 && off(this._duck.gain, this._duckLevel)) {
      this._set(this._duck.gain, this._duckLevel);
      fixed.push('duck');
    }
    if (now - this._fadeChangedAt > FADE_IN + 1 && off(this._master.gain, MASTER_LEVEL)) {
      this._set(this._master.gain, MASTER_LEVEL);
      fixed.push('fade');
    }
    return fixed;
  }

  dispose() {
    if (this._disposed) return;
    this._halt();
    this._disposed = true;
    this._playing = false;
    this._glide(this._master.gain, 0, 0.12);
    // Let the short fade finish before tearing the graph down (avoids a click).
    setTimeout(() => { for (const n of this._chain) n.disconnect(); }, 300);
  }

  // --- scheduling -----------------------------------------------------------

  _tick() {
    this._timer = null;
    if (this._disposed) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (!this._playing && (ctx.state !== 'running' || now >= this._stopAt)) { this._halt(); return; }
    // Throttled timers (background tabs tick about once a second) get a longer lookahead so notes aren't dropped.
    const wall = this._clock();
    const gap = this._lastTickWall ? (wall - this._lastTickWall) / 1000 : 0;
    this._lastTickWall = wall;
    this._lookahead = clamp(Math.max(LOOKAHEAD, gap * 1.5, this._lookahead * 0.9), LOOKAHEAD, MAX_LOOKAHEAD);
    // A suspended context keeps state only; scheduling resumes once it runs.
    if (ctx.state === 'running') {
      const ahead = now + this._lookahead;
      if (this._nextChordTime < now) this._nextChordTime = now + 0.1; // (re)anchor after start/resume
      while (this._nextChordTime < ahead) this._nextChord();
      const due = [];
      this._queue = this._queue.filter((e) => (e.time < ahead ? (due.push(e), false) : true));
      for (const e of due) if (e.time > now - 0.05) this._note(e.midi, Math.max(e.time, now), e.vel, e.dur, e.sustain);
      this._lastScheduledWall = wall;
    }
    this._timer = setTimeout(() => this._tick(), TICK_MS);
  }

  /** Stop the timer, drop queued notes and silence any remaining voices. */
  _halt() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._lastTickWall = 0;
    this._lookahead = LOOKAHEAD;
    this._queue = [];
    this._nextChordTime = 0;
    const now = this.ctx.currentTime;
    for (const v of this._voices.splice(0)) this._fadeVoice(v, now);
    if (this._pendingMood) { this._applyMood(this._pendingMood); this._pendingMood = null; }
  }

  _applyMood(id) {
    const m = MOODS[id];
    this._moodId = id;
    this._bpm = rnd(m.bpm[0], m.bpm[1]);
    this._tonic = pick(m.keys);
    this._prog = [];
    this._chordIdx = 0;
    this._phrases = 0;
    this._nextMod = 3 + Math.floor(Math.random() * 3);
    this._prevCenter = null;
    this._melodyPos = m.center + 14;
    this._motif = newMotif();
  }

  /** Start a new phrase: maybe modulate, drift tempo, random-walk the progression pool. */
  _newPhrase() {
    const m = MOODS[this._moodId];
    if (++this._phrases >= this._nextMod) {
      const options = m.modMoves.map((d) => (this._tonic + d) % 12).filter((k) => m.keys.includes(k));
      this._tonic = options.length ? pick(options) : pick(m.keys);
      this._nextMod = this._phrases + 3 + Math.floor(Math.random() * 3);
    }
    this._bpm = clamp(this._bpm + rnd(-2, 2), m.bpm[0], m.bpm[1]);
    const pool = m.progressions.filter((p) => p !== this._prog);
    this._prog = chance(0.25) && this._prog.length ? this._prog : pick(pool);
    this._chordIdx = 0;
    // Motifs evolve: usually a small mutation, occasionally a fresh idea.
    if (chance(0.2)) this._motif = newMotif();
    else if (chance(0.6)) {
      const i = 1 + Math.floor(Math.random() * (this._motif.moves.length - 1));
      this._motif.moves[i] = pick([-2, -1, 1, 2, 3]);
      this._motif.gaps[i] = pick([1, 1, 2]);
    }
  }

  /** Generate every note for the next chord and queue them with absolute times. */
  _nextChord() {
    if (this._pendingMood) { this._applyMood(this._pendingMood); this._pendingMood = null; }
    if (this._chordIdx >= this._prog.length) this._newPhrase();
    const m = MOODS[this._moodId];
    const [offset, baseQ] = this._prog[this._chordIdx++];
    const quality = COLORS[baseQ] && chance(m.colorProb) ? pick(COLORS[baseQ]) : baseQ;
    const rootPc = (this._tonic + offset) % 12;
    const start = this._nextChordTime;
    const eighth = 30 / this._bpm;
    const steps = m.beats * 2;
    this._nextChordTime = start + steps * eighth;
    /** Time of eighth-note step i, with swing applied to offbeats. */
    const at = (i) => start + Math.floor(i / 2) * 2 * eighth + (i % 2 ? 2 * eighth * m.swing : 0);
    const add = (i, midi, vel, beats, shift = 0) => this._queue.push({
      time: at(i) + shift + rnd(-0.01, 0.01), midi, vel: vel * rnd(0.85, 1.12),
      dur: beats * 2 * eighth, sustain: m.sustain,
    });

    const voicing = this._voice(rootPc, quality, m);
    if (chance(m.bassProb)) add(0, 36 + rootPc, 0.4, m.beats * 0.9); // soft low bass, MIDI 36-47

    // Chord: block, rolled (strummed upward) or short swung stabs.
    if (m.chordStyle === 'roll') {
      const gap = rnd(0.03, 0.07);
      voicing.forEach((n, j) => add(0, n, m.chordVel, m.chordDur, j * gap));
    } else {
      voicing.forEach((n) => add(0, n, m.chordVel, m.chordDur));
      if (m.chordStyle === 'stab' && chance(0.4)) voicing.forEach((n) => add(3, n, m.chordVel * 0.7, 0.75));
    }

    // Motif in the upper register; its steps are kept free of arpeggio notes.
    const busy = new Set([0]);
    if (chance(m.motifProb)) {
      const chordPcs = CHORDS[quality].map((iv) => (rootPc + iv) % 12);
      let step = pick([2, 3, 4]) * m.motifScale;
      this._renderMotif(chordPcs, m).forEach((midi, j) => {
        if (step >= steps) return;
        add(step, midi, 0.5, 1.5 * m.motifScale);
        busy.add(step);
        step += this._motif.gaps[j] * m.motifScale;
      });
    }

    // Arpeggio over the voicing; offbeatBias < 1 favours syncopated offbeats.
    const arp = voicing.map((n) => n + m.arpOctave);
    let k = Math.floor(Math.random() * 4);
    for (let i = 1; i < steps; i++) {
      if (busy.has(i) || !chance(m.arpDensity * (i % 2 ? 1 : m.offbeatBias))) continue;
      const path = ARP_PATHS[m.arpPath];
      const idx = path ? path[k++ % path.length] % arp.length : Math.floor(Math.random() * arp.length);
      add(i, arp[idx], 0.34, rnd(1, 2.5) * m.sustain);
    }
  }

  /** Pick an inversion close to the previous voicing (voice leading) with some randomness. */
  _voice(rootPc, quality, m) {
    let ints = CHORDS[quality];
    if (ints.length > 4 && chance(0.6)) ints = ints.slice(1); // rootless when the bass/ear supplies it
    let base = rootPc + 12 * Math.floor(m.center / 12);
    if (base > m.center + 4) base -= 12;
    const target = this._prevCenter ?? m.center;
    let best = null, bestScore = Infinity;
    for (let inv = 0; inv < ints.length; inv++) {
      let notes = ints.map((iv, j) => base + iv + (j < inv ? 12 : 0)).sort((a, b) => a - b);
      while (notes[notes.length - 1] > 84) notes = notes.map((n) => n - 12);
      while (notes[0] < 45) notes = notes.map((n) => n + 12);
      const avg = notes.reduce((s, n) => s + n, 0) / notes.length;
      const score = Math.abs(avg - target) + rnd(0, 3);
      if (score < bestScore) { bestScore = score; best = notes; }
    }
    this._prevCenter = (best.reduce((s, n) => s + n, 0) / best.length) * 0.7 + m.center * 0.3;
    return best;
  }

  /** Turn the current motif into pitches: walk the scale from a chord tone, snapping clashes. */
  _renderMotif(chordPcs, m) {
    const scale = SCALES[m.scale];
    const notes = [];
    for (let n = 55; n <= 91; n++) if (scale.includes((n - this._tonic + 120) % 12)) notes.push(n);
    const target = this._melodyPos * 0.6 + (m.center + 14) * 0.4;
    let idx = 0;
    notes.forEach((n, i) => {
      const better = Math.abs(n - target) < Math.abs(notes[idx] - target);
      if (chordPcs.includes(n % 12) && (better || !chordPcs.includes(notes[idx] % 12))) idx = i;
    });
    return this._motif.moves.map((mv) => {
      idx = clamp(idx + mv, 0, notes.length - 1);
      let n = notes[idx];
      // Avoid semitone rubs against the chord: nudge onto the neighbouring chord tone.
      if (!chordPcs.includes(n % 12)) {
        if (chordPcs.includes((n + 1) % 12)) n += 1;
        else if (chordPcs.includes((n + 11) % 12)) n -= 1;
      }
      this._melodyPos = n;
      return n;
    });
  }

  // --- synthesis ------------------------------------------------------------

  /** Schedule one synthesized piano note. */
  _note(midi, time, vel, dur, sustain) {
    const ctx = this.ctx;
    if (this._voices.length >= MAX_VOICES) this._fadeVoice(this._voices.shift(), time);
    const f = mtof(midi);
    const tau = clamp(1.5 * Math.pow(2, (60 - midi) / 18), 0.35, 4) * sustain;
    const v = clamp(vel, 0.05, 1);
    const release = time + Math.max(0.08, dur);
    const end = Math.min(release + 0.9, time + tau * 6 + 0.1);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(v * 0.22, time + 0.006);
    env.gain.setTargetAtTime(0, time + 0.006, tau);
    if (release < end) env.gain.setTargetAtTime(0, release, 0.14); // felt damper

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(Math.min(12000, f * (3 + 6 * v)), time);
    lp.frequency.setTargetAtTime(Math.max(350, f * 1.4), time + 0.01, tau * 0.45);
    lp.connect(env);

    /** @type {AudioNode[]} */
    const nodes = [lp, env];
    /** @type {AudioNode} */
    let out = env;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = clamp(((midi - 66) / 48) * 0.5 + rnd(-0.15, 0.15), -0.6, 0.6);
      env.connect(pan); out = pan; nodes.push(pan);
    }
    out.connect(this._bus);

    const oscs = [];
    for (const [ratio, type, gain, cents] of PARTIALS) {
      if (f * ratio > 10000) continue;
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f * ratio; o.detune.value = cents + rnd(-2, 2);
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g); g.connect(lp);
      o.start(time); o.stop(end);
      oscs.push(o); nodes.push(o, g);
    }
    const voice = { env, oscs, nodes, start: time };
    oscs[0].onended = () => this._release(voice);
    this._voices.push(voice);
  }

  /** Quickly fade a voice (stealing / halting) without a click. */
  _fadeVoice(v, time) {
    const t = Math.max(time, v.start + 0.01);
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setTargetAtTime(0, t, 0.03);
    for (const o of v.oscs) { try { o.stop(t + 0.25); } catch { /* already stopped */ } }
  }

  _release(voice) {
    const i = this._voices.indexOf(voice);
    if (i >= 0) this._voices.splice(i, 1);
    for (const n of voice.nodes) n.disconnect();
  }

  /** Ask a suspended (or iOS "interrupted") context to run again; needs a prior user gesture. */
  _resume() {
    if (this.ctx.state === 'running' || this.ctx.state === 'closed') return;
    try { this.ctx.resume()?.catch?.(() => {}); } catch { /* not allowed yet */ }
  }

  /** Clear any automation and glide quickly to the value (watchdog repair). */
  _set(param, value) {
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(0);
    param.setValueAtTime(param.value, now);
    param.setTargetAtTime(value, now, 0.1);
  }

  /** Smoothly move a param to a value in roughly `seconds`, from wherever it currently is. */
  _glide(param, value, seconds) {
    const now = this.ctx.currentTime;
    if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now); }
    param.setTargetAtTime(value, now, seconds / 4);
  }

  /** Stereo decaying-noise impulse response for the convolver reverb. */
  _impulse(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }
}
