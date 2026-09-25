// Echo's voice: a drop of liquid sunset light behind glass.
//
//   import { createVoiceViz } from '/voiceviz.js';
//   const viz = createVoiceViz(canvas, { audio: () => analyserOrNull });
//   viz.setState('speaking');   // 'idle' | 'listening' | 'thinking' | 'speaking'
//   viz.setTheme('light');      // 'dark' | 'light'
//   viz.destroy();
//
// Each frame the viz reads the AnalyserNode that `audio()` returns (Echo's voice while she
// speaks, your mic while you talk): loudness drives motion, scale and ripples; the spectral
// centroid (roughly pitch/brightness) slides the colours along deep rose -> coral -> tangerine
// -> gold. States don't switch, they blend: every state has a weight that eases towards 0 or 1,
// and the drawn parameters are the weighted mix, so idle, listening, thinking and speaking
// morph into each other with no hard cuts.
//
// Rendering is a single WebGL fragment shader (domain-warped noise for the liquid, light
// ribbons for the waves, caustics, a glassy fresnel rim and highlight, an outer glow), with a
// Canvas2D fallback that draws the same idea with gradients. The loop pauses while the tab is
// hidden. With prefers-reduced-motion the liquid stands still and only the light gently pulses.
//
// The canvas is transparent and much bigger than the drop (CSS --viz-zoom says how much), and
// the glow fades to zero alpha well inside it, so its edges never show against the page.
//
// The pure helpers (audio analysis, state targets, blending) are exported for the tests.

export const STATES = /** @type {const} */ (['idle', 'listening', 'thinking', 'speaking']);

/** Palette stops, low -> high along the ramp. Warm: the sunset. Cool: dusk, for listening. */
export const WARM = [[0.69, 0.19, 0.36], [1, 0.416, 0.357], [1, 0.624, 0.263], [1, 0.82, 0.4]]; // deep rose, coral #FF6A5B, tangerine #FF9F43, gold #FFD166
export const COOL = [[0.2, 0.17, 0.4], [0.45, 0.27, 0.6], [0.78, 0.22, 0.4], [1, 0.56, 0.64]]; // dusk indigo, plum, deep rose, soft pink

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

/** Colour at t (0..1) along a 4-stop ramp, as [r, g, b] in 0..1. */
export function ramp(stops, t) {
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = smooth(x - i);
  return [0, 1, 2].map((c) => lerp(stops[i][c], stops[i + 1][c], f));
}

/**
 * Loudness and bands from one analyser frame.
 * @param {Uint8Array} freq  getByteFrequencyData output (0..255 per bin)
 * @param {Float32Array | null} wave  getFloatTimeDomainData output (-1..1), optional
 * @param {number} sampleRate
 * @returns {{ level: number, low: number, mid: number, high: number, centroid: number }} all 0..1
 */
export function analyse(freq, wave, sampleRate = 48000) {
  const binHz = sampleRate / 2 / freq.length;
  const band = (lo, hi) => {
    const a = Math.max(1, Math.floor(lo / binHz)), b = Math.max(a + 1, Math.min(freq.length, Math.ceil(hi / binHz)));
    let sum = 0;
    for (let i = a; i < b; i++) sum += freq[i];
    return sum / (b - a) / 255;
  };
  const low = band(80, 450), mid = band(450, 2000), high = band(2000, 7000);
  let num = 0, den = 0;
  const top = Math.min(freq.length, Math.ceil(7000 / binHz));
  for (let i = 1; i < top; i++) { num += i * freq[i]; den += freq[i]; }
  const centroid = den > 0 ? clamp01((num / den) * binHz / 3500) : 0;
  let level;
  if (wave && wave.length) {
    let s = 0;
    for (let i = 0; i < wave.length; i++) s += wave[i] * wave[i];
    level = clamp01(Math.sqrt(s / wave.length) * 4.2); // a normal speaking voice peaks around 0.15-0.25 RMS
  } else level = clamp01((low * 0.9 + mid * 1.1 + high * 0.6) * 0.9);
  return { level, low: clamp01(low * 1.3), mid: clamp01(mid * 1.5), high: clamp01(high * 2.2), centroid };
}

