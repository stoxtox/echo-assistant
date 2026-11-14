// The eval harness's simulated Mac: a small world of apps and elements, and a bridge that answers
// ComputerUse's requests the way the Mac app (macos/Sources/Driver.swift) does, so every change
// to computer use can be measured on the same tasks: task success, false success ("said done,
// wasn't"), steps and time (scripts/eval.js, test/eval.test.js).
//
// Two drivers, same world:
// - 'legacy' behaves like the Mac app did on Sept 28–29 (the audit's Appendix A): the label search
//   covers the whole app, browser toolbar and menu bar icons first, matches field values and any
//   word in a long line; the found element is swapped for the text at its centre; an
//   Accessibility press is trusted; typing goes to whatever has the focus; a ⌘ from ⌘A leaks into
//   the next typed text (Chrome's ⌘⇧M profile menu); and every action answers ok, unchecked.
// - 'v0' behaves like the Mac app now: page-scoped search in browsers, strict matching, the
//   control around matched text, observe → act → verify (a press that changed nothing is retried
//   as a real click), the focus guard, clean key events, replace mode, right-click, hover, drag.
//
// A spreadsheet (excelScene) behaves as Excel did on Oct 3: the grid is a layout area, not a
// text field; typing with a cell selected replaces what it holds; ⌘A in the formula bar selects
// the cells, not the bar's text; bold shows only on the ribbon's Bold button. The driver answers
// as Driver.swift does now: a cell reference as the target goes there by the Name Box, the grid
// takes typing, a field is emptied and seen to be empty before it is typed over, a field that
// already says it is left alone, and typed text is read back exactly. The sheet also answers
// the scripts of lib/sheets.js (simSheets below), which is how Echo works in a spreadsheet now.
//
// The world encodes what the logs showed real apps do: Gmail's Compose ignores an Accessibility
// press but opens on a real click; the To box needs a chip commit (Tab, comma or Return); FaceTime's
// controls only show on hover; Messages' Share is in a context menu. Nothing here touches the real
// screen. The scoring mirrors LabelMatch/ActMath in macos/Sources/PointMath.swift.
import { EventEmitter } from 'node:events';
import { SCRIPTS, EXCEL, NUMBERS, parseRef, boxAddr, encodeCell } from './sheets.js';

/* ---------- label matching (LabelMatch.score, legacy and now) ---------- */

export const normalize = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

/** @param {string} candidate @param {string} query @param {boolean} strict the current rules */
export function labelScore(candidate, query, strict) {
  const c = normalize(candidate), q = normalize(query);
  if (!c || !q || c.length > 200) return 0;
  if (c === q) return 100;
  const cc = c.replace(/ /g, ''), qc = q.replace(/ /g, '');
  if (cc === qc && qc.length >= 3) return 95;
  if (c.startsWith(q + ' ') || (q.length >= 3 && q.startsWith(c + ' '))) return 75;
  if (` ${c} `.includes(` ${q} `)) {
    if (!strict) return 60;
    const cw = c.split(' ').length, qw = q.split(' ').length;
    return cw <= Math.max(4, qw * 3) ? 60 : 40;
  }
  const words = new Set(q.split(' ')), have = new Set(c.split(' '));
  if (words.size > 1 && [...words].every((w) => have.has(w))) return 45;
  return 0;
}

const INTERACTIVE = new Set(['AXButton', 'AXMenuItem', 'AXMenuBarItem', 'AXLink', 'AXTab', 'AXRadioButton', 'AXCheckBox', 'AXPopUpButton', 'AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField', 'AXCell', 'AXRow']);
const EDITABLE = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField']);
const PASSIVE = new Set(['AXStaticText', 'AXImage', 'AXGroup', 'AXHeading', '']);
const BROWSERS = new Set(['Google Chrome', 'Safari']);
/** The grid of a spreadsheet and its cells (SheetMath.gridRoles). */
const GRID = new Set(['AXLayoutArea', 'AXTable', 'AXCell']);

