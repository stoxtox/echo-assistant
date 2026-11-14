// The live caption under the voice: what you're saying, as you say it, in a slim graphite pill
// (the same look as the Mac app's caption pill). At most two lines: the newest words are brightest,
// older ones dim, and once the words fill both lines the oldest scroll up and fade out under the
// top edge. Short notes ("Didn't catch that") use the same spot but never share it with your
// words: a note only shows while there's no caption, and fades out by itself.
//
// The pure helpers (which words are new, how bright each one is, whether a turn was truly empty)
// are exported for test/livecaption.test.js; createLiveCaption does the DOM.

/** Words at full brightness at the end of the line. */
export const CAPTION_BRIGHT_WORDS = 4;
/** The dimmest an older word gets before it scrolls away. */
export const CAPTION_MIN_ALPHA = 0.42;
/** How long a note ("Didn't catch that") stays before it fades. */
export const NOTE_MS = 2600;
/** The caption's line height (style.css .live-words). */
const LINE_PX = 19;

/** How many push-to-talk turns show the "release Space to send" hint. */
export const PTT_HINT_USES = 3;
/** @param {unknown} uses how many push-to-talk turns you've had */
export const showPttHint = (uses) => !(Number(uses) >= PTT_HINT_USES);

/** @param {unknown} text */
export const wordsOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * How bright a word is, by how far it is from the newest (0 = the newest word).
 * @param {number} fromEnd
 */
export function wordAlpha(fromEnd) {
  if (fromEnd < CAPTION_BRIGHT_WORDS) return 1;
  return Math.max(CAPTION_MIN_ALPHA, +(1 - (fromEnd - CAPTION_BRIGHT_WORDS + 1) * 0.08).toFixed(2));
}

/**
 * How many words at the start of `next` are the same as in `prev`: those stay put, the rest are
 * new (they fade in). The live listener often rewrites its last guess, so only a shared start counts.
 * @param {string[]} prev @param {string[]} next
 */
export function sharedStart(prev, next) {
  let i = 0;
  while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
  return i;
}

/**
 * The caption's words: each with its brightness, and whether it's new since the last update.
 * @param {string[]} prev @param {unknown} text
 * @returns {Array<{ word: string, alpha: number, fresh: boolean }>}
 */
export function captionWords(prev, text) {
  const next = wordsOf(text);
  const keep = sharedStart(prev, next);
  return next.map((word, i) => ({ word, alpha: wordAlpha(next.length - 1 - i), fresh: i >= keep }));
}

/**
 * Was a turn truly empty? Only then does Echo say she didn't catch it: never when the live
 * listener showed your words, or the transcription came back with any.
 * @param {{ live?: unknown, heard?: unknown }} o
 */
export function trulyEmpty({ live = '', heard = '' } = {}) {
  const blank = (t) => !/[\p{L}\p{N}]/u.test(String(t || ''));
  return blank(live) && blank(heard);
}

/**
 * The DOM side. `el` holds two layers that crossfade in the same spot: the caption and the note.
 * @param {HTMLElement} el
 * @param {{ reducedMotion?: MediaQueryList | null, onChange?: () => void }} [opts]
 */
export function createLiveCaption(el, { reducedMotion = matchMedia('(prefers-reduced-motion: reduce)'), onChange = () => {} } = {}) {
  const words = /** @type {HTMLElement} */ (el.querySelector('.live-words'));
  const note = /** @type {HTMLElement} */ (el.querySelector('.live-note'));
  /** @type {string[]} */
  let shown = [];
  let text = '';
  /** @type {any} */
  let noteTimer = 0;
  /** @type {any} */
  let clearTimer = 0;

  function mode() {
    const m = text ? 'caption' : note.textContent ? 'note' : '';
    if (el.dataset.mode !== m) {
      el.dataset.mode = m;
      onChange();
    }
  }

  /**
   * The words sit on the pill's bottom edge and grow upwards; the oldest line slides up under the
   * faded top and out. A new line eases in (FLIP) instead of jumping, and the pill hugs the text.
   * @param {number} before the words' height before this update
   */
  function settle(before) {
    el.dataset.lines = words.offsetHeight > LINE_PX * 1.5 ? '2' : '1';
    el.style.setProperty('--cap-w', `${Math.ceil(words.offsetWidth)}px`);
    const rise = words.offsetHeight - before;
    if (reducedMotion?.matches || rise <= 0 || !before) return;
    words.style.transition = 'none';
    words.style.transform = `translateY(${rise}px)`;
    void words.offsetHeight; // commit the start position before easing to the new one
    words.style.transition = '';
    words.style.transform = '';
  }

  /** Show what you're saying (empty clears it). @param {unknown} next */
  function set(next) {
    const t = String(next || '').replace(/\s+/g, ' ').trim();
    if (t === text) return;
    clearTimeout(clearTimer);
    el.classList.remove('leaving');
    if (!t) return clear();
    // Your words take the spot: a note gives way at once.
    if (note.textContent) hideNote();
    const before = words.offsetHeight;
    const list = captionWords(shown, t);
    const keep = list.findIndex((w) => w.fresh);
    const nodes = /** @type {HTMLElement[]} */ ([...words.children]);
    // Words that stay keep their element (no flicker); the rest are replaced.
    for (let i = nodes.length - 1; i >= (keep < 0 ? list.length : keep); i--) nodes[i].remove();
    list.forEach((w, i) => {
      let span = /** @type {HTMLElement | undefined} */ (words.children[i]);
      if (!span) {
        span = document.createElement('span');
        span.className = 'w fresh';
        span.textContent = w.word + ' '; // the space inside, so lines break between words
        words.append(span);
      }
      span.style.opacity = String(w.alpha);
    });
    shown = list.map((w) => w.word);
    text = t;
    mode();
    settle(before);
  }

  /** Let the caption go: it fades out, then empties. @param {{ now?: boolean }} [o] */
  function clear({ now = false } = {}) {
    clearTimeout(clearTimer);
    if (!text && !words.children.length) return;
    text = '';
    const empty = () => {
      el.classList.remove('leaving');
      if (text) return;
      shown = [];
      words.replaceChildren();
      words.style.transform = '';
      el.dataset.lines = '';
    };
    if (now || reducedMotion?.matches) empty();
    else {
      el.classList.add('leaving');
      clearTimer = setTimeout(empty, 380);
    }
    mode();
  }

  function hideNote() {
    clearTimeout(noteTimer);
    note.classList.remove('on');
    noteTimer = setTimeout(() => { note.textContent = ''; mode(); }, reducedMotion?.matches ? 0 : 420);
  }

  /**
   * A short note in the caption's spot. Never over your words: while a caption shows, it's
   * skipped (returns false). @param {string} msg @param {number} [ms]
   */
  function showNote(msg, ms = NOTE_MS) {
    if (text) return false;
    clearTimeout(noteTimer);
    note.textContent = msg;
    mode();
    void note.offsetHeight;
    note.classList.add('on');
    noteTimer = setTimeout(hideNote, ms);
    return true;
  }

  el.dataset.mode = '';
  return {
    set,
    clear,
    note: showNote,
    /** What the caption shows now. */
    get text() { return text; },
  };
}