/** Asymmetric follower: quick to rise with the voice, slower to settle. dt in seconds. */
export function follow(cur, target, dt, attack = 0.03, release = 0.16) {
  const tau = target > cur ? attack : release;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/**
 * What each state looks like, given the current audio (0..1 values) and time (s).
 * radius: orb size (fraction of the canvas half-width); wobble: outline deformation;
 * warp: liquid swirl; ripple: rings; cool: 0 warm..1 dusk; hue: shift along the ramp;
 * glow: outer halo; bright: light level; sweep: the "working" light running round the rim;
 * speed: how fast the liquid flows; caustic: water-light sparkle.
 */
export function targetParams(state, a, t) {
  const breath = Math.sin(t * 1.25) * 0.5 + 0.5;
  switch (state) {
    case 'listening': return {
      radius: 0.6 + a.level * 0.03, wobble: 0.04 + a.level * 0.1, warp: 0.55 + a.level * 0.4, ripple: 0.12 + a.level * 0.75,
      cool: 1, hue: -0.1 + a.centroid * 0.2, glow: 0.42 + a.level * 0.45, bright: 0.58 + a.level * 0.35, sweep: 0,
      speed: 0.22 + a.level * 0.5, caustic: 0.35 + a.level * 0.3,
    };
    case 'thinking': return {
      radius: 0.6 + breath * 0.008, wobble: 0.05, warp: 0.95, ripple: 0.04,
      cool: 0.12, hue: 0.12 + Math.sin(t * 0.6) * 0.1, glow: 0.5 + breath * 0.1, bright: 0.72, sweep: 1,
      speed: 0.55, caustic: 0.5,
    };
    case 'speaking': return {
      radius: 0.605 + a.level * 0.045 + a.low * 0.015, wobble: 0.05 + a.level * 0.14 + a.low * 0.05, warp: 0.85 + a.level * 0.9, ripple: a.level * 0.55 + a.high * 0.25,
      cool: 0, hue: (a.centroid - 0.35) * 0.8 + a.high * 0.15, glow: 0.55 + a.level * 0.65, bright: 0.8 + a.level * 0.35, sweep: 0,
      speed: 0.45 + a.level * 1.5, caustic: 0.55 + a.level * 0.45,
    };
    default: return { // idle: slow breathing shimmer
      radius: 0.595 + breath * 0.01, wobble: 0.035, warp: 0.5, ripple: 0,
      cool: 0, hue: -0.05 + breath * 0.05, glow: 0.34 + breath * 0.12, bright: 0.52 + breath * 0.1, sweep: 0,
      speed: 0.16, caustic: 0.3,
    };
  }
}
export const PARAM_KEYS = Object.keys(targetParams('idle', { level: 0, low: 0, mid: 0, high: 0, centroid: 0 }, 0));

/** Ease each state's weight towards 1 (current) or 0 (the rest). Weights always sum to 1. */
export function stepWeights(weights, state, dt, rate = 4.5) {
  const k = 1 - Math.exp(-dt * rate);
  const out = {};
  let sum = 0;
  for (const s of STATES) sum += out[s] = lerp(weights[s] ?? 0, s === state ? 1 : 0, k);
  for (const s of STATES) out[s] = sum > 0 ? out[s] / sum : s === state ? 1 : 0;
  return out;
}

/** The drawn parameters: every state's target, mixed by its weight. */
export function blendParams(weights, audio, t) {
  const out = Object.fromEntries(PARAM_KEYS.map((k) => [k, 0]));
  for (const s of STATES) {
    const w = weights[s] || 0;
    if (w < 1e-4) continue;
    const p = targetParams(s, audio, t);
    for (const k of PARAM_KEYS) out[k] += p[k] * w;
  }
  return out;
}

/** Reduced motion: nothing moves or ripples; the light just breathes slowly. */
export function calmParams(p, t) {
  const pulse = Math.sin(t * 0.9) * 0.5 + 0.5;
  return { ...p, wobble: 0, ripple: 0, sweep: 0, speed: 0, radius: 0.6, bright: p.bright * (0.9 + pulse * 0.14), glow: p.glow * (0.85 + pulse * 0.3) };
}

/* ---------------- WebGL ---------------- */

const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * .5 + .5; gl_Position = vec4(aPos, 0., 1.); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes;
uniform float uTime, uFlow, uLevel, uRadius, uWobble, uWarp, uRipple, uCool, uHue, uGlow, uBright, uSweep, uCaustic, uLight, uZoom;
uniform vec2 uEdge; // the canvas's half-extent in drop units: the glow is gone well before it
uniform vec3 uBands;
uniform vec3 uW0, uW1, uW2, uW3, uC0, uC1, uC2, uC3;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0., a = .5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = m * p; a *= .5; }
  return v / .875;
}
vec3 ramp(vec3 a, vec3 b, vec3 c, vec3 d, float t) {
  t = clamp(t, 0., 1.) * 3.;
  if (t < 1.) return mix(a, b, smoothstep(0., 1., t));
  if (t < 2.) return mix(b, c, smoothstep(0., 1., t - 1.));
  return mix(c, d, smoothstep(0., 1., t - 2.));
}
vec3 palette(float t) { return mix(ramp(uW0, uW1, uW2, uW3, t), ramp(uC0, uC1, uC2, uC3, t), uCool); }
// Light focused through a moving water surface.
float caustic(vec2 p, float t) {
  vec2 i = p; float c = 1.;
  for (int n = 0; n < 3; n++) {
    float tt = t * (1. - 3.5 / float(n + 1));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1. / length(vec2(p.x / (sin(i.x + tt) / .006), p.y / (cos(i.y + tt) / .006)));
  }
  c /= 3.; c = 1.17 - pow(c, 1.4);
  return clamp(pow(abs(c), 8.), 0., 1.);
}