/** "A1", "b12", "cell AA3" → "A1" (SheetMath.cellRef in macos/Sources/PointMath.swift), else ''. */
export function cellRef(s) {
  const m = /^(?:CELL\s+)?([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(String(s || '').trim().toUpperCase().replace(/\$/g, ''));
  if (!m || Number(m[2]) > 1048576) return '';
  const column = [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return column <= 16384 ? m[1] + m[2] : '';
}
const EXTRA_ALIASES = new Set(['date', 'time', 'clock', 'wifi', 'wi fi', 'sound', 'volume', 'battery', 'bluetooth', 'focus', 'display', 'user', 'control center']);

/* ---------- the world ---------- */

/**
 * @typedef {{ id: string, app: string, role: string, title?: string, desc?: string, value?: string,
 *   placeholder?: string, web?: boolean, chrome?: boolean, parent?: string, pressAX?: boolean,
 *   hidden?: boolean, secure?: boolean, onPress?: (w: World) => void, onRight?: (w: World) => void,
 *   onHover?: (w: World) => void, onDrop?: (w: World, from: El) => void, commit?: 'chip',
 *   chips?: string[], shortcut?: boolean, extra?: boolean, inert?: boolean, selectAll?: boolean, next?: string,
 *   onReturn?: (w: World) => void, keys?: Record<string, (w: World) => void>, fileInput?: boolean,
 *   files?: string[], onUpload?: (w: World, files: string[]) => void, at?: { x: number, y: number }, looks?: string,
 *   noSelect?: boolean, settable?: boolean, onInput?: (w: World) => void }} El
 *   (noSelect: its text can't be selected with ⌘A or its ends, like Excel's formula bar; settable:
 *   its value can be set through Accessibility)
 */

export class World {
  constructor() {
    /** @type {Map<string, El>} */
    this.els = new Map();
    /** app -> { focus, window, windows, url, menuOpen, version } */
    this.apps = new Map();
    this.front = '';
    /** The legacy driver's leftover ⌘ after ⌘A (the Sept 29 profile-menu bug). */
    this.modLeak = false;
    this.clipboard = '';
    this.facts = new Map();
    this.n = 0;
  }

  app(name, o = {}) {
    if (!this.apps.has(name)) this.apps.set(name, { focus: null, window: o.window || name, windows: 1, url: o.url || '', menuOpen: false, version: 0 });
    Object.assign(this.apps.get(name), o);
    if (!this.front) this.front = name;
    return this.apps.get(name);
  }

  /** @param {Partial<El> & { app: string, role: string }} e */
  add(e) {
    const id = e.id || `e${++this.n}`;
    const el = /** @type {El} */ ({ pressAX: true, ...e, id });
    this.els.set(id, el);
    this.touch(e.app);
    return el;
  }

  remove(id) {
    const e = this.els.get(id);
    if (e) {
      this.els.delete(id);
      this.touch(e.app);
    }
  }

  touch(app) {
    const a = this.apps.get(app);
    if (a) a.version++;
  }

  visible(app) {
    return [...this.els.values()].filter((e) => e.app === app && !e.hidden);
  }

  focused(app = this.front) {
    const id = this.apps.get(app)?.focus;
    return id ? this.els.get(id) || null : null;
  }

  focus(el) {
    const a = this.apps.get(el.app);
    // Leaving Gmail's To box turns what's typed in it into a chip.
    const was = a?.focus ? this.els.get(a.focus) : null;
    if (was && was.id !== el.id && was.commit === 'chip' && was.value) {
      was.chips = [...(was.chips || []), was.value.trim()];
      was.value = '';
    }
    if (a && a.focus !== el.id) {
      a.focus = el.id;
      a.version++;
    }
  }

  set(k, v) {
    this.facts.set(k, v);
  }

  get(k) {
    return this.facts.get(k);
  }

  snapshot(app) {
    const a = this.apps.get(app) || { focus: null, window: '', windows: 0, url: '', menuOpen: false, version: 0 };
    const f = this.focused(app);
    return { front: this.front, focus: f?.id || '', value: f ? `${f.value || ''}|${(f.chips || []).join(',')}` : '', window: a.window, windows: a.windows, url: a.url, menuOpen: a.menuOpen, version: a.version, format: a.sheet ? this.formatOf(app) : '' };
  }

  /* ----- a spreadsheet: apps.get(name).sheet = { sel: 'A1', cells: { A1: { v: 'hello', bold: false } } } ----- */

  /** The selected cell of a spreadsheet app (made when first asked for); of a selected range, its first cell. */
  cell(app) {
    const sh = this.apps.get(app)?.sheet;
    if (!sh) return null;
    const at = parseRef(sh.sel);
    const key = at ? boxAddr(at.row, at.col) : sh.sel;
    sh.cells[key] ||= { v: '', bold: false };
    return sh.cells[key];
  }

  /** Every cell of the selection (made when first asked for). */
  selected(app) {
    const sh = this.apps.get(app)?.sheet;
    if (!sh) return [];
    return cellsOf(sh.sel).map((key) => (sh.cells[key] ||= { v: '', bold: false }));
  }

  /** What the ribbon's Bold button shows for the selection (Driver.swift formatState). */
  formatOf(app) {
    return this.cell(app)?.bold ? 'bold' : '';
  }

  /** The name box and the formula bar show the selected cell. */
  syncSheet(app) {
    const sh = this.apps.get(app)?.sheet;
    if (!sh) return;
    for (const e of this.els.values()) {
      if (e.app !== app) continue;
      if (e.title === 'Name Box') e.value = sh.sel;
      if (e.title === 'Formula Bar') e.value = this.cell(app)?.v || '';
      if (e.title === 'Bold') e.value = this.cell(app)?.bold ? '1' : '0';
    }
  }

  /** Selects a cell; the keyboard goes back to the grid. */
  select(app, ref) {
    const sh = this.apps.get(app)?.sheet;
    if (!sh) return;
    sh.sel = ref;
    this.syncSheet(app);
    const grid = [...this.els.values()].find((e) => e.app === app && e.title === 'Content Area');
    if (grid) this.focus(grid);
    this.touch(app);
  }

  /** Puts `v` in the selected cell (entered, the cell stays selected). */
  enter(app, v) {
    const c = this.cell(app);
    if (!c) return;
    c.v = v;
    this.syncSheet(app);
    this.touch(app);
  }
}

/** Every address of "B2" or "B2:D4", row by row. */
function cellsOf(ref) {
  const b = parseRef(ref);
  if (!b) return [];
  const out = [];
  for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) out.push(boxAddr(b.row + r, b.col + c));
  return out;
}

/* ---------- a spreadsheet app's scripting (answers like the scripts in lib/sheets.js) ---------- */

/**
 * The AppleScript runner of the simulated Mac, for lib/sheets.js: it answers the adapter's scripts
 * from the world's sheet (`apps.get(name).sheet`), in the same lines the real scripts write. What
 * a real app can do to a script is here too: `sheet.editing` (Excel in the middle of editing a
 * cell refuses scripts until Escape), `sheet.notAllowed` (macOS hasn't allowed Echo to control
 * the app), `sheet.slow` (no answer in time). Every call is kept in `calls`, script text and all.
 * @param {World} world
 */
export function simSheets(world) {
  /** @type {Array<{ script: string, args: string[] }>} */
  const calls = [];
  const flag = (cells, key) => (cells.length && cells.every((c) => c?.[key]) ? '1' : cells.some((c) => c?.[key]) ? 'm' : '0');
  const run = async (script, args = []) => {
    calls.push({ script, args: [...args] });
    if (script === SCRIPTS.running) return [...world.apps].filter(([, a]) => a.sheet).map(([name]) => `${name}\t${world.front === name}\n`).join('');
    const app = [EXCEL, NUMBERS].find((k) => SCRIPTS[k] === script);
    if (!app) throw new Error('an unknown script');
    const a = world.apps.get(app);
    const sh = a?.sheet;
    if (!sh) return 'ERR\tnot_running\n';
    if (sh.slow) throw Object.assign(new Error('timed out'), { killed: true });
    if (sh.notAllowed) return `ERR\tscript\t-1743\tNot authorized to send Apple events to ${app}.\n`;
    if (sh.editing) return 'ERR\tscript\t-50\tParameter error.\n';
    const [op, ...rest] = args;
    const cell = (key) => sh.cells[key] || {};
    const filled = () => Object.keys(sh.cells).filter((k) => parseRef(k) && (cell(k).v !== '' && cell(k).v !== undefined || cell(k).bold));
    const used = () => {
      const at = filled().map((k) => /** @type {any} */ (parseRef(k)));
      if (!at.length) return 'A1';
      const r1 = Math.min(...at.map((x) => x.row)), c1 = Math.min(...at.map((x) => x.col));
      return boxAddr(r1, c1, Math.max(...at.map((x) => x.row)) - r1 + 1, Math.max(...at.map((x) => x.col)) - c1 + 1);
    };
    const named = (ref) => (ref === 'used' ? used() : ref === 'selection' ? sh.sel : ref);
    const doc = a.window || 'Book1', name = sh.name || 'Sheet1';
    const priorLines = [];
    let dump = null, fmt = '', held = -1;
    if (op === 'set') {
      const [range, select, nr, nc, limit, wantDoc, wantSheet, ...pairs] = rest;
      if ((wantDoc && wantDoc !== doc) || (wantSheet && wantSheet !== name)) return 'ERR\tchanged\n';
      const box = /** @type {any} */ (parseRef(range));
      let n = 0;
      for (let r = 0; r < Number(nr); r++) {
        const now = Array.from({ length: Number(nc) }, (_, c) => cell(boxAddr(box.row + r, box.col + c)));
        n += now.filter((x) => x.v !== '' && x.v !== undefined).length;
        priorLines.push(['p', ...now.map((x) => encodeCell(x.v))].join('\t'), ['q', ...now.map((x) => encodeCell(x.f || (x.v === undefined ? '' : String(x.v))))].join('\t'));
      }
      if (Number(limit) >= 0 && n > Number(limit)) held = n;
      else {
        cellsOf(range).forEach((key, k) => {
          const kind = pairs[k * 2], text = String(pairs[k * 2 + 1] ?? '');
          const c = (sh.cells[key] ||= { v: '', bold: false });
          delete c.f;
          if (kind === 'n') c.v = Number(text);
          else if (kind === 'b') c.v = text === '1';
          else if (kind === 'e') c.v = '';
          // Excel: a leading apostrophe marks text and isn't part of it. Numbers has no such mark.
          else if (app === EXCEL && text.startsWith("'")) c.v = text.slice(1);
          else if (text.startsWith('=')) Object.assign(c, { v: 0, f: text });
          else c.v = text;
        });
        if (select === '1') sh.sel = range;
        world.syncSheet(app);
        world.touch(app);
        dump = { range, bold: false, formulas: true, texts: true, max: Number(nr) * Number(nc) };
      }
    } else if (op === 'select') {
      world.select(app, rest[0]);
    } else if (op === 'format') {
      const range = named(rest[0]);
      const [bold, italic, underline] = rest.slice(1);
      if (app === NUMBERS && (bold || italic || underline)) return 'ERR\tunsupported\n';
      for (const key of cellsOf(range)) {
        const c = (sh.cells[key] ||= { v: '', bold: false });
        if (bold) c.bold = bold === '1';
        if (italic) c.italic = italic === '1';
        if (underline) c.underline = underline === '1';
      }
      world.syncSheet(app);
      const cells = cellsOf(range).map(cell);
      fmt = `range\t${range}\nfmt\t${flag(cells, 'bold')}\t${flag(cells, 'italic')}\t${flag(cells, 'underline')}`;
    } else if (op === 'read') {
      dump = { range: named(rest[0]), bold: rest[1] === '1', formulas: rest[2] === '1', texts: rest[3] === '1', max: Number(rest[4]) };
    }
    const out = ['OK', `doc\t${doc}`, `sheet\t${name}`, `sel\t${sh.sel}`, `used\t${used()}`, ...priorLines];
    if (held >= 0) out.push(`held\t${held}`);
    if (fmt) out.push(fmt);
    if (dump) {
      const box = /** @type {any} */ (parseRef(dump.range));
      out.push(`size\t${box.rows}\t${box.cols}`);
      const kc = Math.min(box.cols, dump.max), kr = Math.min(box.rows, Math.max(1, Math.floor(dump.max / kc)));
      out.push(`range\t${boxAddr(box.row, box.col, kr, kc)}`);
      const rows = Array.from({ length: kr }, (_, r) => Array.from({ length: kc }, (_, c) => cell(boxAddr(box.row + r, box.col + c))));
      for (const row of rows) out.push(['r', ...row.map((x) => encodeCell(x.v))].join('\t'));
      if (dump.formulas) for (const row of rows) out.push(['f', ...row.map((x) => encodeCell(x.f || (x.v === undefined ? '' : String(x.v))))].join('\t'));
      if (dump.texts) for (const row of rows) out.push(['t', ...row.map((x) => encodeCell(x.v === undefined ? '' : String(x.v)))].join('\t'));
      if (dump.bold) for (const row of rows) out.push(`b\t${row.map((x) => (x.bold ? '1' : '0')).join('')}`);
    }
    return `${out.join('\n')}\n`;
  };
  return { run, calls };
}

/** What changed between two snapshots (VerifyMath.changes). */
export function changes(a, b) {
  const out = [];
  if (a.front !== b.front) out.push('front_app');
  if (a.focus !== b.focus) out.push('focus');
  if (a.value !== b.value) out.push('value');
  if (a.window !== b.window) out.push('window_title');
  if (a.windows !== b.windows) out.push('windows');
  if (a.url !== b.url) out.push('url');
  if (a.menuOpen !== b.menuOpen) out.push(b.menuOpen ? 'menu_opened' : 'menu_closed');
  if (a.version !== b.version) out.push('content');
  if ((a.format || '') !== (b.format || '')) out.push('format');
  return out;
}

const squeeze = (s) => String(s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

/** Is the typed text in the field, exactly (VerifyMath.typed)? Adding: the field grew by it. */
export function typedExactly(text, value, { replaced = false, before = undefined } = {}) {
  const want = squeeze(text), have = squeeze(value);
  if (!want) return replaced ? have === '' : true;
  if (replaced) return have === want;
  if (!have.includes(want)) return false;
  if (before === undefined) return true;
  const was = squeeze(before);
  return have.length >= was.length + want.length - 1 || was === '';
}

/** Does the field already say it (VerifyMath.already)? 'same', 'case' (other capitals) or ''. */
export function alreadyHolds(text, value, replace) {
  const want = squeeze(text), have = squeeze(value);
  if (!want) return '';
  if (have === want) return 'same';
  return !replace && have.toLowerCase() === want.toLowerCase() ? 'case' : '';
}

/* ---------- the simulated Mac app (answers like Driver.swift) ---------- */

/** Time costs (ms) of the pieces of a step, for the time metric. */
export const COST = { bridge: 150, glide: 600, verify: 250, keyPerChar: 55, typingCap: 3000, model: 3200, recipeModel: 3200, hover: 450 };

export class SimBridge extends EventEmitter {
  /** @param {World} world @param {'legacy' | 'v0' | 'v1' | 'v2'} driver */
  constructor(world, driver) {
    super();
    this.world = world;
    this.driver = driver;
    this.native = true;
    this.tokens = new Map();
    this.clock = 0;
    this.n = 0;
  }

  /** Today's driver (v0 and v1 act the same way; v1's agent also uses refs, batching, local commands). */
  get v0() {
    return this.driver !== 'legacy';
  }

  async request(kind, p = {}) {
    this.clock += COST.bridge;
    if (kind === 'act' && p.step === 'resolve') return this.resolve(p);
    if (kind === 'act' && p.step === 'do') return this.act(p);
    if (kind === 'wait') return this.wait(p);
    if (kind === 'observe') return this.observe(p);
    if (kind === 'look') {
      this.clock += 700;
      const image = { data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), mime: 'image/jpeg', width: 1000, height: 800 };
      return { ok: true, look: { text: this.world.visible(this.world.front).map((e) => e.title || e.desc || e.value || '').filter(Boolean).join('\n'), app: this.world.front, image } };
    }
    return { ok: false, error: 'unsupported' };
  }

  appFor(name) {
    const w = this.world;
    if (name && w.apps.has(name)) return name;
    return w.front;
  }

  /** The label search: legacy (whole app, menu bar icons first, loose) or now (scoped, strict). */
  /** @param {string} app @param {string} target @param {{ wantsField?: boolean, scope?: string }} [o] */
  find(app, target, { wantsField = false, scope = '' } = {}) {
    const w = this.world;
    const q = normalize(target);
    const browser = BROWSERS.has(app);
    let pool = w.visible(app);
    if (!this.v0) {
      // Menu bar icons first for names like "Date"; then everything in the app, the browser's own
      // controls (shallow) before the page (deep).
      if (EXTRA_ALIASES.has(q)) {
        const extra = [...w.els.values()].find((e) => e.extra && labelScore(e.title || e.desc || '', target, false) >= 45);
        if (extra) return { el: extra, score: 100 };
      }
      pool = [...pool.filter((e) => e.chrome), ...pool.filter((e) => !e.chrome)];
    } else {
      const sc = scope || (browser ? 'page' : 'app');
      if (sc === 'page' && browser) pool = pool.filter((e) => e.web);
      if (sc === 'menu_bar') pool = [...w.els.values()].filter((e) => e.extra);
    }
    let best = null;
    for (const e of pool) {
      const fields = this.v0 ? [e.title, e.desc, e.placeholder, ...(e.role === 'AXStaticText' ? [e.value] : [])] : [e.title, e.desc, e.placeholder, e.value];
      let s = 0;
      for (const f of fields) s = Math.max(s, labelScore(f || '', target, this.v0));
      if (s < 45) continue;
      if (this.v0) {
        const field = EDITABLE.has(e.role);
        s += INTERACTIVE.has(e.role) || field ? 15 : e.role === 'AXStaticText' ? 5 : e.role === 'AXGroup' ? -10 : 0;
        if (wantsField) s += field ? 30 : -20;
      } else {
        s += INTERACTIVE.has(e.role) ? 15 : e.role === 'AXStaticText' ? 5 : e.role === 'AXGroup' ? -10 : 0;
      }
      // Breadth-first: the first of equals wins (the browser's shallow controls, legacy).
      if (!best || s > best.score) best = { el: e, score: s };
      if (!this.v0 && s >= 115) break;
    }
    if (!best) return null;
    let el = best.el;
    if (this.v0) {
      // The control around matched text (ActMath.shouldClimb + control(around:)).
      if (PASSIVE.has(el.role) && el.parent) {
        const up = w.els.get(el.parent);
        if (up && INTERACTIVE.has(up.role)) el = up;
      }
    } else {
      // The centre hit-test swap: in web content it lands on the text inside the control.
      const inner = [...w.els.values()].find((c) => c.parent === el.id && c.role === 'AXStaticText' && c.web);
      if (inner) el = inner;
    }
    return { el, score: best.score };
  }

  /** The Mac app's observe: visible controls with refs (Driver.swift observe). */
  observe(p) {
    const w = this.world;
    const app = this.appFor(p.app);
    const browser = BROWSERS.has(app);
    this.clock += 250;
    const els = w.visible(app).filter((e) => (INTERACTIVE.has(e.role) || e.role === 'AXDockItem') && (!browser || e.web || p.scope === 'browser'));
    this.snap = `n${++this.n}`;
    this.refs = new Map(els.map((e, i) => [`n${i + 1}`, e]));
    const role = (r) => ({ AXButton: 'button', AXLink: 'link', AXTextField: 'textbox', AXTextArea: 'textbox', AXComboBox: 'combobox', AXSearchField: 'searchbox', AXCheckBox: 'checkbox', AXRow: 'row', AXCell: 'row', AXTab: 'tab', AXMenuItem: 'menuitem' })[r] || 'other';
    return { ok: true, snapshot: this.snap, app, title: w.apps.get(app)?.window || '', elements: els.map((e, i) => ({ ref: `n${i + 1}`, role: role(e.role), name: e.title || e.desc || e.placeholder || '', value: EDITABLE.has(e.role) ? e.value || '' : '', editable: EDITABLE.has(e.role), secret: Boolean(e.secure) })) };
  }

  resolve(p) {
    const w = this.world;
    const app = this.appFor(p.app);
    if (p.app && w.apps.has(p.app)) w.front = p.app;
    this.clock += COST.glide;
    let el = null;
    if (p.x !== undefined && p.y !== undefined) {
      // A spot in the last picture: whatever is drawn there.
      el = w.visible(app).find((e) => e.at && Math.abs(e.at.x - p.x) < 24 && Math.abs(e.at.y - p.y) < 24) || null;
      if (!el) return { ok: true, found: false, message: 'Nothing there.' };
    } else if (p.ref) {
      el = p.snapshot === this.snap ? this.refs?.get(p.ref) : null;
      if (!el || !w.els.has(el.id) || el.hidden) return { ok: true, found: false, stale: true, message: `${p.ref} is stale.` };
    } else if (!p.target && ['press_keys', 'type_text', 'clear_field'].includes(p.action)) el = w.focused(app);
    else if (this.cellTarget(app, p)) {
      // A cell reference in a spreadsheet: Echo goes there itself when the step is done (by the Name Box).
      const cell = this.cellTarget(app, p);
      const token = `t${++this.n}`;
      this.tokens.set(token, { el: w.visible(app).find((e) => e.title === 'Name Box') || null, to: null, app, cell });
      return { ok: true, found: true, token, label: cell, role: 'AXCell', app, window: w.apps.get(app)?.window || '', secure: false, interactive: true };
    } else if (p.target) {
      const hit = this.find(app, p.target, { wantsField: this.v0 && ['type_text', 'clear_field'].includes(p.action), scope: p.scope });
      if (!hit) return { ok: true, found: false, message: `Couldn't find "${p.target}" on screen.` };
      el = hit.el;
    } else if (p.action === 'scroll') el = null;
    let to = null;
    if (p.action === 'drag' && !p.ref) {
      const hit = p.to ? this.find(app, p.to, {}) : null;
      if (!hit) return { ok: true, found: false, message: "Couldn't find where to drag it to." };
      to = hit.el;
    }
    const token = `t${++this.n}`;
    this.tokens.set(token, { el, to, app: el?.app || app });
    return { ok: true, found: true, token, label: el ? el.title || el.desc || el.value || '' : '', role: el?.role || '', app: el?.app || app, window: w.apps.get(el?.app || app)?.window || '', secure: Boolean(el?.secure), ...(this.v0 && el ? { interactive: INTERACTIVE.has(el.role) } : {}) };
  }

  /** The cell a step means, when its target is a cell reference in a spreadsheet (a plain click or typing). */
  cellTarget(app, p) {
    if (!this.v0 || !this.world.apps.get(app)?.sheet || !p.target) return '';
    if (p.action === 'click') return p.button === 'right' || p.double || p.clicks > 1 || p.modifiers ? '' : cellRef(p.target);
    return ['type_text', 'clear_field'].includes(p.action) ? cellRef(p.target) : '';
  }

  /** Is this the grid of a spreadsheet (typing there goes into the selected cell)? */
  isGrid(el) {
    return Boolean(el && this.v0 && this.world.apps.get(el.app)?.sheet && GRID.has(el.role));
  }

  /**
   * Typing in the grid (Driver.swift typeInCell): it replaces what the selected cell holds (adding
   * to it only when asked: mode "append"), is entered with the cell kept selected, and read back.
   */
  typeInCell(app, p, before) {
    const w = this.world;
    const cell = w.cell(app);
    const held = cell.v;
    const text = p.action === 'clear_field' ? '' : String(p.text || '');
    const seen = () => ({ focus: `cell ${w.apps.get(app).sheet.sel}`, value: cell.v });
    const base = { ok: true, app, window: w.apps.get(app)?.window || '' };
    const holds = text ? alreadyHolds(text, held, p.mode === 'replace') : '';
    if (holds) return { ...base, via: 'none', already: holds, holds: held, verified: holds === 'same', changes: [], observed: seen() };
    const append = p.mode === 'append';
    w.enter(app, text ? (append ? held + text : text) : '');
    this.clock += COST.verify;
    return { ...base, via: 'keys', verified: typedExactly(text, cell.v, { replaced: !append, before: append ? held : undefined }), changes: changes(before, w.snapshot(app)), observed: seen() };
  }

  /** An element reacts (a real app shows it: selection, a sheet, a new state), so the app changes. */
  fire(el, handler, arg) {
    el[handler](this.world, arg);
    if (!el.inert) this.world.touch(el.app);
  }

  /** A real mouse click on an element (always reaches the page). */
  realClick(el) {
    if (!el) return;
    if (el.onPress) this.fire(el, 'onPress');
    else if (EDITABLE.has(el.role)) this.world.focus(el);
    else if (el.parent) {
      const up = this.world.els.get(el.parent);
      if (up?.onPress) this.fire(up, 'onPress');
      else if (up && EDITABLE.has(up.role)) this.world.focus(up);
    }
  }

  /** An Accessibility press: only works where the app honours it. Legacy climbs 5 parents. */
  axPress(el) {
    let cur = el;
    for (let i = 0; i < (this.v0 ? 3 : 5) && cur; i++) {
      if (INTERACTIVE.has(cur.role) && !EDITABLE.has(cur.role)) {
        if (cur.pressAX && cur.onPress) this.fire(cur, 'onPress');
        return true; // .success either way: the press "worked"
      }
      cur = cur.parent ? this.world.els.get(cur.parent) : undefined;
    }
    return false;
  }

  /** Characters into whatever has the focus (or page shortcuts when nothing editable does). */
  typeInto(app, text) {
    const w = this.world;
    // The legacy ⌘ leak: a capital M after ⌘A becomes ⌘⇧M, Chrome's profile menu.
    if (!this.v0 && w.modLeak && BROWSERS.has(app) && /^M/.test(text)) {
      w.modLeak = false;
      const menu = [...w.els.values()].find((e) => e.app === app && e.title === 'Manage Your Google Account');
      if (menu) {
        menu.hidden = false;
        w.focus(menu);
        w.apps.get(app).window = 'Accounts and sync';
        w.touch(app);
      }
      return;
    }
    w.modLeak = false;
    const f = w.focused(app);
    if (f && EDITABLE.has(f.role)) {
      if (f.selectAll) {
        f.value = '';
        f.selectAll = false;
      }
      f.value = (f.value || '') + text;
      f.onInput?.(w);
      w.touch(app);
      return;
    }
    // Nothing editable: each letter is a page shortcut (Gmail: c opens a compose).
    if (f?.shortcut || (!f && BROWSERS.has(app))) w.set('shortcuts', (w.get('shortcuts') || 0) + 1);
  }

  pressKey(app, keys) {
    const w = this.world;
    const f = w.focused(app);
    if (keys === 'cmd+a') {
      if (f && EDITABLE.has(f.role) && !f.noSelect) f.selectAll = true;
      if (!this.v0) w.modLeak = true;
      return;
    }
    if (keys === 'tab' || keys === 'return' || keys === ',') {
      if (f?.commit === 'chip' && f.value) {
        f.chips = [...(f.chips || []), f.value.trim()];
        f.value = '';
        w.touch(app);
        const chipText = f.chips.at(-1);
        w.add({ app, role: 'AXButton', title: chipText, web: true, parent: f.parent });
        if (keys === 'tab' && f.next) {
          const n = w.els.get(f.next);
          if (n) w.focus(n);
        }
        return;
      }
      if (keys === 'tab' && f?.next) {
        const n = w.els.get(f.next);
        if (n) w.focus(n);
        return;
      }
      if (keys === 'return' && f?.onReturn) return f.onReturn(w);
    }
    if (keys === 'delete' && f && EDITABLE.has(f.role) && f.selectAll) {
      f.value = '';
      f.selectAll = false;
      w.touch(app);
      return;
    }
    if (f?.keys?.[keys]) return f.keys[keys](w);
    const a = w.apps.get(app);
    if (a?.keys?.[keys]) return a.keys[keys](w);
  }

  typingMs(text) {
    return Math.min(COST.typingCap, String(text).length * COST.keyPerChar);
  }

  act(p) {
    const w = this.world;
    const r = this.tokens.get(p.token);
    if (!r) return { ok: false, error: 'stale', message: 'stale' };
    this.tokens.delete(p.token);
    const app = r.app;
    const el = r.el;
    const before = w.snapshot(app);
    const done = (via, extra = {}) => {
      if (!this.v0) return { ok: true, via, app, window: w.apps.get(app)?.window || '' };
      this.clock += COST.verify;
      const after = w.snapshot(app);
      const ch = changes(before, after);
      return { ok: true, via, app, window: w.apps.get(app)?.window || '', verified: ch.length > 0, changes: ch, observed: { focus: w.focused(app)?.title || w.focused(app)?.desc || '', value: w.focused(app)?.value || '', window: w.apps.get(app)?.window || '', url: w.apps.get(app)?.url || '' }, ...extra };
    };
    switch (p.action) {
      case 'click': {
        if (r.cell) {
          w.select(app, r.cell);
          return done('keys');
        }
        if (p.button === 'right') {
          if (el?.onRight) this.fire(el, 'onRight');
          return done('accessibility');
        }
        if (!this.v0) {
          if (this.axPress(el)) return done('accessibility');
          this.realClick(el);
          return done('events');
        }
        const pressed = this.axPress(el);
        if (pressed && changes(before, w.snapshot(app)).length) return done('accessibility');
        this.realClick(el);
        return done(pressed ? 'accessibility+events' : 'events');
      }
      case 'hover':
        this.clock += COST.hover;
        if (el?.onHover) this.fire(el, 'onHover');
        return done('events');
      case 'drag':
        if (r.to?.onDrop) this.fire(r.to, 'onDrop', el);
        return done('events');
      case 'press_keys':
        this.pressKey(app, p.keys);
        return done('keys');
      case 'scroll':
        w.touch(app);
        return done('events');
      case 'type_text':
      case 'clear_field': {
        const text = p.action === 'clear_field' ? '' : String(p.text || '');
        this.clock += this.typingMs(text);
        if (!this.v0) {
          // Focus the (swapped) element: on a label it "succeeds" without moving the focus.
          if (p.target && el && EDITABLE.has(el.role)) w.focus(el);
          this.typeInto(app, text);
          return done(text.length > 20 ? 'paste' : 'keys');
        }
        // A cell by its reference: there first (the Name Box), then typing in the grid.
        if (r.cell) {
          w.select(app, r.cell);
          return this.typeInCell(app, p, before);
        }
        // The focus guard.
        let f = w.focused(app);
        // The grid of a spreadsheet as the target: the keyboard only has to be in the grid (never a
        // click in the middle of it, which would select another cell).
        if (this.isGrid(el) && !this.isGrid(f)) {
          return { ok: false, error: 'focus_guard', focused: f ? `${f.role} ${f.title || f.desc || ''}` : 'nothing', message: "The keyboard isn't in the sheet, so nothing was typed. Give the cell as the target (into: \"A1\") and Echo goes there itself." };
        }
        if (this.isGrid(f) && (!el || this.isGrid(el))) return this.typeInCell(app, p, before);
        if (p.target || p.ref) {
          if (!el || !(f && (f.id === el.id))) {
            if (el && EDITABLE.has(el.role)) w.focus(el);
            else this.realClick(el);
            f = w.focused(app);
          }
          if (!f || !EDITABLE.has(f.role) || (el && f.id !== el.id && f.parent !== el.id && el.parent !== f.id && !(el.parent && f.parent === el.parent))) {
            return { ok: false, error: 'focus_guard', focused: f ? `${f.role} ${f.title || f.desc || ''}` : 'nothing', message: "The cursor isn't in that field, so nothing was typed." };
          }
        } else if (!f || !EDITABLE.has(f.role)) {
          return { ok: false, error: 'focus_guard', focused: f ? `${f.role} ${f.title || ''}` : 'nothing', message: 'Nothing editable has the keyboard focus.' };
        }
        const replaced = p.mode === 'replace' || p.action === 'clear_field';
        const held = f.value || '';
        // It already says that: nothing is typed a second time.
        const holds = text ? alreadyHolds(text, held, replaced) : '';
        if (holds) return { ok: true, via: 'none', app, window: w.apps.get(app)?.window || '', already: holds, holds: held, verified: holds === 'same', changes: [], observed: { focus: f.title || f.desc || '', value: held } };
        if (replaced && held) {
          // Emptied first, and seen to be empty (ClearMath.plan): its text selected and deleted, or
          // set to nothing through Accessibility. A field where neither works is left as it was.
          if (!f.noSelect || f.settable) {
            f.value = '';
            f.selectAll = false;
            f.onInput?.(w);
            w.touch(app);
          } else {
            return { ok: false, error: 'cant_clear', focused: `${f.role} ${f.title || f.desc || ''}`, message: "Couldn't empty that field first, so nothing was typed over it." };
          }
        }
        if (p.action !== 'clear_field') this.typeInto(app, text);
        const now = w.focused(app);
        const value = now?.value || '';
        this.clock += COST.verify;
        return { ok: true, via: 'keys', app, window: w.apps.get(app)?.window || '', verified: typedExactly(text, value, { replaced, before: replaced ? undefined : held }), changes: changes(before, w.snapshot(app)), observed: { focus: now?.title || now?.desc || '', value } };
      }
      default:
        return { ok: false, error: 'bad_action' };
    }
  }

  wait(p) {
    const w = this.world;
    const app = this.appFor(p.app);
    const hit = this.find(app, p.target, {});
    // The chips and dialogs Gmail shows are in the page; a wait searches the whole app.
    this.clock += Math.min(Number(p.timeoutMs || 1000), hit ? 300 : Number(p.timeoutMs || 1000));
    return { ok: true, found: Boolean(hit), via: 'accessibility' };
  }
}

/* ---------- scenes: the apps as they were on Sept 28–29 ---------- */

/** Chrome with Gmail's inbox, the toolbar, tabs and the profile button in front of it. */
export function gmailScene(w, { composeOpenByAX = false } = {}) {
  const app = 'Google Chrome';
  w.app(app, { window: 'Inbox (3) - sam@example.com - Gmail', url: 'https://mail.google.com/mail/u/0/#inbox' });
  w.front = app;
  // Chrome's own controls (shallow, searched first by the legacy driver).
  w.add({ app, role: 'AXTab', title: 'Inbox (3) - sam@example.com - Gmail', chrome: true });
  w.add({ app, role: 'AXButton', title: 'Sam', desc: 'Profile', chrome: true });
  w.add({ app, role: 'AXMenuItem', title: 'Manage Your Google Account', chrome: true, hidden: true });
  w.add({ app, role: 'AXTextField', title: 'Address and search bar', chrome: true, value: 'mail.google.com/mail/u/0/#inbox' });
  // The page. Compose: a div role=button that ignores an Accessibility press (04:05Z).
  const compose = w.add({ app, role: 'AXButton', title: 'Compose', web: true, pressAX: composeOpenByAX, onPress: (ww) => openCompose(ww) });
  w.add({ app, role: 'AXStaticText', value: 'Compose', web: true, parent: compose.id });
  w.add({ app, role: 'AXRow', title: 'Re: compose the quarterly draft by Friday please, and the subject line for it', web: true });
  w.add({ app, role: 'AXLink', title: 'Inbox 3', web: true });
  const search = w.add({ app, role: 'AXComboBox', desc: 'Search mail', placeholder: 'Search mail', web: true, onReturn: (ww) => { ww.set('mailSearch', search.value); ww.apps.get(app).url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(search.value || '')}`; ww.touch(app); } });
  const inboxList = w.add({ app, role: 'AXGroup', title: 'Message list', web: true, shortcut: true });
  w.focus(inboxList);
  return { app, compose };
}

/** Gmail's compose dialog: To (a chip combobox, with its "To" label), Subject, body, Send. */
export function openCompose(w) {
  const app = 'Google Chrome';
  if ([...w.els.values()].some((e) => e.title === 'New Message')) return;
  const dlg = w.add({ app, role: 'AXGroup', title: 'New Message', web: true });
  w.add({ app, role: 'AXStaticText', value: 'To', web: true, parent: dlg.id });
  const subject = w.add({ id: 'subject', app, role: 'AXTextField', desc: 'Subject', placeholder: 'Subject', web: true, parent: dlg.id });
  const body = w.add({ id: 'body', app, role: 'AXTextArea', desc: 'Message Body', web: true, parent: dlg.id });
  const to = w.add({ id: 'to', app, role: 'AXComboBox', desc: 'To recipients', web: true, parent: dlg.id, commit: 'chip' });
  /** @type {any} */ (to).next = subject.id;
  /** @type {any} */ (subject).next = body.id;
  // Send: the message goes and the compose window closes.
  w.add({ app, role: 'AXButton', title: 'Send ‪(⌘Enter)‬', desc: 'Send', web: true, parent: dlg.id, onPress: (ww) => { ww.set('sent', true); for (const e of [...ww.els.values()]) if (e.parent === dlg.id || e.id === dlg.id) e.hidden = true; ww.touch(app); } });
  w.focus(to);
  w.touch(app);
}

/** A generic page in Chrome with some links and a search box, plus YouTube's player. */
export function chromeScene(w, { youtube = false } = {}) {
  const app = 'Google Chrome';
  w.app(app, { window: youtube ? 'Lofi beats - YouTube' : 'Google', url: youtube ? 'https://www.youtube.com/watch?v=x' : 'https://www.google.com/' });
  w.front = app;
  w.add({ app, role: 'AXTab', title: youtube ? 'Lofi beats - YouTube' : 'Google', chrome: true });
  w.add({ app, role: 'AXButton', title: 'New Tab', chrome: true, onPress: (ww) => { ww.apps.get(app).windows++; ww.touch(app); } });
  w.add({ app, role: 'AXTextField', title: 'Address and search bar', chrome: true, value: youtube ? 'youtube.com/watch?v=x' : 'google.com' });
  const search = w.add({ app, role: 'AXComboBox', title: 'Search', placeholder: 'Search', web: true, value: 'otters', onReturn: (ww) => { ww.set('searched', search.value); ww.apps.get(app).url = `https://www.google.com/search?q=${encodeURIComponent(search.value || '')}`; ww.touch(app); } });
  const result = w.add({ app, role: 'AXLink', title: 'Sea otter - Wikipedia', web: true, onPress: (ww) => { ww.apps.get(app).url = 'https://en.wikipedia.org/wiki/Sea_otter'; ww.apps.get(app).window = 'Sea otter - Wikipedia'; ww.touch(app); } });
  w.add({ app, role: 'AXStaticText', value: 'Sea otter - Wikipedia', web: true, parent: result.id });
  w.add({ app, role: 'AXLink', title: 'Images', web: true, onPress: (ww) => { ww.apps.get(app).url = 'https://www.google.com/imghp'; ww.touch(app); } });
  // An image whose menu has "Save Image As…" (right-click only).
  const img = w.add({ app, role: 'AXImage', desc: 'Otter photo', web: true, onRight: (ww) => { ww.apps.get(app).menuOpen = true; saveItem.hidden = false; ww.touch(app); } });
  const saveItem = w.add({ app, role: 'AXMenuItem', title: 'Save Image As…', hidden: true, onPress: (ww) => { ww.set('savedImage', true); ww.apps.get(app).menuOpen = false; ww.touch(app); } });
  void img;
  if (youtube) {
    const player = w.add({ app, role: 'AXGroup', title: 'YouTube Video Player', web: true });
    w.apps.get(app).keys = {
      k: (ww) => { ww.set('playing', !ww.get('playing')); ww.touch(app); },
      f: (ww) => { ww.set('fullscreen', true); ww.touch(app); },
      'shift+n': (ww) => { ww.set('next', true); ww.apps.get(app).window = 'Next video - YouTube'; ww.touch(app); },
      c: (ww) => { ww.set('captions', true); ww.touch(app); },
    };
    void player;
  }
  // "Date" on the page (sort results by date): the legacy search went to the menu bar clock.
  w.add({ app, role: 'AXLink', title: 'Date', web: true, onPress: (ww) => { ww.set('sortedByDate', true); ww.touch(app); } });
  return { app, search };
}

/** Menu bar extras (the legacy driver searched these first for "Date", "Time"…). */
export function menuExtras(w) {
  w.app('Control Center');
  w.add({ app: 'Control Center', role: 'AXMenuBarItem', title: 'Clock', desc: 'Clock', extra: true, onPress: (ww) => ww.set('clockMenu', true) });
  w.add({ app: 'Control Center', role: 'AXMenuBarItem', title: 'Wi‑Fi', desc: 'Wi-Fi', extra: true, onPress: (ww) => ww.set('wifiMenu', true) });
}

/** Finder with a window of files. */
export function finderScene(w) {
  const app = 'Finder';
  w.app(app, { window: 'Desktop' });
  w.front = app;
  const trash = w.add({ app, role: 'AXDockItem', title: 'Trash', onDrop: (ww, from) => { ww.set('trashed', from.title); ww.remove(from.id); } });
  void trash;
  const folder = w.add({ app, role: 'AXCell', title: 'Projects', onDrop: (ww, from) => ww.set('moved', from.title) });
  void folder;
  const file = w.add({ app, role: 'AXCell', title: 'Budget 2026.xlsx', onPress: (ww) => ww.set('selected', 'Budget 2026.xlsx'), onRight: (ww) => { ww.apps.get(app).menuOpen = true; share.hidden = false; ww.touch(app); } });
  const share = w.add({ app, role: 'AXMenuItem', title: 'Share…', hidden: true, onPress: (ww) => { ww.set('shareOpen', true); ww.touch(app); } });
  void file;
  const search = w.add({ app, role: 'AXSearchField', title: 'Search', web: false, onReturn: (ww) => { ww.set('finderSearch', search.value); ww.touch(app); } });
  w.apps.get(app).keys = { 'cmd+delete': (ww) => { if (ww.get('selected')) { ww.set('trashed', ww.get('selected')); ww.touch(app); } } };
  return { app };
}

/** FaceTime in a call: the share button only shows on hover (Sept 29, 9:59 AM). */
export function facetimeScene(w) {
  const app = 'FaceTime';
  w.app(app, { window: 'FaceTime' });
  w.front = app;
  const share = w.add({ app, role: 'AXButton', title: 'Share Screen', hidden: true, onPress: (ww) => ww.set('sharing', true) });
  w.add({ app, role: 'AXGroup', title: 'Call window', onHover: (ww) => { share.hidden = false; ww.touch(app); } });
  return { app };
}

/** System Settings, and a Notes window. */
export function settingsScene(w) {
  const app = 'System Settings';
  w.app(app, { window: 'General' });
  w.front = app;
  w.add({ app, role: 'AXRow', title: 'Appearance', onPress: (ww) => { ww.apps.get(app).window = 'Appearance'; ww.touch(app); } });
  w.add({ app, role: 'AXRow', title: 'Displays', onPress: (ww) => { ww.apps.get(app).window = 'Displays'; ww.touch(app); } });
  w.add({ app, role: 'AXRow', title: 'Sound', onPress: (ww) => { ww.apps.get(app).window = 'Sound'; ww.touch(app); } });
  w.add({ app, role: 'AXCheckBox', title: 'Dark', onPress: (ww) => { ww.set('dark', true); ww.touch(app); } });
  return { app };
}

export function notesScene(w) {
  const app = 'Notes';
  w.app(app, { window: 'Notes' });
  w.front = app;
  const body = w.add({ app, role: 'AXTextArea', desc: 'Note body', value: '' });
  w.apps.get(app).keys = { 'cmd+n': (ww) => { body.value = ''; ww.focus(body); ww.touch(app); ww.set('newNote', true); } };
  const list = w.add({ app, role: 'AXOutline', title: 'Notes list' });
  w.focus(list);
  return { app, body };
}

/**
 * Excel as it was on Oct 3: the Name Box, the Formula Bar (⌘A there selects the cells, not its
 * text), the grid ("Content Area", a layout area) and the ribbon's Bold button. `cells`: what the
 * sheet holds ({ A5: 'Total' }); `sel`: the selected cell; `barSettable`: whether the formula
 * bar's value can be set through Accessibility.
 */
export function excelScene(w, { cells = {}, sel = 'A1', barSettable = false } = {}) {
  const app = 'Microsoft Excel';
  w.app(app, { window: 'Book1', sheet: { sel, cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, { v, bold: false }])) } });
  w.front = app;
  w.add({ app, role: 'AXComboBox', title: 'Name Box', value: sel, onReturn: (ww) => { const box = [...ww.els.values()].find((e) => e.app === app && e.title === 'Name Box'); const ref = cellRef(box?.value); if (ref) ww.select(app, ref); } });
  const bar = w.add({ app, role: 'AXTextArea', title: 'Formula Bar', value: '', noSelect: true, settable: barSettable, onInput: (ww) => { ww.cell(app).v = bar.value || ''; } });
  w.add({ app, role: 'AXCheckBox', title: 'Bold', value: '0', onPress: (ww) => { const c = ww.cell(app); c.bold = !c.bold; ww.syncSheet(app); } });
  const grid = w.add({ app, role: 'AXLayoutArea', title: 'Content Area' });
  const inGrid = (ww) => ww.focused(app)?.id === grid.id;
  const row = (ref, by) => ref.replace(/\d+$/, (n) => String(Math.max(1, Number(n) + by)));
  w.apps.get(app).keys = {
    // Formatting changes nothing but the ribbon's button (no window, focus or content change).
    'cmd+b': (ww) => { if (inGrid(ww)) { const to = !ww.cell(app).bold; for (const c of ww.selected(app)) c.bold = to; ww.syncSheet(app); } },
    // Escape leaves a cell that was being edited (scripts are refused until then).
    escape: (ww) => { ww.apps.get(app).sheet.editing = false; },
    return: (ww) => { if (inGrid(ww)) ww.select(app, row(ww.apps.get(app).sheet.sel, 1)); },
    delete: (ww) => { if (inGrid(ww)) ww.enter(app, ''); },
  };
  w.focus(grid);
  w.syncSheet(app);
  return { app, grid, bar };
}

export function messagesScene(w) {
  const app = 'Messages';
  w.app(app, { window: 'Messages' });
  w.front = app;
  const field = w.add({ app, role: 'AXTextArea', desc: 'iMessage', placeholder: 'iMessage', value: '', onReturn: (ww) => { ww.set('messageSent', field.value); field.value = ''; ww.touch(app); } });
  w.add({ app, role: 'AXRow', title: 'Sam', onPress: (ww) => { ww.set('chat', 'Sam'); ww.focus(field); ww.touch(app); } });
  return { app, field };
}

/** The Echo Chrome extension on the simulated Chrome: page snapshots with refs, trusted input. */
export class SimBrowser {
  /** @param {World} world @param {SimBridge} bridge (its clock) */
  constructor(world, bridge) {
    this.w = world;
    this.bridge = bridge;
    this.connected = true;
    this.n = 0;
    this.snap = '';
    this.refs = new Map();
  }

  async snapshot() {
    const app = 'Google Chrome';
    this.bridge.clock += 120;
    const els = this.w.visible(app).filter((e) => e.web && (INTERACTIVE.has(e.role) || e.role === 'AXImage'));
    this.snap = `s${++this.n}`;
    this.refs = new Map(els.map((e, i) => [`e${i + 1}`, e]));
    const role = (r) => ({ AXButton: 'button', AXLink: 'link', AXTextField: 'textbox', AXTextArea: 'textbox', AXComboBox: 'combobox', AXSearchField: 'searchbox', AXCheckBox: 'checkbox', AXRow: 'row', AXImage: 'img', AXMenuItem: 'menuitem' })[r] || 'other';
    const a = this.w.apps.get(app);
    return { snapshot: this.snap, url: a?.url || '', title: a?.window || '', elements: els.map((e, i) => ({ ref: `e${i + 1}`, role: role(e.role), name: e.title || e.desc || e.placeholder || '', value: EDITABLE.has(e.role) ? e.value || '' : '', editable: EDITABLE.has(e.role), secret: Boolean(e.secure), ...(e.fileInput ? { file: true } : {}) })) };
  }

  read(el) {
    const a = this.w.apps.get('Google Chrome');
    return { exists: this.w.els.has(el.id) && !el.hidden, value: el.value || '', focused: a?.focus === el.id, url: a?.url || '', title: a?.window || '', nodes: a?.version || 0, files: (el.files || []).length };
  }

  async act({ snapshot, ref, verb, text = '', commit = '', files = [] }) {
    const el = snapshot === this.snap ? this.refs.get(ref) : null;
    if (!el || !this.w.els.has(el.id)) throw Object.assign(new Error(`${ref} is stale`), { code: 'stale' });
    this.bridge.clock += 150;
    const before = this.read(el);
    const w = this.w;
    if (verb === 'click' || verb === 'fill' || verb === 'replace') this.bridge.realClick(el);
    if (verb === 'right_click' && el.onRight) this.bridge.fire(el, 'onRight');
    if (verb === 'hover' && el.onHover) this.bridge.fire(el, 'onHover');
    if (verb === 'fill' || verb === 'replace') {
      w.focus(el);
      el.value = verb === 'replace' ? text : (el.value || '') + text;
      w.touch(el.app);
      this.bridge.clock += Math.min(COST.typingCap, text.length * 8);
    }
    if (verb === 'upload') {
      el.files = files;
      el.onUpload?.(w, files);
      w.touch(el.app);
    }
    const filled = commit && (verb === 'fill' || verb === 'replace') ? this.read(el) : null;
    if (commit) this.bridge.pressKey('Google Chrome', { enter: 'return', tab: 'tab', comma: ',' }[commit]);
    return { before, after: this.read(el), via: 'debugger', ...(filled ? { filled } : {}) };
  }
}

/** The local UI grounder on the simulated screen: finds a drawn thing by what it looks like. */
export function simGround(world) {
  return async (description) => {
    const words = String(description).toLowerCase().split(/\W+/).filter((x) => x.length > 3);
    const el = world.visible(world.front).find((e) => e.looks && words.some((x) => e.looks.includes(x)));
    return el?.at ? { x: el.at.x, y: el.at.y, raw: `(${el.at.x}, ${el.at.y})` } : { error: 'not_found', message: 'not found' };
  };
}
