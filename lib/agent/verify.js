// Did the action do what it should (Stage 5, "no done without a passing check")? The Mac app
// reports what changed on screen after every action (macos/Sources/PointMath.swift VerifyMath:
// focus, value, window title, windows, url, a menu opening or closing, the target's own state, the
// window's content). Any change used to count as success, so a click that only moved the keyboard
// focus onto a button "worked". Now the change has to be the kind that action on that control
// makes: a checkbox or switch must change its own state, a field must take the focus, a button
// must do something beyond taking the focus.
//
// Pure: the dispatcher's step judge (lib/computer.js judgeStep) and the eval harness call it.

/** Controls whose own state is the point of clicking them. */
const TOGGLES = new Set(['AXCheckBox', 'AXSwitch', 'AXRadioButton', 'AXDisclosureTriangle', 'AXTab', 'AXTabButton']);
/** Controls a click puts the keyboard into. */
const FIELDS = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox', 'AXSecureTextField']);
/** Controls a click opens (a menu or list) or changes the value of. */
const OPENERS = new Set(['AXPopUpButton', 'AXMenuButton', 'AXComboBox', 'AXDateField', 'AXColorWell']);

/** Changes that show a click did something (anything but the keyboard focus moving). */
const EFFECTS = ['front_app', 'value', 'window_title', 'windows', 'url', 'menu_opened', 'menu_closed', 'target_state', 'content'];

/**
 * The changes that would show this action worked, or null when any change will do.
 * @param {string} action click, hover, type_text, press_keys…
 * @param {string | undefined} role the target's accessibility role (from resolving it)
 * @returns {{ any: string[], what: string } | null}
 */
export function expectedChange(action, role) {
  if (action !== 'click') return null;
  const r = String(role || '');
  if (TOGGLES.has(r)) return { any: ['target_state', 'value', 'content', 'window_title', 'windows'], what: 'the control itself to switch' };
  if (FIELDS.has(r)) return { any: ['focus', 'target_state', 'menu_opened'], what: 'the field to take the keyboard' };
  if (OPENERS.has(r)) return { any: ['menu_opened', 'target_state', 'value', 'content', 'windows', 'focus'], what: 'it to open or change' };
  return { any: EFFECTS, what: 'something to happen beyond the focus moving' };
}

/**
 * Do the changes the app saw show the action worked?
 * @param {string} action
 * @param {string | undefined} role
 * @param {string[] | undefined} changes what the app saw change (VerifyMath.changes)
 * @returns {{ ok: boolean, why?: string }}
 */
export function postcondition(action, role, changes) {
  const want = expectedChange(action, role);
  if (!want || !Array.isArray(changes)) return { ok: true };
  if (changes.some((c) => want.any.includes(c))) return { ok: true };
  const only = changes.length ? `only ${changes.join(', ').replace(/_/g, ' ')} changed` : 'nothing changed';
  return { ok: false, why: `${only}, and a click there should cause ${want.what}` };
}