void main() {
  // Drop units: the drop keeps its size however big the (transparent) canvas is; uZoom is how
  // many drop units the canvas's half-height spans.
  vec2 p = (vUv * 2. - 1.) * uZoom;
  p.x *= uRes.x / uRes.y;
  float px = 2. * uZoom / uRes.y;
  float r = length(p);
  float ang = atan(p.y, p.x);
  vec2 dir = p / max(r, 1e-4);

  // The outline: slow liquid lobes, plus lobes pushed out by the voice's low, mid and high bands.
  float lobes = fbm(dir * .9 + vec2(uFlow * .35, -uFlow * .27)) - .5;
  float voice = sin(ang * 2. + uFlow * 2.1) * uBands.x + sin(ang * 3. - uFlow * 2.7) * uBands.y * .6 + sin(ang * 5. + uTime * 2.) * uBands.z * .25;
  float R = uRadius * (1. + uWobble * (lobes * .9 + voice * .35));
  float inside = 1. - smoothstep(R - px * 1.5, R + px * .5, r);

  // Outside the drop only the glow is drawn, so the big canvas costs little.
  float edge = max(r - R, 0.);
  float fade = 1. - smoothstep(.45, .9, length(p / uEdge));
  float glowA = min(1., exp(-edge * 7.5) * uGlow * (1. - .45 * uLight) * .9) * fade;
  vec3 gcol = palette(.5 + uHue * .25);
  float dither = (hash(gl_FragCoord.xy) - .5) / 255.;
  // Dither the glow's alpha too: a faint glow is mostly alpha, and 8-bit alpha alone bands into rings.
  glowA = glowA > 0. ? clamp(glowA + dither * 1.5, 0., 1.) : 0.;
  if (inside <= 0.) {
    gl_FragColor = vec4(clamp(gcol * glowA, 0., glowA), glowA);
    return;
  }

  vec2 q = p / R;
  float qr = min(length(q), 1.);
  float z = sqrt(max(0., 1. - qr * qr));       // height on a glass dome
  vec2 lq = q / (.55 + .45 * z);                // refraction: the liquid bends near the rim

  // Inside the drop: a sunset over water. The sky above the waterline holds the sun and flowing
  // waves of light; below it, the same sky is mirrored in water that the voice sets rippling.
  float f = uFlow;
  float hz = -.2 - .1 * uCool + .025 * sin(q.x * 2.3 + f * .8) + uLevel * .035 * sin(q.x * 9. - uTime * 4.);
  float below = smoothstep(hz + px * 2., hz - px * 2., q.y);
  float depth = max(hz - q.y, 0.);
  // Water: mirror about the waterline, with ripple rings and horizontal wobble.
  float ringW = sin(depth * 38. / (.25 + depth) - uTime * 4. - q.x * 2.) * (uRipple * .6 + .08);
  float wob = (noise(vec2(q.x * 3. + f * .4, depth * 26. - uTime * 1.2)) - .5) * (.05 + .12 * depth + uRipple * .1);
  vec2 sp = mix(q, vec2(q.x + wob, 2. * hz - q.y + ringW * .03), below);
  vec2 slq = sp / (.55 + .45 * z);

  vec2 w1 = vec2(fbm(slq * 1.1 + vec2(0., f * .22)), fbm(slq * 1.1 + vec2(5.2, -f * .18)));
  vec2 wq = slq + (w1 - .5) * uWarp * 1.3;
  float liquid = fbm(wq * 1.3 + vec2(f * .12, f * .07));
  float ring = sin(qr * 13. - uTime * 5. - liquid * 3.) * exp(-qr * 1.3) * uRipple;

  // Sky: gold at the horizon deepening to rose, then night-plum at the top.
  float hgt = clamp((sp.y - hz) / (1.1 - hz), 0., 1.);
  float t = .98 - hgt * 1.05 + (liquid - .5) * .7 + uHue * .3;
  vec3 night = mix(vec3(.13, .035, .09), vec3(.05, .045, .13), uCool);
  vec3 col = mix(night, palette(t), clamp(.28 + .72 * (1. - hgt) * (.55 + .6 * liquid), 0., 1.) * (.6 + .4 * uBright));

  // The sun, sitting on the waterline; it swells with the voice and sinks while listening.
  vec2 sun = vec2(.12 * sin(f * .23), hz + .2 + .04 * sin(f * .4) - .08 * uCool);
  float sd = length((sp - sun) * vec2(1., 1.08));
  float sr = .17 + uLevel * .06 + uBands.x * .03;
  float disc = smoothstep(sr, sr - .025, sd) * smoothstep(hz - .01, hz + .02, sp.y);
  vec3 sunCol = mix(palette(1.), vec3(1., .96, .86), .35);
  col = mix(col, sunCol, disc * (.9 - .45 * uCool));
  col += palette(.9) * exp(-sd * 4.) * (.35 + .5 * uBright) * (1. - .5 * uCool);

  // Waves of light: soft ribbons flowing across the sky, lifted and widened by the voice.
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float b = i == 0 ? uBands.x : i == 1 ? uBands.y : uBands.z;
    float amp = .06 + .04 * fi + uLevel * .12 + b * .16;
    float y = hz + .3 + fi * .22 + amp * sin(wq.x * (1.7 + fi * .6) + f * (.9 + fi * .35) + fi * 2.1) + (liquid - .5) * .3 + ring * .05;
    float d = sp.y - y;
    float wdt = .045 + .05 * uLevel + .03 * b;
    float g = exp(-d * d / (wdt * wdt)) * .75 + exp(-abs(d) * 7.) * .25;
    col += palette(.35 + fi * .28 + uHue * .25) * g * (.3 + .55 * uBright) * (.55 + .45 * z);
  }

  // The water: darker than the sky, streaked, with a path of sunlight and a bright waterline.
  float streak = noise(vec2(q.x * 5. + f * .3, depth * 60. - uTime * 2.));
  col = mix(col, col * (.3 + .45 * streak) + palette(.95) * pow(streak, 3.) * exp(-abs(q.x - sun.x) * 5.) * .45 * (.5 + uBright), below);
  col += palette(1.) * exp(-abs(q.y - hz) / (px * 3. + .006)) * (.25 + .5 * uBright) * smoothstep(.95, .4, qr);

  // Water light, strongest where the glass faces you.
  float c = caustic(lq * 2.6 + w1 * 1.2, f * .9 + 23.);
  col += mix(palette(.95), vec3(1.), .5) * c * uCaustic * z * .3 * below;

  // Depth: shade low in the dome, and a darker band just inside the rim (the glass's thickness).
  col *= mix(.6, 1., smoothstep(-1., .5, q.y * .5 + z * .8));
  col *= 1. - .35 * smoothstep(.72, .93, qr) * (1. - smoothstep(.93, 1., qr));

  // Glass: fresnel rim, a soft window highlight top-left, a thin reflection bottom-right.
  float fres = pow(1. - z, 3.);
  col += fres * mix(palette(.8), vec3(1.), .35) * (.45 + .35 * uBright) * (.45 + .55 * smoothstep(-.8, .8, q.y));
  vec2 hq = q - vec2(-.3, .46);
  hq = mat2(.87, -.5, .5, .87) * hq;
  col += exp(-(hq.x * hq.x * 10. + hq.y * hq.y * 40.)) * .5 * vec3(1., .96, .92);
  float cres = smoothstep(.84, .97, qr) * smoothstep(.2, .9, dot(q / max(qr, 1e-3), vec2(.6, -.8)));
  col += cres * .18 * mix(palette(.9), vec3(1.), .5);

  // Thinking: a soft light that runs round the rim.
  float comet = pow(.5 + .5 * cos(ang - uTime * 1.7), 14.) + .35 * pow(.5 + .5 * cos(ang - uTime * 1.7 + .5), 6.);
  col += comet * smoothstep(.6, 1., qr) * uSweep * mix(palette(.9), vec3(1.), .25) * 1.5;

  // Tone map on brightness only, so the colours stay saturated instead of washing to beige.
  float m = max(max(col.r, col.g), col.b);
  col *= (1. - exp(-m * 1.5)) / max(m, 1e-3);

  // Premultiplied output: the drop over its glow. Colour never exceeds alpha, and the dither
  // scales with alpha, so fully transparent pixels stay exactly (0, 0, 0, 0).
  float a = clamp(inside + glowA * (1. - inside), 0., 1.);
  vec3 outc = col * inside + gcol * glowA * (1. - inside);
  outc += dither * a;
  gl_FragColor = vec4(clamp(outc, 0., a), a);
}`;

function initGL(canvas) {
  /** @type {WebGLRenderingContext | null} */
  let gl = null;
  try {
    gl = /** @type {WebGLRenderingContext} */ (canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, powerPreference: 'low-power' }));
  } catch {}
  if (!gl) return null;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = {};
  for (const n of ['uRes', 'uZoom', 'uEdge', 'uTime', 'uFlow', 'uLevel', 'uRadius', 'uWobble', 'uWarp', 'uRipple', 'uCool', 'uHue', 'uGlow', 'uBright', 'uSweep', 'uCaustic', 'uLight', 'uBands',
    'uW0', 'uW1', 'uW2', 'uW3', 'uC0', 'uC1', 'uC2', 'uC3']) u[n] = gl.getUniformLocation(prog, n);
  WARM.forEach((c, i) => gl.uniform3fv(u[`uW${i}`], c));
  COOL.forEach((c, i) => gl.uniform3fv(u[`uC${i}`], c));
  return {
    draw(frame) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform1f(u.uZoom, frame.zoom);
      gl.uniform2f(u.uEdge, frame.zoom * canvas.width / canvas.height, frame.zoom);
      gl.uniform1f(u.uTime, frame.time);
      gl.uniform1f(u.uFlow, frame.flow);
      gl.uniform1f(u.uLevel, frame.audio.level);
      gl.uniform3f(u.uBands, frame.audio.low, frame.audio.mid, frame.audio.high);
      gl.uniform1f(u.uLight, frame.light);
      const p = frame.params;
      for (const k of PARAM_KEYS) gl.uniform1f(u[`u${k[0].toUpperCase()}${k.slice(1)}`], p[k]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    lost: () => gl.isContextLost(),
  };
}

/* ---------------- Canvas2D fallback ---------------- */

function init2D(canvas) {
  const g = canvas.getContext('2d');
  if (!g) return null;
  const css = (rgb, a = 1) => `rgba(${rgb.map((v) => Math.round(v * 255)).join(',')},${a})`;
  const pal = (t, cool) => { const w = ramp(WARM, t), c = ramp(COOL, t); return w.map((v, i) => lerp(v, c[i], cool)); };
  return {
    draw({ params: p, audio, flow, time, light, zoom }) {
      const W = canvas.width, H = canvas.height, s = Math.min(W, H) / 2 / zoom, cx = W / 2, cy = H / 2;
      const R = p.radius * s;
      g.clearRect(0, 0, W, H);
      // glow
      const glow = g.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.65);
      glow.addColorStop(0, css(pal(0.5 + p.hue * 0.25, p.cool), p.glow * (light ? 0.35 : 0.6)));
      glow.addColorStop(1, css(pal(0.5, p.cool), 0));
      g.fillStyle = glow;
      g.fillRect(0, 0, W, H);
      // wobbly outline
      g.save();
      g.beginPath();
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        const wob = Math.sin(a * 3 + flow * 2.1) * (0.4 + audio.low) + Math.sin(a * 5 - flow * 2.7) * (0.25 + audio.mid * 0.6) + Math.sin(a * 2 + flow) * 0.3;
        const rr = R * (1 + p.wobble * wob * 0.35);
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
      g.clip();
      const base = g.createLinearGradient(0, cy - R, 0, cy + R);
      for (const [o, t] of [[0, 0.1], [0.45, 0.4], [0.75, 0.7], [1, 0.95]]) base.addColorStop(o, css(pal(t + p.hue * 0.3, p.cool)));
      g.fillStyle = base;
      g.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);
      // drifting liquid blobs
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const bx = cx + Math.cos(flow * (0.5 + i * 0.2) + i * 2.1) * R * 0.45, by = cy + Math.sin(flow * (0.4 + i * 0.25) + i) * R * 0.4;
        const blob = g.createRadialGradient(bx, by, 0, bx, by, R * (0.55 + p.warp * 0.15));
        blob.addColorStop(0, css(pal(0.35 + i * 0.25 + p.hue * 0.2, p.cool), 0.35 * p.bright));
        blob.addColorStop(1, css(pal(0.5, p.cool), 0));
        g.fillStyle = blob;
        g.fillRect(cx - R, cy - R, R * 2, R * 2);
      }
      // ribbons of light
      for (let i = 0; i < 3; i++) {
        const band = [audio.low, audio.mid, audio.high][i];
        const amp = (0.12 + 0.06 * i + audio.level * 0.22 + band * 0.3) * R;
        g.beginPath();
        for (let x = -R; x <= R; x += R / 24) {
          const y = cy - ((i - 1) * 0.34 * R + amp * Math.sin((x / R) * (2 + i * 0.7) + flow * (0.9 + i * 0.35) + i * 2.1));
          x === -R ? g.moveTo(cx + x, y) : g.lineTo(cx + x, y);
        }
        g.strokeStyle = css(pal(0.45 + i * 0.22 + p.hue * 0.25, p.cool), 0.35 + 0.4 * p.bright);
        g.lineWidth = R * (0.05 + 0.05 * audio.level);
        g.shadowColor = g.strokeStyle;
        g.shadowBlur = R * 0.25;
        g.stroke();
      }
      g.shadowBlur = 0;
      g.globalCompositeOperation = 'source-over';
      // the sun on the waterline, and darker water below with streaks of reflected light
      const hz = cy + R * (0.2 + 0.1 * p.cool);
      const sun = g.createRadialGradient(cx, hz - R * 0.2, 0, cx, hz - R * 0.2, R * (0.2 + audio.level * 0.06));
      sun.addColorStop(0, css(pal(1, p.cool), 0.95 - 0.4 * p.cool));
      sun.addColorStop(0.85, css(pal(1, p.cool), 0.9 - 0.4 * p.cool));
      sun.addColorStop(1, css(pal(1, p.cool), 0));
      g.fillStyle = sun;
      g.fillRect(cx - R, cy - R, R * 2, R * 2);
      g.fillStyle = `rgba(20,8,18,${0.45 - 0.1 * p.bright})`;
      g.fillRect(cx - R * 1.5, hz, R * 3, R * 1.5);
      for (let i = 0; i < 7; i++) {
        const y = hz + R * 0.06 + i * R * 0.1, w = R * (0.5 - i * 0.04) * (1 + 0.3 * Math.sin(flow * 3 + i * 1.7 + time * p.ripple * 4));
        g.fillStyle = css(pal(0.95, p.cool), 0.35 - i * 0.035);
        g.fillRect(cx - w / 2, y, w, Math.max(1, R * 0.025));
      }
      // glass: highlight and rim
      const hl = g.createRadialGradient(cx - R * 0.3, cy - R * 0.44, 0, cx - R * 0.3, cy - R * 0.44, R * 0.4);
      hl.addColorStop(0, 'rgba(255,255,255,.5)');
      hl.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = hl;
      g.fillRect(cx - R, cy - R, R * 2, R * 2);
      const rim = g.createRadialGradient(cx, cy, R * 0.7, cx, cy, R * 1.05);
      rim.addColorStop(0, 'rgba(255,220,180,0)');
      rim.addColorStop(1, `rgba(255,220,180,${0.35 + 0.2 * p.bright})`);
      g.fillStyle = rim;
      g.fillRect(cx - R * 1.2, cy - R * 1.2, R * 2.4, R * 2.4);
      if (p.sweep > 0.01) {
        const a = time * 1.7;
        g.strokeStyle = css(pal(0.85, p.cool), 0.7 * p.sweep);
        g.lineWidth = R * 0.08;
        g.lineCap = 'round';
        g.beginPath();
        g.arc(cx, cy, R * 0.93, -a - 0.9, -a);
        g.stroke();
      }
      g.restore();
    },
    lost: () => false,
  };
}

/* ---------------- The viz ---------------- */

/**
 * @param {HTMLCanvasElement} canvas  sized by CSS; the backing store follows it
 * @param {{ audio?: () => AnalyserNode | null, theme?: 'dark' | 'light', reducedMotion?: MediaQueryList | null, force2d?: boolean }} [opts]
 */
export function createVoiceViz(canvas, { audio = () => null, theme = 'dark', reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'), force2d = false } = {}) {
  let renderer = null;
  if (!force2d) {
    try { renderer = initGL(canvas); } catch (e) { console.warn('[viz] WebGL unavailable, using Canvas2D:', e.message); renderer = null; }
  }
  const kind = renderer ? 'webgl' : '2d';
  if (!renderer) renderer = init2D(canvas);

  let state = 'idle';
  let weights = Object.fromEntries(STATES.map((s) => [s, s === 'idle' ? 1 : 0]));
  let light = theme === 'light' ? 1 : 0;
  let reduced = !!reducedMotion?.matches;
  const onReduced = () => { reduced = !!reducedMotion?.matches; };
  reducedMotion?.addEventListener?.('change', onReduced);

  const heard = { level: 0, low: 0, mid: 0, high: 0, centroid: 0.35 };
  let freq = new Uint8Array(0), wave = new Float32Array(0);
  let flow = Math.random() * 50, time = 0, last = 0, lastDraw = 0, raf = 0;
  let zoom = 1; // drop units per canvas half-height (CSS --viz-zoom): room for the glow to fade out
  let silentSince = 0; // for voices that bypass the analyser (the browser's own speech)

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    zoom = Math.max(1, parseFloat(getComputedStyle(canvas).getPropertyValue('--viz-zoom')) || 1);
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  ro?.observe(canvas);
  resize();

  function listen(dt, now) {
    const node = state === 'speaking' || state === 'listening' ? audio() : null;
    let a = { level: 0, low: 0, mid: 0, high: 0, centroid: heard.centroid };
    if (node) {
      if (freq.length !== node.frequencyBinCount) { freq = new Uint8Array(node.frequencyBinCount); wave = new Float32Array(node.fftSize); }
      node.getByteFrequencyData(freq);
      node.getFloatTimeDomainData(wave);
      a = analyse(freq, wave, node.context.sampleRate);
    }
    // Echo speaking through the browser's built-in voice never reaches the analyser; give the
    // waves a gentle speech-like rhythm so she still looks alive.
    if (state === 'speaking') {
      if (a.level > 0.02) silentSince = 0;
      else if (!silentSince) silentSince = now;
      else if (now - silentSince > 350) {
        const syl = Math.max(0, Math.sin(time * 9.1) * 0.6 + Math.sin(time * 4.3 + 1) * 0.4);
        a = { level: 0.22 + syl * 0.3, low: 0.3 + syl * 0.25, mid: 0.25 + syl * 0.3, high: 0.1 + syl * 0.15, centroid: 0.35 + Math.sin(time * 0.7) * 0.15 };
      }
    } else silentSince = 0;
    for (const k of ['level', 'low', 'mid', 'high']) heard[k] = follow(heard[k], a[k], dt);
    heard.centroid = follow(heard.centroid, a.centroid || heard.centroid, dt, 0.25, 0.6);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    // Idle and reduced motion don't need every frame: 30 and 20 fps are plenty for slow breathing.
    const settled = weights.idle > 0.999 && state === 'idle';
    const minGap = reduced ? 48 : settled ? 31 : 0;
    if (now - lastDraw < minGap) return;
    last = now;
    lastDraw = now;
    time += dt;
    listen(dt, now);
    weights = stepWeights(weights, state, dt);
    let params = blendParams(weights, heard, time);
    if (reduced) params = calmParams(params, time);
    else flow += dt * params.speed;
    if (renderer.lost()) return;
    renderer.draw({ params, audio: reduced ? { ...heard, low: 0, mid: 0, high: 0 } : heard, flow, time: reduced ? 0 : time, light, zoom });
  }

  function start() { if (!raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); });
  canvas.addEventListener('webglcontextrestored', () => { try { renderer = initGL(canvas) || renderer; } catch {} start(); });
  start();

  return {
    /** 'webgl' or '2d' (the fallback). */
    get renderer() { return kind; },
    get state() { return state; },
    setState(s) { if (STATES.includes(s)) state = s; },
    setTheme(t) { light = t === 'light' ? 1 : 0; },
    destroy() {
      stop();
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reducedMotion?.removeEventListener?.('change', onReduced);
    },
  };
}
