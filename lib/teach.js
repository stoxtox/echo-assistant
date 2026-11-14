// Teaching mode: Echo gives one step at a time, watches the user do it, and checks it before moving on.
//
// This is the engine from the teaching-mode design (research task 138, R4), and the one way Echo
// walks the user through an app: every step says one short thing, declares a check (a cell's
// value, the selection, a label showing up), and the engine polls that check every half second.
// Echo never clicks or types for the user here.
//
// A quick lesson (`quick`, what used to be a separate "guide": "where's Wi-Fi?", "just show me
// where things are") is the same thing with less in it. Its steps need no checks of their own:
// each is done when the next step's target shows up (`appears`), and the last is only pointed
// out. Every step begins with the light on it, nothing is acknowledged and no story is told, and
// it stops, telling the assistant, when the light can't find a step (quickLesson below).
//
//   INSTRUCT → point (the light waits there until the step passes, is skipped or the lesson
//               stops: a hold with an id, let go with `release`, docs/firefly-protocol.md),
//               update the card, speak `say` once
//   WATCH    → poll the check; it must hold for 2 polls in a row, and the lesson must have seen it
//               not hold first (a check already true when the step began proves nothing: Echo then
//               asks "tell me when you've done it" and takes the user's word)
//     ├ pass        → tick, what the check saw ("A1 says Hello."; "That works too." for another
//     │               way), 600 ms, the step's story if it may be told (then quiet), next step
//     ├ collateral  → cells outside the step changed (a fill-handle copy, a lost formula):
//     │               "Oops, that changed B3 to B5. Say 'undo' and I'll fix it." at once
//     ├ near-miss   → a gentle correction (wrong cell, a typo, a wrong range), at most one per 10 s
//     ├ editing     → silent: the user is typing in a cell
//     ├ "done"      → Echo looks now and says in one sentence what it sees against what the step
//     │               wanted ("I can see Hello in A5, not A1"); close enough (closeEnough) passes
//     │               with "That works too."; not done is one rung more help
//     ├ a remark    → one or two words that are no command and no question ("okay", "hmm"):
//     │               silence, and the watch goes on; three in a minute with no step passed: one
//     │               line saying what Echo is waiting for, and the offer
//     ├ idle 12 s   → one rung more help (below); idle 45 s → the model hears, in case the step
//     │               can't work as written
//     └ idle 2 min  → pause the lesson and tell the model the user went quiet
//
// How much help a step gets is the help ladder (lib/ladder.js), one rung at a time: wait → a
// general prompt (the step's `prompt`, else one by check kind) → a hint in words (its `hint`, else
// the target's label) → the light points and holds → Echo does the first half (a step with a
// `first_half`) → Echo offers to do the step. Up a rung: 12 s with nothing happening, a wrong try
// the check sees, "done" when it isn't, or "where?" / "help" (at once). "Show me" shows the step
// straight away and "just do it" does it; anything frustrated is acknowledged and gets the offer. The climb
// onto a rung where Echo acts takes two misses or twice the idle time. A step
// begins one rung below where the last one ended (the first two at the point), and a user who is
// ahead ("I know this", "skip", two fast steps) gets shorter lines and no prompt unless asked.
// A user who needs little (ahead, or three steps in a row with no more than a prompt) hears no
// acknowledgements either. The lesson ends with one line of what they did and its closing line.
//
// Three ways to learn, the lesson's `mode`, which the user changes at any moment in plain words
// (RESEARCH.md rule 16): 'guide' (the user does each step; the default), 'show' (Echo does each
// step at a watchable pace: "show me the whole lesson", "keep showing") and 'do' ("do the rest":
// the lesson ends and the assistant does what is left at full speed). "Show me" on one step
// shows that step and offers the turn back; "just do it" does that step at full speed; "let me
// try" hands the lesson back. A demonstrated step goes: one line of intent ("I'll select the top
// row."), a pause, the step itself with nothing said (the assistant does it with its computer
// tools; the lesson only reads the screen), the result sits, then one line of what changed.
// After a whole lesson was shown Echo asks "Want to try it yourself now?", and on yes starts it
// again from step 1 in guide mode, every step a rung lower.
//
// The story (RESEARCH.md 3.5): a step may carry a `why`, one sentence that is not instruction.
// It is said only right after that step passes (mayTellStory), then Echo is quiet for a moment,
// and anything said in that quiet is a question about the story for the assistant. The lesson's
// `opening` is said once before step 1 and its `closing` after the last, behind a one-line recap.
// A passed step is acknowledged with what the check saw ("A1 says Hello."), never a fixed word.
//
// The engine only reads the screen through an adapter, so it's tested with a fake one. A snapshot is
// `{ editing?, active?, selection?, cells: { A1: { value, formula, format, bold } }, charts?, labels?, ui?, elements? }`.
// In Excel and Numbers `sheetAdapter` fills cells through the app's scripting (lib/sheets.js), so
// cell_value, selection and bold checks are seen. `uiAdapter` below works in any app, through
// the Mac app's read-only `state` request (Accessibility only, no screen capture): `ui` is the front
// app, window, page, open menus and the focused field; `elements` the state of controls the steps
// name (selected, expanded, value). Its checks (app_front, window_title, menu_open, url_contains,
// focused, field_value, element_state, element_value, label_gone) need no app-specific adapter.
// A label check is the WHOLE label ("Rectangle 1" is not the Rectangle tool); label_contains is the
// explicit loose one. `told` is a step nothing on screen can prove: the user says when it's done.
// The session runs in the background: start() returns at once, and the model only hears back on
// exceptions (a question, three failed tries, the user going quiet, the lesson ending).

import { PASSWORD_UI } from './policy.ts';
import { cleanRoute, cleanPlace, whereWords } from './screen.js';
import { HelpLadder, RUNG, LADDER_ASKED_MS } from './ladder.js';
import { estimateMs } from './voicestate.js';

export const TEACH_MAX_STEPS = 12;
export const TEACH_POLL_MS = 500;
/** While Echo can't see the screen: one check-in after this long. */
export const TEACH_HINT1_MS = 20 * 1000;
/** Nothing changing for this long: the model hears, in case the step can't work as written. */
export const TEACH_STUCK_MS = 45 * 1000;
export const TEACH_IDLE_MS = 2 * 60 * 1000;
export const TEACH_PRAISE_MS = 600;
export const TEACH_CORRECTION_GAP_MS = 10 * 1000;
export const TEACH_QUESTION_PAUSE_MS = 15 * 1000;
/** Corrections on one step before the model is told the user is struggling. */
export const TEACH_TRIES = 3;
/** Polls in a row Echo can't see the screen before it says so (and the model hears). */
export const TEACH_BLIND_POLLS = 4;
/** A screen read slower than this turns the screen-text fallback off for the lesson. */
export const TEACH_SCREEN_TEXT_MS = 2500;
/** No request to the Mac app may hold a poll up longer than this. */
export const TEACH_REQUEST_MS = 3000;
/** How long "Want me to do this step for you?" waits for its yes. */
export const TEACH_OFFER_MS = 30 * 1000;
/** This many remarks inside this long with no step passed, and Echo says what it is waiting for. */
export const TEACH_REMARKS = 3;
export const TEACH_REMARKS_MS = 60 * 1000;
/**
 * The pace of a demonstration, to be tuned on a real Mac. `leadMs`: the pause between Echo's line
 * of intent and the light setting off. `sitMs`: how long the result sits before Echo says what
 * changed.
 */
export const SHOW_PACE = { leadMs: 600, sitMs: 1000 };
/** After a `why`, Echo is quiet this long (they may want to respond) before the next step's line. */
export const TEACH_STORY_QUIET_MS = 2000;
/** A `why` longer than this is not one breath: it is dropped. */
export const TEACH_WHY_MAX = 160;
/** A `why` is not told within this many steps of the last one. */
export const TEACH_WHY_GAP = 2;
/** The first steps that begin a rung lower in an app the user did well in last time. */
export const TEACH_KNOWN_STEPS = 2;
export const LESSON_MODES = ['guide', 'show', 'do'];

/**
 * About how long a line takes to say (lib/voicestate.js). The pauses that must come after a line
 * (before a demonstration moves, after the story, before a question times out) count from the
 * line's real end when the voice reports it; this stands in only when nothing does.
 * @param {string} line
 */
export const spokenMs = (line) => estimateMs(text(line).length);

/** The promise, or an Error('slow') after ms; the late answer is ignored. */
function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('slow')), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** How many steps ahead a user may jump (they did the next step another way). */
const LOOKAHEAD = 2;

export const CHECK_KINDS = ['selection', 'cell_value', 'cell_formula', 'number_format', 'bold', 'sorted', 'chart_exists', 'label_present', 'any_of', 'all_of',
  // Any app (uiAdapter):
  'app_front', 'window_title', 'menu_open', 'url_contains', 'focused', 'field_value', 'element_state', 'element_value', 'label_gone', 'label_contains',
  // The next thing a step leads to shows up, found the way the light finds it (a quick lesson's check):
  'appears',
  // Nothing on screen can prove it: Echo asks the user to say when it's done.
  'told'];

/** Checks that read a sheet's cells. An adapter that carries no cells (uiAdapter) can't see them. */
export const CELL_KINDS = ['selection', 'cell_value', 'cell_formula', 'number_format', 'bold', 'sorted', 'chart_exists'];
/** The cell checks Echo can see in Excel and Numbers through their scripting (sheetAdapter, lib/sheets.js). */
export const SHEET_SEEN = ['selection', 'cell_value', 'bold'];
/** Checks that read a control by its label through the `state` request. */
const ELEMENT_KINDS = ['element_state', 'element_value'];
/** Checks that look a whole label up on screen. */
const LABEL_KINDS = ['label_present', 'label_gone'];

