// The Sky (the third pane, beside Talk and Workers): every day you talked with Echo is a
// constellation. Each star is one thing you said or typed: further right the later it was, higher
// the more Echo had to say back, bigger where Echo did something for you. Drag to walk back
// through your days. Click a day's name and Echo's light flies it star by star while the day
// plays as a tune (a star's height is its pitch, the pauses between stars are the pauses in
// your day). Click a star to ring it. Today's constellation grows while you talk.
//
// The nights come from GET /api/sky (lib/sky.ts): numbers only, plus what you said at each star
// when the conversation log is kept. Nothing here leaves the window.

const MAJOR = [0, 2, 4, 7, 9], MINOR = [0, 3, 5, 7, 10];
/** How many scale steps a night's tune spans (three octaves of five notes). */
export const STEPS = 15;
const GAP = 150; // px between two nights
const WARM = [255, 240, 214], COOL = [190, 212, 255], ROSE = [255, 170, 214];

/**
 * A star's note: its height picks a step of the night's five-note scale.
 * @param {{ y: number }} star @param {{ root: number, minor: boolean }} night @returns {number} MIDI note
 */
export function noteOf(star, night) {
  const step = Math.max(0, Math.min(STEPS - 1, Math.round((1 - star.y) * (STEPS - 1))));
  const scale = night.minor ? MINOR : MAJOR;
  return night.root - 12 + 12 * Math.floor(step / 5) + scale[step % 5];
}
export const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** How wide a night is drawn: more stars, more room. */
export const widthOf = (night) => Math.round(Math.max(380, Math.min(980, 300 + night.stars.length * 6)));

/**
 * Where each night sits along the sky (px from its left end), oldest first.
 * @param {Array<{ stars: any[] }>} nights @returns {{ x: number[], w: number[], total: number }}
 */
export function layout(nights) {
  const x = [], w = [];
  let at = GAP;
  for (const n of nights) {
    x.push(at);
    w.push(widthOf(n));
    at += widthOf(n) + GAP;
  }
  return { x, w, total: at };
}

/**
 * The tune of a night: its main stars in order, each with when it sounds (seconds from the
 * start). A longer silence in the day is a longer rest, and the whole tune fits in `maxS`.
 * @param {{ stars: Array<{ t: number, main: boolean }> }} night @param {number} [maxS]
 * @returns {Array<{ i: number, at: number }>}
 */
export function tune(night, maxS = 24) {
  const mains = night.stars.map((s, i) => ({ s, i })).filter((x) => x.s.main);
  let at = 0;
  const out = mains.map((m, k) => {
    if (k) at += 0.2 + Math.min(0.75, Math.log2(1 + (m.s.t - mains[k - 1].s.t) / 60000) * 0.17);
    return { i: m.i, at };
  });
  const scale = at > maxS ? maxS / at : 1;
  return out.map((o) => ({ i: o.i, at: Math.round(o.at * scale * 1000) / 1000 }));
}

/** How full the moon is: today against your fullest day (a sliver even on an empty one). */
export function moonPhase(nights, today) {
  const most = Math.max(1, ...nights.map((n) => n.stars.length));
  const now = nights.find((n) => n.day === today)?.stars.length || 0;
  return Math.max(0.06, Math.min(1, now / most));
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

/** A soft round glow, drawn once and stamped for every star. */
function sprite(c) {
  const s = document.createElement('canvas');
  s.width = s.height = 64;
  const g = s.getContext('2d');
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, rgba(c, 1));
  r.addColorStop(0.12, rgba(c, 0.85));
  r.addColorStop(0.32, rgba(c, 0.22));
  r.addColorStop(1, rgba(c, 0));
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return s;
}

/**
 * @param {HTMLElement} root the .sky section
 * @param {{ fetchSky?: () => Promise<any>, reducedMotion?: () => boolean }} [o]
 */
