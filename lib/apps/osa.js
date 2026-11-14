// What the everyday-app adapters share (Finder, Notes, Reminders, Calendar, Mail): how a fixed
// script is called and how its answer is read. The pattern is the spreadsheet adapter's
// (lib/sheets.js):
// - ONE fixed AppleScript per app. What to do and every value go in as arguments (argv), never
//   into the script's text, so a note's or a subject's text can never become code.
// - A script never starts an app: one that isn't running answers not_running (the assistant then
//   offers to open it).
// - Every call has a time limit, and comes back as rows of text or `{ error, message }` with error
//   one of: not_running, not_allowed, not_found, timeout, failed (and a few of an app's own).
// - Nothing here logs. What a note, a message or an event says goes to the assistant only.

/** The longest one call may take. */
export const APP_TIMEOUT_MS = 6000;

export const fail = (error, message) => ({ error, message });

const unescapeText = (s) => String(s).replace(/\\([\\tnr])/g, (_, c) => ({ '\\': '\\', t: '\t', n: '\n', r: '\r' })[c]);
/** A field as a script writes it out (the fake apps in the tests answer the same way). */
export const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

// Handlers every script starts with. A script answers "OK" and then lines of tab-separated
// fields, with backslash, tab and line ends escaped so a field can hold any of them; or
// "ERR", a code, and for an error of the app's own its number and text.
// Every name a script makes up is written |between bars|, so it can never be one of the app's own
// words (lib/sheets.js found that the hard way: inside Excel a variable called rowS is "rows").
export const COMMON = String.raw`
on swapText(theText, findText, putText)
	set AppleScript's text item delimiters to findText
	set |textParts| to text items of theText
	set AppleScript's text item delimiters to putText
	set theText to |textParts| as text
	set AppleScript's text item delimiters to ""
	return theText
end swapText

on escText(theText)
	if theText is missing value then return ""
	set theText to my swapText(theText as text, "\\", "\\\\")
	set theText to my swapText(theText, character id 9, "\\t")
	set theText to my swapText(theText, character id 10, "\\n")
	set theText to my swapText(theText, character id 13, "\\r")
	return theText
end escText

on joinLines(lineList)
	set AppleScript's text item delimiters to character id 10
	set |joinedText| to lineList as text
	set AppleScript's text item delimiters to ""
	return |joinedText|
end joinLines

-- At most this many characters of a text.
on clipText(theText, maxChars)
	if theText is missing value then return ""
	set theText to theText as text
	if (count of theText) > maxChars then return text 1 thru maxChars of theText
	return theText
end clipText

-- A date as 2026-10-03T14:00:00 (this Mac's own time); "" for none.
on isoOf(theDate)
	if theDate is missing value then return ""
	try
		return (theDate as «class isot» as string)
	on error
		return ""
	end try
end isoOf

-- A date from numbers (year, month, day, seconds into the day), so no date is ever read from
-- text, which each region writes differently.
on makeDate(yearNum, monthNum, dayNum, daySecs)
	set |newDate| to current date
	set day of |newDate| to 1
	set year of |newDate| to (yearNum as integer)
	set month of |newDate| to (monthNum as integer)
	set day of |newDate| to (dayNum as integer)
	set time of |newDate| to (daySecs as integer)
	return |newDate|
end makeDate
`;

/** A local time as the four arguments makeDate takes. @param {Date} d */
export const dateArgs = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()].map(String);

/**
 * A date or a date and time the assistant gave ("2026-10-03", "2026-10-03T14:00"), as this Mac's
 * own time; null for anything else. A bare date is that day's midnight here, not in UTC.
 * @returns {Date | null}
 */
export function localDate(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.test(s)) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00` : s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * What a script answered.
 * @returns {any} { error, num, message } or { rows }: each row a line's fields
 */
export function parseAnswer(out) {
  const lines = String(out || '').replace(/\r?\n$/, '').split('\n');
  const head = /** @type {string} */ (lines[0]).split('\t');
  if (head[0] === 'ERR') return { error: head[1] || 'failed', num: Number(head[2]) || 0, message: unescapeText(head[3] || '') };
  if (head[0] !== 'OK') return { error: 'failed', num: 0, message: 'The app gave no answer Echo could read.' };
  return { rows: lines.slice(1).filter(Boolean).map((l) => l.split('\t').map(unescapeText)) };
}

/** Where the user allows it, by app: scripting any app is Automation; these two also have a page of their own. */
const OWN_PANE = { Calendar: 'Calendars', Reminders: 'Reminders' };

const MESSAGES = {
  not_running: (app) => `${app} isn't open, and Echo doesn't open it unasked. Offer to open it (open_app "${app}"), then try again.`,
  not_allowed: (app) => `macOS hasn't allowed Echo to use ${app}. Tell the user: open System Settings, Privacy & Security, Automation, and switch on ${app} under Echo (under Terminal, if Echo was started from there)${OWN_PANE[app] ? `; and in Privacy & Security, ${OWN_PANE[app]}, switch on Echo` : ''}. Then try again.`,
  not_found: (app) => `${app} has nothing by that name or id. Find it first, and use the id that comes back.`,
  timeout: (app) => `${app} didn't answer in time (it may be busy, or showing a dialog). Nothing more was done; try once more.`,
};

/** macOS's own error numbers for: not allowed, not running, timed out, no such thing. */
const NUMBERS = { '-1743': 'not_allowed', '-10004': 'not_allowed', '-600': 'not_running', '-609': 'not_running', '-1712': 'timeout', '-1728': 'not_found', '-1719': 'not_found' };

/**
 * One call of an app's script, with its errors made plain.
 * @param {(script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>} run the AppleScript runner (QuickActions.osa)
 * @param {string} app @param {string} script @param {string[]} args
 * @param {{ timeoutMs?: number, messages?: Record<string, string> }} [o] messages: the words for this app's own error codes
 * @returns {Promise<any>} { error, message } or { rows }
 */
export async function callScript(run, app, script, args, { timeoutMs = APP_TIMEOUT_MS, messages = {} } = {}) {
  /** @type {any} */
  let a;
  try {
    a = parseAnswer(await run(script, args.map(String), { timeoutMs }));
  } catch (e) {
    const err = /** @type {any} */ (e);
    const raw = String(err?.stderr || err?.message || '');
    const m = /\((-\d+)\)/.exec(raw);
    a = err?.killed || err?.signal || /timed? ?out/i.test(raw) ? { error: 'script', num: -1712, message: '' } : { error: 'script', num: m ? Number(m[1]) : 0, message: raw.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }
  if (!a.error) return a;
  const code = a.error === 'script' ? NUMBERS[String(a.num)] || (/not authori[sz]ed|not allowed/i.test(a.message) ? 'not_allowed' : 'failed') : a.error;
  if (messages[code]) return fail(code, messages[code]);
  if (MESSAGES[code]) return fail(code, MESSAGES[code](app));
  return fail(code, `${app} wouldn't do that${a.message ? `: ${a.message}` : ''}.`);
}
