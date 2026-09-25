// Karaoke: highlights the words of Echo's reply in step with her voice.
//
// Each spoken sentence ("chunk") is wrapped into word spans inside its chat bubble. While the
// chunk plays, the word being said glows, words already said settle to normal text, and words
// still to come stay dimmed. Timing comes from the best source available:
//   - ElevenLabs: real per-character timestamps (grouped into words on the server).
//   - Browser voice: the speech engine's word-boundary events.
//   - Kokoro (and anything else): an estimate from word length, syllables and punctuation pauses,
//     scaled to the real audio length with the leading and trailing silence trimmed off.
// Only classes change (color, opacity, shadow in CSS), so the text never reflows.
//
// The pure helpers at the top have no DOM access, so they're unit-tested in Node.

/** @typedef {{ word: string, start: number, end: number }} Token  char offsets into the text */
/** @typedef {{ s: number, e: number }} Span  seconds from the start of the audio */

/** Words (runs of non-space) with their char offsets. @returns {Token[]} */
export function tokenize(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\S+/g)) out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

/** A rough syllable count, good enough to weight how long a word takes to say. */
export function syllables(word) {
  const w = String(word).toLowerCase();
  const digits = (w.match(/\d/g) || []).length;
  const letters = w.replace(/[^a-z]/g, '');
  if (!letters) return Math.max(1, Math.round(digits * 1.3));
  // Acronyms (API, NJ) are spelled out letter by letter.
  const raw = String(word).replace(/[^A-Za-z]/g, '');
  if (raw.length >= 2 && raw.length <= 5 && raw === raw.toUpperCase()) return raw.length + Math.round(digits * 1.3);
  let n = (letters.match(/[aeiouy]+/g) || []).length;
  if (/[^aeiouy]e$/.test(letters) && !/[^aeiouy]le$/.test(letters) && n > 1) n--; // silent e
  return Math.max(1, n) + Math.round(digits * 1.3);
}

