// Key combos: "cmd+shift+s", "Return" (moved out of lib/computer.js unchanged).
const MODS = { cmd: 'cmd', command: 'cmd', '⌘': 'cmd', shift: 'shift', '⇧': 'shift', opt: 'opt', option: 'opt', alt: 'opt', '⌥': 'opt', ctrl: 'ctrl', control: 'ctrl', '⌃': 'ctrl' };
const KEY_ALIASES = { enter: 'return', esc: 'escape', backspace: 'delete', del: 'delete', 'forward-delete': 'forwarddelete', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', 'page-up': 'pageup', 'page-down': 'pagedown', spacebar: 'space' };
// Keep in step with Keys.codes in macos/Sources/Driver.swift.
export const KEY_NAMES = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  'return', 'tab', 'space', 'escape', 'delete', 'forwarddelete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  '-', '=', '[', ']', ';', "'", ',', '.', '/', '`', '\\',
];

/**
 * "cmd+shift+t", "Command-[", "return" → { mods: ['cmd', 'shift'], key: 't', combo: 'cmd+shift+t' }.
 * @param {string} input
 */
export function parseKeys(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) throw new Error('Say which keys to press, like "cmd+t" or "return".');
  // "+" is the separator unless it's the key itself ("cmd++"); a lone "-" or "[" is a key.
  const parts = raw.replace(/\s*\+\s*/g, '+').split(/\+(?!$)|(?<=[a-z⌘⇧⌥⌃])-(?=.)/).map((p) => p.trim()).filter(Boolean);
  const mods = [];
  let key = '';
  for (const p of parts) {
    if (MODS[p]) {
      if (!mods.includes(MODS[p])) mods.push(MODS[p]);
    } else if (key) {
      throw new Error(`Only one key at a time with modifiers ("${input}" has more).`);
    } else {
      key = KEY_ALIASES[p] || p;
    }
  }
  if (!key) throw new Error(`"${input}" has no key to press.`);
  if (!KEY_NAMES.includes(key)) throw new Error(`Echo can't press "${key}".`);
  const order = ['ctrl', 'opt', 'shift', 'cmd'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { mods, key, combo: [...mods, key].join('+') };
}

/* ---------- the safety gate ---------- */

