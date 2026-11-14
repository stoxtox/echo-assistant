// Should Echo ask before this action? Decided by what the action does, not by words in a label
// (ECHO_CORE_PLAN.md §7, decided Oct 2 2026 from what ChatGPT agent, Claude in Chrome and Claude
// Code, Gemini, Apple's App Intents, Alexa and Copilot do). Four tiers:
//
//   1  never asks: reading, scrolling, typing into a field, any undoable edit in the open document
//      (a text field, a checkbox, a slider, a shape: "Apply Corner Radius" is an edit, not a form;
//      a cell or a small block of a spreadsheet: Echo keeps what the cells held, for "undo that")
//   2  asks unless the user just said exactly that: deleting, saving over, closing or quitting
//      with work open, git push ("save it", "delete the screenshot" go ahead; "tidy up" asks);
//      and one spreadsheet write that replaces or clears more than 20 cells that hold something
//      (that one always asks: no words of the user's name which cells); moving anything to the
//      Trash through Finder's scripting, and moving or renaming more than 10 files at once
//      (lib/apps/finder.js: the many-at-once ones always ask too)
//   3  always asks, even when told: sending, posting, submitting a form, buying, accounts and
//      sign-ins, system settings, the Terminal, installing; anything prompted by text on screen
//   4  never: passwords and codes, card numbers, the privacy settings, Echo's own window, moving
//      money (handed to the user)
//
// The hard refusals and the context rules (a "Continue" on a payment page, Return in a chat) come
// from the classifier this replaces (lib/agent/risk.js classifyAction), which still runs first.
import { classifyAction } from './agent/risk.js';

export type Tier = 1 | 2 | 3 | 4;
/** `again`: asked because the user said no to this kind of thing a moment ago (lib/computer.js refusedRoute). */
export type Verdict = { level: 'ok' | 'risky' | 'refuse'; tier: Tier; category?: string; reason?: string; again?: boolean };
type Req = Parameters<typeof classifyAction>[0] & { overwrites?: number; op?: string; count?: number; airdrop?: boolean; file?: string };

/** How many cells that already hold something one spreadsheet write may replace or clear without asking first. */
export const SHEET_OVERWRITE_MAX = 20;

/** How many files one move or one rename through Finder (lib/apps/finder.js) may touch without asking first. */
export const FILES_MAX = 10;

/** Controls whose change is an edit in the open document, undone with ⌘Z: never a form being sent. */
const EDIT_ROLES = /^AX(?:TextField|TextArea|SearchField|ComboBox|CheckBox|Switch|RadioButton|Slider|Incrementor|Stepper|ValueIndicator|ColorWell|PopUpButton|DisclosureTriangle|Tab|TabButton|SegmentedControl|StaticText|Image|Unknown|Group|Cell|Row|OutlineRow|LevelIndicator|ScrollArea|Splitter|Canvas)$/;
/** Categories an edit control can never really be (it holds a value; it doesn't send or pay). */
const EDIT_SAFE = new Set(['submit', 'delete', 'send', 'account']);