/** A label as compared: lower case, accents off, punctuation and dashes as single spaces. Keep in step with LabelMatch.normalize (macos/Sources/PointMath.swift). */
export const foldLabel = (s) => text(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Is the label seen on screen the one asked for? 'exact': the whole label, case, spacing and
 * punctuation folded ("Wi‑Fi" is "wifi"), so "Rectangle" (the tool) is never "Rectangle 1" (the
 * layer the user drew: on Oct 3 that prefix match skipped a lesson from step 1 to step 5).
 * 'contains': the label holds the words asked for. Keep in step with LabelMatch.fits.
 * @param {any} seen @param {any} want @param {'exact' | 'contains'} [mode]
 */
export function labelFits(seen, want, mode = 'exact') {
  const c = foldLabel(seen), q = foldLabel(want);
  if (!c || !q) return false;
  if (c === q) return true;
  const cc = c.replaceAll(' ', ''), qc = q.replaceAll(' ', '');
  if (cc === qc && qc.length >= 3) return true;
  return mode === 'contains' && ` ${c} `.includes(` ${q} `);
}

const has = (got, want) => Boolean(text(want)) && text(got).toLowerCase().includes(text(want).toLowerCase());

/**
 * Does a value match equals (exact, case-insensitive), contains, or approx ± tolerance (numbers)?
 * @param {any} check @param {any} got
 */
function valueFits(check, got) {
  const v = text(got);
  if (check.approx !== undefined) {
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return v !== '' && Number.isFinite(n) && Math.abs(n - Number(check.approx)) <= Number(check.tolerance ?? Math.max(1, Math.abs(Number(check.approx)) * 0.05));
  }
  if (check.equals !== undefined) return v.toLowerCase() === text(check.equals).toLowerCase();
  if (check.contains !== undefined) return has(v, check.contains);
  return v !== '';
}

/** A control's state against the step: every state the check names must hold. */
function stateFits(check, el) {
  if (!el?.present) return false;
  const flags = { selected: el.selected, expanded: el.expanded, enabled: el.enabled, checked: el.value === undefined ? undefined : ['1', 'true', 'on'].includes(text(el.value).toLowerCase()) };
  const named = Object.keys(flags).filter((k) => check[k] !== undefined);
  return named.every((k) => flags[k] === Boolean(check[k]));
}

/* ---------- cell addresses ---------- */

const A1_RE = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/i;

/** True for "B2", "$B$2" or "B2:B5". */
export function isCellAddress(s) {
  const parts = String(s || '').trim().split(':');
  return parts.length <= 2 && parts.every((p) => A1_RE.test(p));
}

/** "B2" → { col: 2, row: 2 }, or null. */
export function parseA1(s) {
  const m = A1_RE.exec(String(s || '').trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

/** 28 → "AB". */
export function colLetters(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const a1 = (col, row) => `${colLetters(col)}${row}`;
/** "$b$2" → "B2"; ranges are normalized part by part. */
export const normAddr = (s) => String(s || '').trim().split(':').map((p) => { const c = parseA1(p); return c ? a1(c.col, c.row) : p.trim().toUpperCase(); }).join(':');

/** Every cell of "B2:C3" (or just "B2"), row by row. */
export function expandRange(range) {
  const [from, to = from] = String(range || '').split(':').map(parseA1);
  if (!from || !to) return [];
  const out = [];
  for (let r = Math.min(from.row, to.row); r <= Math.max(from.row, to.row); r++)
    for (let c = Math.min(from.col, to.col); c <= Math.max(from.col, to.col); c++) out.push(a1(c, r));
  return out;
}

/** Same range? "B2" equals "B2:B2", and "B5:B2" equals "B2:B5". */
function sameRange(a, b) {
  const x = expandRange(normAddr(a)), y = expandRange(normAddr(b));
  return x.length > 0 && x.length === y.length && x.every((c) => y.includes(c));
}

/** "B3 to B5" for a run in one column or row, else a short list. */
export function describeCells(cells) {
  const list = [...new Set(cells.map(normAddr))].map((c) => ({ c, p: parseA1(c) })).filter((x) => x.p)
    .sort((a, b) => a.p.col - b.p.col || a.p.row - b.p.row);
  if (!list.length) return '';
  if (list.length === 1) return list[0].c;
  const sameCol = list.every((x) => x.p.col === list[0].p.col) && list.every((x, k) => x.p.row === list[0].p.row + k);
  const byRow = [...list].sort((a, b) => a.p.row - b.p.row || a.p.col - b.p.col);
  const sameRow = byRow.every((x) => x.p.row === byRow[0].p.row) && byRow.every((x, k) => x.p.col === byRow[0].p.col + k);
  if (sameCol) return `${list[0].c} to ${list[list.length - 1].c}`;
  if (sameRow) return `${byRow[0].c} to ${byRow[byRow.length - 1].c}`;
  if (list.length <= 3) return `${list.slice(0, -1).map((x) => x.c).join(', ')} and ${list[list.length - 1].c}`;
  return `${list.slice(0, 2).map((x) => x.c).join(', ')} and ${list.length - 2} more cells`;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const count = (n) => NUMBER_WORDS[n] || String(n);

/** "two cells to the left", said from where the user is to where we want them; '' if not in line. */
export function direction(from, to) {
  const f = parseA1(from), t = parseA1(to);
  if (!f || !t) return '';
  const dc = t.col - f.col, dr = t.row - f.row;
  const cells = (n) => `${count(n)} ${n === 1 ? 'cell' : 'cells'}`;
  if (dr === 0 && dc !== 0) return `${cells(Math.abs(dc))} to the ${dc < 0 ? 'left' : 'right'}`;
  if (dc === 0 && dr !== 0) return `${cells(Math.abs(dr))} ${dr < 0 ? 'up' : 'down'}`;
  return '';
}

/* ---------- checks (pure, over snapshots) ---------- */

const text = (v) => (v === undefined || v === null ? '' : String(v)).trim();
const cellOf = (snap, addr) => (snap?.cells && snap.cells[normAddr(addr)]) || {};
const isEmpty = (c) => !c || (text(c.value) === '' && text(c.formula) === '');
const squash = (f) => text(f).replace(/\s+/g, '').toUpperCase();

/** Does the value meet a cell_value check? */
function valueMatches(check, value) {
  const v = text(value);
  const ci = check.ci !== false;
  const eq = (a, b) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (check.equals !== undefined) return eq(v, text(check.equals));
  if (check.number !== undefined) return v !== '' && Number(v.replace(/[$,\s]/g, '')) === Number(check.number);
  if (check.contains !== undefined) return ci ? v.toLowerCase().includes(text(check.contains).toLowerCase()) : v.includes(text(check.contains));
  return v !== '';
}

function formulaMatches(check, formula) {
  if (!text(formula)) return false;
  try {
    return new RegExp(check.matches, 'i').test(squash(formula));
  } catch {
    return false;
  }
}

/** The numbers in column `by` of a range, skipping a header row. */
function columnNumbers(snap, range, by) {
  const cells = expandRange(range);
  const col = parseA1(`${by}1`)?.col;
  const vals = cells.filter((c) => parseA1(c).col === col).map((c) => text(cellOf(snap, c).value));
  const start = vals.length && Number.isNaN(Number(vals[0].replace(/[$,]/g, ''))) ? 1 : 0;
  return vals.slice(start).map((v) => Number(v.replace(/[$,]/g, '')));
}

/**
 * Is this check true in the snapshot?
 * @param {any} check
 * @param {any} snap
 * @returns {boolean}
 */
export function evalCheck(check, snap) {
  if (!check || !snap) return false;
  switch (check.kind) {
    case 'selection': {
      const want = check.range || check.cell;
      const got = snap.selection || snap.active;
      return Boolean(want && got) && sameRange(want, got);
    }
    case 'cell_value': return valueMatches(check, cellOf(snap, check.cell).value);
    case 'cell_formula': return formulaMatches(check, cellOf(snap, check.cell).formula);
    case 'number_format': {
      const cells = expandRange(check.range);
      return cells.length > 0 && cells.every((c) => text(cellOf(snap, c).format).includes(text(check.like)));
    }
    case 'bold': {
      const cells = expandRange(check.range);
      return cells.length > 0 && cells.every((c) => cellOf(snap, c).bold === true);
    }
    case 'sorted': {
      const nums = columnNumbers(snap, check.range, check.by || 'A');
      if (nums.length < 2 || nums.some((n) => Number.isNaN(n))) return false;
      const asc = String(check.order || 'asc').toLowerCase().startsWith('asc');
      return nums.every((n, k) => k === 0 || (asc ? nums[k - 1] <= n : nums[k - 1] >= n));
    }
    case 'chart_exists': return Number(snap.charts || 0) > 0;
    case 'label_present': return Boolean(snap.labels && snap.labels[check.label]);
    case 'label_gone': return Boolean(snap.labels) && snap.labels[check.label] === false;
    case 'label_contains': return Boolean(snap.contains && snap.contains[check.label]);
    case 'appears': return Boolean(snap.appears && snap.appears[check.label]);
    case 'told': return false; // only the user's word passes it (TeachSession.takesWord)
    case 'app_front': return has(snap.ui?.app, check.app) || has(snap.ui?.front, check.app);
    case 'window_title': return has(snap.ui?.window, check.contains);
    case 'menu_open': return Boolean(snap.ui) && Boolean(snap.ui.menuOpen) === (check.open ?? true);
    case 'url_contains': return has(snap.ui?.url, check.text);
    case 'focused': return has(snap.ui?.focus?.label, check.label) || has(snap.ui?.focus?.role, check.label);
    case 'field_value': return Boolean(snap.ui?.focus) && valueFits(check, snap.ui.focus.value);
    case 'element_state': return stateFits(check, snap.elements?.[check.label]);
    case 'element_value': return Boolean(snap.elements?.[check.label]?.present) && valueFits(check, snap.elements[check.label].value);
    case 'any_of': return (check.checks || []).some((c) => evalCheck(c, snap));
    case 'all_of': return (check.checks || []).length > 0 && check.checks.every((c) => evalCheck(c, snap));
    default: return false;
  }
}

/** The cells a check expects to change (the rest count as collateral). */
export function checkCells(check) {
  if (!check) return [];
  switch (check.kind) {
    case 'cell_value': case 'cell_formula': return [normAddr(check.cell)];
    case 'number_format': case 'bold': case 'sorted': return expandRange(check.range);
    case 'any_of': case 'all_of': return [...new Set((check.checks || []).flatMap(checkCells))];
    default: return [];
  }
}

/** The labels that checks of these kinds (nested ones too) need looked up. */
function checkNames(check, kinds) {
  if (!check) return [];
  if (kinds.includes(check.kind)) return [check.label];
  if (check.kind === 'any_of' || check.kind === 'all_of') return (check.checks || []).flatMap((c) => checkNames(c, kinds));
  return [];
}

/** The `appears` checks in a check (nested ones too): each names what to look for, and where. */
function appearsIn(check) {
  if (!check) return [];
  if (check.kind === 'appears') return [check];
  if (check.kind === 'any_of' || check.kind === 'all_of') return (check.checks || []).flatMap(appearsIn);
  return [];
}

/** The ways a step can pass: each branch of a top-level any_of, else the check itself. */
const branches = (check) => (check?.kind === 'any_of' ? check.checks || [] : [check]);

/** Cells whose value or formula differ between two snapshots. */
export function diffCells(before, after) {
  const a = before?.cells || {}, b = after?.cells || {};
  const out = [];
  for (const addr of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[addr] || {}, y = b[addr] || {};
    if (text(x.value) !== text(y.value) || text(x.formula) !== text(y.formula)) out.push({ cell: normAddr(addr), before: x, after: y });
  }
  return out;
}

/** Levenshtein distance, for "Cofee" vs "Coffee". */
export function editDistance(a, b) {
  const s = String(a), t = String(b);
  const row = Array.from({ length: t.length + 1 }, (_, k) => k);
  for (let i = 1; i <= s.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[t.length];
}

/** Does this changed cell hold what the step wanted, just somewhere else? */
function holdsExpected(check, c) {
  if (check?.kind === 'cell_value') return valueMatches(check, c.value);
  if (check?.kind === 'cell_formula') return formulaMatches(check, c.formula);
  return false;
}

/**
 * Changes outside the step's expected cells: overwritten values, lost formulas, a fill-handle copy.
 * One empty cell that now holds the step's expected entry is a misplaced entry (a near-miss), not collateral.
 * @param {any} step
 * @param {any} baseline the snapshot taken when the step started
 * @param {any} snap
 */
export function collateralChanges(step, baseline, snap) {
  const expected = new Set((step.expect_changes || checkCells(step.check)).map(normAddr));
  const outside = diffCells(baseline, snap).filter((d) => !expected.has(d.cell));
  const misplaced = outside.filter((d) => isEmpty(d.before) && holdsExpected(step.check, d.after));
  return misplaced.length === 1 && outside.length === 1 ? [] : outside;
}

/**
 * The gentle correction for a step that isn't done yet, or null. Never says "wrong".
 * @param {any} step
 * @param {any} baseline
 * @param {any} snap
 * @returns {{ key: string, say: string } | null}
 */
export function nearMiss(step, baseline, snap) {
  // Lesson-declared near-misses come first: "if this shows up, they went somewhere else".
  for (const n of step.near_miss || []) {
    if (n?.check && evalCheck(n.check, snap) && !evalCheck(n.check, baseline)) return { key: `custom:${JSON.stringify(n.check)}`, say: String(n.say || `Not quite. ${step.say}`) };
  }
  const check = step.check || {};
  if (check.kind === 'selection') {
    const want = normAddr(check.range || check.cell);
    const got = normAddr(snap.selection || snap.active || '');
    const was = normAddr(baseline?.selection || baseline?.active || '');
    if (!got || got === was || sameRange(got, want)) return null;
    const dir = !want.includes(':') && !got.includes(':') ? direction(got, want) : '';
    return { key: `sel:${got}`, say: `That's ${got}. We want ${want}${dir ? `, ${dir}` : ''}.` };
  }
  if (check.kind === 'cell_value' || check.kind === 'cell_formula') {
    const want = normAddr(check.cell);
    const changed = diffCells(baseline, snap);
    const elsewhere = changed.find((d) => d.cell !== want && isEmpty(d.before) && holdsExpected(check, d.after));
    if (elsewhere) {
      const dir = direction(elsewhere.cell, want);
      return {
        key: `moved:${elsewhere.cell}`,
        say: dir ? `That's ${elsewhere.cell}. We want ${want}, ${dir}.` : `Close. That went in ${elsewhere.cell}. Click ${want} and try again.`,
      };
    }
    const here = changed.find((d) => d.cell === want);
    if (!here) return null;
    const got = cellOf(snap, want);
    if (check.kind === 'cell_value' && check.equals !== undefined) {
      const v = text(got.value), e = text(check.equals);
      if (v && editDistance(v.toLowerCase(), e.toLowerCase()) <= 2) return { key: `typo:${v}`, say: `Almost. It says ${v}. Try ${e}.` };
      if (v) return { key: `value:${v}`, say: `That says ${v}. We want ${e} in ${want}.` };
    }
    if (check.kind === 'cell_formula') {
      const f = squash(got.formula), v = text(got.value);
      if (!f && /^[A-Z]+\(/i.test(v)) return { key: `astext:${v}`, say: 'Almost. Start the formula with an equals sign.' };
      const have = /\(([A-Z]{1,3}\d+):([A-Z]{1,3}\d+)\)/.exec(f);
      const wantRange = check.range ? normAddr(check.range) : '';
      if (have && wantRange && !sameRange(`${have[1]}:${have[2]}`, wantRange)) {
        const [w1, w2] = wantRange.split(':');
        return { key: `range:${f}`, say: `That adds ${have[1]} to ${have[2]}. We want ${w1} through ${w2}.` };
      }
      if (f) return { key: `formula:${f}`, say: `Not quite. ${step.hint || step.say}` };
    }
  }
  // Any app: another app came to the front, a typo in the field, a value close but not there yet.
  if (check.kind === 'app_front' && snap.ui?.app && snap.ui.app !== baseline?.ui?.app && !evalCheck(check, snap)) {
    return { key: `app:${snap.ui.app}`, say: `That's ${snap.ui.app}. We want ${check.app}.` };
  }
  if (check.kind === 'field_value' && check.equals !== undefined) {
    const v = text(snap.ui?.focus?.value), e = text(check.equals);
    if (v && v !== text(baseline?.ui?.focus?.value) && v.toLowerCase() !== e.toLowerCase() && editDistance(v.toLowerCase(), e.toLowerCase()) <= 2) {
      return { key: `ftypo:${v}`, say: `Almost. It says ${v}. Try ${e}.` };
    }
  }
  if (check.kind === 'element_value' && check.approx !== undefined) {
    const now = text(snap.elements?.[check.label]?.value), was = text(baseline?.elements?.[check.label]?.value);
    if (now && now !== was) return { key: `approx:${now}`, say: `That's ${now}. We want about ${check.approx}.` };
  }
  return null;
}

/** Anything Echo can see differs between two snapshots: cells, selection, labels, the app's state or a control's. */
export function changedSince(a, b) {
  const view = (x) => JSON.stringify([x?.selection || x?.active || '', x?.labels || {}, x?.contains || {}, x?.appears || {}, x?.ui || {}, x?.elements || {}, x?.charts || 0]);
  return diffCells(a, b).length > 0 || view(a) !== view(b);
}

/* ---------- "done", said by the user while the check doesn't hold ---------- */

const hasValue = (c) => Boolean(c) && (c.equals !== undefined || c.number !== undefined || c.contains !== undefined);
const wantedText = (c) => text(c?.equals ?? c?.number ?? c?.contains ?? c?.approx);

/**
 * What each cell is meant to hold, from the lesson's own cell_value steps: { A1: its check }.
 * @param {any[]} steps
 */
export function cellTexts(steps) {
  const out = {};
  for (const st of steps || []) for (const b of branches(st?.check)) if (b?.kind === 'cell_value' && hasValue(b)) out[normAddr(b.cell)] = b;
  return out;
}

/**
 * Close enough, per check kind: the step isn't done as written, but the difference doesn't matter
 * for learning. cell_value: the same text in any other cell passes (not one that held it before
 * the step). selection: any one cell holding the text meant for the wanted cell, selected, passes.
 * bold: any cell holding that text, in bold, passes. Other kinds: never (Echo can't tell from
 * the app's state; the assistant looks instead).
 * @param {any} check @param {any} snap
 * @param {{ baseline?: any, texts?: Record<string, any> }} [o] texts: cellTexts(steps)
 * @returns {{ say: string, moved: { from: string, to: string } } | null} say: what Echo sees against what the step wanted
 */
export function closeEnough(check, snap, { baseline = null, texts = {} } = {}) {
  if (!check || !snap) return null;
  const cells = Object.keys(snap.cells || {}).map(normAddr);
  const single = (a) => Boolean(a) && !a.includes(':');
  if (check.kind === 'cell_value') {
    const want = normAddr(check.cell);
    if (!hasValue(check)) return null;
    const at = cells.find((c) => c !== want && valueMatches(check, cellOf(snap, c).value) && !valueMatches(check, cellOf(baseline, c).value));
    return at ? { say: `I can see ${text(cellOf(snap, at).value)} in ${at}, not ${want}.`, moved: { from: want, to: at } } : null;
  }
  if (check.kind === 'selection') {
    const want = normAddr(check.range || check.cell), got = normAddr(snap.selection || snap.active || '');
    const holds = texts[want];
    if (!single(want) || !single(got) || got === want || !holds || !valueMatches(holds, cellOf(snap, got).value)) return null;
    return { say: `I can see ${got} selected, not ${want}.`, moved: { from: want, to: got } };
  }
  if (check.kind === 'bold') {
    const want = normAddr(check.range);
    const holds = texts[want];
    if (!single(want) || !holds) return null;
    const at = cells.find((c) => c !== want && cellOf(snap, c).bold === true && valueMatches(holds, cellOf(snap, c).value));
    return at ? { say: `I can see ${at} in bold, not ${want}.`, moved: { from: want, to: at } } : null;
  }
  return null;
}

/**
 * One specific sentence: what Echo sees against what the step wanted. '' when the app's state
 * shows nothing to name.
 * @param {any} check @param {any} snap
 */
export function seenVersusWanted(check, snap) {
  if (!check || !snap) return '';
  switch (check.kind) {
    case 'selection': {
      const want = normAddr(check.range || check.cell), got = normAddr(snap.selection || snap.active || '');
      return got && want && !sameRange(got, want) ? `I can see ${got} selected, not ${want}.` : '';
    }
    case 'cell_value': {
      const want = normAddr(check.cell), v = text(cellOf(snap, want).value), w = wantedText(check);
      if (v && !valueMatches(check, v)) return `I can see ${v} in ${want}${w ? `, not ${w}` : ''}.`;
      return v ? '' : `I can see ${want} is still empty.`;
    }
    case 'bold': return check.range ? `I can see ${normAddr(check.range)} isn't bold yet.` : '';
    case 'window_title': return text(snap.ui?.window) ? `I can see the ${text(snap.ui.window).slice(0, 60)} window, not ${text(check.contains)}.` : '';
    case 'app_front': return text(snap.ui?.app) ? `I can see ${text(snap.ui.app)} in front, not ${text(check.app)}.` : '';
    case 'field_value': {
      if (!snap.ui?.focus) return '';
      const v = text(snap.ui.focus.value), w = wantedText(check);
      return v ? `I can see ${v.slice(0, 60)} in the field${w ? `, not ${w}` : ''}.` : 'I can see the field is still empty.';
    }
    case 'element_value': {
      const v = text(snap.elements?.[check.label]?.value), w = wantedText(check);
      return v ? `I can see ${text(check.label)} at ${v.slice(0, 40)}${w ? `, not ${w}` : ''}.` : '';
    }
    default: return '';
  }
}

/**
 * The user says the step is done and its check doesn't hold. From one look: `ok` (close enough:
 * pass, with `moved` saying which cell stands in for the one the lesson named) or not, each with
 * the one sentence of what Echo sees; null when the look shows nothing to name.
 * @param {any} step @param {any} baseline @param {any} snap @param {Record<string, any>} [texts]
 * @returns {{ ok: boolean, say: string, moved?: { from: string, to: string } } | null}
 */
export function doneLook(step, baseline, snap, texts = {}) {
  for (const b of branches(step?.check)) {
    const near = closeEnough(b, snap, { baseline, texts });
    if (near) return { ok: true, ...near };
  }
  const see = seenVersusWanted(branches(step?.check)[0], snap);
  return see ? { ok: false, say: see } : null;
}

/**
 * The focused cell, when the app's state names one (a spreadsheet's focus is labelled with its
 * address): the snapshot with that one cell filled in. Otherwise the snapshot as it was.
 * @param {any} snap
 */
export function withFocusCell(snap) {
  const m = /^(?:cell\s+)?(\$?[A-Z]{1,3}\$?\d{1,7})$/i.exec(text(snap?.ui?.focus?.label));
  if (!m) return snap;
  const cell = normAddr(m[1]);
  return { ...snap, active: snap.active || cell, selection: snap.selection || cell, cells: { [cell]: { value: text(snap.ui.focus.value) }, ...(snap.cells || {}) } };
}

/** A later step, with the cell the lesson named swapped for the one the user really used (its check, its target and its words). */
export function moveCell(step, from, to) {
  const word = new RegExp(`\\b${from}\\b`, 'g');
  const swap = (v) => (typeof v === 'string' ? (isCellAddress(v) ? (normAddr(v) === from ? to : v) : v.replace(word, to)) : v);
  const deep = (o) => (Array.isArray(o) ? o.map(deep) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deep(v)])) : swap(o));
  return deep(step);
}

/** What the lesson is waiting to see, in one line, for a user who keeps talking and isn't getting anywhere. */
export function waitingFor(step) {
  const c = step?.check || {};
  switch (c.kind) {
    case 'cell_value': return hasValue(c) ? `I'm waiting to see ${wantedText(c)} in ${normAddr(c.cell)}.` : `I'm waiting for something in ${normAddr(c.cell)}.`;
    case 'cell_formula': return `I'm waiting for a formula in ${normAddr(c.cell)}.`;
    case 'selection': return `I'm waiting for ${normAddr(c.range || c.cell)} to be selected.`;
    case 'bold': return `I'm waiting for ${normAddr(c.range)} to turn bold.`;
    case 'window_title': return `I'm waiting for the ${text(c.contains)} window.`;
    case 'app_front': return `I'm waiting for ${text(c.app)} to come to the front.`;
    case 'menu_open': return "I'm waiting for the menu to open.";
    case 'label_present': case 'label_contains': case 'appears': return `I'm waiting for ${text(c.label)} to show up.`;
    case 'label_gone': return `I'm waiting for ${text(c.label)} to go away.`;
    case 'field_value': return wantedText(c) ? `I'm waiting for the field to say ${wantedText(c)}.` : "I'm waiting for you to type in the field.";
    case 'element_state': case 'element_value': return `I'm waiting for ${text(c.label)} to change.`;
    default: return `I'm waiting for this: ${text(step?.say)}`;
  }
}

/* ---------- what Echo says on each rung of the help ladder (lib/ladder.js) ---------- */

/**
 * Rung 1: one short line that doesn't give the answer. The step's own `prompt` when the lesson
 * wrote one, else one by what the step checks.
 * @param {any} step
 */
export function generalPrompt(step) {
  if (text(step?.prompt)) return text(step.prompt);
  const kind = branches(step?.check)[0]?.kind;
  if (step?.route || kind === 'menu_open') return 'Have a look along the menu bar.';
  if (['selection', 'cell_value', 'cell_formula'].includes(kind)) return 'Have a look at the sheet. Which cell is it?';
  if (kind === 'field_value' || kind === 'focused') return 'Where would you type that?';
  if (kind === 'app_front') return 'Have a look along the Dock.';
  return 'What do you think comes next?';
}

/**
 * Rung 2: where it is and what it looks like, in words. The step's own `hint`; else what it
 * points at, where first and then the thing, as people say it (RESEARCH.md 2.3): "It's in the
 * toolbar at the top left: the Rectangle button." `where` is what the Mac app said of the target
 * (`place`, `container`, `kind`: lib/screen.js cleanPlace); when it said nothing, only the label
 * ("Look for Rectangle."). '' when the step has neither: that rung is passed over.
 * @param {any} step @param {{ place?: string, container?: string, kind?: string } | null} [where]
 */
export function hintInWords(step, where) {
  const hint = text(step?.hint);
  if (hint && hint !== text(step?.say)) return hint;
  const t = step?.target;
  const routed = Array.isArray(step?.route) && step.route.length > 1;
  const label = routed ? step.route.join(', then ') : typeof t === 'string' ? text(t) : t?.cell ? `cell ${normAddr(t.cell)}` : '';
  if (!label) return '';
  const at = whereWords(where);
  if (!at) return `Look for ${label}.`;
  // The kind is said once ("the File menu", never "the File menu menu"), and never for a route:
  // the app only said what the first thing on it is.
  const kind = routed ? '' : cleanPlace(where).kind || '';
  const named = !kind ? label : label.toLowerCase().endsWith(kind) ? `the ${label}` : `the ${label} ${kind}`;
  return `It's ${at}: ${named}${/[.!?…]$/.test(named) ? '' : '.'}`;
}

/** What a lesson asks the app to find for a step's hint in words: the first label of its route, else its target. '' when there is nothing to ask (a hint the lesson wrote, a cell, no target). */
export function hintTarget(step) {
  const hint = text(step?.hint);
  if (hint && hint !== text(step?.say)) return '';
  if (Array.isArray(step?.route) && step.route.length > 1) return text(step.route[0]);
  return typeof step?.target === 'string' ? text(step.target) : '';
}

/** A step's line for a user who is ahead of the lesson: its last sentence. */
export const lastSentence = (say) => text(say).split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).at(-1) || text(say);

/* ---------- showing, the story and small wins (pure) ---------- */

/** Verbs a step's line may open with ("Click Dark." → "I'll click Dark."). */
const INTENT_VERBS = [...'click type press select drag choose open scroll enter pick tap find move go hold turn set switch draw make add put check uncheck close save copy paste use start change name fill hit double right'.split(' ')];

/**
 * What Echo says before it demonstrates a step: the step's own line, turned from an instruction
 * into intent ("Top left, click the square icon." → "Top left, I'll click the square icon.").
 * A line that doesn't open with a verb Echo knows gets a plain "I'll do this one."
 * @param {any} step
 */
export function intentLine(step) {
  const s = lastSentence(step?.say).replace(/[.!?\s]+$/, '');
  const m = /^((?:[^,]{1,30},\s+)?)([A-Za-z-]+)(.*)$/.exec(s);
  if (!m || !INTENT_VERBS.includes(m[2].toLowerCase().split('-')[0])) return "I'll do this one.";
  return `${m[1]}I'll ${m[2].toLowerCase()}${m[3].replace(/\byour\b/g, 'the')}.`;
}

const spokenRange = (r) => normAddr(r).replace(':', ' to ');
/** "Rectangle 1" (a thing the step made) is "the rectangle"; any other label is said as it is. */
const madeThing = (label) => {
  const m = /^(.*\D)\s+\d+$/.exec(label);
  return m ? `the ${m[1].trim().toLowerCase()}` : label;
};

/**
 * One short, specific line for a check that holds: what it saw ("A1 says Hello.", "That's the
 * rectangle."). The acknowledgement when a step passes, and what Echo says changed after it
 * demonstrates one. '' when the check names nothing worth saying.
 * @param {any} check a check that holds in `snap` @param {any} snap
 */
export function sawLine(check, snap) {
  if (!check) return '';
  const label = text(check.label).slice(0, 60);
  switch (check.kind) {
    case 'selection': return `${spokenRange(check.range || check.cell)} is selected.`;
    case 'cell_value': {
      const v = text(cellOf(snap, check.cell).value).slice(0, 40);
      return v ? `${normAddr(check.cell)} says ${v}.` : '';
    }
    case 'cell_formula': return `${normAddr(check.cell)} has its formula.`;
    case 'number_format': return `${spokenRange(check.range)} is formatted.`;
    case 'bold': return `${spokenRange(check.range)} is bold now.`;
    case 'sorted': return "That's sorted.";
    case 'chart_exists': return "There's the chart.";
    case 'label_present': case 'label_contains': return label ? `That's ${madeThing(label)}.` : '';
    case 'label_gone': return label ? `${label} is gone.` : '';
    case 'app_front': return text(check.app) ? `${text(check.app)} is in front.` : '';
    case 'window_title': return text(check.contains) ? `That's the ${text(check.contains).slice(0, 60)} window.` : '';
    case 'menu_open': return (check.open ?? true) ? "The menu's open." : "The menu's closed.";
    case 'url_contains': return "That's the page.";
    case 'focused': return label ? `The cursor's in ${label}.` : '';
    case 'field_value': return wantedText(check) ? `It says ${wantedText(check).slice(0, 40)}.` : '';
    case 'element_state': {
      if (!label) return '';
      if (check.checked !== undefined) return `${label} is ${check.checked ? 'on' : 'off'}.`;
      if (check.selected !== undefined) return check.selected ? `${label} is selected.` : `${label} isn't selected now.`;
      if (check.expanded !== undefined) return `${label} is ${check.expanded ? 'open' : 'closed'}.`;
      return '';
    }
    case 'element_value': {
      const v = text(snap?.elements?.[check.label]?.value).slice(0, 40);
      return label && v ? `${label} is at ${v}.` : '';
    }
    case 'any_of': return sawLine((check.checks || []).find((c) => evalCheck(c, snap)), snap);
    case 'all_of': return (check.checks || []).map((c) => sawLine(c, snap)).find(Boolean) || '';
    default: return '';
  }
}

/** What Echo can see of a step's check in this snapshot, in one line; '' when it doesn't hold or names nothing. */
export function seenLine(check, snap) {
  if (!snap || snap.error || snap.editing) return '';
  const way = branches(check).find((b) => evalCheck(b, snap));
  return way ? sawLine(way, snap) : '';
}

/** A few plain words for a pass nothing on screen can name, varied by step. */
const ACKS = ['Got it.', "That's it.", 'There it is.'];

/**
 * May the story (a step's `why`) be told now? Only right after that step passed by the user's own
 * doing ('user') or Echo's demonstration of it ('shown'), and never when: it is too long to say
 * in one breath, it was told before, the step needed Echo to act (rung 4 or 5: they are
 * struggling), the user was frustrated on it, the user is ahead of the lesson (fast and terse),
 * or a story was told within the last two steps. A story that may not be told is dropped.
 * @param {{ why?: string, by?: string, rung?: number, frustrated?: boolean, ahead?: boolean, since?: number, again?: boolean }} o
 *   since: how many steps ago the last story was told (Infinity: none yet)
 */
export function mayTellStory({ why = '', by = 'user', rung = 0, frustrated = false, ahead = false, since = Infinity, again = false } = {}) {
  const w = text(why);
  if (!w || w.length > TEACH_WHY_MAX || again) return false;
  if (by !== 'user' && by !== 'shown') return false;
  if (rung >= RUNG.DO_PART || frustrated || ahead) return false;
  return since > TEACH_WHY_GAP;
}

/**
 * The lesson's mode after one of its voice commands: "show me the whole lesson" / "keep showing"
 * → 'show'; "do the rest" → 'do'; "let me try" → 'guide'. "Show me" and "just do it" are for the
 * one step and leave the mode as it is.
 * @param {string} mode @param {string | null} command
 */
export function modeAfter(mode, command) {
  return { show_all: 'show', do_all: 'do', try: 'guide' }[command || ''] || mode;
}

/**
 * The end of a lesson in one line: at most three of the things done, from the steps' own lines
 * (the first, a middle one and the last when there were more), each cut to its action. '' for fewer than two.
 * @param {string[]} done the lines of the steps that were done @param {{ watched?: boolean }} [o] watched: Echo did them all
 */
export function recapLine(done, { watched = false } = {}) {
  // Each thing in a few words: the clause that opens with the verb ("Type Coffee, then press Return." → "type Coffee").
  const short = (d) => {
    const whole = lastSentence(d).replace(/[.!?\s]+$/, '');
    return whole.split(/,\s+/).find((c) => INTENT_VERBS.includes(c.split(/[\s-]/)[0].toLowerCase())) || whole;
  };
  const all = (done || []).map(short).filter(Boolean);
  if (all.length < 2) return '';
  const picked = all.length <= 3 ? all : [all[0], all[Math.floor(all.length / 2)], all.at(-1)];
  const things = picked.map((x) => `${x[0].toLowerCase()}${x.slice(1)}`);
  return `${watched ? 'That was it' : 'You did it'}: ${things.join(', then ')}.`;
}

/* ---------- quick lessons ---------- */

/**
 * A quick lesson from steps that only say what to point at ("where's Wi-Fi?", "just show me
 * where things are"): nothing is planned or checked first, so step 1 is shown at once. A step
 * with no check of its own is done when the next step's target shows up (inside menus: the first
 * label of its route), and the last one is only pointed out (`told`, which a quick lesson never
 * waits on: TeachSession.onlyShown). No opening, closing or story.
 * @param {{ goal?: string, title?: string, app?: string, steps?: any[] }} req
 * @returns {{ ok: boolean, lesson?: any, error?: string, note?: string }} error: 'bad_route' or 'no_steps', with a note for the assistant
 */
export function quickLesson({ goal = '', title = '', app = '', steps } = {}) {
  const given = Array.isArray(steps) ? steps : [];
  const badRoute = given.map((s) => cleanRoute(s?.route).error).find(Boolean);
  if (badRoute) return { ok: false, error: 'bad_route', note: badRoute };
  // A step with a route points at the route's last label, shown by way of the ones before it.
  const list = given.map((s) => {
    const { route } = cleanRoute(s?.route);
    return route ? { ...s, route, target: route[route.length - 1] } : s;
  }).filter((s) => s && text(s.target)).slice(0, TEACH_MAX_STEPS);
  if (!list.length) return { ok: false, error: 'no_steps', note: 'Give the steps: each with the label to point at and one short sentence.' };
  const leadsTo = (next) => ({ kind: 'appears', label: text(next.route?.[0] || next.target), ...(next.menu_bar ? { menu_bar: true } : {}), ...(next.app || app ? { app: text(next.app || app) } : {}) });
  return {
    ok: true,
    lesson: {
      goal: text(goal),
      title: text(title || goal),
      quick: true,
      steps: list.map(({ why, ...s }, k) => ({ ...s, say: text(s.say) || `Click ${text(s.target)}.`, check: s.check || (list[k + 1] ? leadsTo(list[k + 1]) : { kind: 'told' }) })),
    },
  };
}

/* ---------- lesson lint ---------- */

const ACTION_VERBS = ['click', 'type', 'press', 'select', 'drag', 'choose', 'open', 'scroll', 'enter', 'pick', 'tap', 'find', 'move', 'go'];

/**
 * Problems with a spoken step line (design rules: one action, ≤ 14 words, no "next to", "drag" says where to grab).
 * @param {string} say
 * @returns {string[]}
 */
export function lintSay(say) {
  const s = text(say);
  const lower = s.toLowerCase();
  const problems = [];
  if (!s) return ['empty'];
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 14) problems.push(`too long (${words.length} words, keep it to 14 or fewer)`);
  if (/\b(next to|beside)\b/.test(lower)) problems.push('ambiguous position: name the cell or say left of / right of / above / below');
  if (/\band then\b/.test(lower)) problems.push('chains steps with "and then": one action per line');
  if (/\bdrag/.test(lower) && !/\b(middle|centre|center|grab|white plus|square)\b/.test(lower)) problems.push('says drag without saying where to grab');
  // "Hold Shift and click B5" and "Type Coffee, then press Return" are one action each.
  const verbs = lower.replace(/\bhold\b[^.,]*?\band\b/g, ' ').replace(/\bpress (return|enter|tab)\b/g, ' ').match(new RegExp(`\\b(${ACTION_VERBS.join('|')})\\b`, 'g')) || [];
  if (new Set(verbs).size > 1) problems.push(`more than one action (${[...new Set(verbs)].join(', ')})`);
  return problems;
}

/**
 * Checks a lesson's shape: 1 to 12 steps, each with a line and a known check.
 * @param {any} lesson
 * @param {{ lint?: boolean }} [opts]
 */
export function validateLesson(lesson, { lint = true } = {}) {
  const errors = [];
  const steps = Array.isArray(lesson?.steps) ? lesson.steps : [];
  if (!steps.length) errors.push('no steps');
  if (steps.length > TEACH_MAX_STEPS) errors.push(`too many steps (${steps.length}, at most ${TEACH_MAX_STEPS})`);
  const checkOk = (c) => c && CHECK_KINDS.includes(c.kind) && (c.kind !== 'any_of' && c.kind !== 'all_of' ? true : Array.isArray(c.checks) && c.checks.length > 0 && c.checks.every(checkOk));
  steps.forEach((s, k) => {
    if (!text(s?.say)) errors.push(`step ${k + 1}: no say`);
    if (!checkOk(s?.check)) errors.push(`step ${k + 1}: missing or unknown check`);
    const gesture = s?.gesture === 'drag' && text(s.from) && text(s.to);
    if (s?.gesture === 'drag' && !gesture) errors.push(`step ${k + 1}: a drag needs from and to`);
    if (cleanRoute(s?.route).error) errors.push(`step ${k + 1}: a route is at most 6 short labels, in the order they are opened`);
    if (lint) for (const p of lintSay(s?.say)) if (!(gesture && /drag/.test(p))) errors.push(`step ${k + 1}: ${p}`);
  });
  return { ok: errors.length === 0, errors };
}

/* ---------- lesson repair ---------- */

const MANY_ACTIONS = /more than one action|and then/;
// Where a two-action line comes apart, tried in this order: sentences, ";", "and then", "then".
const SPLITS = [/(?<=[.!?])\s+(?=[A-Z0-9"'])/, /\s*;\s*/, /,?\s+and then\s+/i, /,?\s+then\s+/i];

/** "Click A2 and then type Coffee." → ["Click A2.", "Type Coffee."]; a line that is one action stays whole. */
export function splitSay(say) {
  const s = text(say);
  if (!lintSay(s).some((p) => MANY_ACTIONS.test(p))) return [s];
  for (const re of SPLITS) {
    const parts = s.split(re).map((x) => x.trim().replace(/^[,;\s]+|[,;\s]+$/g, '')).filter(Boolean);
    if (parts.length > 1) return parts.flatMap(splitSay).map((x) => `${x[0].toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? '' : '.'}`);
  }
  return [s];
}

/**
 * Mends a plan instead of sending it back (on Oct 3 two rejections for "more than one action" each
 * cost a whole new plan, about 15 s): a two-action step becomes one step per action (the last
 * keeps the check; the earlier ones are `told`, since nothing on screen proves them), and an
 * over-long line keeps its first sentence (the rest becomes the hint). Style problems that can't
 * be mended are kept and noted. Only a plan that can't run is refused: no steps, too many, a step
 * with no line or no known check.
 * @param {any} lesson
 * @returns {{ ok: boolean, lesson: any, errors: string[], repairs: Array<{ step: number, reason: string }>, note: string }}
 *   `repairs` name the step and a reason code, never the step's words (they go to the lesson log)
 */
export function repairLesson(lesson) {
  const given = Array.isArray(lesson?.steps) ? lesson.steps : [];
  const repairs = [];
  const notes = [];
  let room = TEACH_MAX_STEPS - given.length;
  const steps = given.flatMap((st, k) => {
    if (!st || !text(st.say)) return [st];
    const n = k + 1;
    const fix = (reason, note) => { repairs.push({ step: n, reason }); notes.push(`step ${n} ${note}`); };
    let step = { ...st };
    if (step.gesture === 'drag' && !(text(step.from) && text(step.to))) {
      delete step.gesture;
      fix('drag_without_ends', 'said drag without from and to, so the pointer shows its target only');
    }
    const parts = splitSay(step.say);
    let out = [step];
    if (parts.length > 1 && parts.length - 1 <= room) {
      room -= parts.length - 1;
      // The target (and the route through menus to it) belongs to the first action.
      const { target, menu_bar, route, ...rest } = step;
      const aim = target ? { target, menu_bar, ...(route ? { route } : {}) } : {};
      out = parts.map((say, j) => (j < parts.length - 1
        ? { say, ...(j === 0 ? aim : {}), check: { kind: 'told' } }
        : { ...rest, say, ...(rest.gesture === 'drag' ? aim : {}) }));
      fix('split', `had ${parts.length} actions, so it is now ${parts.length} steps; the earlier ones wait for the user to say they're done`);
    }
    return out.map((x) => {
      const words = text(x.say).split(/\s+/);
      const first = text(x.say).split(SPLITS[0])[0];
      if (words.length > 14 && first !== text(x.say) && first.split(/\s+/).length <= 14) {
        fix('trimmed', 'was long, so only its first sentence is spoken (the rest is its hint)');
        return { ...x, say: first, hint: x.hint || text(x.say).slice(first.length).trim() };
      }
      const left = lintSay(x.say).filter((p) => !(x.gesture === 'drag' && /drag/.test(p)));
      if (left.length) fix('kept', `was kept as written (${left.map((p) => p.replace(/ \(.*$/, '').replace(/:.*$/, '')).join(', ')})`);
      return x;
    });
  });
  const fixed = { ...lesson, steps };
  const shape = validateLesson(fixed, { lint: false });
  const note = notes.length ? `Echo adjusted the plan: ${notes.join('; ')}. Next time write one short action per step, each with its own check.` : '';
  return { ok: shape.ok, lesson: fixed, errors: shape.errors, repairs, note };
}

/* ---------- voice commands ---------- */

// "Alright, I did.", "Seems like I did", "I got it. Now what next?", "What's next?": the user says
// they've done the step. On Oct 1 none of these were lesson phrases, so each went to the model as a
// question and paused the watch. Now they mean "check now".
const PROGRESS_FILLER = /^(?:(?:ok|okay|alright|all right|yeah|yes|yep|so|um|uh|well|i think|i guess|seems like|looks like|it seems)\s+)*/;
const PROGRESS_DONE = /^(?:i did(?: it| that)?|i've done (?:it|that)|i have done (?:it|that)|i'm done|i am done|done|did it|finished|got it|i got it|i clicked(?: it| on it| that)?|it's done|that's done|there|there you go)?$/;
const PROGRESS_NEXT = /^(?:now )?(?:what(?:'s| is)? next|what now|now what(?: next)?|what do i do now|next one|and now)?$/;

/** Is this the user saying they did the step (and maybe asking what's next)? */
export function isProgressTalk(said) {
  const s = String(said || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(PROGRESS_FILLER, '');
  if (!s) return false;
  // "i got it now what next": a done part, then an optional "what's next" part, split at any space.
  const cuts = [0, ...[...s.matchAll(/ /g)].map((m) => m.index), s.length];
  return cuts.some((k) => {
    const done = s.slice(0, k).trim(), next = s.slice(k).trim().replace(PROGRESS_FILLER, '');
    return Boolean(done || next) && PROGRESS_DONE.test(done) && PROGRESS_NEXT.test(next);
  });
}

/**
 * The lesson's own voice commands, handled without a model call. 'do_all': "do it all", "do the
 * rest" (Echo does every step that is left, at full speed). 'show': "show me" (Echo shows this
 * step). 'where': "show me where", "where is it" (the light points at it; Echo never does the
 * step for that). 'stuck': "where?", "I can't find it", "help" (one rung more
 * help, at once). 'help': anything frustrated ("why can't you", "this isn't working", "I don't
 * want to"): Echo offers to do the step. 'know': "I know this" (Echo says less).
 * 'show_all': "show me the whole lesson", "keep showing" (Echo shows every step that is left).
 * 'do': "just do it", "do it for me" (this step, at full speed). 'try': "let me try" (the user
 * takes the lesson back).
 * @returns {'repeat'|'show'|'show_all'|'do'|'try'|'next'|'back'|'pause'|'resume'|'stop'|'done'|'undo'|'do_all'|'help'|'stuck'|'where'|'know'|null}
 */
export function teachCommand(said) {
  const s = String(said || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(echo |hey echo |ok |okay )/, '').replace(/ please$/, '');
  if (/^(repeat|again|repeat that|say that again|what was that|come again|one more time)$/.test(s)) return 'repeat';
  if (/^(show me|show me how|can you show me|yes show me)$/.test(s)) return 'show';
  if (/^(next|skip|skip it|skip this|skip this one|next step)$/.test(s)) return 'next';
  if (/^(back|go back|previous|previous step)$/.test(s)) return 'back';
  if (/^(pause|wait|hold on|hang on)$/.test(s)) return 'pause';
  if (/^(resume|go on|continue|keep going|ok go on|i'm back)$/.test(s)) return 'resume';
  if (/^(stop|stop the lesson|end the lesson|quit|i'm done with this|that's enough)$/.test(s)) return 'stop';
  if (/^(done|i did it|i'm done|did it|finished)$/.test(s) || isProgressTalk(s)) return 'done';
  if (/^(undo|oops|undo that|whoops)$/.test(s)) return 'undo';
  if (WHERE.test(s) && s.split(' ').length <= 8) return 'where';
  if (STUCK.test(s)) return 'stuck';
  if (/^i (?:already )?know(?: this| that| how| this one| how to do (?:this|that|it))?(?: already)?$/.test(s)) return 'know';
  if (TRY.test(s)) return 'try';
  if (SHOW_ALL.test(s) || (DO_ALL.test(s) && /\bshow\b/.test(s))) return 'show_all';
  if (DO_ALL.test(s)) return 'do_all';
  if (SHOW_STEP.test(s)) return 'show';
  if (DO_STEP.test(s)) return 'do';
  if (FRUSTRATED.test(s)) return 'help';
  return null;
}

const DO_ALL = /\b(?:the whole (?:lesson|thing)|do it all|do all of it|do (?:the rest|everything|all the steps)|the rest of (?:it|the lesson|the steps))\b/;
/** The whole of what was said, so a real question ("where is the rectangle tool?") still goes to the assistant. */
const STUCK = /^(?:where|where is it|where is that|where's it|where's that|which one|which|what|huh|help|help me|i'?m stuck|i'?m lost|i (?:can'?t|cannot|don'?t) (?:find|see) (?:it|that))$/;
/** Asking to be pointed at it ("can you show me where?" once made Echo click it instead: "show me"). */
const WHERE = /\bshow me where\b|\bshow me which\b|^(?:(?:can|could) you )?point(?: (?:it out|at it|to it|me to it|at that|to that))?$|^where(?:'s| is) (?:it|that)$/;
const SHOW_ALL = /\bshow me (?:the rest|everything|all of it|it all)\b|^keep showing(?: me)?$/;
const SHOW_STEP = /\bshow me\b/;
const DO_STEP = /\bjust do it\b|\b(?:you )?do it for me\b|\byou do it\b/;
/** The whole of what was said: the user takes the lesson back. */
const TRY = /^(?:let me(?: try| do it| have a go)?(?: myself)?|i(?:'ll| will| want to| wanna) (?:try|do it)(?: myself)?|my turn|guide me)$/;
/** Answers to "Your turn on the next one?" that mean "no, keep showing". */
const KEEP_SHOWING = /^(?:no|nope|nah|no thanks|not yet|keep showing(?: me)?|keep going|carry on|show me|you do it|do it)$/;
const PLAIN_YES = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|alright|please|my turn)\s*)+$/;
const PLAIN_NO = /^(?:no|nope|nah|no thanks|no thank you|not now|not yet|i'?m good|that'?s enough)$/;
const FRUSTRATED = /\bwhy can'?t you\b|\b(?:this|it) (?:isn'?t|is not|doesn'?t|does not|won'?t) work(?:ing)?\b|\bnot working\b|\bi don'?t (?:want|wanna)\b|\bi give up\b/;
const plainSaid = (said) => String(said || '').toLowerCase().replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** A yes or a no to "Want me to do this step for you?". */
const OFFER_YES = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|alright|please|go ahead|go on|do it|just do it|you do it|do that|show me)\s*)+$/;
const OFFER_NO = /^(?:no|nope|nah|no thanks|no thank you|not yet|i'?ll do it|let me(?: try| do it)?|i can do it|i got it|i'?ve got it)$/;
/** Asked, not remarked: it ends on a question mark or opens like a question. */
const isQuestion = (said) => /\?\s*$/.test(String(said || '')) || /^(?:what|why|how|where|when|who|which|can|could|would|will|should|do|does|did|is|are|was|were)\b/.test(plainSaid(said));

/* ---------- the engine ---------- */

/**
 * A lesson's screen access. Only `snapshot` is required.
 * @typedef {{
 *   snapshot: (req: { labels: string[], elements?: string[], contains?: string[], appears?: Array<{ label: string, app?: string, menu_bar?: boolean }>, screenLabels?: string[], bold?: boolean }) => Promise<any>,
 *   cannotSee?: string[],
 *   undo?: () => Promise<any>,
 *   restore?: (cells: Record<string, any>) => Promise<any>,
 * }} TeachAdapter
 */

/**
 * Answers label checks through the Mac app's `wait` request (Accessibility, then the screen's text
 * when allowed), for lessons outside Excel.
 * @param {{ request: (type: string, params: any) => Promise<any> }} bridge
 * @param {{ app?: string, useScreen?: boolean, screenEveryMs?: number, screenMs?: number, requestMs?: number, onScreenOff?: (i: { ms: number, why: string }) => void, now?: () => number }} [opts]
 * @returns {TeachAdapter}
 */
export function labelAdapter(bridge, { app, useScreen = false, screenEveryMs = 3000, screenMs = TEACH_SCREEN_TEXT_MS, requestMs = TEACH_REQUEST_MS, onScreenOff = () => {}, now = Date.now } = {}) {
  // Is the label on screen now? ("present": "appear" with a fresh baseline every poll only counted a
  // label that showed up during the 300 ms wait, so one already there read as missing; on Oct 1
  // the drawn rectangle never counted.) The app is asked for the whole label (`match`), and its
  // answer counts only if the label it found really is that one. When Accessibility finds
  // nothing, read the screen's text at most every few seconds (canvas apps like Adobe XD show
  // little to Accessibility), one label per read, the one read longest ago; what that read said
  // holds until the next one, so a label only the screen text shows doesn't flicker between polls.
  // Only the current step's labels (`screenLabels`) are read that way. That text read took 38 s
  // on macOS 27 (Apple Vision), so one slower than screenMs, or failing, turns it off for the
  // rest of the lesson instead of holding every poll up.
  let lastScreen = -Infinity;
  let screenOff = false;
  /** @type {Map<string, { found: boolean, at: number }>} what the screen's text last said, per label */
  const read = new Map();
  return {
    async snapshot({ labels = [], contains = [], appears = [], screenLabels }) {
      const wanted = [...labels.map((label) => ({ label, mode: 'exact', key: `=${label}` })), ...contains.map((label) => ({ label, mode: 'contains', key: `~${label}` }))];
      const onScreen = wanted.filter((w) => useScreen && !screenOff && (!screenLabels || screenLabels.includes(w.label)));
      const due = now() - lastScreen >= screenEveryMs ? [...onScreen].sort((x, y) => (read.get(x.key)?.at ?? -Infinity) - (read.get(y.key)?.at ?? -Infinity))[0] : null;
      const out = { labels: {}, contains: {}, appears: {} };
      // What a step leads to (`appears`): looked for the way the light looks for it (the finder's
      // own match, menu bar icons first when the step says so), through Accessibility only, so
      // nothing is captured while Echo waits. No answer is a look that saw nothing: the lesson
      // then says it can't see, rather than waiting in silence.
      for (const a of appears) {
        let r;
        try {
          r = await within(bridge.request('wait', { target: String(a.label).slice(0, 120), app: a.app || app, menuBar: Boolean(a.menu_bar), mode: 'present', timeoutMs: 300, useScreen: false }), requestMs);
        } catch (e) {
          return { cells: {}, error: String(e?.message || 'unseen').slice(0, 120) };
        }
        out.appears[a.label] = Boolean(r && r.ok !== false && r.found);
      }
      for (const w of wanted) {
        const screen = w === due && !screenOff;
        const ask = bridge.request('wait', { target: String(w.label).slice(0, 120), app, mode: 'present', match: w.mode, timeoutMs: 300, useScreen: screen });
        let r;
        if (screen) {
          const t0 = now();
          let failed = '';
          try {
            r = await within(ask, screenMs);
          } catch (e) {
            r = null;
            failed = e?.message === 'slow' ? 'slow' : 'failed';
          }
          const ms = now() - t0;
          if (failed || ms > screenMs) {
            screenOff = true;
            onScreenOff({ ms, why: failed || 'slow' });
          }
        } else {
          r = await within(ask, requestMs);
        }
        const found = Boolean(r && r.ok !== false && r.found && labelFits(r.label, w.label, /** @type {any} */ (w.mode)));
        const seenByAx = found && r.via === 'accessibility';
        if (screen && !seenByAx) {
          lastScreen = now();
          read.set(w.key, { found, at: lastScreen });
        }
        if (seenByAx || screenOff) read.delete(w.key);
        (w.mode === 'exact' ? out.labels : out.contains)[w.label] = found || (onScreen.includes(w) && read.get(w.key)?.found === true);
      }
      return { cells: {}, ...out };
    },
  };
}

/**
 * Works in any app: one read-only `state` request per poll (front app, window, page, menus, the
 * focused field, and the controls the steps name), plus the `wait` lookup for label checks. Needs
 * the Mac app from Oct 2026 or later; an older one answers `state` with an error, and every poll
 * then reads as "editing" (nothing passes), so the teach tool checks with `probe()` first.
 * @param {{ request: (type: string, params: any) => Promise<any> }} bridge
 * @param {{ app?: string, useScreen?: boolean, onScreenOff?: (i: { ms: number, why: string }) => void, requestMs?: number }} [opts] useScreen: label checks may read the screen's text
 * @returns {TeachAdapter & { probe: () => Promise<boolean>, check: () => Promise<'ok' | 'no_answer' | 'old_app'> }}
 */
export function uiAdapter(bridge, { app, useScreen = false, onScreenOff = () => {}, requestMs = TEACH_REQUEST_MS } = {}) {
  const labelsOf = labelAdapter(bridge, { app, useScreen, onScreenOff, requestMs });
  const state = async (elements) => {
    const r = await within(bridge.request('state', { app, labels: elements.slice(0, 12) }), requestMs);
    if (!r || r.ok === false || r.error) throw new Error(r?.message || 'no state');
    return r;
  };
  return {
    // The app's state carries no cells: a cell check can't be seen to pass or fail from here.
    cannotSee: CELL_KINDS,
    async probe() {
      try {
        return Boolean(await state([]));
      } catch {
        return false;
      }
    },
    /** Can lessons run: 'ok', the Mac app isn't answering ('no_answer'), or it's too old ('old_app'). */
    async check() {
      try {
        const r = await within(bridge.request('state', { app, labels: [] }), requestMs);
        if (r && !(r.ok === false || r.error)) return 'ok';
        if (r && /unknown|unsupported|not supported|no such/i.test(`${r.error || ''} ${r.message || ''}`)) return 'old_app';
      } catch {}
      // No answer. One that answers other requests (pointing, looking) but has never answered
      // this one is an older build; one that's answered nothing lately is just not answering.
      const b = /** @type {any} */ (bridge);
      const recent = Number(b.lastAnswerAt) > 0 && Date.now() - Number(b.lastAnswerAt) < 2 * 60_000;
      return b.answeredKinds instanceof Set && !b.answeredKinds.has('state') && recent ? 'old_app' : 'no_answer';
    },
    async snapshot({ labels = [], elements = [], contains = [], appears = [], screenLabels }) {
      // Couldn't see the screen (the Mac app slow or gone): say so, rather than throwing, which
      // would read as "the user is typing" and keep the lesson silent.
      try {
        const r = await state(elements);
        const shown = labels.length || contains.length || appears.length ? await labelsOf.snapshot({ labels, contains, appears, screenLabels }) : { labels: {}, contains: {}, appears: {} };
        if (shown.error) return shown;
        const ui = { front: r.front, app: r.app, window: r.window, windows: r.windows, url: r.url, menuOpen: Boolean(r.menuOpen), signature: r.signature, focus: r.focus || {} };
        return { cells: {}, labels: shown.labels, contains: shown.contains, appears: shown.appears, ui, elements: r.elements || {} };
      } catch (e) {
        return { cells: {}, error: String(e?.message || 'unseen').slice(0, 120) };
      }
    },
  };
}

/**
 * A lesson in Excel or Numbers: the selection, what the cells hold and which are bold, read
 * through the app's own scripting (lib/sheets.js) on top of what `base` sees, so cell_value,
 * selection and bold checks pass by themselves. Only when the lesson's app (the one named, else
 * the one in front) is a spreadsheet app; and when it can't be read (macOS hasn't allowed Echo to
 * control it, no sheet is open), the lesson is as blind to cells as before and asks the user to
 * say when they've done it. While the user is typing in a cell nothing is read (and nothing is
 * ever sent to the app): that poll says "editing".
 * @param {TeachAdapter & Record<string, any>} base
 * @param {{ in: (app: string) => ({ snapshot: (o: { bold?: boolean }) => Promise<any> } | null) }} sheets lib/sheets.js Sheets
 * @param {{ app?: string }} [opts]
 * @returns {TeachAdapter & Record<string, any>}
 */
export function sheetAdapter(base, sheets, { app } = {}) {
  let seen = false;
  return {
    ...base,
    get cannotSee() {
      const blind = base.cannotSee || [];
      return seen ? blind.filter((k) => !SHEET_SEEN.includes(k)) : blind;
    },
    async snapshot(req) {
      const snap = await base.snapshot(req);
      if (snap?.error) return snap;
      const sheet = sheets.in(app || snap?.ui?.app || '');
      const r = sheet ? await sheet.snapshot({ bold: Boolean(req.bold) }).catch(() => ({ error: 'failed' })) : { error: 'unsupported' };
      // Mid-edit or no answer in time: this poll shows nothing new, as while the user types.
      if (r.error === 'editing' || r.error === 'timeout') return { ...snap, editing: true };
      seen = !r.error;
      return r.error ? snap : { ...snap, cells: r.cells, selection: r.selection, active: r.active };
    },
  };
}

export class TeachSession {
  /**
   * @param {{
   *   adapter: TeachAdapter,
   *   say?: (text: string) => any,
   *   id?: string,
   *   point?: (target: any, step: any, stepId: string) => any,
   *   locate?: (label: string, step: any) => any,
   *   release?: (stepId: string, outcome: 'done' | 'skipped' | 'stopped') => void,
   *   card?: (c: any) => void,
   *   report?: (r: { kind: string, step: number, total: number, note: string }) => void,
   *   log?: (e: { kind: string, step: number, total: number, rung?: number, from?: number, trigger?: string, mode?: string, told?: boolean }) => void,
   *   app?: string,
   *   prior?: (app: string) => boolean,
   *   now?: () => number,
   *   setTimer?: (fn: () => void, ms: number) => any,
   *   clearTimer?: (t: any) => void,
   *   autoPoll?: boolean,
   * }} opts locate: where a label is on screen, in words ({ place, container, kind }), asked without moving the light;
   *   say: speaks a line; it may return a promise of when the voice really finished it (ms), and then the
   *   lesson's pauses count from that (see say() below);
   *   app: the app the lesson is in, when the plan named one (else the one in front at step 1);
   *   prior: did the last lesson in that app go well (lib/lessonnotes.js)? Then this one starts with less help
   */
  constructor({ adapter, id = 'lesson', say = () => undefined, point = () => {}, locate = () => null, release = () => {}, card = () => {}, report = () => {}, log = () => {}, app = '', prior = () => false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, autoPoll = true }) {
    this.adapter = adapter;
    this.id = id;
    this.sayFn = say;
    this.pointFn = point;
    this.locateFn = locate;
    this.releaseFn = release;
    /** The id the light is waiting under on the current step ('' when it isn't waiting), and how many waits there have been. */
    this.held = '';
    this.holds = 0;
    this.cardFn = card;
    this.reportFn = report;
    this.logFn = log;
    this.app = app;
    this.priorFn = prior;
    /** 'guide', 'show' or 'do' (see the top of this file). */
    this.mode = 'guide';
    /** The step Echo is doing itself right now (the assistant has been asked to), or null. `line`: when its line of intent is over (a shown step waits for that). @type {{ pace: 'show' | 'do', once: boolean, rung: number, line: { at: number, done: Promise<void> | null } | null } | null} */
    this.demo = null;
    /** A question of Echo's that waits `ms` past its end for the answer: the turn back after one shown step, or trying the lesson after watching it. @type {{ kind: 'turn' | 'retry', ms: number, line: { at: number } } | null} */
    this.ask = null;
    /** How much help the current step is getting (lib/ladder.js). */
    this.ladder = new HelpLadder();
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.autoPoll = autoPoll;
    this.phase = 'idle';
    this.timer = null;
    this.polling = false;
  }

  get active() {
    return this.phase !== 'idle' && this.phase !== 'ended';
  }

  /**
   * Starts a lesson in the background and returns at once.
   * @param {{ title?: string, goal?: string, steps: any[], mode?: string, quick?: boolean, opening?: string, closing?: string }} lesson
   * @param {{ startAt?: number }} [opts]
   */
  start(lesson, { startAt = 1 } = {}) {
    const steps = (Array.isArray(lesson?.steps) ? lesson.steps : []).filter((s) => s && text(s.say) && s.check).slice(0, TEACH_MAX_STEPS);
    if (!steps.length) return { ok: false, note: 'Give the steps: each with one short line and a check.' };
    if (this.active) return { ok: false, note: 'A lesson is already running.' };
    const bad = validateLesson({ steps }, { lint: false });
    if (!bad.ok) return { ok: false, note: `The lesson has problems: ${bad.errors.join('; ')}.` };
    this.title = text(lesson.title || lesson.goal) || 'Lesson';
    this.goal = text(lesson.goal || lesson.title);
    this.steps = steps;
    this.i = Math.min(Math.max(1, Number(startAt) || 1), steps.length) - 1;
    this.done = [];
    this.ladder = new HelpLadder();
    /** A quick lesson (see the top of this file): the user always does the steps, and there is no hook or closing line. */
    this.quick = Boolean(lesson.quick);
    this.mode = lesson.mode === 'show' && !this.quick ? 'show' : 'guide';
    this.opening = this.quick ? '' : text(lesson.opening);
    this.closing = this.quick ? '' : text(lesson.closing);
    this.opened = false;
    /** The app the lesson is in, known once step 1 has looked; and whether the last lesson there went well. */
    this.appName = undefined;
    this.knows = false;
    this.demo = null;
    this.ask = null;
    /** The rung each step ended on (a step Echo did counts as the top), for the note kept across lessons. */
    this.rungs = [];
    /** The user asked to be shown, or the lesson was a demonstration. */
    this.wasShown = this.mode === 'show';
    /** The stories told (never twice), and the step the last one followed. */
    this.told = new Set();
    this.lastWhy = -Infinity;
    this.pendingWhy = '';
    /** The last story told, and when its telling is over (say). @type {{ at: number } | null} */
    this.story = null;
    this.lastLine = null;
    this.frustratedOn = -1;
    this.phase = 'instruct';
    this.pausedUntil = 0;
    this.schedule(0);
    const how = this.mode === 'show'
      ? 'Echo says what it is about to do on each step and asks you to do that one step (a "show_step" report); say nothing yourself.'
      : this.quick
        ? "Echo points at each step and says it, moving on when the next thing shows up; don't repeat the steps."
        : "Echo speaks each step and watches; don't repeat the steps.";
    return { ok: true, note: `Lesson started, step ${this.i + 1} of ${steps.length}. ${how}` };
  }

  /** A user who needs little: no acknowledgements, no line of intent (ahead of the lesson, or three easy steps in a row). */
  get quiet() {
    return this.ladder.terse || this.ladder.sayLess;
  }

  /** Echo has just told a story and is leaving room for an answer. */
  get storyGap() {
    return this.phase === 'praise' && this.now() < this.storyOver;
  }

  /** When the quiet after the last story is over (0: none told). */
  get storyOver() {
    return this.story ? this.story.at + TEACH_STORY_QUIET_MS : 0;
  }

  /** Echo is doing the current step itself (the assistant is, with its computer tools). */
  get demoing() {
    return Boolean(this.demo) && this.active;
  }

  /** That step is being done at full speed ("just do it"), not shown. */
  get fullSpeed() {
    return this.demoing && this.demo?.pace === 'do';
  }

  /** How long before a demonstration may move: Echo's line of intent is still being said (Infinity until the voice says it ended), then a pause. */
  leadLeft() {
    const line = this.demoing ? this.demo?.line : null;
    return line ? Math.max(0, line.at + SHOW_PACE.leadMs - this.now()) : 0;
  }

  /** Resolves when a demonstration may move: the line of intent has been said, and the pause after it is over. */
  async lead() {
    const d = this.demo;
    if (!this.demoing || !d?.line) return;
    await d.line.done;
    const left = this.demo === d ? this.leadLeft() : 0;
    if (left > 0) await new Promise((r) => this.setTimer(() => r(undefined), left));
  }

  /** Is a line of Echo's still being said, as far as the voice has reported? */
  get saying() {
    return this.lastLine?.at === Infinity;
  }

  /** How the lesson went, in a few numbers (lib/lessonnotes.js): never what it was about. */
  summary() {
    const sorted = [...(this.rungs || [])].sort((a, b) => a - b);
    return { app: this.appName || '', steps: sorted.length, medianRung: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0, shown: Boolean(this.wasShown) };
  }

  /** The mode changes (a voice command, or Echo couldn't do a step): noted for the log, never said. */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'guide') this.wasShown = true;
    this.note('mode', { mode });
  }

  get step() {
    return this.steps?.[this.i];
  }

  /**
   * Says a line, and returns when it is over: `at` is the moment (from the line's length until
   * the voice reports its real end, Infinity while a voice that reports is still saying it), and
   * `done` resolves then. `say` (the constructor's) returns a promise of the real end when there
   * is a voice to ask (lib/computer.js); it never hangs (lib/voicestate.js whenDone).
   * @param {string | null | undefined} line
   * @returns {{ at: number, done: Promise<void> | null }}
   */
  say(line) {
    const mark = { at: this.now() + spokenMs(line || ''), done: /** @type {Promise<void> | null} */ (null) };
    // (A lesson that has ended says nothing more: it may have ended while the light was finding a step.)
    if (!line || this.phase === 'ended') return mark;
    const question = /\?\s*$/.test(line);
    // Echo asked the user something: its own nudges wait a few seconds for the answer.
    if (question) this.ladder.asked(this.now());
    // While the model answers a question, the lesson's own line waits (only the latest is kept).
    if (this.quietUntil > this.now()) {
      this.heldLine = line;
      return mark;
    }
    const ended = this.sayFn(line);
    if (typeof ended?.then !== 'function') return mark;
    mark.at = Infinity;
    this.lastLine = mark;
    mark.done = Promise.resolve(ended).then((at) => {
      mark.at = Number.isFinite(at) ? Math.min(at, this.now()) : this.now();
      // Nobody can act on a line they are still hearing: the idle time, and the wait after a
      // question, count from when the line FINISHED.
      this.lastChangeAt = Math.max(this.lastChangeAt || 0, mark.at);
      if (question) this.ladder.asked(mark.at);
    }, () => {
      mark.at = this.now();
    });
    return mark;
  }

  /** The model's answer is over: anything the lesson held back is said now. */
  endQuiet() {
    this.quietUntil = 0;
    const line = this.heldLine;
    this.heldLine = '';
    if (line && this.active) this.sayFn(line);
  }

  /**
   * Point at the step's target. The light waits there for the user, under one id for as long as
   * this step is being waited on (a hint or a "repeat" points again under the same id). It
   * returns when the light is there (or after a moment, if the app never says so), so what is
   * said next (the step's instruction) is heard as the light lands, not before.
   */
  async point(step) {
    if (!step?.target) return;
    // (A step that is only pointed out has nobody to wait for: the light shows it and isn't held.)
    if (!this.onlyShown) this.held ||= `${this.id}.${++this.holds}`;
    const r = await this.pointFn(step.target, step, this.held);
    // What it found belongs to Passwords or the Keychain: never Echo's to show (Oct 2: "Apple"
    // matched the Passwords menu bar icon, the user clicked it and Passwords opened). The lesson
    // stops there, and the assistant says in words where the thing really is.
    if (this.active && (PASSWORD_UI.test(text(r?.app)) || PASSWORD_UI.test(text(r?.label)))) {
      this.end('off_limits', `The pointer found the Passwords/Keychain item instead of "${text(step.target)}", so Echo stopped at step ${this.i + 1} without saying it. Tell the user not to click there, and say in words where "${text(step.target)}" really is (for the Apple menu: the Apple logo at the far left of the menu bar).`);
    }
    return r;
  }

  /**
   * Where the step's target is, in words, for the hint on rung 2: asked of the app without moving
   * the light (the user is still finding it themselves). Null when there is nothing to ask or the
   * app can't say; the hint is then the label alone.
   */
  async whereIs(step) {
    const label = hintTarget(step);
    if (!label) return null;
    try {
      return (await this.locateFn(label, step)) || null;
    } catch {
      return null;
    }
  }

  /** Point, once the step is on the pointing rung: below it the user is finding the thing themselves. */
  async show(step) {
    if (this.ladder.rung >= RUNG.POINT) return this.point(step);
  }

  /**
   * The light stops waiting: the step passed ('done'), was left undone ('skipped'), or the lesson
   * is no longer watching it ('stopped': ended or paused). Once per wait; nothing if none is on.
   * @param {'done' | 'skipped' | 'stopped'} outcome
   */
  release(outcome) {
    const id = this.held;
    if (!id) return;
    this.held = '';
    try {
      this.releaseFn(id, outcome);
    } catch {}
  }

  /** @param {string} state @param {{ finished?: boolean, complete?: boolean }} [over] the lesson's last card says it is over, and whether it got to the end */
  updateCard(state, over = {}) {
    const s = this.step;
    this.cardFn({ title: this.title, step: this.i + 1, total: this.steps.length, current: s?.say || '', ghost: s?.ghost, next: this.steps[this.i + 1]?.say || '', done: [...this.done], state, ...over });
  }

  report(kind, note) {
    this.reportFn({ kind, step: this.i + 1, total: this.steps?.length || 0, note });
  }

  /** Something for the lesson log only: the model isn't called, so nothing is said about it (on
   *  Oct 3 a weak-check report was read aloud as "Quick note: ..."). */
  note(kind, extra = {}) {
    this.logFn({ kind, step: this.i + 1, total: this.steps?.length || 0, ...extra });
  }

  /** Nothing on screen can show this step is done (its check is `told`, or was already true when
   *  the step began and hasn't been seen to change): Echo asks, and takes the user's word. */
  get takesWord() {
    return branches(this.step?.check).some((b) => b?.kind === 'told') || !(this.seenFalse || []).some(Boolean);
  }

  /** The last step of a quick lesson, with no check of its own: there is nothing after it to wait
   *  for, so it is pointed out, said, and the lesson is over. */
  get onlyShown() {
    return Boolean(this.quick) && this.i === this.steps.length - 1 && this.step?.check?.kind === 'told';
  }

  /** The adapter can't see any of the ways this step passes (a cell check, with only the app's
   *  state to go on): nothing passes by itself, so Echo asks the user to say when it's done, and
   *  then looks (see `done` in hear). */
  get unseeable() {
    const blind = this.adapter.cannotSee || [];
    const needs = (c) => (c?.kind === 'any_of' || c?.kind === 'all_of' ? (c.checks || []).some(needs) : blind.includes(c?.kind));
    return blind.length > 0 && branches(this.step?.check).every(needs);
  }

  /** "Want me to do this step for you?" has been asked on this step and still waits for its answer. */
  get offerOpen() {
    return this.offered === this.i && this.offerUntil > this.now();
  }

  /** Which way the step passed in this snapshot (-1: not yet). A way only counts once the lesson
   *  has seen it NOT hold since the step began: the lesson must see the change happen. */
  passed(snap) {
    return branches(this.step.check).findIndex((b, k) => this.seenFalse[k] && evalCheck(b, snap));
  }

  schedule(ms) {
    if (!this.autoPoll || !this.active) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.poll().catch(() => {}).finally(() => this.schedule(TEACH_POLL_MS));
    }, ms);
  }

  /** A snapshot with every label and control the current and look-ahead checks need; adapter errors read as "editing". */
  async snap() {
    // (A quick lesson looks for the current step's check only: every label that isn't there yet
    // costs a moment, and its first step is shown at once.)
    const window = this.steps.slice(this.i, this.i + 1 + (this.quick ? 0 : LOOKAHEAD));
    const names = (kinds, steps = window) => [...new Set(steps.flatMap((s) => [...checkNames(s.check, kinds), ...(s.near_miss || []).flatMap((n) => checkNames(n.check, kinds))]))];
    try {
      // Only the current step's labels may be read off the screen's text; the look-ahead ones are cheap lookups.
      // Which cells are bold is only read when a step in view checks for it (it costs more to read).
      const hasBold = (c) => c?.kind === 'bold' || (c?.checks || []).some(hasBold);
      const s = await this.adapter.snapshot({ labels: names(LABEL_KINDS), elements: names(ELEMENT_KINDS), contains: names(['label_contains']), appears: [...new Map(window.flatMap((st) => appearsIn(st.check)).map((c) => [c.label, c])).values()], screenLabels: names([...LABEL_KINDS, 'label_contains'], [this.step]), bold: window.some((st) => hasBold(st.check)) });
      if (s?.error) this.lastError = s.error;
      return { cells: {}, ...(s || {}) };
    } catch {
      return { cells: {}, editing: true };
    }
  }

  /** INSTRUCT: point, card, speak once, and remember how things looked. */
  async instruct({ replay = false } = {}) {
    const s = this.step;
    this.demo = null;
    this.ask = null;
    this.phase = 'watch';
    this.baseline = await this.snap();
    if (this.baseline.editing) this.baseline = { ...this.baseline, editing: false };
    this.last = this.baseline;
    this.streak = 0;
    this.lastChangeAt = this.now();
    this.hintLevel = 0;
    this.tries = replay ? this.tries || 0 : 0;
    this.lastNearKey = '';
    this.collateralKey = '';
    if (!replay) {
      // A new step: nothing said about it yet, no offer made, no look asked for.
      this.offered = -1;
      this.offerUntil = 0;
      this.helped = false;
      this.lookAsked = false;
      this.stuckTold = false;
      // The first step given: which app this is, and whether the last lesson there went well
      // (then the first steps begin a rung lower, and Echo says so once).
      if (this.appName === undefined) {
        this.appName = text(this.app || this.baseline.ui?.app).slice(0, 80);
        this.knows = !this.quick && Boolean(this.appName) && Boolean(this.priorFn(this.appName));
        if (this.knows) this.ladder.lowerSteps = Math.max(this.ladder.lowerSteps, TEACH_KNOWN_STEPS);
      }
      // It begins on the rung the user has earned (lib/ladder.js). A step Echo shows has no rung.
      if (this.mode !== 'show') {
        // (Every step of a quick lesson begins with the light on it, as a lesson's first steps do.)
        if (this.quick) this.ladder.prev = null;
        const rung = this.ladder.begin(this.i, this.now(), { hint: Boolean(hintInWords(s)), point: Boolean(s.target), part: Boolean(text(s.first_half)) });
        this.note('rung', { rung, from: rung, trigger: 'start' });
      }
    }
    // A check that already holds before the user does anything can't tell when they've done it
    // ("the File menu is there"), so it can never pass the step by itself: each way of passing
    // counts only once the lesson has seen it not hold. Until then Echo asks the user to say when
    // it's done. (Coming back from a pause keeps what was seen before it.)
    const ways = branches(s.check);
    const before = replay && this.seenFalse?.length === ways.length ? this.seenFalse : [];
    this.seenFalse = ways.map((b, k) => Boolean(before[k]) || (b?.kind !== 'told' && !evalCheck(b, this.baseline)));
    this.falseRun = ways.map(() => 0);
    this.markAhead(this.baseline);
    if (this.takesWord && !replay && !ways.some((b) => b?.kind === 'told')) this.note('weak_check');
    // Once, before the first step: that Echo will say less here (an app they know), and the hook.
    if (!this.opened) {
      this.opened = true;
      if (this.knows && this.mode === 'guide') this.say(`You know your way around ${this.appName} now, so I'll say less.`);
      this.say(this.opening);
    }
    if (this.mode === 'show') return this.demonstrate({ rung: RUNG.WAIT });
    this.updateCard('watching');
    const shown = await this.show(s);
    // (The lesson was stopped, or its steps replaced, while the light was finding this one.)
    if (this.step !== s || !this.active) return;
    if (this.quick) {
      // A quick lesson is the light and one line per step: a step the light can't show ends it,
      // and the assistant says the rest in words.
      if (shown?.ok === false) return this.end('failed', shown.error === 'permission' ? `Permission needed. Tell the user: ${text(shown.message)}` : `Couldn't point at step ${this.i + 1}: ${text(shown.message || shown.error)}. Describe the rest of the steps instead.`);
      if (s.target && !shown?.found) return this.end('not_found', `Couldn't find "${text(s.target)}" on screen at step ${this.i + 1}, so Echo stopped without saying it. Describe where it is, or ask what they see.`);
      if (this.onlyShown) {
        this.say(this.ladder.terse ? lastSentence(s.say) : s.say);
        return this.finish();
      }
    }
    // A step that begins on the hint rung with no hint of its own: where its target is, if the app can say.
    let where = null;
    if (this.ladder.rung === RUNG.HINT && !replay && !this.ladder.terse && hintTarget(s)) {
      where = await this.whereIs(s);
      // (The lesson was stopped, or moved on, while the app was finding it.)
      if (this.step !== s || !this.active) return;
    }
    // Echo did the first half and the assistant has said so: the rest is the user's.
    const handBack = replay && this.partDone;
    this.partDone = false;
    this.say(handBack ? 'Your turn.' : this.stepLine(s, { replay, where }));
  }

  /**
   * The step as spoken: its line (only the last sentence for a user who is ahead), and, when the
   * step begins on the prompt or the hint rung, that rung's line after it (only one the lesson
   * wrote, or where the app says the target is: a general prompt or the target's bare label adds
   * nothing to the step itself).
   * @param {any} s @param {{ replay?: boolean, where?: any }} [o]
   */
  stepLine(s, { replay = false, where = null } = {}) {
    const terse = this.ladder.terse;
    const rung = this.ladder.rung;
    const hint = text(s.hint) === text(s.say) ? '' : text(s.hint) || (whereWords(where) ? hintInWords(s, where) : '');
    const extra = replay || terse ? '' : rung === RUNG.PROMPT ? text(s.prompt) : rung === RUNG.HINT ? hint : '';
    const tell = this.takesWord || this.unseeable ? " Tell me when you've done it." : '';
    return `${terse ? lastSentence(s.say) : s.say}${extra ? ` ${extra}` : ''}${tell}`;
  }

  /**
   * More help on this step, by one rung (`trigger`: 'idle', 'wrong', 'done', 'stuck'). `lead` is
   * what Echo has to say about what it sees (a correction, "Not yet. …"): it is said in place of
   * the prompt or the hint, and before the offer. Each rung's line is said once: a step passes
   * each rung once on the way up.
   * @param {string} trigger @param {{ lead?: string }} [o]
   */
  async climb(trigger, { lead = '' } = {}) {
    const step = this.step;
    const c = this.ladder.climb(trigger, this.now());
    if (!c) {
      // No more help to give (or Echo just asked something): what it sees is still said.
      if (lead) {
        await this.show(step);
        this.say(lead);
      }
      return null;
    }
    this.note('rung', { rung: c.to, from: c.from, trigger });
    // (A user who is ahead gets no prompt unless they ask: the rung moves and nothing is said.)
    if (c.quiet) return c;
    this.updateCard('hint');
    switch (c.to) {
      case RUNG.PROMPT:
        this.say(lead || generalPrompt(step));
        break;
      case RUNG.HINT: {
        // Where first, then the thing: the app is asked where it is, and the light stays put.
        const where = lead || !hintTarget(step) ? null : await this.whereIs(step);
        if (this.step === step && this.active) this.say(lead || hintInWords(step, where));
        break;
      }
      case RUNG.POINT:
        await this.point(step);
        this.say(lead || "It's here. Your turn.");
        break;
      case RUNG.DO_PART:
        this.doPart(lead);
        break;
      default:
        // The top: Echo never takes a step over without asking. Once per step.
        if (this.offered !== this.i) this.offer(`${lead ? `${lead} ` : ''}Want me to do this step for you?`);
        else if (lead) this.say(lead);
    }
    return c;
  }

  /** Straight to the top of the ladder for this step (`trigger`: 'do', 'frustrated', 'done'). */
  toTop(trigger) {
    const c = this.ladder.top(trigger, this.now());
    if (c) this.note('rung', { rung: c.to, from: c.from, trigger });
  }

  /** Which later steps weren't done yet when this one began: only those can be jumped to or over. */
  markAhead(baseline) {
    this.ahead = this.steps.map((x, k) => (k > this.i && k <= this.i + LOOKAHEAD ? !evalCheck(x.check, baseline) : false));
    this.falseAtStart = !evalCheck(this.step.check, baseline);
    this.jumpTo = -1;
  }

  /** One WATCH tick. Tests call this directly with a fake clock. */
  async poll() {
    if (this.polling || !this.active) return;
    this.polling = true;
    try {
      await this.tick();
    } finally {
      this.polling = false;
    }
  }

  async tick() {
    const t = this.now();
    if (this.phase === 'paused') return;
    if (this.pausedUntil > t) return;
    if (this.heldLine && !(this.quietUntil > t)) this.endQuiet();
    if (this.phase === 'instruct') return this.instruct();
    if (this.phase === 'praise') {
      if (t < this.praiseUntil || t < this.storyOver) return;
      // The result has sat: the story, if this step has one that may be told, then quiet.
      if (this.pendingWhy) {
        const why = this.pendingWhy;
        this.pendingWhy = '';
        this.told.add(why);
        this.lastWhy = this.i;
        // The quiet after it counts from when the story has been told.
        this.story = this.say(why);
        return;
      }
      return this.onward();
    }
    // Echo did the step and the result has sat: what changed, in one line.
    if (this.phase === 'sat') return t >= this.satUntil ? this.afterDemo() : undefined;
    // Echo's question got no answer: the next step is the user's; or the lesson they watched ends.
    if (this.phase === 'ask') {
      if (this.ask && t < this.ask.line.at + this.ask.ms) return;
      const kind = this.ask?.kind;
      this.ask = null;
      return kind === 'turn' ? this.advance() : this.finish();
    }
    if (this.phase !== 'watch') return;
    const step = this.step;
    const snap = await this.snap();
    if (snap.error) return this.blindTick(t, step);
    if (this.blind) this.blind = 0;
    // The step began while Echo couldn't see: its baseline is the first real look. Whatever it
    // shows of this step may have been done while Echo was blind, so it counts; later steps are
    // judged from this look.
    if (this.baseline?.error) {
      this.baseline = snap;
      this.last = snap;
      this.markAhead(snap);
      this.falseAtStart = true;
    }
    if (snap.editing) {
      // The user is mid-typing in a cell: stay quiet, and it counts as activity.
      this.lastChangeAt = t;
      this.streak = 0;
      return;
    }
    if (changedSince(this.last, snap)) this.lastChangeAt = t;
    this.last = snap;

    // Collateral changes come first and always speak at once.
    const collateral = collateralChanges(step, this.baseline, snap);
    if (collateral.length) {
      this.streak = 0;
      const key = collateral.map((d) => d.cell).sort().join(',');
      if (key !== this.collateralKey) {
        this.collateralKey = key;
        const lostFormula = collateral.some((d) => text(d.before.formula) && !text(d.after.formula));
        this.updateCard('hint');
        this.say(`Oops, that changed ${describeCells(collateral.map((d) => d.cell))}${lostFormula ? ' and removed a formula' : ''}. Say "undo" and I'll fix it.`);
      }
      return;
    }
    this.collateralKey = '';

    // A way of passing that doesn't hold, two polls in a row, has been seen not to hold.
    branches(step.check).forEach((b, k) => {
      this.falseRun[k] = b?.kind !== 'told' && !evalCheck(b, snap) ? this.falseRun[k] + 1 : 0;
      if (this.falseRun[k] >= 2) this.seenFalse[k] = true;
    });
    const branch = this.passed(snap);
    if (branch >= 0) {
      this.streak += 1;
      if (this.streak >= 2) return this.pass(branch > 0 ? 'That works too.' : null);
      return;
    }
    this.streak = 0;

    // They did a later step already (another way there): roll with it. Only when that step and
    // every step jumped over (this one too) had a check that wasn't true when this step began, and
    // the later one now holds two polls in a row. A check that was already true proves nothing:
    // on Oct 3 two of those carried a lesson from step 1 to step 5 after one click.
    const jump = this.ahead.findLastIndex((wasFalse, k) => wasFalse && evalCheck(this.steps[k].check, snap));
    const clean = jump > this.i && this.falseAtStart && this.ahead.slice(this.i + 1, jump).every(Boolean);
    if (clean && jump === this.jumpTo) {
      for (let k = this.i; k < jump; k++) this.done.push(this.steps[k].say);
      this.i = jump;
      return this.pass('That works too.');
    }
    this.jumpTo = clean ? jump : -1;

    const miss = nearMiss(step, this.baseline, snap);
    // (Not in the few seconds after Echo asked something: the next poll says it.)
    if (miss && miss.key !== this.lastNearKey && t - (this.lastCorrectionAt ?? -Infinity) >= TEACH_CORRECTION_GAP_MS && !this.ladder.waiting(t)) {
      this.lastNearKey = miss.key;
      this.lastCorrectionAt = t;
      this.tries += 1;
      this.updateCard('hint');
      // A wrong try the check can see: the correction, and one rung more help.
      await this.climb('wrong', { lead: miss.say });
      if (this.phase !== 'watch') return;
      if (this.tries === TEACH_TRIES) this.report('struggling', `The user has missed step ${this.i + 1} ("${step.say}") ${TEACH_TRIES} times. Look at the screen: if the step is the problem, fix it with lesson_control replace_steps; if not, say nothing: Echo gives more help by itself, and offers to do the step. The lesson keeps watching.`);
      return;
    }

    const idle = t - this.lastChangeAt;
    if (this.quietUntil > t) return; // the model is answering: no nudges over it
    if (this.saying) return; // Echo's own line is still being said: the idle time counts from its end
    if (idle >= TEACH_IDLE_MS) {
      this.phase = 'paused';
      this.release('stopped');
      this.updateCard('paused');
      this.say('I\'ll pause here. Say "go on" when you\'re ready.');
      this.report('idle', `The user went quiet on step ${this.i + 1} of ${this.steps.length} ("${step.say}"), and Echo told them the lesson is paused until they say "go on". Say nothing unless they speak.`);
      return;
    }
    if (idle >= TEACH_STUCK_MS && !this.stuckTold) {
      // Nothing is said here: the ladder below gives the help. The model hears once, so it can
      // mend a step that can't work.
      this.stuckTold = true;
      this.report('stuck', `The user has been on step ${this.i + 1} ("${step.say}") for ${Math.round(idle / 1000)} seconds with nothing changing. Echo is giving more help by itself, a rung at a time (a prompt, a hint, the light, then an offer to do the step).${this.takesWord && !branches(step.check).some((b) => b?.kind === 'told') ? " Its check was already true before the step began, so it can't show when the step is done: Echo is waiting for the user to say so." : ''} Look at the screen: if the step can't work as written (wrong target, wrong gesture, a check that can't pass), fix it with lesson_control replace_steps. Otherwise say nothing.`);
    }
    // Nothing happening: one rung more help. Counted from the last thing the user did or said, or
    // the last rung, and never while an offer waits for its answer.
    if (!this.offerOpen && this.ladder.idleDue(t, this.lastChangeAt)) await this.climb('idle');
  }

  /**
   * A poll where Echo couldn't see the screen: nothing passes or gets corrected, and it isn't
   * activity, so the check-ins still come. After a few in a row Echo says so once, and the model hears.
   */
  async blindTick(t, step) {
    this.streak = 0;
    this.blind = (this.blind || 0) + 1;
    if (this.blind === TEACH_BLIND_POLLS) {
      this.say("I can't see your screen right now, so I can't check this step. Say next when you've done it.");
      this.report('cant_see', `Echo can't read the screen right now (${this.lastError || 'no answer'}), so it can't check step ${this.i + 1} ("${step.say}"). The user can say "next" to move on. If it keeps happening, the Mac app may need a look.`);
    }
    if (this.quietUntil > t) return;
    const idle = t - this.lastChangeAt;
    if (idle >= TEACH_HINT1_MS && this.hintLevel < 1) {
      this.hintLevel = 1;
      this.updateCard('hint');
      await this.show(step);
      this.say(`Still with me? ${step.say}`);
    }
  }

  /**
   * The step is done by the user: tick it, say what the check saw (`line` says something else in
   * its place: "That works too."), then the story if it may be told, then the next step or the
   * end. A user who needs little hears no acknowledgement, unless the line must be heard (`keep`:
   * it says which cell stands in for the one the lesson named).
   * @param {string | null} [line] @param {{ keep?: boolean, snap?: any }} [o] snap: the look the step passed on
   */
  pass(line = null, { keep = false, snap = this.last } = {}) {
    const step = this.step;
    const rung = this.ladder.rung;
    this.lastPassAt = this.now();
    this.offerUntil = 0;
    this.rungs.push(rung);
    this.ladder.solved(this.now()); // the next step starts a rung lower
    this.release('done');
    this.done.push(step.say);
    this.updateCard('correct');
    // What the check saw, when the lesson saw it happen (a check that was true all along, or the
    // user's word for it, names nothing): else the step's own words of praise, else a plain one.
    const way = snap && !snap.error && !snap.editing ? this.passed(snap) : -1;
    // (A quick lesson goes straight on to the next thing.)
    const ack = keep ? line : this.quiet || this.quick ? '' : line ?? ((way >= 0 ? sawLine(branches(step.check)[way], snap) : '') || text(step.praise) || ACKS[this.i % ACKS.length]);
    this.settle(ack, { by: 'user', rung });
  }

  /**
   * A step has just ended (the user did it, or Echo did): the one line about it, and what comes
   * after waits a moment, so the result can be seen (and the story, when it may be told, comes
   * once it has).
   * @param {string | null} line @param {{ by: string, rung: number, once?: boolean }} o once: Echo showed this one step on request
   */
  settle(line, { by, rung, once = false }) {
    this.say(line);
    const why = text(this.step.why);
    const tell = mayTellStory({ why, by, rung, frustrated: this.frustratedOn === this.i, ahead: this.ladder.terse, since: this.i - this.lastWhy, again: this.told.has(why) });
    if (why) this.note('story', { told: tell });
    this.pendingWhy = tell ? why : '';
    this.turnBack = once;
    this.phase = 'praise';
    this.praiseUntil = this.now() + TEACH_PRAISE_MS;
  }

  /** After a step has ended and been spoken about: the next step, Echo's question, or the end. */
  async onward() {
    const last = this.i >= this.steps.length - 1;
    const turnBack = this.turnBack;
    this.turnBack = false;
    // The whole lesson was shown: the turn is offered, and on yes it starts again, guided.
    if (last && this.mode === 'show') return this.asks('retry', 'Want to try it yourself now?', TEACH_OFFER_MS);
    if (last) return this.finish();
    // One step was shown on request: the turn goes back, unless they say to keep showing.
    if (turnBack && this.mode === 'guide') return this.asks('turn', 'Your turn on the next one?', LADDER_ASKED_MS);
    return this.advance();
  }

  /** Echo asks, and waits `ms` past the question for the answer (tick moves on without one). */
  asks(kind, line, ms) {
    this.phase = 'ask';
    this.ask = { kind, ms, line: this.say(line) };
  }

  advance() {
    this.i += 1;
    this.phase = 'instruct';
    return this.instruct();
  }

  /** The current step is left undone (the user said "skip"), or Echo has done it (lesson_control skip): on to the next, or the end. */
  async next() {
    if (this.demo) return this.demonstrated();
    this.release('skipped');
    this.ladder.left();
    if (this.i >= this.steps.length - 1) this.finish();
    else await this.advance();
  }

  /** The end: one line of what they did (at most three things) and the lesson's closing line; then Echo is quiet. */
  finish() {
    // A quick lesson only pointed things out: its last words were the last step's own.
    if (this.quick) return this.end('finished', `Every step${this.goal ? ` of "${this.goal}"` : ''} has been pointed out and said, and the light is on the last one. Say nothing more.`);
    const watched = !this.rungs.some((r) => r < RUNG.DO_IT);
    this.say([this.ladder.terse ? '' : recapLine(this.done, { watched }), this.closing].filter(Boolean).join(' '));
    this.end('finished', `The lesson${this.goal ? ` "${this.goal}"` : ''} is finished: ${this.done.length} of ${this.steps.length} steps done. Echo has said what they did and closed the lesson itself. Say nothing more.`);
  }

  /**
   * The user watched the whole lesson and wants to try: it starts again from step 1, guided, every
   * step a rung lower than it otherwise would be (they have just seen it done). The stories were
   * told once and are not told again.
   */
  restart() {
    this.ask = null;
    this.setMode('guide');
    this.i = 0;
    this.done = [];
    this.rungs = [];
    this.lastWhy = -Infinity;
    this.ladder = new HelpLadder({ lowerSteps: Infinity });
    this.phase = 'instruct';
    this.report('retry', `The user watched Echo do the lesson${this.goal ? ` "${this.goal}"` : ''} and now wants to try it themselves: it has started again from step 1 and Echo guides them. What Echo made while showing is still on screen, so a step whose check is already true can't be seen to pass. If that is so, put things back as they were (undo what you did) or fix the steps with lesson_control replace_steps, and say what you did in a few words; otherwise say nothing.`);
    this.schedule(0);
  }

  end(kind, note) {
    this.phase = 'ended';
    // Every way out of a lesson comes through here: a light still waiting is let go.
    this.release('stopped');
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.updateCard(kind === 'finished' ? 'correct' : 'stopped', { finished: true, complete: kind === 'finished' });
    this.report(kind, note);
  }

  /** Stops the lesson (the Stop button, Escape). */
  stop() {
    if (this.active) this.end('stopped', `The user stopped the lesson at step ${this.i + 1} of ${this.steps.length}. Say so in a few words.`);
  }

  /**
   * The model re-plans: the current step and everything after it are replaced, and the new
   * current step is shown at once. Steps already done stay done.
   * @param {any[]} steps
   */
  replaceSteps(steps) {
    if (!this.active) return { ok: false, note: 'No lesson is running.' };
    const fresh = (Array.isArray(steps) ? steps : []).filter((x) => x && text(x.say) && x.check);
    // Mended like a new plan (repairLesson): only steps that can't run are sent back.
    const plan = repairLesson({ steps: fresh.slice(0, TEACH_MAX_STEPS - this.i) });
    if (!fresh.length || !plan.ok) return { ok: false, repairs: plan.repairs, note: `Fix the new steps: ${fresh.length ? plan.errors.join('; ') : 'no steps'}.` };
    this.steps = [...this.steps.slice(0, this.i), ...plan.lesson.steps];
    this.release('skipped'); // the step it was waiting on is gone
    this.quietUntil = 0;
    this.heldLine = '';
    this.phase = 'instruct';
    this.schedule(0);
    return { ok: true, repairs: plan.repairs, note: `Steps replaced from step ${this.i + 1}; the lesson shows step ${this.i + 1} now. ${plan.note ? `${plan.note} ` : ''}Say nothing more.` };
  }

  /** Lets the lesson watch again after a question went to the model. */
  resume() {
    this.pausedUntil = 0;
    this.endQuiet();
    if (this.phase === 'paused') {
      this.phase = 'instruct';
      this.schedule(0);
    }
  }

  /** Context for the model when the user asks something mid-lesson. */
  context() {
    const s = this.step;
    return { title: this.title, step: this.i + 1, total: this.steps.length, say: s?.say, hint: s?.hint, lastCheck: this.last ? evalCheck(s?.check, this.last) : false, mode: this.mode, ...(this.storyGap ? { story: text(s?.why) } : {}) };
  }

  /**
   * Speech during a lesson. Lesson commands are handled here, without a model call; anything else
   * pauses the watch for a moment and comes back with the lesson context for the model.
   * @param {string} said
   * @param {{ answering?: boolean }} [opts] answering: the assistant asked something, so a short answer is for it
   * @returns {Promise<{ handled: boolean, command?: string, context?: ReturnType<TeachSession["context"]> }>}
   */
  async hear(said, opts = {}) {
    if (!this.active) return { handled: false };
    const cmd = this.takes(said, opts);
    const step = this.step;
    switch (cmd) {
      case 'yes':
        this.demonstrate({ once: true, rung: this.ladder.rung });
        return { handled: true, command: cmd };
      case 'no':
        this.offerUntil = 0;
        this.say('Okay, go ahead.');
        this.lastChangeAt = this.now();
        return { handled: true, command: cmd };
      case 'help':
        await this.frustrated();
        return { handled: true, command: cmd };
      case 'where': {
        // "Show me where", "where is it": the light goes to it, and the step stays the user's.
        this.lastChangeAt = this.now();
        const c = this.ladder.pointOut(this.now());
        if (c) this.note('rung', { rung: c.to, from: c.from, trigger: 'where' });
        this.updateCard('hint');
        await this.point(step);
        if (this.step === step && this.active) this.say("It's here. Your turn.");
        return { handled: true, command: cmd };
      }
      case 'stuck':
        // "Where?", "I can't find it", "help": one rung more, at once. At the top, the step again.
        this.lastChangeAt = this.now();
        if (!(await this.climb('stuck'))) {
          await this.show(step);
          this.say(step.say);
        }
        return { handled: true, command: cmd };
      case 'know':
        // "I know this": Echo says less from here, and says nothing now.
        this.ladder.ahead();
        this.lastChangeAt = this.now();
        this.note('ahead');
        return { handled: true, command: cmd };
      case 'do_all':
        this.setMode('do');
        this.doAll();
        return { handled: true, command: cmd };
      case 'show_all':
        // "Show me the whole lesson", "keep showing": Echo shows every step that is left.
        this.setMode('show');
        if (this.demo) this.demo.once = false;
        else if (this.phase === 'ask') {
          this.ask = null;
          await this.advance();
        } else if (this.phase === 'watch') this.demonstrate({ rung: this.ladder.rung });
        return { handled: true, command: cmd };
      case 'try':
        // "Let me try": the lesson is the user's again, from this step (or the next, if Echo is mid-step).
        this.setMode('guide');
        this.lastChangeAt = this.now();
        if (this.phase === 'ask') {
          this.ask = null;
          await this.advance();
        } else if (this.demo) {
          this.demo.once = false;
          this.say("Okay, the next one's yours.");
        } else this.say('Okay, go ahead.');
        return { handled: true, command: cmd };
      case 'retry':
        this.restart();
        return { handled: true, command: cmd };
      case 'enough':
        this.ask = null;
        this.finish();
        return { handled: true, command: cmd };
      case 'do':
        // "Just do it", "do it for me": this one step, at full speed, and the lesson goes on.
        if (this.demo) return { handled: true, command: cmd };
        this.toTop('do');
        this.demonstrate({ pace: 'do', rung: RUNG.DO_IT });
        return { handled: true, command: cmd };
      case 'remark':
        this.remarked();
        return { handled: true, command: cmd };
      case 'repeat':
        await this.show(step);
        this.say(step.say);
        this.lastChangeAt = this.now();
        return { handled: true, command: cmd };
      case 'show': {
        // "Show me": Echo shows this one step, with no offer first, and then offers the turn back.
        if (this.demo) return { handled: true, command: cmd };
        const rung = this.ladder.rung;
        this.toTop('do');
        this.demonstrate({ once: true, rung });
        return { handled: true, command: cmd };
      }
      case 'next':
        // "Skip": they know this one, so Echo says less from here.
        this.ladder.ahead();
        await this.next();
        return { handled: true, command: cmd };
      case 'back':
        this.release('skipped');
        this.i = Math.max(0, this.i - 1);
        this.done = this.done.slice(0, this.i);
        await this.instruct();
        return { handled: true, command: cmd };
      case 'pause':
        this.phase = 'paused';
        this.release('stopped');
        this.updateCard('paused');
        this.say('Paused. Say "go on" when you\'re ready.');
        return { handled: true, command: cmd };
      case 'resume':
        if (this.phase !== 'paused') return { handled: false, context: this.context() };
        // Echo couldn't do the step it was showing: the lesson is the user's from here.
        if (this.demo) this.setMode('guide');
        this.phase = 'instruct';
        await this.instruct({ replay: true });
        return { handled: true, command: cmd };
      case 'stop':
        this.say('Okay, stopping the lesson.');
        this.stop();
        return { handled: true, command: cmd };
      case 'done':
        await this.saidDone(step);
        return { handled: true, command: cmd };
      case 'undo':
        await this.undo();
        return { handled: true, command: cmd };
      default:
        // A question or a remark: the model answers it. The lesson keeps watching (a step done
        // meanwhile still passes) but holds its own lines until the answer is over, so the two
        // never talk over each other. Talking also shows the user is still here.
        this.remarks = [...this.recentRemarks(), this.now()];
        this.quietUntil = this.now() + TEACH_QUESTION_PAUSE_MS;
        this.lastChangeAt = this.now();
        return { handled: false, context: this.context() };
    }
  }

  /**
   * What the lesson makes of something said, with no model call: one of its commands, a yes or no
   * to its offer, or a 'remark' it lets pass (one or two words that are no command and no
   * question: "okay", "hmm", "I think"; on Oct 3 fourteen of those became model turns on one
   * step). null: a question or a real sentence, which the assistant answers.
   * @param {string} said @param {{ answering?: boolean }} [opts]
   * @returns {string | null}
   */
  takes(said, { answering = false } = {}) {
    if (!this.active) return null;
    const cmd = teachCommand(said);
    const s = plainSaid(said).replace(/^(echo |hey echo )/, '').replace(/ please$/, '');
    // An answer to Echo's own question: the turn back after one shown step, or trying after watching.
    if (this.phase === 'ask' && this.ask?.kind === 'turn') {
      if (KEEP_SHOWING.test(s) || cmd === 'show' || cmd === 'show_all') return 'show_all';
      if (PLAIN_YES.test(s) || cmd === 'try') return 'try';
    }
    if (this.phase === 'ask' && this.ask?.kind === 'retry') {
      if (PLAIN_YES.test(s) || cmd === 'try') return 'retry';
      if (PLAIN_NO.test(s)) return 'enough';
    }
    // Right after the story, what is said is about the story: the assistant answers it. (Stopping
    // and pausing still work, and a word or two that asks nothing gets no reply.)
    if (this.storyGap) {
      if (cmd === 'stop' || cmd === 'pause') return cmd;
      return !answering && !isQuestion(said) && !cmd && s.split(' ').filter(Boolean).length <= 2 ? 'remark' : null;
    }
    if (this.offerOpen) {
      if (OFFER_YES.test(s)) return 'yes';
      if (OFFER_NO.test(s)) return 'no';
    }
    if (cmd) return cmd;
    if (answering || isQuestion(said)) return null;
    if (s.split(' ').filter(Boolean).length <= 2) return 'remark';
    // A third thing said in a minute with nothing getting done: Echo says what it is waiting for.
    return this.restless() ? 'remark' : null;
  }

  /** The times of what was said (and wasn't a command) in the last minute. */
  recentRemarks() {
    return (this.remarks || []).filter((at) => this.now() - at < TEACH_REMARKS_MS);
  }

  /** One more remark would make three in a minute with no step passed, and Echo hasn't yet said what it is waiting for. */
  restless() {
    return !this.helped && this.phase === 'watch' && this.recentRemarks().length >= TEACH_REMARKS - 1 && !(this.now() - (this.lastPassAt ?? -Infinity) < TEACH_REMARKS_MS);
  }

  /** A remark: no reply at all, the watch goes on. The third in a minute with no step passed gets
   *  ONE helpful line (what Echo is waiting for, and the offer), not the step's words again. */
  remarked() {
    const help = this.restless();
    this.remarks = [...this.recentRemarks(), this.now()];
    this.lastChangeAt = this.now(); // talking shows the user is still here
    this.note('remark');
    if (!help) return;
    this.helped = true;
    this.frustratedOn = this.i;
    this.toTop('frustrated');
    this.offer(`${waitingFor(this.step)} Want me to do this step for you?`);
  }

  /**
   * "Done", said by the user. The screen answers when it can: passed, or one specific sentence of
   * what Echo sees against what the step wanted, and when the difference doesn't matter for
   * learning the step passes with "That works too." (the later steps then use the cell the user
   * really used). Not done: the sentence, and one rung more help (at the top, the offer, once).
   */
  async saidDone(step) {
    const snap = await this.snap();
    this.lastChangeAt = this.now();
    if (snap.error) return this.say("I can't see your screen right now. Say next if you've done it.");
    // Their word is enough only when the screen can't say; otherwise the screen answers.
    if (this.passed(snap) >= 0 || this.takesWord) return this.pass(null, { snap });
    const blind = this.unseeable;
    const seen = blind ? withFocusCell(snap) : snap;
    const look = doneLook(step, this.baseline, seen, cellTexts(this.steps));
    if (look?.ok) {
      const { from, to } = look.moved || {};
      if (from && to) this.steps = this.steps.map((x, k) => (k > this.i ? moveCell(x, from, to) : x));
      this.note('close_enough');
      return this.pass(`${look.say} That works too.`, { keep: true });
    }
    // The focused cell is the one the step named and holds what it wanted: done as written.
    if (blind && branches(step.check).some((b) => evalCheck(b, seen))) return this.pass(null, { snap: seen });
    if (blind) {
      // Echo can't see cells from the app's state. The first time, the assistant looks at the
      // screen once and answers; the second, the offer; after that the user's word is taken,
      // never a dead end.
      if (this.lookAsked && this.offered === this.i) return this.pass('Okay.');
      if (this.lookAsked) {
        this.toTop('done');
        return this.offer();
      }
      this.lookAsked = true;
      this.quietUntil = this.now() + TEACH_QUESTION_PAUSE_MS;
      return this.report('look', `The user says they've done step ${this.i + 1} ("${step.say}"), and Echo can't see it from the app's state. Look at the screen once (look_at_screen), then answer in ONE specific sentence what you see against what the step wanted, like "I can see Hello in A5, not A1." If the step is done, or the difference doesn't matter for learning (the right text in a different cell of the same sheet, a shape drawn in a different place, the right thing done by a different route), call lesson_control with action "accept": Echo says "That works too" and moves on, so don't say that yourself. Otherwise add the one thing to change, and nothing more.`);
    }
    await this.climb('done', { lead: look ? `Not yet. ${look.say}` : `Not yet. I don't see it on screen. ${nearMiss(step, this.baseline, snap)?.say || step.say}` });
  }

  /** "Want me to do this step for you?", once per step: a "yes" inside TEACH_OFFER_MS and Echo shows it (demonstrate). */
  offer(line = 'Want me to do this step for you?') {
    this.offered = this.i;
    this.offerUntil = this.now() + TEACH_OFFER_MS;
    this.lastChangeAt = this.now();
    this.note('offer');
    this.updateCard('hint');
    this.say(line);
  }

  /** Something frustrated was said: a few words that say Echo heard it, then the offer; once the offer has been made on this step, the step itself. */
  async frustrated() {
    this.frustratedOn = this.i;
    this.toTop('frustrated');
    if (this.offered === this.i) return this.demonstrate({ once: true, rung: RUNG.DO_IT });
    this.offer("That one's fiddly. Want me to do it?");
  }

  /**
   * Echo does the first half of this step (the step's `first_half`: selecting the tool, opening
   * the menu) and leaves the rest. Like demonstrate, the assistant does it with its computer tools;
   * the lesson stops watching until it is told to go on (lesson_control resume), and then hands
   * the step back with "Your turn."
   * @param {string} [lead]
   */
  doPart(lead = '') {
    const step = this.step;
    this.phase = 'paused';
    this.partDone = true;
    this.release('stopped');
    this.updateCard('demo');
    this.say(`${lead ? `${lead} ` : ''}I'll start this one. Watch.`);
    this.report('do_part', `The user is stuck on step ${this.i + 1} of ${this.steps.length} ("${step.say}"), and Echo said "I'll start this one. Watch." Do ONLY this first part yourself now with your computer tools (look first if you need to): ${text(step.first_half)} Say what you did in a few words, then call lesson_control with action "resume": Echo says "Your turn" and watches the user do the rest. Do nothing more of the step. If you can't control the Mac, say so in one sentence and call lesson_control with action "resume".`);
  }

  /**
   * Echo does this ONE step itself. The lesson only reads the screen, so the assistant does it
   * with its computer tools; the lesson stops watching until it is told the step is done
   * (lesson_control skip → next). Shown ('show'): one line of intent first, and the first movement
   * waits for it (leadLeft); nothing is said while the light moves or the step runs; then the
   * result sits and Echo says what changed (demonstrated). At full speed ('do'): "Okay.", the
   * step, one line.
   * @param {{ pace?: 'show' | 'do', once?: boolean, rung?: number }} [o] once: one step on request, so the turn is offered back;
   *   rung: how much help the step had needed before Echo took it (for the story)
   */
  demonstrate({ pace = 'show', once = false, rung = RUNG.WAIT } = {}) {
    const step = this.step;
    this.offerUntil = 0;
    this.wasShown = true;
    this.phase = 'paused';
    this.release('stopped');
    this.updateCard('demo');
    const intent = pace === 'do' ? 'Okay.' : this.quiet ? '' : intentLine(step);
    const said = this.say(intent);
    this.demo = { pace, once, rung, line: pace === 'show' ? said : null };
    const ifNot = `If you can't control the Mac, say so in one sentence and call lesson_control with action "resume".`;
    if (pace === 'do') {
      this.report('do_step', `The user asked Echo to do step ${this.i + 1} of ${this.steps.length} ("${step.say}") for them, and Echo said "Okay." Do exactly this ONE step yourself now with your computer tools (look first if you need to), with no "say" on them and without speaking, then call lesson_control with action "skip": Echo says what changed in one line and carries on at the next step by itself. Do no later step. ${ifNot}`);
    } else {
      this.report('show_step', `Echo is showing the user step ${this.i + 1} of ${this.steps.length} ("${step.say}")${intent ? ` and has said "${intent}"` : ''}. Do exactly this ONE step yourself now with your computer tools (look first if you need to), with no "say" on them and without speaking: nothing is said while the light moves or the step runs. Then call lesson_control with action "skip" and say nothing: Echo lets the result sit, says what changed, and carries on by itself. Do no later step. ${ifNot}`);
    }
  }

  /** The assistant has done the step Echo was showing or doing: it counts as done, and a shown result sits before anything is said. */
  demonstrated() {
    const d = this.demo;
    if (!d) return;
    this.demo = null;
    this.justShown = d;
    this.ladder.shown();
    this.rungs.push(RUNG.DO_IT);
    this.done.push(this.step.say);
    this.updateCard('correct');
    if (d.pace === 'do') return this.afterDemo();
    this.phase = 'sat';
    this.satUntil = this.now() + SHOW_PACE.sitMs;
  }

  /** What changed, in one line from what the step's check now sees; then the story, the turn back, or the next step. */
  async afterDemo() {
    const d = this.justShown || { pace: 'show', once: false, rung: RUNG.WAIT };
    this.phase = 'praise'; // (nothing else begins while Echo looks)
    this.praiseUntil = Infinity;
    const snap = await this.snap();
    if (!snap.error && !snap.editing) this.last = snap;
    const saw = seenLine(this.step.check, snap);
    const line = d.pace === 'do' ? saw || 'Done.' : this.quiet ? '' : saw || "That's done.";
    this.settle(line, { by: d.pace === 'show' ? 'shown' : 'echo', rung: d.rung, once: d.once });
  }

  /** "Do the rest" / "do it all": the lesson ends, and the assistant does every step that is left at full speed, with one line at the end. */
  doAll() {
    const rest = this.steps.slice(this.i).map((x, k) => `${k + 1}. ${x.say}`).join(' ');
    this.say("Okay, I'll do the rest.");
    this.end('do_all', `The user asked Echo to do the rest of the lesson${this.goal ? ` "${this.goal}"` : ''} for them, and Echo said "Okay, I'll do the rest." The lesson has ended. Do these remaining steps yourself now, in order, with your computer tools, at full speed and without narrating them: ${rest} Then say in ONE sentence what is done. If you can't control the Mac, say so in one sentence.`);
  }

  /** The assistant looked and the step is done, or close enough (lesson_control accept): "That works too.", and on to the next. */
  accept() {
    if (!this.active) return false;
    if (this.phase !== 'praise') this.pass('That works too.');
    return true;
  }

  /** ⌘Z, then check the cells are back the way the step started; put back any it missed. */
  async undo() {
    const step = this.step;
    if (this.adapter.undo) await this.adapter.undo();
    let snap = await this.snap();
    const left = diffCells(this.baseline, snap);
    if (left.length && this.adapter.restore) {
      const cells = Object.fromEntries(left.map((d) => [d.cell, d.before]));
      await this.adapter.restore(cells);
      snap = await this.snap();
      this.say(diffCells(this.baseline, snap).length ? 'I couldn\'t put everything back. Check the sheet.' : 'Undo missed some cells, so I put them back.');
    } else if (left.length) {
      this.say('That didn\'t undo everything. Press Command Z once more.');
    } else {
      this.say('Fixed it.');
    }
    this.last = snap;
    this.collateralKey = '';
    this.streak = 0;
    this.lastChangeAt = this.now();
    await this.show(step);
    this.say(step.alt_say || step.say);
  }
}
