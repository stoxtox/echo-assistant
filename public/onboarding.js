// Echo's first-run setup: a warm, plain-spoken walk-through in a full-window card.
//
//   import { createWizard } from '/onboarding.js';
//   const wizard = createWizard({ applySettings, speak, setHandsFree, handsFree, useExample, onFinish, hush });
//   wizard.open('welcome', { canClose: false });   // or any id in STEPS
//   wizard.open('files', { single: true });         // just one step, then close (Settings > Change…)
//
// Each step saves as it goes (POST /api/onboarding); the last one sends finish: true. The pure
// helpers at the top (examples, suggestions, paths, PIN checks) have no DOM and are tested in
// test/onboarding-ui.test.js.

export const STEPS = /** @type {const} */ (['welcome', 'name', 'help', 'files', 'voice', 'talking', 'pin', 'permissions', 'tour']);

/** Short, friendly descriptions for the interest cards (titles come from the server). */
export const INTEREST_INFO = {
  errands: { title: 'Everyday errands', blurb: 'Texts, calendar events and little jobs on your Mac' },
  research: { title: 'Questions and research', blurb: 'Answers, explanations and recommendations' },
  documents: { title: 'Spreadsheets, Excel and documents', blurb: 'Budgets, lists, reports and Excel files' },
  apps: { title: 'Building apps and websites', blurb: 'Simple websites and handy little apps' },
};

/** Things to say, by interest. Generic on purpose: no real people or places. */
export const EXAMPLES = {
  errands: ["Text Sam I'm running ten minutes late", 'Add dentist on Tuesday at 3 to my calendar'],
  research: ["What's a good dinner spot near me that's open late?", 'Explain how a Roth IRA works, simply'],
  documents: ['Make me a monthly budget spreadsheet', 'Analyze the sales Excel file in my Downloads'],
  apps: ['Build a simple website for my bakery', 'Make a to-do list app I can open in my browser'],
};

/** Chat suggestions for someone who hasn't said what they want help with. */
export const DEFAULT_SUGGESTIONS = [
  'How are my workers doing?',
  'Make me a monthly budget spreadsheet.',
  'Build a simple website for my bakery.',
];

/** Examples from each list in turn: the first of each, then the second of each, and so on. */
function roundRobin(keys) {
  const out = [];
  const lists = keys.map((k) => (EXAMPLES[k] || []).map((text) => ({ interest: k, text })));
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

/**
 * Tour examples chosen from the person's interests: up to `max`, and at least `min` (topped up
 * from the other interests when they picked only one or none).
 * @param {string[]} interests
 * @returns {{ interest: string, text: string }[]}
 */
export function tourExamples(interests = [], max = 6, min = 4) {
  const all = Object.keys(EXAMPLES);
  const picked = (interests || []).filter((k) => all.includes(k));
  const out = roundRobin(picked.length ? picked : all).slice(0, max);
  if (out.length < min) out.push(...roundRobin(all.filter((k) => !picked.includes(k))).slice(0, min - out.length));
  return out;
}

/**
 * The idea buttons on the empty chat. Tailored from interests when the person set any (or is in
 * beginner mode); otherwise a general set.
 * @param {{ interests?: string[], beginnerMode?: boolean }} settings
 * @returns {string[]}
 */
export function suggestionsFor(settings = {}) {
  const interests = settings.interests || [];
  if (!interests.length && !settings.beginnerMode) return DEFAULT_SUGGESTIONS;
  return tourExamples(interests, 3, 3).map((e) => e.text);
}

/** "/Users/me/Echo Projects" -> "~/Echo Projects" (shown to people; the server expands ~/). */
export function friendlyPath(p, home = '') {
  const s = String(p || '');
  if (!home) return s;
  const base = home.replace(/\/+$/, '');
  if (s === base) return '~';
  if (s.startsWith(base + '/')) return '~/' + s.slice(base.length + 1);
  return s;
}

/** The last folder name in a path, for the little folder preview. */
export const folderName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || 'Echo Projects';

/**
 * Why a new PIN isn't acceptable yet, in plain words; null when it's fine.
 * @param {string} pin @param {string} confirm
 */
export function pinProblem(pin, confirm) {
  const p = String(pin || '');
  if (!p) return 'Type a PIN, or choose "Skip for now".';
  if (!/^\d+$/.test(p)) return 'Use numbers only.';
  if (p.length < 4 || p.length > 10) return 'Use 4 to 10 digits.';
  if (String(confirm || '') !== p) return "The two PINs don't match. Type the same PIN twice.";
  return null;
}

/** "Heart (US, warm)" -> { name: 'Heart', note: 'US, warm' } */
export function splitVoiceName(label) {
  const m = String(label || '').match(/^(.*?)\s*\((.*)\)\s*$/);
  return m ? { name: m[1], note: m[2] } : { name: String(label || ''), note: '' };
}

/** Accents, in plain words. */
export const ACCENTS = [
  ['en-IN', 'Indian English'],
  ['en-US', 'American English'],
  ['en', 'Another English accent'],
];

/* ---------- icons (24px line art in the sunset gradient) ---------- */
const ICONS = {
  errands: '<path d="M5.5 8h13l-1.1 11.2a1.5 1.5 0 0 1-1.5 1.3H8.1a1.5 1.5 0 0 1-1.5-1.3L5.5 8Z"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5"/>',
  research: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15.2 15.2 4.8 4.8"/><path d="M8.2 8.6a3 3 0 0 1 2.3-1.1"/>',
  documents: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M4 9.5h16M4 14.5h16M10 4v16"/>',
  apps: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9h18"/><path d="m10 12.3-2.2 2.2 2.2 2.2M14 12.3l2.2 2.2-2.2 2.2"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  contacts: '<circle cx="12" cy="9" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  messages: '<path d="M4 11.5c0-4 3.6-7 8-7s8 3 8 7-3.6 7-8 7c-1 0-2-.15-2.9-.43L5 19.5l1.1-3.5A6.6 6.6 0 0 1 4 11.5Z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9 4-1.2 7-4.8 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  space: '<rect x="2.5" y="7" width="19" height="10" rx="2.5"/><path d="M7 13h10"/>',
  wave: '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  esc: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>',
  workers: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
  quote: '<path d="M10 7H6.5A1.5 1.5 0 0 0 5 8.5V12h4v5H5M19 7h-3.5A1.5 1.5 0 0 0 14 8.5V12h4v5h-4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14h8"/>',
  sparkle: '<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.9L12 18.5l-1.8-5.8L4.5 10.8 10.2 9 12 3.5Z"/>',
};
const svg = (name, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="url(#sunsetSend)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 5.6v12.8a1 1 0 0 0 1.5.86l10.4-6.4a1 1 0 0 0 0-1.72L9.5 4.74A1 1 0 0 0 8 5.6Z"/></svg>';
const STOP = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ---------- tiny DOM helper ---------- */
/**
 * h('div', { class: 'x', onclick: fn, 'aria-label': 'y' }, 'text', child)
 * @param {string} tag @param {Record<string, any>} [props] @param {...any} kids
 * @returns {any} the element (typed loosely: it may be an input, a select or a button)
 */
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'hidden'].includes(k)) n[k] = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
  return n;
}
const icon = (name, cls = '', size = 22) => h('span', { class: `wiz-ic ${cls}`, 'aria-hidden': 'true', html: svg(name, size) });