/** How long the pause after a word is, in the same units as a syllable. */
export function pauseAfter(word) {
  if (/(\.\.\.|…)["')\]]?$/.test(word)) return 2;
  if (/[.!?]["')\]]?$/.test(word)) return 2.2;
  if (/[,;:]["')\]]?$/.test(word)) return 1.3;
  if (/[—–-]$/.test(word)) return 1;
  return 0;
}

/**
 * Estimated word timings for `text` spoken over `duration` seconds, with `lead` seconds of
 * silence before the first word and `tail` after the last. @returns {Span[]}
 */
export function estimateTimings(text, duration, { lead = 0, tail = 0 } = {}) {
  const words = tokenize(text);
  if (!words.length || !(duration > 0)) return [];
  const speak = words.map(({ word }) => 0.45 + syllables(word) + Math.min(word.length, 18) * 0.03);
  const pause = words.map(({ word }, i) => (i < words.length - 1 ? pauseAfter(word) : 0));
  const units = speak.reduce((a, b) => a + b, 0) + pause.reduce((a, b) => a + b, 0);
  const span = Math.max(0.05, duration - lead - tail);
  const k = span / units;
  const out = [];
  let t = Math.min(lead, duration);
  for (let i = 0; i < words.length; i++) {
    const s = t;
    t += speak[i] * k;
    out.push({ s, e: t });
    t += pause[i] * k;
  }
  return out;
}

/**
 * Where the speech starts and ends inside an audio clip, so the estimate isn't thrown off by
 * the silence engines pad clips with. @param {Float32Array} samples
 */
export function speechBounds(samples, sampleRate, threshold = 0.02) {
  const n = samples?.length || 0;
  if (!n || !sampleRate) return { lead: 0, tail: 0 };
  const win = Math.max(1, Math.round(sampleRate * 0.01)); // 10 ms windows
  const loud = (from) => {
    let peak = 0;
    for (let i = from; i < Math.min(n, from + win); i++) peak = Math.max(peak, Math.abs(samples[i]));
    return peak >= threshold;
  };
  let a = 0;
  while (a < n && !loud(a)) a += win;
  if (a >= n) return { lead: 0, tail: 0 };
  let b = n - win;
  while (b > a && !loud(b)) b -= win;
  const lead = Math.max(0, a / sampleRate - 0.02);
  const tail = Math.max(0, (n - (b + win)) / sampleRate - 0.02);
  return { lead, tail };
}

const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Map real spoken-word timings onto the words shown in the bubble. The spoken text can differ a
 * little (markdown stripped, a URL read as "a link"), so words are matched in order and any
 * unmatched words get times interpolated between their neighbours. Returns null when the two
 * don't line up well enough to trust. @returns {Span[] | null}
 */
export function alignTimings(text, spoken) {
  const words = tokenize(text);
  if (!words.length || !spoken?.length) return null;
  const times = new Array(words.length).fill(null);
  let j = 0;
  let matched = 0;
  for (let i = 0; i < words.length && j < spoken.length; i++) {
    const w = norm(words[i].word);
    if (!w) continue;
    for (let k = j; k < Math.min(spoken.length, j + 4); k++) {
      if (norm(spoken[k].w) === w) {
        times[i] = { s: spoken[k].s, e: spoken[k].e };
        j = k + 1;
        matched++;
        break;
      }
    }
  }
  if (matched < Math.max(1, words.length * 0.5)) return null;
  // Fill the gaps between matched words.
  const first = spoken[0].s, last = spoken[spoken.length - 1].e;
  for (let i = 0; i < words.length; i++) {
    if (times[i]) continue;
    let a = i;
    while (a > 0 && !times[a - 1]) a--;
    let b = i;
    while (b < words.length && !times[b]) b++;
    const from = a > 0 ? times[a - 1].e : first;
    const to = b < words.length ? times[b].s : last;
    const step = Math.max(0, to - from) / (b - a);
    for (let x = a; x < b; x++) times[x] = { s: from + step * (x - a), e: from + step * (x - a + 1) };
  }
  return times;
}

/** Index of the word being said at time t (-1 before the first word). */
export function wordAt(times, t) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Index of the word containing (or just before) char offset `at`, for browser boundary events. */
export function wordAtChar(tokens, at) {
  let ans = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].start <= at) ans = i;
    else break;
  }
  return ans;
}

/* ---------- DOM ---------- */

/**
 * @param {{ now: () => number }} opts  `now` is the audio clock in seconds (AudioContext time).
 */
export function createKaraoke({ now }) {
  const live = new Set(); // bubbles currently in karaoke mode
  const pending = new WeakMap(); // bubble -> chunks not yet finished
  const open = new WeakSet(); // bubbles still streaming text
  let active = null; // the chunk playing now
  let raf = 0;

  /** The unbound rest of a bubble's text lives in a trailing span, so it can be dimmed. */
  function tailOf(el) {
    const last = el.lastElementChild;
    if (last?.classList.contains('k-tail')) return last;
    if (el.children.length) return null; // rich content we didn't build; leave it alone
    const tail = document.createElement('span');
    tail.className = 'k-tail';
    tail.textContent = el.textContent;
    el.textContent = '';
    el.append(tail);
    return tail;
  }

  /** Append streamed text to a bubble. */
  function append(el, text) {
    const tail = tailOf(el);
    if (tail) tail.textContent += text;
    else el.append(text);
  }

  /** Mark a bubble as still streaming, so it stays in karaoke mode between sentences. */
  function hold(el) { open.add(el); }

  /** The bubble's text is complete. */
  function release(el) {
    if (!el) return;
    open.delete(el);
    if (!pending.get(el)) settle(el);
  }

  function settle(el) {
    el.classList.remove('k-live');
    live.delete(el);
  }

  /** Wrap one sentence of a bubble into word spans. Returns a chunk, or null if it isn't there. */
  function bind(el, text) {
    if (!el || !text) return null;
    const tail = tailOf(el);
    const full = tail?.textContent || '';
    const at = full.indexOf(text);
    if (!tail || at < 0) return null;
    const node = document.createElement('span');
    node.className = 'k-chunk';
    const tokens = tokenize(text);
    const spans = [];
    let pos = 0;
    for (const t of tokens) {
      if (t.start > pos) node.append(text.slice(pos, t.start));
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = t.word;
      node.append(w);
      spans.push(w);
      pos = t.end;
    }
    if (pos < text.length) node.append(text.slice(pos));
    if (at > 0) tail.before(full.slice(0, at));
    tail.before(node);
    tail.textContent = full.slice(at + text.length);
    el.classList.add('k-live');
    live.add(el);
    pending.set(el, (pending.get(el) || 0) + 1);
    return { el, text, tokens, spans, cur: -1, said: 0, times: null, start: 0, done: false };
  }

  /** Move the highlight to word `idx`, touching only the spans that change. */
  function moveTo(chunk, idx) {
    if (idx === chunk.cur || idx < -1) return;
    const { spans } = chunk;
    if (chunk.cur >= 0) spans[chunk.cur]?.classList.remove('now');
    for (; chunk.said < Math.min(idx, spans.length); chunk.said++) spans[chunk.said].classList.add('said');
    if (idx >= 0 && idx < spans.length) spans[idx].classList.add('now');
    chunk.cur = idx;
  }

  function tick() {
    raf = 0;
    if (!active || !active.times) return;
    const i = wordAt(active.times, now() - active.start);
    moveTo(active, Math.min(i, active.spans.length - 1));
    raf = requestAnimationFrame(tick);
  }

  /**
   * Start highlighting a chunk against the audio clock.
   * @param {any} chunk
   * @param {{ start: number, duration: number, times?: Span[] | null, bounds?: { lead: number, tail: number } }} o
   */
  function play(chunk, { start, duration, times = null, bounds = undefined }) {
    if (!chunk || chunk.done) return;
    chunk.times = times?.length === chunk.spans.length ? times : estimateTimings(chunk.text, duration, bounds);
    chunk.start = start;
    active = chunk;
    if (!raf) raf = requestAnimationFrame(tick);
  }

  /** Browser voice: jump straight to the word at a char offset from a boundary event. */
  function boundary(chunk, charIndex) {
    if (!chunk || chunk.done) return;
    active = chunk;
    moveTo(chunk, wordAtChar(chunk.tokens, charIndex));
  }

  /** The chunk finished (or was skipped): all its words become normal text. */
  function finish(chunk) {
    if (!chunk || chunk.done) return;
    chunk.done = true;
    moveTo(chunk, chunk.spans.length);
    if (active === chunk) active = null;
    const left = (pending.get(chunk.el) || 1) - 1;
    pending.set(chunk.el, left);
    if (!left && !open.has(chunk.el)) settle(chunk.el);
  }

  /** Barge-in or stop: everything is instantly normal text. */
  function stopAll() {
    active = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    for (const el of live) {
      el.querySelectorAll('.w.now').forEach((w) => w.classList.remove('now'));
      el.querySelectorAll('.w:not(.said)').forEach((w) => w.classList.add('said'));
      pending.delete(el);
      settle(el);
    }
  }

  return { append, hold, release, bind, play, boundary, finish, stopAll };
}
