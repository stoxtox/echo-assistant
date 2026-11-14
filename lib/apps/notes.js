// Notes through its own scripting: find a note, read one, make one, add to one. Never delete.
// The pattern and the rules are in ./osa.js. What a note says goes to the assistant only.
import { COMMON, callScript, fail } from './osa.js';

export const NOTES = 'Notes';
/** How many notes a search gives, and how much of one note a read gives (characters). */
export const FIND_MAX = 10;
export const READ_CHARS = 6000;
/** The most text one new note or one addition may hold. */
export const WRITE_CHARS = 20000;

// argv: what to do, then
//   find    words ("" for the newest)  max
//   read    id or exact title  maxChars
//   create  body (HTML, its first line is the title)  folder ("" for the usual one)
//   append  id or exact title  what to add (HTML)
// A locked note is never opened. Adding to a note sets its whole body again, which would drop a
// picture or a file kept in it, so a note with attachments is refused instead.
export const NOTES_SCRIPT = String.raw`${COMMON}
on run argv
	set |theOp| to item 1 of argv
	set |TB| to character id 9
	if application "Notes" is not running then return "ERR" & |TB| & "not_running"
	try
		with timeout of 5 seconds
			tell application "Notes"
				set |outLines| to {"OK"}
				set |shown| to {}
				if |theOp| is "find" then
					set |theQuery| to item 2 of argv
					set |maxCount| to (item 3 of argv) as integer
					if |theQuery| is "" then
						set |hits| to every note
					else
						set |hits| to (every note whose name contains |theQuery|)
						if (count of |hits|) < |maxCount| then set |hits| to |hits| & (every note whose (name does not contain |theQuery|) and (plaintext contains |theQuery|))
					end if
					set |hitCount| to count of |hits|
					set end of |outLines| to "count" & |TB| & |hitCount|
					if |hitCount| > |maxCount| then set |hitCount| to |maxCount|
					repeat with |i| from 1 to |hitCount|
						set end of |shown| to item |i| of |hits|
					end repeat
				else if |theOp| is "create" then
					if item 3 of argv is "" then
						set |theNote| to make new note with properties {body:item 2 of argv}
					else
						set |theNote| to make new note at (first folder whose name is (item 3 of argv)) with properties {body:item 2 of argv}
					end if
					set |shown| to {|theNote|}
				else
					set |theRef| to item 2 of argv
					if |theRef| starts with "x-coredata://" then
						set |theNote| to note id |theRef|
					else
						set |theNote| to first note whose name is |theRef|
					end if
					if password protected of |theNote| then return "ERR" & |TB| & "locked"
					if |theOp| is "append" then
						if (count of attachments of |theNote|) > 0 then return "ERR" & |TB| & "has_attachments"
						set |oldSize| to count of ((plaintext of |theNote|) as text)
						set body of |theNote| to (body of |theNote|) & (item 3 of argv)
						set end of |outLines| to "grew" & |TB| & ((count of ((plaintext of |theNote|) as text)) - |oldSize|)
					else
						set |wholeText| to (plaintext of |theNote|) as text
						set end of |outLines| to "size" & |TB| & (count of |wholeText|)
						set end of |outLines| to "text" & |TB| & my escText(my clipText(|wholeText|, (item 3 of argv) as integer))
					end if
					set |shown| to {|theNote|}
				end if
				repeat with |oneRef| in |shown|
					set |oneNote| to contents of |oneRef|
					set |folderName| to ""
					try
						set |folderName| to name of container of |oneNote|
					end try
					set end of |outLines| to "note" & |TB| & my escText(id of |oneNote|) & |TB| & my escText(name of |oneNote|) & |TB| & my isoOf(modification date of |oneNote|) & |TB| & my escText(|folderName|)
				end repeat
				return my joinLines(|outLines|)
			end tell
		end timeout
	on error |errText| number |errNum|
		return "ERR" & |TB| & "script" & |TB| & |errNum| & |TB| & my escText(|errText|)
	end try
end run
`;