const PERMS = [
  { id: 'mic', icon: 'mic', title: 'Microphone', why: 'So I can hear you.', pane: 'microphone' },
  { id: 'contacts', icon: 'contacts', title: 'Contacts', why: 'So you can text people by name, like "Text Sam".', pane: 'contacts' },
  { id: 'messages', icon: 'messages', title: 'Messages', why: 'So I can send texts for you. I always show you the message first.', pane: 'automation' },
  { id: 'calendar', icon: 'calendar', title: 'Calendar', why: 'So I can add events for you.', pane: 'calendars' },
];
const CHIP = { idle: 'Not tested', busy: 'Checking…', ok: 'Works ✓', bad: 'Needs permission' };

/**
 * @param {{
 *   applySettings: (s: any) => void,
 *   speak: (text: string) => void,
 *   setHandsFree: (on: boolean) => void,
 *   handsFree: () => boolean,
 *   useExample: (text: string) => void,
 *   onFinish?: (settings: any) => void,
 *   onClose?: () => void,
 *   hush?: () => void,
 * }} deps
 */
export function createWizard(deps) {
  /** @type {HTMLElement | null} */
  let root = null;
  let els = /** @type {Record<string, any>} */ ({});
  let state = null; // GET /api/onboarding
  let voices = [];
  let idx = 0;
  let single = false;
  let canClose = true;
  let busy = false;
  let answers = {};
  let perm = {};
  let view = null;
  let lastFocus = null;
  /** @type {Array<() => void>} */
  let cleanups = [];
  let audio = null; // the voice preview playing now

  const isOpen = () => Boolean(root);

  async function post(patch) {
    const res = await fetch('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Let's try that again.");
    if (data.settings) {
      state.settings = data.settings;
      deps.applySettings(data.settings);
    }
    if (typeof data.hasPin === 'boolean') state.hasPin = data.hasPin;
    return data;
  }

  /**
   * @param {string} [stepId]
   * @param {{ canClose?: boolean, single?: boolean, state?: any }} [opts]
   */
  async function open(stepId = 'welcome', opts = {}) {
    if (root) close();
    try {
      const [ob, cat] = await Promise.all([
        opts.state ? Promise.resolve(opts.state) : fetch('/api/onboarding').then((r) => r.json()),
        fetch('/api/voices').then((r) => r.json()).catch(() => ({ providers: [] })),
      ]);
      state = ob;
      voices = cat.providers?.find((p) => p.id === 'kokoro')?.voices || [];
    } catch {
      state = { needed: false, settings: {}, interests: {}, hasPin: false, defaults: { projectsDir: '', home: '' } };
    }
    const s = state.settings || {};
    const home = state.defaults?.home || '';
    answers = {
      userName: s.userName || '',
      assistantName: s.assistantName || 'Echo',
      interests: [...(s.interests || [])],
      developer: s.onboarded === false || s.onboarded === undefined ? false : !s.beginnerMode,
      projectsDir: friendlyPath(s.projectsDir || state.defaults?.projectsDir || '', home),
      voice: s.ttsProvider === 'kokoro' && s.voice ? s.voice : 'af_heart',
      speed: Number(s.speed) || 1.05,
      handsFree: Boolean(s.handsFree || deps.handsFree()),
      sttLanguage: s.sttLanguage || 'en-IN',
      pin: '',
      pin2: '',
    };
    perm = Object.fromEntries(PERMS.map((p) => [p.id, { status: 'idle', message: '' }]));
    single = Boolean(opts.single);
    canClose = opts.canClose ?? !state.needed;
    idx = Math.max(0, STEPS.indexOf(/** @type {any} */ (stepId)));
    lastFocus = document.activeElement;
    build();
    render();
  }

  function build() {
    const title = h('span', { class: 'wiz-sr' }, 'Set up Echo');
    els.step = h('div', { class: 'wiz-step', 'aria-live': 'polite' });
    els.orb = h('div', { class: 'wiz-orb', 'aria-hidden': 'true' }, h('i'), h('b'));
    els.back = h('button', { type: 'button', class: 'ghost wiz-back', onclick: () => go(-1) }, 'Back');
    els.next = h('button', { type: 'button', class: 'wiz-next', onclick: () => next() }, 'Continue');
    els.dots = h('div', { class: 'wiz-dots', role: 'img' }, STEPS.map(() => h('i')));
    els.close = h('button', { type: 'button', class: 'wiz-close icon-btn', 'aria-label': 'Close setup', title: 'Close', onclick: () => close() },
      h('span', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' }));
    els.close.hidden = !canClose;
    els.scroll = h('div', { class: 'wiz-scroll' }, els.orb, els.step);
    els.card = h('div', { class: 'wiz-card' }, els.close, els.scroll, h('div', { class: 'wiz-foot' }, els.back, els.dots, els.next));
    root = h('div', { class: 'wiz', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wizTitle' },
      h('div', { class: 'wiz-sky', 'aria-hidden': 'true' }, h('i', { class: 's1' }), h('i', { class: 's2' }), h('i', { class: 's3' })),
      title, els.card);
    root.addEventListener('keydown', onKey);
    document.body.append(root);
    document.body.classList.add('wiz-open');
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (audio) return stopPreview();
      if (canClose) close();
      return;
    }
    if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
      const t = /** @type {HTMLElement} */ (e.target);
      if (['BUTTON', 'TEXTAREA', 'SELECT', 'A'].includes(t.tagName)) return; // the focused control acts
      if (t.tagName === 'INPUT' && ['checkbox', 'radio', 'range'].includes(/** @type {HTMLInputElement} */ (t).type)) return;
      e.preventDefault();
      next();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the wizard.
      const f = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')])
        .filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  function runCleanups() {
    for (const fn of cleanups.splice(0)) try { fn(); } catch {}
  }

  function close() {
    if (!root) return;
    runCleanups();
    stopPreview();
    root.remove();
    root = null;
    document.body.classList.remove('wiz-open');
    /** @type {HTMLElement} */ (lastFocus)?.focus?.();
    deps.onClose?.();
  }

  function go(delta) {
    const to = idx + delta;
    if (to < 0 || to >= STEPS.length) return;
    idx = to;
    render();
  }

  async function next() {
    if (busy || !view) return;
    const label = els.next.textContent;
    busy = true;
    els.next.disabled = true;
    const slow = setTimeout(() => { els.next.textContent = 'Saving…'; }, 350);
    let ok = false;
    try {
      ok = view.save ? (await view.save()) !== false : true;
    } catch (e) {
      view.error?.(e.message);
    } finally {
      clearTimeout(slow);
      busy = false;
      if (root) {
        els.next.disabled = false;
        els.next.textContent = label;
      }
    }
    if (!ok || !root) return;
    if (single) { close(); return; }
    if (idx < STEPS.length - 1) go(1);
  }

  function render() {
    runCleanups();
    stopPreview();
    const id = STEPS[idx];
    view = VIEWS[id]();
    els.step.replaceChildren(...view.nodes.filter(Boolean));
    els.step.dataset.step = id;
    els.card.dataset.step = id;
    els.step.classList.remove('enter');
    void els.step.offsetWidth; // restart the entrance animation
    els.step.classList.add('enter');
    els.orb.classList.toggle('big', id === 'welcome' || id === 'tour');
    els.back.style.visibility = idx === 0 || single ? 'hidden' : '';
    els.dots.hidden = single;
    els.next.textContent = single ? 'Save' : view.next || 'Continue';
    [...els.dots.children].forEach((d, i) => { d.className = i === idx ? 'on' : i < idx ? 'done' : ''; });
    els.dots.setAttribute('aria-label', `Step ${idx + 1} of ${STEPS.length}`);
    els.scroll.scrollTop = 0;
    const focus = view.focus || els.step.querySelector('h1');
    requestAnimationFrame(() => focus?.focus({ preventScroll: true }));
  }

  /* ---------- building blocks ---------- */
  const heading = (text, eyebrow) => [
    eyebrow ? h('div', { class: 'wiz-eyebrow' }, eyebrow) : null,
    h('h1', { id: 'wizTitle', tabindex: '-1' }, text),
  ];
  const lead = (text) => h('p', { class: 'wiz-lead' }, text);
  const errorLine = () => h('p', { class: 'wiz-err', role: 'alert' });
  const stepLabel = () => (single ? '' : `Step ${idx + 1} of ${STEPS.length}`);
  const aName = () => (answers.assistantName || 'Echo').trim() || 'Echo';

  /* ---------- steps ---------- */
  const VIEWS = {
    welcome() {
      return {
        next: "Let's begin",
        nodes: [
          ...heading(`Hi, I'm ${aName()}`),
          lead("You talk to me the way you'd talk to a friend, and I get things done. I can run errands on your Mac, answer questions, and make spreadsheets, documents and simple websites for you."),
          h('div', { class: 'wiz-note' }, icon('sparkle', 'wiz-note-ic', 18),
            h('span', {}, 'I run on your own Claude subscription, so I work through the account you already have.')),
          h('p', { class: 'wiz-soft' }, "Let's get you set up. It takes about two minutes."),
        ],
      };
    },

    name() {
      const err = errorLine();
      const you = h('input', { class: 'wiz-input', id: 'wizUser', maxlength: '40', autocomplete: 'given-name', placeholder: 'Your first name', value: answers.userName, spellcheck: 'false' });
      you.addEventListener('input', () => { answers.userName = you.value; });
      const me = h('input', { class: 'wiz-input small', id: 'wizAssistant', maxlength: '24', value: answers.assistantName, spellcheck: 'false' });
      me.addEventListener('input', () => { answers.assistantName = me.value; });
      return {
        focus: you,
        error: (m) => { err.textContent = m; },
        save: async () => {
          await post({ userName: answers.userName.trim(), assistantName: aName() });
          return true;
        },
        nodes: [
          ...heading('What should I call you?', stepLabel()),
          lead("Just your first name is fine. I'll use it when I greet you."),
          h('label', { class: 'wiz-label', for: 'wizUser' }, 'Your name'), you,
          h('div', { class: 'wiz-aside' },
            h('label', { for: 'wizAssistant' }, h('strong', {}, 'My name'), h('span', {}, 'Prefer to call me something else? Change it here.')),
            me),
          err,
        ],
      };
    },

    help() {
      const err = errorLine();
      const labels = state.interests && Object.keys(state.interests).length ? state.interests : Object.fromEntries(Object.entries(INTEREST_INFO).map(([k, v]) => [k, v.title]));
      const cards = Object.keys(labels).map((k) => {
        const on = () => answers.interests.includes(k);
        const b = h('button', { type: 'button', class: `wiz-choice${on() ? ' on' : ''}`, 'aria-pressed': String(on()) },
          icon(k, 'wiz-choice-ic', 22),
          h('span', { class: 'wiz-choice-text' }, h('strong', {}, labels[k]), h('span', {}, INTEREST_INFO[k]?.blurb || '')),
          h('span', { class: 'wiz-tick', 'aria-hidden': 'true', html: CHECK }));
        b.onclick = () => {
          answers.interests = on() ? answers.interests.filter((x) => x !== k) : [...answers.interests, k];
          b.classList.toggle('on', on());
          b.setAttribute('aria-pressed', String(on()));
        };
        return b;
      });
      const hint = h('p', { class: 'wiz-hint' });
      const opts = [[false, 'Not really'], [true, "Yes, I'm a developer"]].map(([dev, label]) => {
        const b = h('button', { type: 'button', role: 'radio', class: 'wiz-seg' }, label);
        b.onclick = () => { answers.developer = dev; sync(); };
        b.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            answers.developer = !answers.developer;
            sync();
            opts[answers.developer ? 1 : 0].b.focus();
          }
        });
        return { dev, b };
      });
      const sync = () => {
        for (const o of opts) {
          const on = o.dev === answers.developer;
          o.b.classList.toggle('on', on);
          o.b.setAttribute('aria-checked', String(on));
          o.b.tabIndex = on ? 0 : -1;
        }
        hint.textContent = answers.developer
          ? "Great. I'll talk more technically and ask you less often. You can change this in Settings."
          : "No problem. I'll use plain language, suggest things to try, and double-check with you before anything risky, like deleting files or sending a message. That's beginner mode.";
      };
      sync();
      return {
        error: (m) => { err.textContent = m; },
        save: async () => {
          await post({ interests: answers.interests, developer: answers.developer });
          return true;
        },
        nodes: [
          ...heading('What would you like help with?', stepLabel()),
          lead('Pick as many as you like. It helps me suggest good things to try.'),
          h('div', { class: 'wiz-choices', role: 'group', 'aria-label': 'What you want help with' }, cards),
          h('div', { class: 'wiz-q', id: 'wizDevQ' }, 'Have you written code before?'),
          h('div', { class: 'wiz-segs', role: 'radiogroup', 'aria-labelledby': 'wizDevQ' }, opts.map((o) => o.b)),
          hint,
          err,
        ],
      };
    },

    files() {
      const err = errorLine();
      const usual = friendlyPath(state.defaults?.projectsDir || '', state.defaults?.home || '') || '~/Echo Projects';
      const input = h('input', { class: 'wiz-input mono', id: 'wizFolder', value: answers.projectsDir || usual, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'wizFolderHint' });
      const rootName = h('span', {}, folderName(input.value));
      const reset = h('button', { type: 'button', class: 'wiz-link' }, 'Use the usual spot');
      const syncReset = () => { reset.hidden = input.value.trim() === usual; };
      input.addEventListener('input', () => {
        answers.projectsDir = input.value;
        rootName.textContent = folderName(input.value);
        err.textContent = '';
        input.classList.remove('invalid');
        syncReset();
      });
      reset.onclick = () => { input.value = usual; input.dispatchEvent(new Event('input')); input.focus(); };
      syncReset();
      const tree = h('div', { class: 'wiz-tree', 'aria-hidden': 'true' },
        h('div', { class: 'wiz-tree-root' }, icon('folder', 'wiz-tree-ic', 18), rootName),
        ...['Monthly budget', 'Bakery website', 'Trip planner'].map((n) => h('div', { class: 'wiz-tree-row' }, icon('folder', 'wiz-tree-ic', 16), h('span', {}, n))));
      return {
        focus: input,
        error: (m) => { err.textContent = m; input.classList.add('invalid'); },
        save: async () => {
          const v = input.value.trim();
          if (!v) throw new Error('Type a folder, or choose "Use the usual spot".');
          const out = await post({ projectsDir: v });
          answers.projectsDir = friendlyPath(out.projectsDir || v, state.defaults?.home || '');
          return true;
        },
        nodes: [
          ...heading('Where should I keep your projects?', stepLabel()),
          lead('Every new spreadsheet, document or website gets its own folder in here, so everything stays tidy and easy to find.'),
          h('div', { class: 'wiz-files' },
            h('div', { class: 'wiz-files-field' },
              h('label', { class: 'wiz-label', for: 'wizFolder' }, 'Projects folder'),
              input,
              h('p', { class: 'wiz-hint', id: 'wizFolderHint' }, "I'll create this folder for you. The usual spot is fine for most people; ", h('code', {}, '~'), ' means your home folder.'),
              reset),
            tree),
          err,
        ],
      };
    },

    voice() {
      const err = errorLine();
      const cards = voices.map((v) => {
        const { name, note } = splitVoiceName(v.name);
        const pick = h('button', { type: 'button', role: 'radio', class: 'wiz-voice-pick', 'aria-label': `${name}${note ? `, ${note}` : ''}` },
          h('strong', {}, name), h('span', {}, note || ' '));
        const play = h('button', { type: 'button', class: 'wiz-play', 'aria-label': `Play a sample of ${name}`, title: 'Hear this voice', html: PLAY });
        const card = h('div', { class: 'wiz-voice' }, pick, play);
        pick.onclick = () => { answers.voice = v.id; sync(); };
        play.onclick = () => preview(v.id, play, name);
        return { id: v.id, card, pick };
      });
      const sync = () => {
        for (const c of cards) {
          const on = c.id === answers.voice;
          c.card.classList.toggle('on', on);
          c.pick.setAttribute('aria-checked', String(on));
        }
      };
      sync();
      // First run: the voice (~90 MB) downloads by itself; show how far along it is.
      const dl = h('p', { class: 'wiz-hint wiz-download', role: 'status', hidden: true });
      const bar = h('progress', { max: '1', value: '0', class: 'wiz-progress', hidden: true });
      const pollVoice = async () => {
        if (!dl.isConnected && dl.dataset.started) return;
        dl.dataset.started = '1';
        try {
          const { voice } = await fetch('/api/assets').then((r) => r.json());
          const busy = voice.state === 'loading' || voice.state === 'downloading';
          dl.hidden = bar.hidden = !busy;
          /** @type {HTMLProgressElement} */ (bar).value = voice.progress || 0;
          dl.textContent = voice.state === 'downloading' ? `Downloading Echo's voice… ${Math.round((voice.progress || 0) * 100)}%${voice.mb ? ` of ${voice.mb} MB` : ''}` : 'Getting the voice ready…';
          if (busy) setTimeout(pollVoice, 800);
        } catch {}
      };
      pollVoice();
      const speedOut = h('span', { class: 'wiz-speed-val' }, `${answers.speed.toFixed(2)}×`);
      const speed = h('input', { type: 'range', min: '0.8', max: '1.3', step: '0.05', value: String(answers.speed), id: 'wizSpeed' });
      speed.addEventListener('input', () => { answers.speed = Number(speed.value); speedOut.textContent = `${answers.speed.toFixed(2)}×`; });
      return {
        error: (m) => { err.textContent = m; },
        save: async () => {
          await post({ ttsProvider: 'kokoro', voice: answers.voice, speed: answers.speed });
          return true;
        },
        nodes: [
          ...heading('Pick a voice you like', stepLabel()),
          lead('Tap ▶ to hear each one. The first sample can take a few seconds while the voice warms up.'),
          dl,
          bar,
          voices.length
            ? h('div', { class: 'wiz-voices', role: 'radiogroup', 'aria-label': 'Voice' }, cards.map((c) => c.card))
            : h('p', { class: 'wiz-hint' }, "I couldn't load the voices just now. You can pick one later in Settings."),
          h('div', { class: 'wiz-speed' },
            h('label', { for: 'wizSpeed' }, 'Speaking speed'),
            h('span', { class: 'wiz-speed-end' }, 'Slower'), speed, h('span', { class: 'wiz-speed-end' }, 'Faster'), speedOut),
          err,
        ],
      };
    },

    talking() {
      const err = errorLine();
      const toggle = h('input', { type: 'checkbox', id: 'wizHands', role: 'switch', checked: answers.handsFree });
      toggle.addEventListener('change', () => { answers.handsFree = toggle.checked; });
      const accent = h('select', { id: 'wizAccent', class: 'wiz-select' }, ACCENTS.map(([v, label]) => h('option', { value: v }, label)));
      /** @type {HTMLSelectElement} */ (accent).value = answers.sttLanguage;
      accent.addEventListener('change', () => { answers.sttLanguage = /** @type {HTMLSelectElement} */ (accent).value; });
      return {
        error: (m) => { err.textContent = m; },
        save: async () => {
          await post({ handsFree: answers.handsFree, sttLanguage: answers.sttLanguage });
          deps.setHandsFree(answers.handsFree);
          return true;
        },
        nodes: [
          ...heading('Two ways to talk to me', stepLabel()),
          h('div', { class: 'wiz-ways' },
            h('div', { class: 'wiz-way' },
              h('div', { class: 'wiz-way-art' }, h('kbd', { class: 'wiz-bigkey' }, 'Space')),
              h('strong', {}, 'Hold Space, or click the orb'),
              h('span', {}, "Hold the Space bar while you talk and let go when you're done. Or click the glowing orb to start, and again to stop.")),
            h('div', { class: 'wiz-way' },
              h('div', { class: 'wiz-way-art wiz-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i')),
              h('strong', {}, 'Hands-free: just talk'),
              h('span', {}, 'I listen all the time and answer when you pause. Best in a quiet room.'))),
          h('label', { class: 'wiz-toggle', for: 'wizHands' },
            h('span', { class: 'wiz-toggle-text' }, h('strong', {}, 'Hands-free listening'), h('span', {}, 'You can switch this any time from the top bar.')),
            h('span', { class: 'switch big' }, toggle, h('span', { class: 'track' }))),
          h('div', { class: 'wiz-row' },
            h('label', { class: 'wiz-label inline', for: 'wizAccent' }, 'Your accent'), accent),
          h('p', { class: 'wiz-hint' }, 'Press ', h('kbd', {}, 'Esc'), ' any time to make me stop talking. And you can always type instead.'),
          err,
        ],
      };
    },

    pin() {
      const err = errorLine();
      if (state.hasPin) {
        return {
          nodes: [
            ...heading('Set a safety PIN', stepLabel()),
            lead('I can improve my own software, but only after someone types this PIN on this screen. So it stays locked unless you say so.'),
            h('div', { class: 'wiz-done-card' }, h('span', { class: 'wiz-done-ic', html: CHECK }),
              h('span', {}, h('strong', {}, 'A PIN is already set.'), " You're all good here. You can change it in Settings.")),
          ],
        };
      }
      const a = h('input', { class: 'wiz-input pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: '10', id: 'wizPin', placeholder: '••••', 'aria-describedby': 'wizPinHint' });
      const b = h('input', { class: 'wiz-input pin', type: 'password', inputmode: 'numeric', autocomplete: 'new-password', maxlength: '10', id: 'wizPin2', placeholder: '••••' });
      a.value = answers.pin;
      b.value = answers.pin2;
      const onIn = () => {
        answers.pin = a.value;
        answers.pin2 = b.value;
        err.textContent = '';
        a.classList.remove('invalid');
        b.classList.remove('invalid');
      };
      a.addEventListener('input', onIn);
      b.addEventListener('input', onIn);
      const skip = h('button', { type: 'button', class: 'wiz-link' }, 'Skip for now');
      skip.onclick = () => { answers.pin = answers.pin2 = ''; go(1); };
      return {
        focus: a,
        error: (m) => { err.textContent = m; },
        save: async () => {
          const problem = pinProblem(a.value, b.value);
          if (problem) {
            err.textContent = problem;
            (/^Type|numbers|digits/.test(problem) ? a : b).classList.add('invalid');
            (/^Type|numbers|digits/.test(problem) ? a : b).focus();
            return false;
          }
          await post({ pin: a.value });
          answers.pin = answers.pin2 = '';
          return true;
        },
        nodes: [
          ...heading('Set a safety PIN', stepLabel()),
          lead('I can improve my own software, but only after someone types this PIN on this screen. So it stays locked unless you say so.'),
          h('div', { class: 'wiz-pins' },
            h('div', {}, h('label', { class: 'wiz-label', for: 'wizPin' }, 'Choose a PIN'), a),
            h('div', {}, h('label', { class: 'wiz-label', for: 'wizPin2' }, 'Type it again'), b)),
          h('p', { class: 'wiz-hint', id: 'wizPinHint' }, "4 to 10 digits. Pick something you'll remember and others won't guess."),
          err,
          h('div', { class: 'wiz-skip' }, skip, h('span', {}, "If you skip, self-improve stays off. You can set a PIN later in Settings.")),
        ],
      };
    },

    permissions() {
      const rows = PERMS.map((p) => permRow(p));
      return {
        nodes: [
          ...heading('A few Mac permissions', stepLabel()),
          lead('Test each one now so everything works later. If a Mac pop-up appears, click OK or Allow. You can skip any of these.'),
          h('div', { class: 'wiz-perms' }, rows),
        ],
      };
    },

    tour() {
      const err = errorLine();
      const name = (answers.userName || state.settings?.userName || '').trim();
      const examples = tourExamples(answers.interests);
      const cards = examples.map((ex) =>
        h('button', { type: 'button', class: 'wiz-example', onclick: () => finish(ex.text).catch((e) => { err.textContent = e.message; }) },
          icon(ex.interest, 'wiz-example-ic', 18),
          h('span', {}, `“${ex.text}”`)));
      const tip = (ic, strong, rest) => h('li', {}, icon(ic, 'wiz-tip-ic', 18), h('span', {}, h('strong', {}, strong), rest));
      return {
        next: `Start using ${aName()}`,
        error: (m) => { err.textContent = m; },
        save: async () => { await finish(); return false; },
        nodes: [
          ...heading(`You're all set${name ? `, ${name}` : ''}!`),
          lead('Here are a few things you could say. Tap one to put it in the message box.'),
          h('div', { class: 'wiz-examples' }, cards),
          h('div', { class: 'wiz-q' }, 'Good to know'),
          h('ul', { class: 'wiz-tips' },
            tip('space', 'Hold Space or click the orb', ' to talk. Let go when you’re done.'),
            tip('esc', 'Press Esc', ' to make me stop talking.'),
            tip('workers', 'The Workers tab', ' shows bigger jobs, and anything that needs your OK.')),
          err,
        ],
      };
    },
  };

  /** Finish setup; with `example`, put it in the message box afterwards (not sent). */
  async function finish(example = '') {
    const out = await post({ finish: true, userName: (answers.userName || '').trim() || undefined });
    const settings = out.settings;
    close();
    deps.onFinish?.(settings);
    if (example) deps.useExample(example);
    else {
      const who = settings?.userName ? `, ${settings.userName}` : '';
      deps.speak(`Welcome${who}! I'm ready whenever you are. Just talk, or type below.`);
    }
  }

  /* ---------- voice preview ---------- */
  function stopPreview() {
    if (!audio) return;
    audio.ctrl?.abort();
    audio.el?.pause();
    if (audio.url) URL.revokeObjectURL(audio.url);
    audio.btn?.classList.remove('loading', 'playing');
    if (audio.btn) { audio.btn.innerHTML = PLAY; audio.btn.setAttribute('aria-label', `Play a sample of ${audio.name}`); }
    audio = null;
  }
  async function preview(voiceId, btn, name) {
    const same = audio?.btn === btn;
    stopPreview();
    if (same) return; // a second click stops it
    deps.hush?.();
    const who = (answers.userName || '').trim();
    const text = `Hi${who ? ` ${who}` : ''}! I'm ${aName()}. This is how I'll sound when I talk with you.`;
    const ctrl = new AbortController();
    audio = { btn, name, ctrl, el: null, url: '' };
    btn.classList.add('loading');
    btn.innerHTML = '<span class="wiz-spin"></span>';
    btn.setAttribute('aria-label', `Loading ${name}. Click to stop.`);
    try {
      const res = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal, body: JSON.stringify({ text, provider: 'kokoro', voice: voiceId, speed: answers.speed }) });
      if (!res.ok) throw new Error('tts');
      const url = URL.createObjectURL(await res.blob());
      if (audio?.btn !== btn) { URL.revokeObjectURL(url); return; }
      const el = new Audio(url);
      audio.el = el;
      audio.url = url;
      btn.classList.remove('loading');
      btn.classList.add('playing');
      btn.innerHTML = STOP;
      btn.setAttribute('aria-label', `Stop the sample of ${name}`);
      el.onended = () => { if (audio?.el === el) stopPreview(); };
      await el.play();
    } catch (e) {
      if (e?.name === 'AbortError') return;
      if (audio?.btn === btn) stopPreview();
      const err = els.step.querySelector('.wiz-err');
      if (err) err.textContent = "I couldn't play that sample. The voice may still be loading; try again in a moment.";
    }
  }

  /* ---------- permissions ---------- */
  function permRow(p) {
    const st = perm[p.id];
    const chip = h('span', { class: 'wiz-chip', role: 'status' });
    const msg = h('p', { class: 'wiz-perm-msg' });
    const meter = h('div', { class: 'wiz-meter', 'aria-hidden': 'true' }, h('i'));
    const openBtn = h('button', { type: 'button', class: 'ghost small', onclick: () => fetch('/api/permissions/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pane: p.pane }) }).catch(() => {}) }, 'Open System Settings');
    const test = h('button', { type: 'button', class: 'small wiz-test' }, 'Test');
    test.setAttribute('aria-label', `Test ${p.title}`);
    const sync = () => {
      chip.textContent = CHIP[st.status];
      chip.className = `wiz-chip ${st.status}`;
      msg.textContent = st.message;
      msg.hidden = !st.message;
      openBtn.hidden = st.status !== 'bad';
      meter.hidden = !(p.id === 'mic' && st.status === 'ok' && st.live);
      test.disabled = st.status === 'busy';
      test.textContent = st.status === 'ok' || st.status === 'bad' ? 'Test again' : 'Test';
    };
    test.onclick = async () => {
      st.status = 'busy';
      st.message = p.id === 'mic' ? 'If Chrome asks, click Allow.' : 'If a Mac pop-up appears, click OK. This can take a few seconds.';
      sync();
      if (p.id === 'mic') await testMic(st, meter, sync);
      else {
        try {
          const res = await fetch('/api/permissions/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: p.id }) });
          const out = await res.json();
          st.status = out.ok ? 'ok' : 'bad';
          st.message = out.message || out.error || '';
        } catch {
          st.status = 'bad';
          st.message = "I couldn't run the test. Is Echo still running?";
        }
      }
      if (root) sync();
    };
    sync();
    return h('div', { class: `wiz-perm` },
      icon(p.icon, 'wiz-perm-ic', 20),
      h('div', { class: 'wiz-perm-text' }, h('strong', {}, p.title), h('span', {}, p.why), meter, msg),
      h('div', { class: 'wiz-perm-side' }, chip, h('div', { class: 'wiz-perm-btns' }, openBtn, test)));
  }

  async function testMic(st, meter, sync) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      st.status = 'bad';
      st.message = e?.name === 'NotFoundError'
        ? "I couldn't find a microphone. Plug one in, or check the Sound settings on your Mac."
        : "Chrome is blocking the microphone. Click the icon at the left of the address bar, open Site settings, and set Microphone to Allow. If it's still blocked, your Mac may be blocking Chrome: use Open System Settings and switch Chrome on.";
      return;
    }
    st.status = 'ok';
    st.message = 'Say something: the bar should move when you talk.';
    st.live = true;
    const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
    const ac = new Ctx();
    const an = ac.createAnalyser();
    an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const bar = /** @type {HTMLElement} */ (meter.firstElementChild);
    let raf = 0;
    let level = 0;
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      level = Math.max(rms * 7, level * 0.9);
      bar.style.transform = `scaleX(${Math.min(1, level).toFixed(3)})`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    const stop = () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      ac.close().catch(() => {});
      st.live = false;
    };
    const timer = setTimeout(() => { stop(); st.message = 'Your microphone works.'; if (root) sync(); }, 12000);
    cleanups.push(() => { clearTimeout(timer); stop(); });
  }

  return { open, close, isOpen };
}