/** Keyboard shortcuts by what they do. */
const SAVE_KEYS = new Set(['cmd+s', 'shift+cmd+s', 'alt+cmd+s', 'alt+shift+cmd+s']);
const CLOSE_KEYS = new Set(['cmd+w', 'shift+cmd+w', 'cmd+q', 'alt+cmd+w', 'alt+cmd+q']);
/** Menu items and buttons that save or close. */
const SAVE_LABEL = /^(?:save|save as(?:…|\.\.\.)?|save a copy(?:…|\.\.\.)?|save all|replace|overwrite)$/i;
const CLOSE_LABEL = /^(?:close(?: window| tab| all)?|quit(?: \S+(?: \S+)?)?|don'?t save|discard changes|delete draft)$/i;
/** The Passwords app, Keychain Access, and their menu bar icon: never Echo's to open or point at. */
export const PASSWORD_UI = /\b(?:passwords|keychain(?: access)?)\b/i;
/** Moving money is never Echo's to do. */
const MOVES_MONEY = /\b(?:send money|transfer (?:money|funds)|wire (?:money|transfer)|bank transfer|zelle|venmo|paypal send|pay (?:now|\$\s?\d))\b/i;
/** Running a push or a deploy in the Terminal: asks unless said (tier 2 at most for push). */
const GIT_PUSH = /^\s*git\s+push\b/;

/** Controls that Return or Space presses when they have the keyboard focus. */
const PRESS_ROLES = /^AX(?:Button|MenuButton|MenuItem|Link)$/;
const PRESS_KEYS = new Set(['return', 'enter', 'space']);
/** The AirDrop window or sheet, by its title; and the buttons in it that send nothing. */
const AIRDROP_WINDOW = /^airdrop\b/i;
const AIRDROP_LEAVES = /^(?:cancel|done|close(?: window)?|minimi[sz]e|zoom|airdrop)$/i;

/**
 * Is this Return, Enter or Space (no other keys held) on a button that has a name? Then it does
 * what a click on that button does, and is judged as that click (Oct 4: a "Submit" card was
 * cancelled, then Return on the focused Submit button sent the form with no card).
 * The Mac app says which control has the keyboard focus when the step names no target, or the
 * control the step named; when it says neither (no focus it can read), this is false.
 */
export function pressesButton(req: { action?: string; keys?: unknown; target?: string; resolved?: { label?: string; role?: string } }): boolean {
  const r = req.resolved || {};
  return req.action === 'press_keys' && PRESS_KEYS.has(combo(req.keys)) && PRESS_ROLES.test(String(r.role || '')) && Boolean(String(r.label || '').trim());
}

/** Kinds of action the user's own exact words can approve (tier 2). Send is never one: it always asks. */
export const SAY_SO_CATEGORIES = ['delete', 'save', 'close'];

const t = (tier: Tier, category: string, reason: string): Verdict => ({ level: tier === 1 ? 'ok' : tier === 4 ? 'refuse' : 'risky', tier, category, reason });
const ok: Verdict = { level: 'ok', tier: 1 };

function combo(keys: unknown): string {
  const parts = String(keys || '').toLowerCase().replace(/command|⌘/g, 'cmd').replace(/option|opt|⌥/g, 'alt').replace(/control|ctrl|⌃/g, 'ctrl').replace(/⇧/g, 'shift').split(/[+\s]+/).filter(Boolean);
  const order = ['ctrl', 'alt', 'shift', 'cmd'];
  const mods = order.filter((m) => parts.includes(m));
  const key = parts.filter((p) => !order.includes(p));
  return [...mods, ...key].join('+');
}

/**
 * The tier for one action, from what it does. Pure: the tests call it directly.
 */
export function classifyByEffect(req: Req): Verdict {
  // A write to a spreadsheet through the app's own scripting (lib/sheets.js): an edit in the open
  // document that Echo can put back. Replacing or clearing a lot of it at once asks first.
  if (req.action === 'sheet_write') {
    const n = Number(req.overwrites) || 0;
    return n > SHEET_OVERWRITE_MAX ? t(2, 'overwrite', `replace or clear ${n} cells that hold something`) : ok;
  }
  // Files through the Finder adapter (lib/apps/finder.js). The Trash always asks, whatever the
  // user said ('trash' is not a kind their words can approve: nothing ties "delete it" to the path
  // a script was given); a move or a rename asks once it is more than a handful.
  if (req.action === 'app_files') {
    const n = Number(req.count) || 0;
    const things = n === 1 ? 'one thing' : `${n} things`;
    if (req.op === 'trash') return t(2, 'trash', `move ${things} to the Trash (the user can put it back from there)`);
    return n > FILES_MAX ? t(2, 'move', `${req.op === 'rename' ? 'rename' : 'move'} ${things} at once`) : ok;
  }
  // Return or Space on a focused button is a click on it: whatever the click would ask, this asks.
  if (pressesButton(req)) {
    const asClick = classifyByEffect({ ...req, action: 'click', keys: undefined });
    if (asClick.level !== 'ok') return asClick;
  }
  const base = classifyAction(req);
  const r = (req.resolved || {}) as NonNullable<Req['resolved']>;
  const label = String(r.label || req.target || '').trim();

  // Tier 4: never (passwords, the privacy settings, Echo's own window) and moving money.
  if (base.level === 'refuse') return { ...base, level: 'refuse', tier: 4 };
  if (PASSWORD_UI.test(String(r.app || req.app || '')) || PASSWORD_UI.test(label)) return t(4, 'secret', 'open the Passwords app or the Keychain. Those are yours');
  if (req.action === 'type_text' && MOVES_MONEY.test(`${label} ${r.window || ''}`)) return t(4, 'money', 'move money. That one is yours to do');
  if (req.action === 'click' && MOVES_MONEY.test(label)) return t(4, 'money', 'move money. That one is yours to do');

  // AirDrop: a click on a person or a device in the AirDrop window (or the click right after
  // choosing AirDrop in a Share menu: `airdrop`, lib/computer.js) sends them the file. It asks as
  // sending a message does, whatever the thing clicked is called or made of.
  if (req.action === 'click' && (req.airdrop || AIRDROP_WINDOW.test(String(r.window || '').trim())) && !AIRDROP_LEAVES.test(label)) {
    return t(3, 'send', `send ${req.file ? `“${req.file}”` : 'the file'} to ${label ? `“${label}”` : 'whoever is at that spot'} by AirDrop`);
  }

  // Keyboard shortcuts by what they do.
  if (req.action === 'press_keys') {
    const k = combo(req.keys);
    if (SAVE_KEYS.has(k)) return t(2, 'save', 'save over the open file');
    if (CLOSE_KEYS.has(k)) return t(2, 'close', k.endsWith('q') ? 'quit the app (anything unsaved would be lost)' : 'close the window (anything unsaved would be lost)');
  }
  if (req.action === 'type_text' && GIT_PUSH.test(String(req.text || '')) && base.category === 'terminal') return t(3, 'terminal', 'run git push in the terminal');

  if (base.level === 'ok') {
    // Menu items and buttons that save or close, which the old rules didn't know.
    if (req.action === 'click' && SAVE_LABEL.test(label)) return t(2, 'save', 'save over the open file');
    if (req.action === 'click' && CLOSE_LABEL.test(label)) return t(2, 'close', 'close or quit (anything unsaved would be lost)');
    return ok;
  }

  const category = String(base.category || '');
  // An edit control or the canvas changes the document, undoably: a field named "Apply Corner
  // Radius", a "Finish" checkbox, canvas text that says "…finish faster". Never a form being sent.
  // (System settings are the exception: a switch there changes the Mac.)
  if (req.action !== 'press_keys' && category !== 'system' && EDIT_ROLES.test(String(r.role || '')) && EDIT_SAFE.has(category)) return ok;

  if (category === 'delete') return t(2, 'delete', base.reason || 'delete something');
  // Everything else the old rules flagged (send, money, submit on a button, account, system,
  // terminal, install) always asks.
  return t(3, category, base.reason || 'do something that can\'t be undone');
}
