// Read it back before typing it. Speech recognition mishears email addresses and numbers (a
// misheard address once went into a sign-up form), so before Echo types or sends an exact detail
// (an email address, a phone number, any long number), it reads the details back in one short
// question, spelling out email addresses, and waits for the user's yes. lib/computer.js holds the
// gate (ComputerUse.readBack); this file is the pure part: what counts as a detail, how to spell
// it, and whether a reply read it back.

import { luhn } from './screen.js';

const EMAIL = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
// A run of digits with the usual separators (+1 (555) 010-3141, 555 010 3141, 02134).
const NUMBER = /\+?\(?\d[\d ().-]*\d/g;
const MIN_DIGITS = 5;

const NUMBER_WORDS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/**
 * The exact details in text Echo is about to type: email addresses, and numbers of 5 or more
 * digits (phone numbers, ZIP codes, account and order numbers), but never a card number.
 * @param {string} text
 * @returns {string[]}
 */
export function exactDetails(text) {
  const t = String(text || '');
  const emails = [...(t.match(EMAIL) || [])];
  const rest = emails.reduce((s, e) => s.replace(e, ' '), t);
  // A card number is never read back (Echo refuses to type it anyway).
  const numbers = (rest.match(NUMBER) || []).map((n) => n.trim()).filter((n) => n.replace(/\D/g, '').length >= MIN_DIGITS && !luhn(n));
  return [...new Set([...emails, ...numbers])];
}

/** Letters and digits only, lowercased: how a detail is compared. */
const squeeze = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * What a reply said, squeezed the same way, with spoken forms undone: "at", "dot", "dash",
 * "underscore", "plus" dropped and number words made digits, so "s-a-m dot lee four two at
 * example dot com" matches sam.lee42@example.com.
 * @param {string} said
 */
function spokenKey(said) {
  const words = String(said || '').toLowerCase().replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u);
  return words.filter((w) => !['at', 'dot', 'dash', 'hyphen', 'underscore', 'plus', 'period', 'point'].includes(w)).map((w) => NUMBER_WORDS[w] ?? w).join('');
}

/**
 * Did this reply read the detail back (plainly, spelled out, or in words)?
 * @param {string} said @param {string} detail
 */
export function readsBack(said, detail) {
  const d = squeeze(detail);
  if (!d) return true;
  return squeeze(said).includes(d) || spokenKey(said).includes(d);
}

/**
 * An email address spelled out for reading back: "s-a-m-dot-l-e-e-4-2 at example dot com".
 * Other details come back as they are.
 * @param {string} detail
 */
export function spellOut(detail) {
  const d = String(detail || '');
  const at = d.lastIndexOf('@');
  if (at < 0) return d;
  const user = [...d.slice(0, at)].map((c) => ({ '.': 'dot', _: 'underscore', '-': 'dash', '+': 'plus' })[c] || c).join('-');
  return `${user} at ${d.slice(at + 1).split('.').join(' dot ')}`;
}

const YES = /\b(yes|yeah|yep|yup|yah|correct|right|exactly|sure|ok|okay|perfect|confirm(ed)?|go ahead|do it|type it|that'?s it|that'?s right|sounds good|good)\b/;
const NOT_YES = /\b(no|nope|nah|not|wrong|incorrect|wait|but|actually|instead|change|different|other|another|except|mistake|spell)\b|\?/;

/**
 * Is this the user's plain yes to a read-back? A "no", a correction or a question isn't.
 * @param {string} text
 */
export function isPlainYes(text) {
  const t = String(text || '').toLowerCase().replace(/[’]/g, "'");
  return YES.test(t) && !NOT_YES.test(t);
}
