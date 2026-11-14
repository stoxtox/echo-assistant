// Should Echo ask before this action, or never do it? The rules by words and context
// (lib/policy.ts adds the tiers by effect on top). Moved out of lib/computer.js unchanged.
import { redactText, luhn } from '../screen.js';
import { parseKeys } from './keys.js';

const SECRET_FIELD = /\b(pass ?(word|code|phrase)|pwd|secret|api ?key|access ?key|token|card ?number|credit ?card|debit ?card|cvv|cvc|cv2|security ?code|pin|ssn|social ?security|one[- ]?time ?(pass)?code|verification ?code|2fa|otp|mfa|seed ?phrase|recovery ?(key|phrase))\b/i;
export const ECHO_APP = /^echo$/i;
const SETTINGS_APP = /^(system settings|system preferences)$/i;
const SETTINGS_BUNDLE = /^com\.apple\.(systempreferences|settings)/i;
const PRIVACY_PANE = /privacy|security|accessibility|screen (recording|capture)|input monitoring|full disk|automation|files (and|&) folders|passwords|login items|touch id|users (and|&) groups|developer tools|app management/i;
// (An assistant's chat box too: Return there sends what Echo wrote to another assistant, which may act on it.)
const MESSAGING_APPS = /^(claude|chatgpt|codex|cursor|messages|mail|slack|discord|whatsapp|telegram|signal|microsoft teams|teams|outlook|microsoft outlook|messenger|spark|airmail|superhuman|zoom)$/i;
const TERMINAL_APPS = /^(terminal|iterm2?|warp|ghostty|alacritty|kitty|hyper)$/i;
// Chat and mail web apps in a browser tab: Return there sends too (Slack, WhatsApp or Discord in Chrome).
const WEB_CHAT = /\b(slack|whatsapp|discord|messenger|telegram|microsoft teams|teams|linkedin|instagram|x\.com|twitter|gmail|outlook|signal|google chat|chat\.google)\b/i;

/** What each kind of risky action looks like, in a label, a window title or a key's context. */
/** @type {Array<[string, RegExp]>} */
const RISKY = [
  ['send', /\b(send|reply( all)?|forward|post|tweet|publish|share|comment)\b/i],
  ['money', /\b(buy|purchase|pay(ment)?|check ?out|place (your )?order|order now|add to (cart|bag|basket)|subscribe|donate|transfer|send money|upgrade|billing|tip)\b|[$€£₹¥]\s?\d/i],
  ['delete', /\b(delete|remove|trash|erase|discard|empty|uninstall|clear (all|history|data)|wipe|reset|move to bin)\b/i],
  ['submit', /\b(submit|confirm|apply|agree|accept|sign up|register|create (an )?account|book|reserve|rsvp|finish|place)\b/i],
  ['account', /\b(sign ?in|log ?in|login|log ?out|sign ?out|password|account|authori[sz]e|allow access|grant|two[- ]factor|2fa|verify)\b/i],
  ['system', /\b(install|restart|shut ?down|update now|erase all)\b/i],
];
// A window that's about money or signing in makes its "Continue" or Return risky too.
const MONEY_CONTEXT = /\b(check ?out|payment|pay|billing|purchase|order|cart|basket|bank|wallet|transfer)\b/i;
const LOGIN_CONTEXT = /\b(sign ?in|log ?in|login|sign ?up|register|verify|two[- ]factor|password)\b/i;
const PROCEED = /\b(continue|next|ok|okay|done|confirm|go|proceed|yes|save)\b/i;
// False flags, from the confirmations in the action log that were always allowed at once:
// Return in a browser's address bar only goes to a page, even with Gmail open in the tab.
const ADDRESS_BAR = /\b(address (and|&) search bar|address bar|location bar|url bar|omnibox|search or (enter|type) (web )?address)\b/i;
const BROWSERS = /^(google chrome|chrome|safari|arc|firefox|microsoft edge|brave browser|opera|vivaldi|orion)$/i;
// A sidebar row or plain text in System Settings only opens a pane: switches and buttons still ask.
const SETTINGS_NAV_ROLES = /^(AXStaticText|AXRow|AXOutlineRow|AXCell)$/;

export const RISK_WORDS = {
  send: 'send a message or post something',
  money: 'spend money or change a payment',
  delete: 'delete something',
  submit: 'submit or confirm a form',
  account: 'sign in or change an account',
  system: 'change a system setting or install something',
  terminal: 'run a command in the terminal',
  share_screen: 'show your screen to the people on the call',
};

/** A button or menu item that starts sharing the screen (FaceTime, Control Center, Zoom, Meet): "Share My Screen", "Share Entire Screen", "Share Built-in Retina Display". */
export const SCREEN_SHARE = /\bshare\b[^.]{0,30}\b(screen|display|window|desktop)\b|\bstart (screen )?sharing\b/i;

/**
 * Should this action happen? Pure: the tests call it directly.
 * @param {{ action: string, target?: string, text?: string, keys?: string, app?: string, to?: string, button?: string,
 *   resolved?: { label?: string, role?: string, subrole?: string, app?: string, bundle?: string,
 *   window?: string, field?: string, secure?: boolean, inEcho?: boolean, privacyPane?: boolean } }} req
 * @returns {{ level: 'ok' | 'risky' | 'refuse', category?: string, reason?: string }}
 */