const MESSAGES = {
  locked: 'That note is locked. Echo never opens a locked note: the user reads it in Notes themselves.',
  has_attachments: 'That note holds a picture or a file, and adding to it from here could drop it. Nothing was changed: make a new note instead (notes_create), or the user adds it in Notes.',
  not_found: 'There is no note (or no folder) by that name or id. Find it first with notes_find and use its id.',
};

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Plain text as the HTML Notes keeps: one block per line. */
export const toHtml = (text) => String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => `<div>${l ? escapeHtml(l) : '<br>'}</div>`).join('');

const noteOf = (f) => ({ id: f[1] || '', title: f[2] || '', changed: (f[3] || '').slice(0, 16), ...(f[4] ? { folder: f[4] } : {}) });
const row = (rows, key) => rows.find((f) => f[0] === key);

export class Notes {
  /** @param {{ run: (script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>, timeoutMs?: number }} opts */
  constructor({ run, timeoutMs }) {
    this.run = run;
    this.timeoutMs = timeoutMs;
  }

  call(args) {
    return callScript(this.run, NOTES, NOTES_SCRIPT, args, { messages: MESSAGES, ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}) });
  }

  /** Notes whose title or text holds the words (titles first); with no words, the newest. */
  async find(args = {}) {
    const a = await this.call(['find', String(args.text ?? '').trim().slice(0, 200), String(FIND_MAX)]);
    if (a.error) return a;
    const notes = a.rows.filter((f) => f[0] === 'note').map(noteOf);
    const total = Number(row(a.rows, 'count')?.[1]) || notes.length;
    return { found: total, notes, count: notes.length };
  }

  /** One note's text, by the id notes_find gave (or its exact title). */
  async read(args = {}) {
    const ref = String(args.note ?? '').trim();
    if (!ref) return fail('not_found', MESSAGES.not_found);
    const a = await this.call(['read', ref, String(READ_CHARS)]);
    if (a.error) return a;
    const text = row(a.rows, 'text')?.[1] || '';
    const size = Number(row(a.rows, 'size')?.[1]) || text.length;
    return { ...noteOf(row(a.rows, 'note') || []), text, ...(size > text.length ? { note: `Only the first ${text.length} of ${size} characters are here.` } : {}), count: 1 };
  }

  /** A new note: a title, then the text. */
  async create(args = {}) {
    const title = String(args.title ?? '').trim().slice(0, 200);
    const text = String(args.text ?? '');
    if (!title) return fail('bad_note', 'The note needs a title.');
    if (text.length > WRITE_CHARS) return fail('too_big', `That is ${text.length} characters; one note from here holds at most ${WRITE_CHARS}.`);
    const a = await this.call(['create', `<div><h1>${escapeHtml(title)}</h1></div>${text ? toHtml(text) : ''}`, String(args.folder ?? '').trim().slice(0, 200)]);
    if (a.error) return a;
    return { done: true, created: noteOf(row(a.rows, 'note') || []), count: 1 };
  }

  /** Add text to the end of a note; checked by how much longer the note is afterwards. */
  async append(args = {}) {
    const ref = String(args.note ?? '').trim();
    const text = String(args.text ?? '');
    if (!ref) return fail('not_found', MESSAGES.not_found);
    if (!text.trim()) return fail('bad_note', 'Give the text to add.');
    if (text.length > WRITE_CHARS) return fail('too_big', `That is ${text.length} characters; one addition holds at most ${WRITE_CHARS}.`);
    const a = await this.call(['append', ref, toHtml(text)]);
    if (a.error) return a;
    const grew = Number(row(a.rows, 'grew')?.[1]) || 0;
    const n = noteOf(row(a.rows, 'note') || []);
    if (grew <= 0) return { done: false, ...n, note: 'NOT confirmed: the note is no longer than before. Don\'t tell the user it was added; read the note (notes_read) and say what it holds.', count: 0 };
    return { done: true, ...n, added: grew, count: 1 };
  }
}
