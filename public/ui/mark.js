// The mark: Echo's three bars. They are the logo: the top-left brand mark, the favicon, the empty
// Workers pane, the top of each setup step (style.css .mark draws three <i> bars; nothing moves).
// The living presence is the companion (public/ui/companion.js).
//
// What is left here is what both had in common: which voice state shows, and how a voice level is
// read and smoothed. Exported for the companion and for test/mark.test.js.

/**
 * Which state the presence shows. `heard` is the instant "heard you" cue the server sends the moment
 * you stop talking (no spoken acknowledgement): it goes to thinking straight away.
 * @param {{ speaking?: boolean, listening?: boolean, busy?: boolean, heard?: boolean }} s
 */
export function vizStateFor(s) {
  return s.speaking ? 'speaking' : s.listening ? 'listening' : s.busy || s.heard ? 'thinking' : 'idle';
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Loudness (0..1) of one frame of sound. A normal speaking voice peaks around 0.15-0.25 RMS,
 * so that lands near the top of the range.
 * @param {ArrayLike<number> | null | undefined} wave samples in -1..1 (getFloatTimeDomainData)
 */
export function levelOf(wave) {
  if (!wave || !wave.length) return 0;
  let s = 0;
  for (let i = 0; i < wave.length; i++) s += wave[i] * wave[i];
  return clamp01(Math.sqrt(s / wave.length) * 4.2);
}

/**
 * Ease `cur` towards `target`: quick to rise, slower to fall, so the light jumps with a word
 * and settles after it instead of flickering.
 * @param {number} cur @param {number} target @param {number} dt seconds since the last frame
 */
export function follow(cur, target, dt, attack = 0.03, release = 0.16) {
  const tau = target > cur ? attack : release;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}