export function classifyAction(req) {
  const r = req.resolved || {};
  const app = String(r.app || req.app || '').trim();
  const window = String(r.window || '');
  const label = [r.label, req.target].filter(Boolean).join(' ');
  const field = [r.field, r.label, req.target].filter(Boolean).join(' ');
  const refuse = (category, reason) => ({ level: /** @type {const} */ ('refuse'), category, reason });
  const risky = (category, reason) => ({ level: /** @type {const} */ ('risky'), category, reason: reason || RISK_WORDS[category] });

  // Never: Echo's own window, the privacy panes, secrets.
  if (r.inEcho || ECHO_APP.test(app)) return refuse('echo', "Echo doesn't act in its own window.");
  const settings = SETTINGS_APP.test(app) || SETTINGS_BUNDLE.test(String(r.bundle || ''));
  if (r.privacyPane || (settings && PRIVACY_PANE.test(`${window} ${label}`))) return refuse('privacy', "Echo never touches the Privacy & Security settings. Those are yours to change.");
  if (req.action === 'type_text') {
    const t = String(req.text || '');
    if (r.secure || r.subrole === 'AXSecureTextField' || r.role === 'AXSecureTextField') return refuse('secret', 'That is a password field. Echo never types passwords.');
    if (SECRET_FIELD.test(field)) return refuse('secret', 'That field is for a password, code or card number. Echo never types those.');
    if (redactText(t).count > 0 || looksLikeCard(t)) return refuse('secret', 'That text looks like a password, key or card number. Echo never types those.');
  }

  // Needs a clear yes (opening a pane from the sidebar doesn't change anything).
  const settingsNav = settings && req.action === 'click' && !req.button && SETTINGS_NAV_ROLES.test(String(r.role || '')) && !RISKY.some(([, re]) => re.test(label));
  if (settings && !settingsNav && !['scroll', 'wait_for', 'hover'].includes(req.action)) return risky('system', 'change a system setting');
  if (req.action === 'scroll' || req.action === 'wait_for' || req.action === 'hover') return { level: 'ok' };
  // Dragging something onto the Trash deletes it.
  if (req.action === 'drag' && /\b(trash|bin|delete|remove)\b/i.test(String(req.to || ''))) return risky('delete');
  if (req.action === 'clear_field') {
    if (r.secure || r.subrole === 'AXSecureTextField' || r.role === 'AXSecureTextField') return refuse('secret', 'That is a password field. Echo never touches passwords.');
    return { level: 'ok' };
  }
  if (TERMINAL_APPS.test(app) && (req.action === 'type_text' || (req.action === 'press_keys' && /return/.test(String(req.keys))))) return risky('terminal');

  if (req.action === 'press_keys') {
    let k;
    try {
      k = parseKeys(String(req.keys || ''));
    } catch {
      return { level: 'ok' }; // the tool rejects it anyway
    }
    const context = `${window} ${field}`;
    if (k.key === 'return') {
      if (!k.mods.length && BROWSERS.test(app) && ADDRESS_BAR.test(field)) return { level: 'ok' };
      if (MESSAGING_APPS.test(app) || WEB_CHAT.test(window) || /\b(compose|new message|reply|chat|dm|direct message)\b/i.test(context)) return risky('send');
      if (MONEY_CONTEXT.test(context)) return risky('money');
      if (LOGIN_CONTEXT.test(context)) return risky('account');
      if (k.mods.includes('cmd')) return risky('submit', 'send or submit what is open');
    }
    if ((k.key === 'delete' || k.key === 'forwarddelete') && k.mods.includes('cmd')) return risky('delete');
    if (k.combo === 'shift+cmd+d' && MESSAGING_APPS.test(app)) return risky('send');
    return { level: 'ok' };
  }

  if (req.action === 'type_text') {
    if (/\b(user ?name|e-?mail|login|account|phone)\b/i.test(field) && LOGIN_CONTEXT.test(`${window} ${field}`)) return risky('account', 'fill in a sign-in form');
    return { level: 'ok' };
  }

  // click
  // Starting a screen share is its own kind of step: it is not sending a message, and one yes covers the two or three clicks it takes.
  if (SCREEN_SHARE.test(label)) return risky('share_screen');
  // Finder's Share button only opens the share menu; the send happens (and asks) after that.
  if (/^finder$/i.test(app) && /^share( ?(…|\.\.\.))?$/i.test(String(r.label || req.target || '').trim())) return { level: 'ok' };
  if (MESSAGING_APPS.test(app)) {
    // Retrying a failed message sends it.
    if (/^(try again|resend|retry|send again)$/i.test(String(r.label || req.target || '').trim())) return risky('send');
    // A conversation in the list ("Alex, Muted, Message Send Failure, 8:52 PM") only opens it:
    // its status words aren't a Send button.
    if (label.split(',').length >= 3) {
      const row = label.replace(/\b(message )?(send failure|failed to send|not delivered)\b/gi, '');
      for (const [category, re] of RISKY) if (re.test(row)) return risky(category);
      return { level: 'ok' };
    }
  }
  for (const [category, re] of RISKY) if (re.test(label)) return risky(category);
  if (PROCEED.test(label) && MONEY_CONTEXT.test(window)) return risky('money');
  if (PROCEED.test(label) && LOGIN_CONTEXT.test(window)) return risky('account');
  return { level: 'ok' };
}


export function looksLikeCard(text) {
  for (const m of String(text).matchAll(/\d(?:[ -]?\d){12,18}/g)) if (luhn(m[0])) return true;
  return false;
}