export function createSky(root, o = {}) {
  const fetchSky = o.fetchSky || (() => fetch('/api/sky').then((r) => r.json()));
  const calm = o.reducedMotion || (() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const canvas = root.querySelector('canvas'), tip = root.querySelector('.sky-tip'), empty = root.querySelector('.sky-empty');
  const g = canvas.getContext('2d');
  const glow = { said: sprite(WARM), typed: sprite(COOL), acted: sprite(ROSE) };
  let nights = [], today = '', lay = layout([]), words = false;
  let W = 0, H = 0, dpr = 1;
  let pan = 0, vel = 0, drag = null, hover = null, open = false, raf = 0, last = 0, loaded = false;
  /** Stars that have just appeared: "day/trace" → when (they fall in). */
  const born = new Map();
  /** What is playing: the night, its tune, when it began (audio clock), and the notes rung so far. */
  let play = null;
  let shoot = null, nextShoot = 6;
  /** A star rung by hand: one ripple. */
  let ripple = null;
  const dust = Array.from({ length: 260 }, (_, i) => {
    const r = Math.sin(i * 12.9898) * 43758.5453, q = Math.sin(i * 78.233) * 12543.123, z = Math.sin(i * 3.7) * 9153.7;
    return { x: r - Math.floor(r), y: q - Math.floor(q), d: 0.15 + 0.75 * (z - Math.floor(z)), p: i * 1.7 };
  });

  /* ---------- sound ---------- */
  let ac = null, out = null, echo = null, drone = null;
  function audio() {
    if (ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    out = ac.createGain();
    out.gain.value = 0.5;
    out.connect(ac.destination);
    // A little room: one soft repeat that fades.
    echo = ac.createDelay(1);
    echo.delayTime.value = 0.31;
    const back = ac.createGain(), dull = ac.createBiquadFilter();
    back.gain.value = 0.34;
    dull.type = 'lowpass';
    dull.frequency.value = 2200;
    echo.connect(dull).connect(back).connect(echo);
    back.connect(out);
    return ac;
  }
  /** Ring one note: a small bell (two partials and a soft body under them). */
  function ring(midi, when, loud = 1, soft = false) {
    const a = audio();
    if (!a) return;
    const t = Math.max(when, a.currentTime), f = hz(midi), v = a.createGain();
    v.gain.setValueAtTime(0, t);
    v.gain.linearRampToValueAtTime(0.22 * loud, t + (soft ? 0.03 : 0.006));
    v.gain.exponentialRampToValueAtTime(0.0008, t + (soft ? 1.1 : 1.9));
    v.connect(out);
    v.connect(echo);
    for (const [mult, gain, type] of [[1, 1, 'sine'], [2.01, soft ? 0.12 : 0.34, 'sine'], [0.5, 0.3, 'triangle'], [4.2, soft ? 0 : 0.07, 'sine']]) {
      if (!gain) continue;
      const osc = a.createOscillator(), og = a.createGain();
      osc.type = type;
      osc.frequency.value = f * mult;
      og.gain.setValueAtTime(gain, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + (mult > 2 ? 0.5 : 1.8));
      osc.connect(og).connect(v);
      osc.start(t);
      osc.stop(t + 2);
    }
  }
  /** The night's home note held quietly under its tune. */
  function hum(night, seconds) {
    const a = audio();
    if (!a) return;
    stopHum();
    const v = a.createGain(), t = a.currentTime;
    v.gain.setValueAtTime(0, t);
    v.gain.linearRampToValueAtTime(0.05, t + 1.2);
    v.gain.setValueAtTime(0.05, t + seconds);
    v.gain.linearRampToValueAtTime(0, t + seconds + 2.5);
    v.connect(out);
    const oscs = [night.root - 24, night.root - 17].map((m) => {
      const osc = a.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz(m);
      osc.connect(v);
      osc.start(t);
      osc.stop(t + seconds + 2.6);
      return osc;
    });
    drone = { v, oscs };
  }
  function stopHum() {
    if (!drone || !ac) return;
    const t = ac.currentTime;
    drone.v.gain.cancelScheduledValues(t);
    drone.v.gain.setTargetAtTime(0, t, 0.15);
    for (const osc of drone.oscs) { try { osc.stop(t + 0.8); } catch {} }
    drone = null;
  }

  /* ---------- where things are ---------- */
  const top = () => H * 0.13, tall = () => Math.max(120, H * 0.56);
  const at = (ni, s) => ({ x: lay.x[ni] + s.x * lay.w[ni] - pan, y: top() + s.y * tall() });
  const maxPan = () => Math.max(0, lay.total - W);
  const clampPan = (p) => Math.max(Math.min(0, lay.total - W) / 2, Math.min(maxPan(), p));
  const centre = (ni) => clampPan(lay.x[ni] + lay.w[ni] / 2 - W / 2);

  function resize() {
    const r = root.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(200, r.width);
    H = Math.max(200, r.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    pan = clampPan(pan);
  }

  function starAt(px, py) {
    let best = null;
    nights.forEach((n, ni) => {
      if (lay.x[ni] - pan > W + 40 || lay.x[ni] + lay.w[ni] - pan < -40) return;
      n.stars.forEach((s, si) => {
        const p = at(ni, s), d = Math.hypot(p.x - px, p.y - py);
        if (d < 16 && (!best || d < best.d)) best = { ni, si, d };
      });
    });
    return best;
  }
  /** The name under a night, as a box to click. */
  const titleBox = (ni) => ({ x: lay.x[ni] - pan, y: top() + tall() + 14, w: lay.w[ni], h: 64 });
  const titleAt = (px, py) => nights.findIndex((_, ni) => { const b = titleBox(ni); return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h; });

  /* ---------- drawing ---------- */
  function draw(now) {
    const t = now / 1000, still = calm();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Night: deep blue at the top, a little light where the land meets it.
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#04050c');
    bg.addColorStop(0.55, '#090d22');
    bg.addColorStop(1, '#161a3a');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    // A slow veil of Echo's colours, barely there.
    for (const [hue, y0, speed] of [['rgba(71,128,255,', 0.3, 0.021], ['rgba(168,102,255,', 0.42, 0.016], ['rgba(255,102,158,', 0.52, 0.012]]) {
      const cx = W * (0.5 + 0.35 * Math.sin((still ? 0 : t) * speed * 6 + y0 * 9) - (pan / Math.max(1, lay.total)) * 0.2);
      const v = g.createRadialGradient(cx, H * y0, 0, cx, H * y0, W * 0.6);
      v.addColorStop(0, `${hue}0.07)`);
      v.addColorStop(1, `${hue}0)`);
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
    }
    // Far stars, drifting less than the near ones as you walk.
    for (const d of dust) {
      const x = (((d.x * 2400 - pan * d.d * 0.35) % (W + 40)) + (W + 40)) % (W + 40) - 20, y = d.y * H * 0.8;
      const a = 0.16 + 0.5 * d.d * (still ? 0.7 : 0.6 + 0.4 * Math.sin(t * (0.6 + d.d) + d.p));
      g.fillStyle = `rgba(214,224,255,${a.toFixed(3)})`;
      g.fillRect(x, y, d.d > 0.7 ? 1.6 : 1, d.d > 0.7 ? 1.6 : 1);
    }
    moon(t);
    if (shoot) shooting(t);

    nights.forEach((n, ni) => {
      const left = lay.x[ni] - pan;
      if (left > W + 60 || left + lay.w[ni] < -60) return;
      const playing = play && play.ni === ni, isToday = n.day === today;
      // The lines of the day.
      g.lineCap = 'round';
      n.links.forEach(([a, b], k) => {
        const p = at(ni, n.stars[a]), q = at(ni, n.stars[b]);
        const lit = playing && play.lit.has(b);
        g.strokeStyle = lit ? 'rgba(255,236,200,0.75)' : `rgba(200,214,255,${hover?.ni === ni ? 0.3 : 0.17})`;
        g.lineWidth = lit ? 1.5 : 1;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(q.x, q.y);
        g.stroke();
        void k;
      });
      // Its stars.
      n.stars.forEach((s, si) => {
        const p = at(ni, s), key = `${n.day}/${s.trace}`, b = born.get(key);
        let fall = 1;
        if (b !== undefined) {
          fall = Math.min(1, (now - b) / 900);
          if (fall >= 1) born.delete(key);
        }
        const tw = still ? 1 : 0.82 + 0.18 * Math.sin(t * (1.1 + (si % 7) * 0.23) + si * 2.1);
        const rung = playing ? play.rung.get(si) : undefined;
        const pulse = rung !== undefined ? Math.max(0, 1 - (now - rung) / 900) : 0;
        const big = (s.main ? 9 : 5) * (0.75 + s.size * 0.34) * (1 + pulse * 0.9) * (hover?.ni === ni && hover.si === si ? 1.5 : 1);
        const y = p.y - (1 - fall) ** 2 * 140;
        g.globalAlpha = Math.min(1, (s.main ? 0.95 : 0.55) * tw * fall + pulse);
        const img = s.acted ? glow.acted : glow[s.kind] || glow.said;
        g.drawImage(img, p.x - big, y - big, big * 2, big * 2);
        // Where Echo did something: four fine rays.
        if (s.acted && s.main) {
          g.strokeStyle = `rgba(255,214,236,${0.5 * tw + pulse * 0.5})`;
          g.lineWidth = 0.8;
          const r = big * 1.25;
          g.beginPath();
          g.moveTo(p.x - r, y); g.lineTo(p.x + r, y);
          g.moveTo(p.x, y - r); g.lineTo(p.x, y + r);
          g.stroke();
        }
        if (fall < 1) {
          g.strokeStyle = `rgba(255,255,255,${0.5 * (1 - fall)})`;
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(p.x + 14, y - 46 * (1 - fall) - 12);
          g.lineTo(p.x, y);
          g.stroke();
        }
        if (pulse > 0) {
          g.globalAlpha = pulse * 0.7;
          g.strokeStyle = 'rgba(255,240,214,1)';
          g.lineWidth = 1;
          g.beginPath();
          g.arc(p.x, y, big * 0.5 + (1 - pulse) * 26, 0, Math.PI * 2);
          g.stroke();
        }
        g.globalAlpha = 1;
      });
      // Its name.
      const b = titleBox(ni), mid = b.x + b.w / 2, over = hover?.title === ni;
      g.textAlign = 'center';
      g.fillStyle = over || playing ? 'rgba(255,255,255,0.98)' : 'rgba(236,240,255,0.86)';
      g.font = '600 13px -apple-system, "SF Pro Text", system-ui, sans-serif';
      const name = `${playing ? '❚❚' : '▶'}   ${n.name.toUpperCase().split('').join(' ')}`;
      g.fillText(name, mid, b.y + 18);
      g.fillStyle = 'rgba(180,190,225,0.72)';
      g.font = '12px -apple-system, "SF Pro Text", system-ui, sans-serif';
      g.fillText(`${isToday ? 'Today' : n.label} · ${n.stars.length} ${n.stars.length === 1 ? 'star' : 'stars'}`, mid, b.y + 38);
      g.fillStyle = 'rgba(150,160,200,0.6)';
      g.fillText(n.why, mid, b.y + 55);
    });

    // Echo's light, flying the day.
    if (play) flyLight(now);
    if (ripple) {
      const k = (now - ripple.at) / 800, n = nights[ripple.ni];
      if (k >= 1 || !n?.stars[ripple.si]) ripple = null;
      else {
        const p = at(ripple.ni, n.stars[ripple.si]);
        g.globalAlpha = (1 - k) * 0.8;
        g.strokeStyle = 'rgba(255,240,214,1)';
        g.lineWidth = 1;
        g.beginPath();
        g.arc(p.x, p.y, 5 + k * 30, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    hills();
  }

  function moon(t) {
    const r = Math.max(18, Math.min(34, H * 0.05)), cx = W - r - 34, cy = r + 30, phase = moonPhase(nights, today);
    const halo = g.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 4);
    halo.addColorStop(0, `rgba(210,220,255,${0.1 + phase * 0.12})`);
    halo.addColorStop(1, 'rgba(210,220,255,0)');
    g.fillStyle = halo;
    g.fillRect(cx - r * 4, cy - r * 4, r * 8, r * 8);
    g.save();
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#1a1e3a';
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    // The lit part grows from the right as the day fills.
    const body = g.createRadialGradient(cx + r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r * 1.1);
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.6, '#e9ecff');
    body.addColorStop(1, '#aab2de');
    g.fillStyle = body;
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
    g.ellipse(cx, cy, Math.abs(1 - phase * 2) * r, r, 0, Math.PI / 2, -Math.PI / 2, phase > 0.5);
    g.fill();
    g.restore();
    void t;
  }

  function hills() {
    for (const [depth, base, colour] of [[0.25, 0.9, '#0b0e22'], [0.5, 0.945, '#05060f']]) {
      g.fillStyle = colour;
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W + 24; x += 24) {
        const wx = x + pan * depth;
        g.lineTo(x, H * base - 12 * Math.sin(wx * 0.006) - 7 * Math.sin(wx * 0.017 + 2) - 4 * Math.sin(wx * 0.041));
      }
      g.lineTo(W, H);
      g.fill();
    }
  }

  function shooting(t) {
    const k = (t - shoot.at) / 0.9;
    if (k >= 1) { shoot = null; return; }
    const x = shoot.x + k * shoot.dx, y = shoot.y + k * shoot.dy, a = Math.sin(k * Math.PI);
    const tail = g.createLinearGradient(x, y, x - shoot.dx * 0.28, y - shoot.dy * 0.28);
    tail.addColorStop(0, `rgba(255,255,255,${0.85 * a})`);
    tail.addColorStop(1, 'rgba(255,255,255,0)');
    g.strokeStyle = tail;
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x - shoot.dx * 0.28, y - shoot.dy * 0.28);
    g.stroke();
  }

  function flyLight(now) {
    const a = audio(), n = nights[play.ni];
    if (!a || !n) return stop();
    const el = a.currentTime - play.t0, notes = play.notes;
    // Ring what is due (asked for a little ahead, on the audio clock, so the rhythm is exact).
    while (play.next < notes.length && notes[play.next].at <= el + 0.12) {
      const note = notes[play.next], s = n.stars[note.i];
      ring(noteOf(s, n), play.t0 + note.at, 0.55 + Math.min(0.45, s.size * 0.16), s.kind === 'typed');
      // The small stars passed on the way glint, an octave up and very quietly.
      const from = play.next ? notes[play.next - 1].i : -1;
      for (let i = from + 1, k = 0; i < note.i && k < 3; i++, k++) ring(noteOf(n.stars[i], n) + 12, play.t0 + note.at - 0.05 * (k + 1), 0.1, true);
      setTimeout(() => { if (play && play.ni !== undefined && nights[play.ni] === n) { play.rung.set(note.i, performance.now()); play.lit.add(note.i); } }, Math.max(0, (play.t0 + note.at - a.currentTime) * 1000));
      play.next++;
    }
    // Where the light is: between the last star rung and the next.
    let k = 0;
    while (k < notes.length - 1 && notes[k + 1].at <= el) k++;
    const A = at(play.ni, n.stars[notes[k].i]), nxt = notes[Math.min(notes.length - 1, k + 1)], B = at(play.ni, n.stars[nxt.i]);
    const span = Math.max(0.001, nxt.at - notes[k].at), u = Math.max(0, Math.min(1, (el - notes[k].at) / span)), e = u * u * (3 - 2 * u);
    const x = A.x + (B.x - A.x) * e, y = A.y + (B.y - A.y) * e - Math.sin(e * Math.PI) * Math.min(26, Math.hypot(B.x - A.x, B.y - A.y) * 0.18);
    play.trail.push({ x: x + pan, y, at: now });
    while (play.trail.length && now - play.trail[0].at > 520) play.trail.shift();
    for (const p of play.trail) {
      const f = 1 - (now - p.at) / 520;
      g.globalAlpha = f * 0.5;
      g.drawImage(glow.said, p.x - pan - 7 * f, p.y - 7 * f, 14 * f, 14 * f);
    }
    g.globalAlpha = 1;
    g.drawImage(glow.said, x - 15, y - 15, 30, 30);
    // Walk along with the light when it nears an edge.
    if (!drag && (x > W - 120 || x < 120)) pan = clampPan(pan + (x > W - 120 ? x - (W - 120) : x - 120) * 0.08);
    if (el > notes[notes.length - 1].at + 2.2) stop();
  }

  /* ---------- playing ---------- */
  function start(ni) {
    const a = audio(), n = nights[ni];
    if (!a || !n || !n.stars.length) return;
    a.resume?.();
    const notes = tune(n);
    if (!notes.length) return;
    play = { ni, notes, t0: a.currentTime + 0.25, next: 0, rung: new Map(), lit: new Set(), trail: [] };
    hum(n, notes[notes.length - 1].at + 1);
    root.dispatchEvent(new CustomEvent('sky-play', { detail: { day: n.day, name: n.name } }));
  }
  function stop() {
    play = null;
    stopHum();
  }

  /* ---------- the loop ---------- */
  function frame(now) {
    raf = 0;
    if (!open) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (!drag && Math.abs(vel) > 4) {
      pan = clampPan(pan + vel * dt);
      vel *= 0.94;
    }
    const t = now / 1000;
    if (!calm() && !shoot && t > nextShoot) {
      shoot = { at: t, x: W * (0.15 + Math.random() * 0.6), y: H * (0.06 + Math.random() * 0.2), dx: 180 + Math.random() * 160, dy: 60 + Math.random() * 60 };
      nextShoot = t + 14 + Math.random() * 22;
    }
    draw(now);
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (open && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };

  /* ---------- the mouse ---------- */
  const where = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  canvas.addEventListener('pointerdown', (e) => {
    const p = where(e);
    drag = { x: p.x, pan, moved: 0, at: performance.now(), lastX: p.x, lastAt: performance.now() };
    vel = 0;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = where(e);
    if (drag) {
      const nowT = performance.now();
      drag.moved = Math.max(drag.moved, Math.abs(p.x - drag.x));
      pan = clampPan(drag.pan - (p.x - drag.x));
      vel = -(p.x - drag.lastX) / Math.max(0.008, (nowT - drag.lastAt) / 1000) * 0.6;
      drag.lastX = p.x;
      drag.lastAt = nowT;
      showTip(null);
      return;
    }
    const s = starAt(p.x, p.y), ti = s ? -1 : titleAt(p.x, p.y);
    hover = s ? { ni: s.ni, si: s.si } : ti >= 0 ? { title: ti, ni: ti } : null;
    canvas.style.cursor = s || ti >= 0 ? 'pointer' : 'grab';
    showTip(s, p);
  });
  canvas.addEventListener('pointerup', (e) => {
    const p = where(e), was = drag;
    drag = null;
    showTip(null);
    if (!was || was.moved > 5) return;
    vel = 0;
    const s = starAt(p.x, p.y);
    if (s) {
      const n = nights[s.ni], star = n.stars[s.si];
      audio()?.resume?.();
      ring(noteOf(star, n), 0, 0.9, star.kind === 'typed');
      ripple = { ni: s.ni, si: s.si, at: performance.now() };
      return;
    }
    const ti = titleAt(p.x, p.y);
    if (ti >= 0) (play && play.ni === ti ? stop() : (stop(), start(ti)));
  });
  canvas.addEventListener('pointerleave', () => { hover = null; showTip(null); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    pan = clampPan(pan + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
    vel = 0;
    showTip(null);
  }, { passive: false });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { vel = (e.key === 'ArrowLeft' ? -1 : 1) * 900; e.preventDefault(); }
    if (e.key === ' ' && nights.length) { e.preventDefault(); play ? stop() : start(nearest()); }
  });
  /** The night nearest the middle of the window. */
  function nearest() {
    let best = 0, d = Infinity;
    nights.forEach((_, ni) => { const m = Math.abs(lay.x[ni] + lay.w[ni] / 2 - pan - W / 2); if (m < d) { d = m; best = ni; } });
    return best;
  }

  function showTip(s, p) {
    if (!s) { tip.hidden = true; return; }
    const n = nights[s.ni], star = n.stars[s.si];
    const did = star.acted ? 'Echo did something on your Mac' : star.tools ? 'Echo looked something up' : '';
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'sky-tip-time';
    head.textContent = `${clock(star.t)} · ${star.kind === 'typed' ? 'typed' : 'said'}`;
    tip.append(head);
    if (star.said) {
      const q = document.createElement('div');
      q.className = 'sky-tip-said';
      q.textContent = `“${star.said}”`;
      tip.append(q);
    } else if (!words) {
      const q = document.createElement('div');
      q.className = 'sky-tip-note';
      q.textContent = 'Turn on “Keep a conversation log” to see what you said here.';
      tip.append(q);
    }
    if (did) {
      const d = document.createElement('div');
      d.className = 'sky-tip-note';
      d.textContent = did;
      tip.append(d);
    }
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.max(8, Math.min(W - tw - 8, p.x - tw / 2))}px`;
    tip.style.top = `${p.y - th - 18 < 8 ? p.y + 20 : p.y - th - 18}px`;
  }

  /* ---------- the nights ---------- */
  async function load({ first = false } = {}) {
    let data;
    try { data = await fetchSky(); } catch { return; }
    if (!data || !Array.isArray(data.nights)) return;
    const before = new Map(nights.map((n) => [n.day, new Set(n.stars.map((s) => s.trace))]));
    const hadAny = loaded;
    nights = data.nights;
    today = data.today || '';
    words = data.words === true;
    lay = layout(nights);
    empty.hidden = nights.length > 0;
    // Stars that were not there a moment ago fall in.
    if (hadAny) for (const n of nights) for (const s of n.stars) if (!before.get(n.day)?.has(s.trace)) born.set(`${n.day}/${s.trace}`, performance.now());
    if (first || !loaded) pan = nights.length ? centre(nights.length - 1) : 0;
    loaded = true;
    if (play && !nights[play.ni]) stop();
    kick();
  }

  const ro = new ResizeObserver(() => { if (open) { resize(); kick(); } });
  ro.observe(root);

  return {
    /** The pane was opened: draw, and fetch the nights (again). */
    show() {
      open = true;
      resize();
      load({ first: !loaded });
      kick();
    },
    hide() {
      open = false;
      stop();
      showTip(null);
    },
    /** Something was just said: today's constellation may have a new star. */
    refresh() { if (open) load(); },
    /** Go to today, and play it if asked. */
    today({ play: go = false } = {}) {
      if (!nights.length) return;
      pan = centre(nights.length - 1);
      vel = 0;
      if (go) { stop(); start(nights.length - 1); }
      kick();
    },
    get playing() { return Boolean(play); },
    get nights() { return nights; },
  };
}
