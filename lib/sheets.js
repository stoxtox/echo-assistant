// Spreadsheets through the app's own scripting, not clicks and keys.
//
// On Oct 3 Echo drove Excel with the pointer and the keyboard: going to a cell by the Name Box
// failed 8 times out of 15, "B4" was typed INTO cell A4 ("CoffeeB4"), typing that did land came
// back "the field is still empty", and one turn took 117 seconds. Excel and Numbers are both
// scriptable, so this is how Echo works in a sheet now; keystrokes stay only as the fallback.
//
// One small interface (`sheets.in('Microsoft Excel')` or `'Numbers'`), two back ends:
//   where()                       the front document, its active sheet, the selection, the used range
//   read(range, { max, bold })    values as rows (text, numbers, true/false, empty as "")
//   write(ref, value)             one cell, read back
//   writeMany(startRef, rows)     a block in one call (sent to the app in parts of whole rows), read back
//   fillRows({ rows, columns })   made-up sample rows from a short recipe per column (no app involved)
//   select(range)                 selects it (and scrolls it into view), read back
//   format(range, { bold, … })    sets it and reads it back
//   find(text)                    the first cells holding that text (up to 10)
//   headers()                     the first non-empty row of the used range
//   undo()                        puts back what the last write replaced
//
// Rules that keep this safe:
// - ONE fixed AppleScript per app. What to do and every value go in as arguments (argv), never
//   into the script's text, so a cell's text can never become code.
// - Only the front document's active sheet (in Numbers: its selected table, else its first).
//   References are checked here before any script runs; "Sheet2!A1" is refused.
// - A script never starts an app: one that isn't running answers not_running.
// - Every call has a time limit, and comes back as a plain result or `{ error, message }` with
//   error one of: not_running, no_document, not_allowed, bad_ref, timeout, unsupported, changed,
//   too_big, failed.
// - Excel refuses scripts while a cell is being edited. Then Escape goes to the grid once (the
//   caller's `escape`, the usual key path) and the call is tried once more. Never while a lesson
//   watches (`gentle`): there the person typing in the cell is the user.
// - Nothing here logs: cell contents go to the assistant only (lib/computer.js logs the tool,
//   the size of the range, how long it took and whether it worked).

export const EXCEL = 'Microsoft Excel';
export const NUMBERS = 'Numbers';
/** The longest one call may take. */
export const SHEET_TIMEOUT_MS = 4000;
export const READ_MAX = 400;
/**
 * The most cells one script call sets. Not the size of the arguments (macOS takes about a
 * megabyte of them): it is time. A call has a few seconds, the script reads the block before and
 * after it writes, and Numbers sets a block cell by cell. A bigger write goes in several calls.
 */
const WRITE_PART = 200;
/** The most text one script call carries in its arguments. */
const PART_BYTES = 200_000;
/** The most cells one write takes, in all. */
export const WRITE_MAX = 20000;
/** Numbers sets a block cell by cell (about 25 ms each), so it takes less. */
const NUMBERS_WRITE_MAX = 4000;
export const FIND_MAX = 10;
/** How many cells a find looks through (the top of the used range). */
const FIND_CELLS = 4000;
/** How many writes are remembered for "undo that". */
const UNDO_DEPTH = 20;
const MAX_ROW = 1048576;
const MAX_COL = 16384;

/** "excel", "Microsoft Excel", "numbers" → the app's real name; '' for anything else. */
export function sheetApp(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'microsoft excel' || n === 'excel') return EXCEL;
  if (n === 'numbers') return NUMBERS;
  return '';
}

/* ---------- references ---------- */

/** 28 → "AB". */
export function colName(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function parseCell(s) {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(s);
  if (!m) return null;
  const col = [.../** @type {string} */ (m[1]).toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const row = Number(m[2]);
  return col <= MAX_COL && row <= MAX_ROW ? { row, col } : null;
}

/** The address of a box of cells: "B2", or "B2:D10". */
export function boxAddr(row, col, rows = 1, cols = 1) {
  const from = `${colName(col)}${row}`;
  return rows > 1 || cols > 1 ? `${from}:${colName(col + cols - 1)}${row + rows - 1}` : from;
}

/**
 * A reference as Echo takes it: "A1", "$b$2", "B2:D10" (either corner first). Anything else is
 * null: a sheet-qualified one ("Sheet2!A1"), a whole column ("A:A"), a name, a formula.
 * @returns {{ addr: string, row: number, col: number, rows: number, cols: number, cells: number } | null}
 */
export function parseRef(ref) {
  const parts = String(ref ?? '').trim().split(':');
  if (parts.length > 2) return null;
  const a = parseCell(/** @type {string} */ (parts[0]));
  const b = parts.length === 2 ? parseCell(/** @type {string} */ (parts[1])) : a;
  if (!a || !b) return null;
  const row = Math.min(a.row, b.row), col = Math.min(a.col, b.col);
  const rows = Math.abs(a.row - b.row) + 1, cols = Math.abs(a.col - b.col) + 1;
  return { addr: boxAddr(row, col, rows, cols), row, col, rows, cols, cells: rows * cols };
}

/* ---------- what goes over the wire ---------- */

// A script answers in lines of tab-separated fields. A cell is one field: a letter for its kind
// and then its text, with backslash, tab and line ends escaped so a cell can hold any of them.
//   e empty · s text · n number · b1 / b0 true / false · d a date (ISO)

const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
const unescapeText = (s) => String(s).replace(/\\([\\tnr])/g, (_, c) => ({ '\\': '\\', t: '\t', n: '\n', r: '\r' })[c]);

/** A value as a script writes it out (the simulated sheet in lib/evalsim.js answers the same way). */
export function encodeCell(v) {
  if (v === undefined || v === null || v === '') return 'e';
  if (typeof v === 'boolean') return v ? 'b1' : 'b0';
  if (typeof v === 'number') return `n${v}`;
  return `s${escapeText(v)}`;
}

/** @returns {string | number | boolean} */
export function decodeCell(f) {
  const kind = String(f || 'e')[0], rest = String(f || '').slice(1);
  if (kind === 'b') return rest === '1';
  if (kind === 'n') {
    // AppleScript writes a number the way the Mac's region does ("3,5"); it never groups digits.
    const n = Number(rest.replace(',', '.'));
    return Number.isFinite(n) ? n : unescapeText(rest);
  }
  if (kind === 's' || kind === 'd') return unescapeText(rest);
  return '';
}

/**
 * What a script answered, as an object.
 * @returns {any} { error, num, message } or { doc, sheet, selection, used, range, size, rows, texts, formulas, bold, fmt }
 */
export function parseAnswer(out) {
  const lines = String(out || '').replace(/\r?\n$/, '').split('\n');
  const head = /** @type {string} */ (lines[0]).split('\t');
  if (head[0] === 'ERR') return { error: head[1] || 'failed', num: Number(head[2]) || 0, message: unescapeText(head[3] || '') };
  if (head[0] !== 'OK') return { error: 'failed', num: 0, message: 'The app gave no answer Echo could read.' };
  /** @type {any} */
  const a = { rows: [], texts: [], formulas: [], bold: [], before: [], beforeFormulas: [] };
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    const key = f[0], rest = f.slice(1);
    if (key === 'r') a.rows.push(rest.map(decodeCell));
    else if (key === 't') a.texts.push(rest.map((x) => String(decodeCell(x))));
    else if (key === 'f') a.formulas.push(rest.map((x) => String(decodeCell(x))));
    else if (key === 'p') a.before.push(rest.map(decodeCell));
    else if (key === 'q') a.beforeFormulas.push(rest.map((x) => String(decodeCell(x))));
    else if (key === 'held') a.held = Number(rest[0]) || 0;
    else if (key === 'b') a.bold.push([...(rest[0] || '')].map((c) => c === '1'));
    else if (key === 'size') a.size = { rows: Number(rest[0]) || 0, cols: Number(rest[1]) || 0 };
    else if (key === 'fmt') a.fmt = Object.fromEntries(['bold', 'italic', 'underline'].map((k, i) => [k, rest[i] === '1' ? true : rest[i] === '0' ? false : rest[i] === 'm' ? 'mixed' : undefined]));
    else if (key === 'sel' || key === 'used' || key === 'range') a[key === 'sel' ? 'selection' : key] = parseRef(rest[0])?.addr || '';
    else if (key === 'doc' || key === 'sheet' || key === 'table') a[key] = unescapeText(rest[0] || '');
  }
  return a;
}

/* ---------- the scripts (fixed text: nothing is ever spliced in) ---------- */

// Every name a script makes up is written |between bars|, which makes it a plain name whatever
// the app calls its own things. Inside `tell application "Microsoft Excel"` a variable called
// rowS IS Excel's "rows" (AppleScript ignores capitals), so `set rowS to …` writes to every row of
// the sheet, and outLines is Excel's "outlines". The tab character goes by its number for the
// same reason ("tab" is a word of Excel's).

// Shared by both: escaping, encoding a value, numbers from text, addresses.
const COMMON = String.raw`
on swapText(theText, findText, putText)
	set AppleScript's text item delimiters to findText
	set textParts to text items of theText
	set AppleScript's text item delimiters to putText
	set theText to textParts as text
	set AppleScript's text item delimiters to ""
	return theText
end swapText

on escText(theText)
	set theText to my swapText(theText as text, "\\", "\\\\")
	set theText to my swapText(theText, character id 9, "\\t")
	set theText to my swapText(theText, character id 10, "\\n")
	set theText to my swapText(theText, character id 13, "\\r")
	return theText
end escText

on encCell(theVal)
	if theVal is missing value then return "e"
	set valKind to class of theVal
	if valKind is boolean then
		if theVal then return "b1"
		return "b0"
	end if
	if valKind is integer or valKind is real then return "n" & (theVal as text)
	if valKind is date then return "d" & (theVal as «class isot» as string)
	try
		set valText to theVal as text
	on error
		return "s#ERROR"
	end try
	if valText is "" then return "e"
	return "s" & my escText(valText)
end encCell

-- A number from its text, whichever decimal mark this Mac uses.
on toNum(numText)
	try
		return numText as number
	on error
		try
			return (my swapText(numText, ".", ",")) as number
		on error
			return numText
		end try
	end try
end toNum

on colLetters(colNum)
	set lettersText to ""
	repeat while colNum > 0
		set lettersText to (character id (65 + ((colNum - 1) mod 26))) & lettersText
		set colNum to (colNum - 1) div 26
	end repeat
	return lettersText
end colLetters

on addrOf(firstRow, firstCol, numRows, numCols)
	set addrText to (my colLetters(firstCol)) & firstRow
	if numRows > 1 or numCols > 1 then set addrText to addrText & ":" & (my colLetters(firstCol + numCols - 1)) & (firstRow + numRows - 1)
	return addrText
end addrOf

-- The value an argument stands for: its kind, then its text.
on argValue(argKind, argText)
	if argKind is "n" then return my toNum(argText)
	if argKind is "b" then return (argText is "1")
	if argKind is "e" then return ""
	return argText
end argValue

on joinLines(lineList)
	set AppleScript's text item delimiters to character id 10
	set joinedText to lineList as text
	set AppleScript's text item delimiters to ""
	return joinedText
end joinLines
`;

// argv: what to do, then
//   where
//   read   range|"used"|"selection"  bold  formulas  texts  maxCells
//   set    range  select  rows  cols  limit  doc  sheet  then kind, text for every cell, row by row
//          (limit: when more cells than this hold something, nothing is written: -1 for no limit;
//           doc, sheet: what must still be in front, "" for whatever is)
//   select range
//   format range|"selection"  bold  italic  underline     ("1", "0" or "" to leave it)
const EXCEL_SCRIPT = String.raw`
on run argv
	set |theOp| to item 1 of argv
	set |TB| to character id 9
	if application "Microsoft Excel" is not running then return "ERR" & |TB| & "not_running"
	try
		with timeout of 3 seconds
			tell application "Microsoft Excel"
				if (count of workbooks) is 0 then return "ERR" & |TB| & "no_document"
				set |theBook| to active workbook
				set |theSheet| to active sheet of |theBook|
				set |theRange| to missing value
				set |askBold| to false
				set |askFormulas| to false
				set |askTexts| to false
				set |cellLimit| to 0
				set |priorLines| to {}
				set |heldCount| to 0

				if |theOp| is "set" then
					if (item 7 of argv is not "" and item 7 of argv is not (name of |theBook|)) or (item 8 of argv is not "" and item 8 of argv is not (name of |theSheet|)) then return "ERR" & |TB| & "changed"
					set |theRange| to range (item 2 of argv) of |theSheet|
					set |numRows| to (item 4 of argv) as integer
					set |numCols| to (item 5 of argv) as integer
					set |isSingle| to (|numRows| is 1 and |numCols| is 1)
					-- What is there now, before anything is written: for "undo that", and to stop
					-- when more of it holds something than the caller allows without asking.
					set |oldVals| to value of |theRange|
					set |oldForms| to formula of |theRange|
					if |isSingle| then
						set |oldVals| to {{|oldVals|}}
						set |oldForms| to {{|oldForms|}}
					end if
					repeat with |ri| from 1 to |numRows|
						set |lineText| to "p"
						set |lineForm| to "q"
						repeat with |ci| from 1 to |numCols|
							set |cellCode| to my encCell(item |ci| of item |ri| of |oldVals|)
							if |cellCode| is not "e" then set |heldCount| to |heldCount| + 1
							set |lineText| to |lineText| & |TB| & |cellCode|
							set |lineForm| to |lineForm| & |TB| & my encCell(item |ci| of item |ri| of |oldForms|)
						end repeat
						set end of |priorLines| to |lineText|
						set end of |priorLines| to |lineForm|
					end repeat
					set |heldLimit| to (item 6 of argv) as integer
					if |heldLimit| ≥ 0 and |heldCount| > |heldLimit| then
						set |theOp| to "held"
					else
						set |newVals| to {}
						set |argIdx| to 9
						repeat |numRows| times
							set |newRow| to {}
							repeat |numCols| times
								set end of |newRow| to my argValue(item |argIdx| of argv, item (|argIdx| + 1) of argv)
								set |argIdx| to |argIdx| + 2
							end repeat
							set end of |newVals| to |newRow|
						end repeat
						if |isSingle| then
							set value of |theRange| to item 1 of item 1 of |newVals|
						else
							set value of |theRange| to |newVals|
						end if
						if item 3 of argv is "1" then select |theRange|
						set |askFormulas| to true
						set |askTexts| to true
						set |cellLimit| to |numRows| * |numCols|
					end if
				else if |theOp| is "select" then
					set |theRange| to range (item 2 of argv) of |theSheet|
					-- goto selects it and brings it into view; a plain select leaves the window where it was.
					try
						goto reference |theRange|
					on error
						select |theRange|
					end try
				else if |theOp| is "format" then
					if item 2 of argv is "selection" then
						set |theRange| to selection
					else
						set |theRange| to range (item 2 of argv) of |theSheet|
					end if
					set |fontObj| to font object of |theRange|
					if item 3 of argv is not "" then set bold of |fontObj| to (item 3 of argv is "1")
					if item 4 of argv is not "" then set italic of |fontObj| to (item 4 of argv is "1")
					if item 5 of argv is "1" then set underline of |fontObj| to underline style single
					if item 5 of argv is "0" then set underline of |fontObj| to underline style none
				else if |theOp| is "read" then
					if item 2 of argv is "used" then
						set |theRange| to used range of |theSheet|
					else if item 2 of argv is "selection" then
						set |theRange| to selection
					else
						set |theRange| to range (item 2 of argv) of |theSheet|
					end if
					set |askBold| to (item 3 of argv is "1")
					set |askFormulas| to (item 4 of argv is "1")
					set |askTexts| to (item 5 of argv is "1")
					set |cellLimit| to (item 6 of argv) as integer
				end if

				set |outLines| to {"OK", "doc" & |TB| & my escText(name of |theBook|), "sheet" & |TB| & my escText(name of |theSheet|)}
				try
					set |curSel| to selection
					set end of |outLines| to "sel" & |TB| & my addrOf(first row index of |curSel|, first column index of |curSel|, count of rows of |curSel|, count of columns of |curSel|)
				end try
				set |usedRng| to used range of |theSheet|
				set end of |outLines| to "used" & |TB| & my addrOf(first row index of |usedRng|, first column index of |usedRng|, count of rows of |usedRng|, count of columns of |usedRng|)
				set |outLines| to |outLines| & |priorLines|
				if |theOp| is "held" then set end of |outLines| to "held" & |TB| & |heldCount|

				if |theOp| is "format" then
					-- A range that is all one style answers with its name ("Bold Italic"); a mixed one with
					-- nothing, and then "bold" is true only when every cell is: false there means none
					-- (when it was just switched off) or some.
					set |fontObj| to font object of |theRange|
					set |styleName| to font style of |fontObj|
					set |fmtText| to ""
					repeat with |fmtPair| in {{"Bold", bold of |fontObj|, item 3 of argv}, {"Italic", italic of |fontObj|, item 4 of argv}}
						if class of |styleName| is text then
							if |styleName| contains (item 1 of |fmtPair|) then
								set |fmtText| to |fmtText| & |TB| & "1"
							else
								set |fmtText| to |fmtText| & |TB| & "0"
							end if
						else if (item 2 of |fmtPair|) is true then
							set |fmtText| to |fmtText| & |TB| & "1"
						else if (item 3 of |fmtPair|) is "0" then
							set |fmtText| to |fmtText| & |TB| & "0"
						else
							set |fmtText| to |fmtText| & |TB| & "m"
						end if
					end repeat
					set |underVal| to underline of |fontObj|
					if |underVal| is underline style none then
						set |fmtText| to |fmtText| & |TB| & "0"
					else if |underVal| is missing value then
						set |fmtText| to |fmtText| & |TB| & "m"
					else
						set |fmtText| to |fmtText| & |TB| & "1"
					end if
					set end of |outLines| to "range" & |TB| & my addrOf(first row index of |theRange|, first column index of |theRange|, count of rows of |theRange|, count of columns of |theRange|)
					set end of |outLines| to "fmt" & |fmtText|
				end if

				if |theOp| is "read" or |theOp| is "set" then
					set |firstRow| to first row index of |theRange|
					set |firstCol| to first column index of |theRange|
					set |numRows| to count of rows of |theRange|
					set |numCols| to count of columns of |theRange|
					set end of |outLines| to "size" & |TB| & |numRows| & |TB| & |numCols|
					-- Too big: the top rows that fit.
					set |keepCols| to |numCols|
					if |keepCols| > |cellLimit| then set |keepCols| to |cellLimit|
					set |keepRows| to |cellLimit| div |keepCols|
					if |keepRows| < 1 then set |keepRows| to 1
					if |keepRows| > |numRows| then set |keepRows| to |numRows|
					if |keepRows| < |numRows| or |keepCols| < |numCols| then set |theRange| to range (my addrOf(|firstRow|, |firstCol|, |keepRows|, |keepCols|)) of |theSheet|
					set end of |outLines| to "range" & |TB| & my addrOf(|firstRow|, |firstCol|, |keepRows|, |keepCols|)
					set |isSingle| to (|keepRows| is 1 and |keepCols| is 1)
					set |cellVals| to value of |theRange|
					if |isSingle| then set |cellVals| to {{|cellVals|}}
					repeat with |ri| from 1 to |keepRows|
						set |lineText| to "r"
						repeat with |ci| from 1 to |keepCols|
							set |lineText| to |lineText| & |TB| & my encCell(item |ci| of item |ri| of |cellVals|)
						end repeat
						set end of |outLines| to |lineText|
					end repeat
					if |askFormulas| then
						set |cellVals| to formula of |theRange|
						if |isSingle| then set |cellVals| to {{|cellVals|}}
						repeat with |ri| from 1 to |keepRows|
							set |lineText| to "f"
							repeat with |ci| from 1 to |keepCols|
								set |lineText| to |lineText| & |TB| & my encCell(item |ci| of item |ri| of |cellVals|)
							end repeat
							set end of |outLines| to |lineText|
						end repeat
					end if
					if |askTexts| then
						set |cellVals| to string value of |theRange|
						if |isSingle| then set |cellVals| to {{|cellVals|}}
						repeat with |ri| from 1 to |keepRows|
							set |lineText| to "t"
							repeat with |ci| from 1 to |keepCols|
								set |lineText| to |lineText| & |TB| & my encCell(item |ci| of item |ri| of |cellVals|)
							end repeat
							set end of |outLines| to |lineText|
						end repeat
					end if
					if |askBold| then
						-- A range that is all one style answers with its name, a mixed one with nothing:
						-- one question for the whole range, then row by row, then cell by cell, only
						-- where it is mixed.
						set |wholeStyle| to font style of font object of |theRange|
						repeat with |ri| from 1 to |keepRows|
							set |lineText| to ""
							set |lineStyle| to |wholeStyle|
							if class of |lineStyle| is not text then set |lineStyle| to font style of font object of (range (my addrOf(|firstRow| + |ri| - 1, |firstCol|, 1, |keepCols|)) of |theSheet|)
							repeat with |ci| from 1 to |keepCols|
								set |oneStyle| to |lineStyle|
								if class of |oneStyle| is not text then set |oneStyle| to font style of font object of (range (my addrOf(|firstRow| + |ri| - 1, |firstCol| + |ci| - 1, 1, 1)) of |theSheet|)
								if class of |oneStyle| is text and |oneStyle| contains "Bold" then
									set |lineText| to |lineText| & "1"
								else
									set |lineText| to |lineText| & "0"
								end if
							end repeat
							set end of |outLines| to "b" & |TB| & |lineText|
						end repeat
					end if
				end if
				return my joinLines(|outLines|)
			end tell
		end timeout
	on error |errText| number |errNum|
		return "ERR" & |TB| & "script" & |TB| & |errNum| & |TB| & my escText(|errText|)
	end try
end run
` + COMMON;

// Numbers: the front document's active sheet, and in it the table with the selection (else the
// first table). Bold and italic are read from the font's name ("Helvetica-Bold"); Numbers has no
// way to set them from a script, so `format` with something to set answers unsupported.
const NUMBERS_SCRIPT = String.raw`
on run argv
	set |theOp| to item 1 of argv
	set |TB| to character id 9
	if application "Numbers" is not running then return "ERR" & |TB| & "not_running"
	try
		with timeout of 3 seconds
			tell application "Numbers"
				if (count of documents) is 0 then return "ERR" & |TB| & "no_document"
				set |theDoc| to front document
				set |theSheet| to active sheet of |theDoc|
				if (count of tables of |theSheet|) is 0 then return "ERR" & |TB| & "no_document"
				try
					set |theTable| to first table of |theSheet| whose class of selection range is range
				on error
					set |theTable| to table 1 of |theSheet|
				end try
				set |theRange| to missing value
				set |askBold| to false
				set |askFormulas| to false
				set |askTexts| to false
				set |cellLimit| to 0
				set |priorLines| to {}
				set |heldCount| to 0

				if |theOp| is "set" then
					if (item 7 of argv is not "" and item 7 of argv is not (name of |theDoc|)) or (item 8 of argv is not "" and item 8 of argv is not (name of |theSheet|)) then return "ERR" & |TB| & "changed"
					set |numRows| to (item 4 of argv) as integer
					set |numCols| to (item 5 of argv) as integer
					set |startAt| to my cornerOf(item 2 of argv)
					set |firstRow| to item 1 of |startAt|
					set |firstCol| to item 2 of |startAt|
					-- What is there now, before anything is written (cells past the table's edge are empty).
					set |haveRows| to row count of |theTable|
					set |haveCols| to column count of |theTable|
					repeat with |ri| from 0 to (|numRows| - 1)
						set |lineText| to "p"
						set |lineForm| to "q"
						repeat with |ci| from 0 to (|numCols| - 1)
							set |cellCode| to "e"
							set |formCode| to "e"
							if (|firstRow| + |ri|) ≤ |haveRows| and (|firstCol| + |ci|) ≤ |haveCols| then
								set |theCell| to cell (my addrOf(|firstRow| + |ri|, |firstCol| + |ci|, 1, 1)) of |theTable|
								set |cellCode| to my encCell(value of |theCell|)
								set |formCode| to my encCell(formula of |theCell|)
							end if
							if |cellCode| is not "e" then set |heldCount| to |heldCount| + 1
							set |lineText| to |lineText| & |TB| & |cellCode|
							set |lineForm| to |lineForm| & |TB| & |formCode|
						end repeat
						set end of |priorLines| to |lineText|
						set end of |priorLines| to |lineForm|
					end repeat
					set |heldLimit| to (item 6 of argv) as integer
					if |heldLimit| ≥ 0 and |heldCount| > |heldLimit| then
						set |theOp| to "held"
					else
						-- A block that runs past the table's edge: the table grows to hold it.
						if (|firstRow| + |numRows| - 1) > |haveRows| then set row count of |theTable| to (|firstRow| + |numRows| - 1)
						if (|firstCol| + |numCols| - 1) > |haveCols| then set column count of |theTable| to (|firstCol| + |numCols| - 1)
						set |argIdx| to 9
						repeat with |ri| from 0 to (|numRows| - 1)
							repeat with |ci| from 0 to (|numCols| - 1)
								set value of cell (my addrOf(|firstRow| + |ri|, |firstCol| + |ci|, 1, 1)) of |theTable| to my argValue(item |argIdx| of argv, item (|argIdx| + 1) of argv)
								set |argIdx| to |argIdx| + 2
							end repeat
						end repeat
						set |theRange| to range (my rangeName(|firstRow|, |firstCol|, |numRows|, |numCols|)) of |theTable|
						if item 3 of argv is "1" then set selection range of |theTable| to |theRange|
						set |askFormulas| to true
						set |askTexts| to true
						set |cellLimit| to |numRows| * |numCols|
					end if
				else if |theOp| is "select" then
					set |theRange| to range (my wholeRef(item 2 of argv)) of |theTable|
					set selection range of |theTable| to |theRange|
				else if |theOp| is "format" then
					if item 3 of argv is not "" or item 4 of argv is not "" or item 5 of argv is not "" then return "ERR" & |TB| & "unsupported"
					if item 2 of argv is "selection" then
						set |theRange| to selection range of |theTable|
					else
						set |theRange| to range (my wholeRef(item 2 of argv)) of |theTable|
					end if
				else if |theOp| is "read" then
					if item 2 of argv is "used" then
						set |theRange| to cell range of |theTable|
					else if item 2 of argv is "selection" then
						set |theRange| to selection range of |theTable|
					else
						set |theRange| to range (my wholeRef(item 2 of argv)) of |theTable|
					end if
					set |askBold| to (item 3 of argv is "1")
					set |askFormulas| to (item 4 of argv is "1")
					set |askTexts| to (item 5 of argv is "1")
					set |cellLimit| to (item 6 of argv) as integer
				end if

				set |outLines| to {"OK", "doc" & |TB| & my escText(name of |theDoc|), "sheet" & |TB| & my escText(name of |theSheet|), "table" & |TB| & my escText(name of |theTable|)}
				try
					set end of |outLines| to "sel" & |TB| & (name of selection range of |theTable|)
				end try
				set end of |outLines| to "used" & |TB| & (name of cell range of |theTable|)
				set |outLines| to |outLines| & |priorLines|
				if |theOp| is "held" then set end of |outLines| to "held" & |TB| & |heldCount|

				if |theOp| is "format" then
					set |fontNames| to font name of every cell of |theRange|
					set |boldMark| to my shareOf(|fontNames|, "Bold")
					set |italMark| to my shareOf(|fontNames|, "Italic")
					if |italMark| is "0" then set |italMark| to my shareOf(|fontNames|, "Oblique")
					set end of |outLines| to "range" & |TB| & (name of |theRange|)
					set end of |outLines| to "fmt" & |TB| & |boldMark| & |TB| & |italMark| & |TB| & ""
				end if

				if |theOp| is "read" or |theOp| is "set" then
					set |firstRow| to address of row 1 of |theRange|
					set |firstCol| to address of column 1 of |theRange|
					set |numRows| to count of rows of |theRange|
					set |numCols| to count of columns of |theRange|
					set end of |outLines| to "size" & |TB| & |numRows| & |TB| & |numCols|
					set |keepCols| to |numCols|
					if |keepCols| > |cellLimit| then set |keepCols| to |cellLimit|
					set |keepRows| to |cellLimit| div |keepCols|
					if |keepRows| < 1 then set |keepRows| to 1
					if |keepRows| > |numRows| then set |keepRows| to |numRows|
					if |keepRows| < |numRows| or |keepCols| < |numCols| then set |theRange| to range (my rangeName(|firstRow|, |firstCol|, |keepRows|, |keepCols|)) of |theTable|
					set end of |outLines| to "range" & |TB| & my addrOf(|firstRow|, |firstCol|, |keepRows|, |keepCols|)
					-- Every cell of a range comes back as one list, row after row.
					set |cellVals| to value of every cell of |theRange|
					repeat with |ri| from 1 to |keepRows|
						set |lineText| to "r"
						repeat with |ci| from 1 to |keepCols|
							set |lineText| to |lineText| & |TB| & my encCell(item ((|ri| - 1) * |keepCols| + |ci|) of |cellVals|)
						end repeat
						set end of |outLines| to |lineText|
					end repeat
					if |askFormulas| then
						set |cellVals| to formula of every cell of |theRange|
						repeat with |ri| from 1 to |keepRows|
							set |lineText| to "f"
							repeat with |ci| from 1 to |keepCols|
								set |lineText| to |lineText| & |TB| & my encCell(item ((|ri| - 1) * |keepCols| + |ci|) of |cellVals|)
							end repeat
							set end of |outLines| to |lineText|
						end repeat
					end if
					if |askTexts| then
						set |cellVals| to formatted value of every cell of |theRange|
						repeat with |ri| from 1 to |keepRows|
							set |lineText| to "t"
							repeat with |ci| from 1 to |keepCols|
								set |lineText| to |lineText| & |TB| & my encCell(item ((|ri| - 1) * |keepCols| + |ci|) of |cellVals|)
							end repeat
							set end of |outLines| to |lineText|
						end repeat
					end if
					if |askBold| then
						set |cellVals| to font name of every cell of |theRange|
						repeat with |ri| from 1 to |keepRows|
							set |lineText| to ""
							repeat with |ci| from 1 to |keepCols|
								if ((item ((|ri| - 1) * |keepCols| + |ci|) of |cellVals|) as text) contains "Bold" then
									set |lineText| to |lineText| & "1"
								else
									set |lineText| to |lineText| & "0"
								end if
							end repeat
							set end of |outLines| to "b" & |TB| & |lineText|
						end repeat
					end if
				end if
				return my joinLines(|outLines|)
			end tell
		end timeout
	on error |errText| number |errNum|
		return "ERR" & |TB| & "script" & |TB| & |errNum| & |TB| & my escText(|errText|)
	end try
end run

-- "1" when every name holds the word, "0" when none does, "m" when some do.
on shareOf(nameList, theWord)
	set hitCount to 0
	repeat with oneName in nameList
		if ((contents of oneName) as text) contains theWord then set hitCount to hitCount + 1
	end repeat
	if hitCount is 0 then return "0"
	if hitCount is (count of nameList) then return "1"
	return "m"
end shareOf

-- Numbers names a range "B2:D4", and one cell as a range "B2:B2".
on wholeRef(addrText)
	if addrText contains ":" then return addrText
	return addrText & ":" & addrText
end wholeRef

on rangeName(firstRow, firstCol, numRows, numCols)
	return my wholeRef(my addrOf(firstRow, firstCol, numRows, numCols))
end rangeName

-- "B2" or "B2:D4" → {row, column} of its first cell.
on cornerOf(addrText)
	if addrText contains ":" then set addrText to text 1 thru ((offset of ":" in addrText) - 1) of addrText
	set colNum to 0
	set rowDigits to ""
	repeat with oneChar in (characters of addrText)
		set charCode to id of (contents of oneChar)
		if charCode ≥ 65 and charCode ≤ 90 then
			set colNum to colNum * 26 + (charCode - 64)
		else
			set rowDigits to rowDigits & (contents of oneChar)
		end if
	end repeat
	return {rowDigits as integer, colNum}
end cornerOf
` + COMMON;

// Which of the two is open, and is it in front? No app's own words here, so it never has to find
// (or start) an app that isn't there.
const RUNNING_SCRIPT = String.raw`
on run argv
	set outText to ""
	repeat with oneName in argv
		set theApp to application (contents of oneName)
		if running of theApp then set outText to outText & (contents of oneName) & (character id 9) & (frontmost of theApp) & (character id 10)
	end repeat
	return outText
end run
`;

export const SCRIPTS = { [EXCEL]: EXCEL_SCRIPT, [NUMBERS]: NUMBERS_SCRIPT, running: RUNNING_SCRIPT };

/* ---------- values going in ---------- */

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * One value as the script takes it: its kind and its text. A number (or text that is one) goes in
 * as a number, the rest as text; a leading "=" is a formula ONLY when the caller says so.
 * @param {unknown} v @param {{ formula?: boolean }} [o]
 * @returns {{ kind: 'e' | 'n' | 'b' | 't' | 'f', text: string }}
 */
export function cellInput(v, { formula = false } = {}) {
  if (v === undefined || v === null || v === '') return { kind: 'e', text: '' };
  if (typeof v === 'boolean') return { kind: 'b', text: v ? '1' : '0' };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'n', text: String(v) } : { kind: 't', text: String(v) };
  const s = String(v);
  if (formula && s.startsWith('=')) return { kind: 'f', text: s };
  if (PLAIN_NUMBER.test(s.trim())) return { kind: 'n', text: s.trim() };
  return { kind: 't', text: s };
}

/**
 * Text the app would read as something else is marked as text. Excel: a leading apostrophe (it
 * isn't part of the value), for text that starts like a formula ("=", "+", "-", "@") or with an
 * apostrophe of its own. Numbers has no such mark: there a leading "=" always makes a formula, so
 * the write is read back and reported as not what was asked.
 */
function asSent(app, c) {
  if (app === EXCEL && c.kind === 't' && /^[=+\-@']/.test(c.text)) return `'${c.text}`;
  return c.text;
}

const ISO_DATE = /^\d{4}-\d\d-\d\dT/;
const squash = (s) => String(s).replace(/\s+/g, '').toUpperCase();

/** Does the cell now hold what was asked for? (`held`: its value, `shown`: as the app displays it, `formula`: its formula) */
function holds(c, held, shown, formula, isDate) {
  if (c.kind === 'e') return held === '';
  // Numbers keeps true and false as 1 and 0.
  if (c.kind === 'b') return held === (c.text === '1') || held === Number(c.text);
  if (c.kind === 'n') return typeof held === 'number' && held === Number(c.text);
  if (c.kind === 'f') return squash(formula) === squash(c.text);
  if (typeof held === 'string' && !isDate) return held === c.text;
  // The app read the text as it does when typed: a date ("3/4/2026"), a percentage ("5%"), money ("$5").
  return isDate || String(shown).trim() === c.text.trim() || (typeof held === 'boolean' && String(held).toUpperCase() === c.text.trim().toUpperCase());
}

const fail = (error, message) => ({ error, message });
const tooBig = (cells, max = WRITE_MAX) => fail('too_big', `That is ${cells} cells; one write takes at most ${max}. Write fewer rows, or tell the user it is too much for one go.`);

/**
 * A block as the script calls that set it: whole rows, each call at most WRITE_PART cells (a row
 * wider than that goes alone).
 * @param {string[][][]} sent rows of [kind, text]
 */
function inParts(sent) {
  /** @type {string[][][][]} */
  const parts = [];
  /** @type {string[][][]} */
  let part = [];
  let bytes = 0;
  for (const row of sent) {
    const size = row.reduce((n, c) => n + Buffer.byteLength(/** @type {string} */ (c[1])), 0);
    if (part.length && ((part.length + 1) * row.length > WRITE_PART || bytes + size > PART_BYTES)) {
      parts.push(part);
      part = [];
      bytes = 0;
    }
    part.push(row);
    bytes += size;
  }
  parts.push(part);
  return parts;
}
const BAD_REF = (ref) => fail('bad_ref', `"${String(ref).slice(0, 40)}" isn't a cell or a range Echo can use. Give "A1" or "B2:D10", on the sheet that is open (no sheet names).`);

const CHANGED = fail('changed', 'Nothing was written: another document or sheet is in front now. Look again (sheet_read) and ask afresh if it is still wanted.');

/** How to allow it, in words for the user. */
const notAllowed = (app) => fail('not_allowed', `macOS hasn't allowed Echo to control ${app}. Tell the user: open System Settings, Privacy & Security, Automation, and switch on ${app} under Echo (under Terminal, if Echo was started from there). Until then Echo can only click and type there.`);

export class Sheets {
  /**
   * @param {{ run: (script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>,
   *   escape?: ((app: string) => Promise<boolean>) | null, timeoutMs?: number }} opts
   *   run: the AppleScript runner (QuickActions.osa); escape: sends Escape to the app's grid
   */
  constructor({ run, escape = null, timeoutMs = SHEET_TIMEOUT_MS }) {
    this.run = run;
    this.escape = escape;
    this.timeoutMs = timeoutMs;
    /** Apps seen running (so their script can be compiled without macOS asking where the app is). */
    this.seen = new Set();
    /** @type {Map<string, SheetApp>} */
    this.apps = new Map();
  }

  /** The adapter for one app ("Microsoft Excel" or "Numbers"), or null for any other. */
  in(app) {
    const name = sheetApp(app);
    if (!name) return null;
    if (!this.apps.has(name)) this.apps.set(name, new SheetApp(this, name));
    return /** @type {SheetApp} */ (this.apps.get(name));
  }

  /** Which spreadsheet apps are open: [{ app, front }]. Never starts one. */
  async running() {
    try {
      const out = await this.run(RUNNING_SCRIPT, [EXCEL, NUMBERS], { timeoutMs: this.timeoutMs });
      const list = String(out).split('\n').filter(Boolean).map((l) => ({ app: /** @type {string} */ (l.split('\t')[0]), front: l.split('\t')[1] === 'true' }));
      for (const a of list) this.seen.add(a.app);
      return list;
    } catch {
      return [];
    }
  }

  /** The spreadsheet app to use when none was named: the one in front, else the only one open. */
  async front() {
    const list = await this.running();
    return (list.find((a) => a.front) || (list.length === 1 ? list[0] : null))?.app || '';
  }

  /**
   * One script call, with its errors made plain.
   * @param {string} app @param {string[]} args
   * @param {{ gentle?: boolean, cells?: number }} [o] gentle: never send Escape (a lesson is watching the user type)
   */
  async call(app, args, { gentle = false, cells = 0 } = {}) {
    if (!this.seen.has(app) && !(await this.running()).some((a) => a.app === app)) return fail('not_running', MESSAGES.not_running(app));
    // Numbers sets a block cell by cell, so a big block gets a little longer.
    const timeoutMs = this.timeoutMs + (app === NUMBERS ? cells * 25 : 0);
    const once = async () => {
      try {
        return parseAnswer(await this.run(/** @type {string} */ (SCRIPTS[app]), args, { timeoutMs }));
      } catch (e) {
        const err = /** @type {any} */ (e);
        if (err?.killed || err?.signal || /timed? ?out/i.test(String(err?.message))) return { error: 'script', num: -1712, message: '' };
        const m = /\((-\d+)\)/.exec(String(err?.stderr || err?.message || ''));
        return { error: 'script', num: m ? Number(m[1]) : 0, message: String(err?.stderr || err?.message || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
      }
    };
    const known = (a) => a.error !== 'script' || a.num === -1743 || a.num === -600 || a.num === -609;
    let a = await once();
    // Excel refuses scripts while a cell is being edited (and says so in more than one way):
    // Escape to the grid once, then once more.
    if (!known(a) && app === EXCEL && !gentle && this.escape && (await this.escape(app).catch(() => false))) a = await once();
    if (a.error !== 'script') return a.error ? fail(a.error, MESSAGES[a.error]?.(app) || a.message || 'That did not work.') : a;
    if (a.num === -1743) return notAllowed(app);
    if (a.num === -600 || a.num === -609) return fail('not_running', MESSAGES.not_running(app));
    if (a.num === -1712) return fail('timeout', `${app} didn't answer in time (it may be busy, showing a dialog, or in the middle of editing a cell). Nothing more was done; try once more.`);
    return fail(app === EXCEL && gentle ? 'editing' : 'failed', `${app} wouldn't do that${a.message ? `: ${a.message}` : ''}. (It may be editing a cell, showing a dialog, or the sheet may be protected.)`);
  }
}

const MESSAGES = {
  not_running: (app) => `${app} isn't open. Open the file first (open_app).`,
  no_document: (app) => `${app} has no spreadsheet open${app === NUMBERS ? ' (or the sheet in front has no table)' : ''}. Open the file first (open_app with file).`,
  unsupported: (app) => `${app} can't do that from a script. Select the cells (sheet_select), then use the keyboard: press_keys cmd+b (bold), cmd+i (italic) or cmd+u (underline).`,
};

class SheetApp {
  /** @param {Sheets} sheets @param {string} app */
  constructor(sheets, app) {
    this.sheets = sheets;
    this.app = app;
    /** What the last writes replaced, newest last. @type {Array<{ doc: string, sheet: string, range: string, before: Array<Array<{ kind: string, text: string }>> }>} */
    this.undos = [];
  }

  /** @param {string[]} args @param {{ gentle?: boolean, cells?: number }} [o] */
  call(args, o) {
    return this.sheets.call(this.app, args, o);
  }

  /** The front document, its active sheet, the selection and the used range. */
  async where() {
    const a = await this.call(['where']);
    if (a.error) return a;
    const used = parseRef(a.used);
    return { app: this.app, doc: a.doc, sheet: a.sheet, ...(a.table ? { table: a.table } : {}), selection: a.selection, used: a.used, rows: used?.rows || 0, cols: used?.cols || 0 };
  }

  /**
   * Values as rows. `range`: "A1", "B2:D10", or left out for the used range ("selection": what is selected).
   * @param {string} [range]
   * @param {{ max?: number, bold?: boolean, formulas?: boolean, texts?: boolean, gentle?: boolean }} [o]
   */
  async read(range, { max = READ_MAX, bold = false, formulas = false, texts = false, gentle = false } = {}) {
    const named = range && range !== 'used' && range !== 'selection';
    const ref = named ? parseRef(range) : null;
    if (named && !ref) return BAD_REF(range);
    const flag = (b) => (b ? '1' : '0');
    const a = await this.call(['read', ref ? ref.addr : range || 'used', flag(bold), flag(formulas), flag(texts), String(Math.max(1, Math.round(max)))], { gentle });
    if (a.error) return a;
    const got = parseRef(a.range);
    const full = a.size && got ? boxAddr(got.row, got.col, a.size.rows, a.size.cols) : a.range;
    const clipped = Boolean(a.size && got && (a.size.rows > got.rows || a.size.cols > got.cols));
    return {
      doc: a.doc, sheet: a.sheet, selection: a.selection, used: a.used, range: a.range, rows: a.rows,
      ...(bold ? { bold: a.bold } : {}), ...(formulas ? { formulas: a.formulas } : {}), ...(texts ? { texts: a.texts } : {}),
      ...(clipped ? { clipped: true, full, note: `${full} is ${a.size.rows * a.size.cols} cells: only ${a.range} is here. Read the rest by range.` } : {}),
    };
  }

  /** The header row: the first row of the used range that holds anything, with its address. */
  async headers() {
    const r = await this.read('used');
    if (r.error) return r;
    const box = /** @type {NonNullable<ReturnType<typeof parseRef>>} */ (parseRef(r.range));
    const i = r.rows.findIndex((row) => row.some((v) => v !== ''));
    if (i < 0) return { doc: r.doc, sheet: r.sheet, range: '', values: [], used: r.used, selection: r.selection, note: 'The sheet is empty.' };
    return { doc: r.doc, sheet: r.sheet, range: boxAddr(box.row + i, box.col, 1, box.cols), row: box.row + i, values: r.rows[i], used: r.used, selection: r.selection };
  }

  /** The first cells holding `text` (any capitals, anywhere in the cell), up to 10 addresses. */
  async find(text) {
    const want = String(text ?? '').trim().toLowerCase();
    if (!want) return fail('empty', 'Say what to look for.');
    const r = await this.read('used', { max: FIND_CELLS, texts: true });
    if (r.error) return r;
    const box = /** @type {NonNullable<ReturnType<typeof parseRef>>} */ (parseRef(r.range));
    const cells = [];
    r.rows.forEach((row, i) => row.forEach((v, j) => {
      if (String(v).toLowerCase().includes(want) || String(r.texts[i]?.[j] ?? '').toLowerCase().includes(want)) cells.push(boxAddr(box.row + i, box.col + j));
    }));
    return { doc: r.doc, sheet: r.sheet, cells: cells.slice(0, FIND_MAX), ...(cells.length > FIND_MAX ? { more: cells.length - FIND_MAX } : {}), searched: r.range, ...(r.clipped ? { note: r.note } : {}) };
  }

  /** Selects a range (and scrolls it into view); returns the selection as the app now has it. */
  async select(range) {
    const ref = parseRef(range);
    if (!ref) return BAD_REF(range);
    const a = await this.call(['select', ref.addr]);
    if (a.error) return a;
    return { doc: a.doc, sheet: a.sheet, selection: a.selection, verified: a.selection === ref.addr };
  }

  /**
   * Sets bold, italic or underline on a range ("selection": what is selected) and reads it back.
   * With nothing to set, it only reads.
   * @param {string} range @param {{ bold?: boolean, italic?: boolean, underline?: boolean }} [f]
   */
  async format(range, f = {}) {
    const ref = range === 'selection' ? null : parseRef(range);
    if (range !== 'selection' && !ref) return BAD_REF(range);
    const flag = (v) => (v === undefined || v === null ? '' : v ? '1' : '0');
    const a = await this.call(['format', ref ? ref.addr : 'selection', flag(f.bold), flag(f.italic), flag(f.underline)]);
    if (a.error) return a;
    const now = a.fmt || {};
    const asked = Object.keys(f).filter((k) => ['bold', 'italic', 'underline'].includes(k) && f[k] !== undefined && f[k] !== null);
    return { doc: a.doc, sheet: a.sheet, range: a.range, bold: now.bold, italic: now.italic, ...(now.underline !== undefined ? { underline: now.underline } : {}), verified: asked.every((k) => now[k] === Boolean(f[k])) };
  }

  /**
   * Sets a block, top-left cell first, in as many script calls as it takes, and gives back what
   * the cells held and what they hold now as one answer. After the first call the rest must be
   * the same document and sheet. When a call fails the answer is its error with `done` (how many
   * rows went in before it) and `sofar` (the answer up to there).
   * @param {number} row @param {number} col @param {string[][][]} sent rows of [kind, text]
   * @param {{ select?: boolean, limit?: string, doc?: string, sheet?: string }} [o]
   * @returns {Promise<any>}
   */
  async setRows(row, col, sent, { select = false, limit = '-1', doc = '', sheet = '' } = {}) {
    const nc = /** @type {string[][]} */ (sent[0]).length;
    /** @type {any} */
    const all = { doc, sheet, before: [], beforeFormulas: [], rows: [], texts: [], formulas: [], selection: '', inPlace: true };
    let done = 0;
    for (const part of inParts(sent)) {
      const range = boxAddr(row + done, col, part.length, nc);
      const a = await this.call(['set', range, select ? '1' : '0', String(part.length), String(nc), limit, all.doc, all.sheet, ...part.flat(2)], { cells: part.length * nc });
      if (a.error || a.held !== undefined) return { ...a, done, sofar: all };
      for (const k of ['before', 'beforeFormulas', 'rows', 'texts', 'formulas']) all[k].push(...a[k]);
      Object.assign(all, { doc: a.doc, sheet: a.sheet, selection: a.selection, inPlace: all.inPlace && (a.range || range) === range });
      done += part.length;
    }
    return all;
  }

  /**
   * How many cells of a block hold something now (for a write that goes in parts: the question
   * "replace all this?" is asked before any part is written). Only the part of it inside the
   * used range is read.
   * @returns {Promise<any>} { count, doc, sheet } or an error
   */
  async filled(row, col, nr, nc) {
    const w = await this.where();
    if (w.error) return w;
    const used = parseRef(w.used);
    const r1 = Math.max(row, used?.row ?? 1), c1 = Math.max(col, used?.col ?? 1);
    const r2 = Math.min(row + nr, used ? used.row + used.rows : 0), c2 = Math.min(col + nc, used ? used.col + used.cols : 0);
    let count = 0;
    if (r2 > r1 && c2 > c1) {
      const step = Math.max(1, Math.floor(READ_MAX / (c2 - c1)));
      for (let r = r1; r < r2; r += step) {
        const n = Math.min(step, r2 - r);
        const got = await this.read(boxAddr(r, c1, n, c2 - c1), { max: n * (c2 - c1) });
        if (got.error) return got;
        count += got.rows.flat().filter((v) => v !== '').length;
      }
    }
    return { count, doc: w.doc, sheet: w.sheet };
  }

  /**
   * One cell: sets it, then reads it back.
   * @param {string} ref @param {unknown} value @param {{ formula?: boolean, select?: boolean, maxOverwrite?: number, expect?: { doc?: string, sheet?: string } }} [o]
   */
  async write(ref, value, o = {}) {
    const at = parseRef(ref);
    if (!at || at.cells !== 1) return BAD_REF(ref);
    const r = await this.writeMany(at.addr, [[value]], o);
    if (r.error || r.overwrite !== undefined) return r;
    return { ...r, cell: at.addr, holds: r.rows[0][0] };
  }

  /**
   * A block, top-left cell first; then what the cells now hold. A big block reaches the app in
   * several script calls (setRows) but is one write: one answer, one "undo that", and when a part
   * fails the parts before it are put back.
   * `maxOverwrite`: when more cells than this already hold something, nothing is written and
   * the answer is `{ overwrite: n }` (the caller asks the user first). `expect`: the document and
   * sheet it must still be (after a question was asked), else `changed`.
   * @param {string} startRef @param {unknown[][]} rows
   * @param {{ formula?: boolean, select?: boolean, maxOverwrite?: number, expect?: { doc?: string, sheet?: string } }} [o]
   */
  async writeMany(startRef, rows, { formula = false, select = false, maxOverwrite = Infinity, expect } = {}) {
    const start = parseRef(startRef);
    if (!start || start.cells !== 1) return BAD_REF(startRef);
    if (!Array.isArray(rows) || !rows.length || !rows.every((r) => Array.isArray(r) && r.length === rows[0].length && r.length > 0)) return fail('bad_rows', 'Give the values as rows, every row with the same number of values.');
    const nr = rows.length, nc = rows[0].length;
    const most = this.app === NUMBERS ? NUMBERS_WRITE_MAX : WRITE_MAX;
    if (nr * nc > most) return tooBig(nr * nc, most);
    if (start.row + nr - 1 > MAX_ROW || start.col + nc - 1 > MAX_COL) return BAD_REF(startRef);
    const range = boxAddr(start.row, start.col, nr, nc);
    const cells = rows.map((r) => r.map((v) => cellInput(v, { formula })));
    const sent = cells.map((r) => r.map((c) => [c.kind === 'f' ? 't' : c.kind, asSent(this.app, c)]));
    let limit = Number.isFinite(maxOverwrite) ? String(Math.max(0, Math.round(maxOverwrite))) : '-1';
    let { doc = '', sheet = '' } = expect || {};
    // In one call the script itself counts what the cells hold before it writes. In several, that
    // is counted here first, so nothing is written before the user was asked.
    if (limit !== '-1' && inParts(sent).length > 1) {
      const now = await this.filled(start.row, start.col, nr, nc);
      if (now.error) return now;
      if ((doc && doc !== now.doc) || (sheet && sheet !== now.sheet)) return CHANGED;
      if (now.count > Number(limit)) return { overwrite: now.count, range, doc: now.doc, sheet: now.sheet };
      ({ doc, sheet } = now);
      limit = '-1';
    }
    const a = await this.setRows(start.row, start.col, sent, { select, limit, doc, sheet });
    // What the cells held, for "undo that".
    const remember = (got, n) => {
      this.undos.push({ doc: got.doc, sheet: got.sheet, range: boxAddr(start.row, start.col, n, nc), before: got.before.map((r, i) => r.map((v, j) => previous(v, got.beforeFormulas[i]?.[j] ?? ''))) });
      if (this.undos.length > UNDO_DEPTH) this.undos.shift();
    };
    if (a.error) {
      const err = a.error === 'changed' ? CHANGED : fail(a.error, a.message);
      if (!a.done) return err;
      // A later part failed: the rows that went in are put back, so a write is all or nothing.
      remember(a.sofar, a.done);
      const back = await this.undo();
      const written = boxAddr(start.row, start.col, a.done, nc);
      return back.error
        ? { ...fail(a.error, `${err.message} It stopped part way: ${written} was written and the rest was not. sheet_undo puts ${written} back.`), written }
        : fail(a.error, `${err.message} It stopped part way, so the rows already written were put back: the sheet is as it was.`);
    }
    // More of it holds something than may be replaced without asking: nothing was written.
    if (a.held !== undefined) return { overwrite: a.held, range, doc: a.doc, sheet: a.sheet };
    remember(a, nr);
    /** @type {Array<{ cell: string, holds: string | number | boolean }>} */
    const wrong = [];
    cells.forEach((r, i) => r.forEach((c, j) => {
      const held = a.rows[i]?.[j] ?? '';
      const isDate = typeof held === 'string' && ISO_DATE.test(held) && c.kind === 't' && !ISO_DATE.test(c.text);
      if (!holds(c, held, a.texts[i]?.[j] ?? '', a.formulas[i]?.[j] ?? '', isDate)) wrong.push({ cell: boxAddr(start.row + i, start.col + j), holds: held });
    }));
    const overwrote = a.before.flat().filter((v) => v !== '').length;
    return { doc: a.doc, sheet: a.sheet, range, cells: nr * nc, rows: a.rows, selection: a.selection, overwrote, verified: wrong.length === 0 && a.inPlace, ...(wrong.length ? { wrong: wrong.slice(0, 5) } : {}) };
  }

  /** "Undo that": the cells of the last write go back to what they held. Only on the same sheet of the same document. */
  async undo() {
    const u = this.undos.pop();
    if (!u) return fail('nothing', 'Echo has written nothing here to undo. For anything else, use the app\'s own undo (press_keys cmd+z).');
    const nr = u.before.length, nc = /** @type {any[]} */ (u.before[0]).length;
    const quoted = (c) => (c.kind === 't' && this.app === EXCEL && (/^[=+\-@']/.test(c.text) || PLAIN_NUMBER.test(c.text.trim())) ? `'${c.text}` : c.text);
    const at = /** @type {NonNullable<ReturnType<typeof parseRef>>} */ (parseRef(u.range));
    const a = await this.setRows(at.row, at.col, u.before.map((r) => r.map((c) => [c.kind === 'f' ? 't' : c.kind, quoted(c)])), { doc: u.doc, sheet: u.sheet });
    if (a.error) {
      // What wasn't put back can still be: the rows from where it stopped.
      this.undos.push({ ...u, range: boxAddr(at.row + a.done, at.col, nr - a.done, nc), before: u.before.slice(a.done) });
      const partly = a.done ? ` The first ${a.done} rows were put back; sheet_undo again does the rest.` : '';
      return a.error === 'changed' ? fail('changed', `Nothing was put back: that write was in ${u.sheet} of ${u.doc}, and another document or sheet is in front now.`) : fail(a.error, `${a.message}${partly}`);
    }
    return { doc: a.doc, sheet: a.sheet, range: u.range, restored: nr * nc, rows: a.rows, verified: true };
  }

  /**
   * For a lesson that watches the user: the selection and every cell of the used range that holds
   * something (or is bold), as lib/teach.js reads a snapshot. Never sends Escape.
   * @param {{ bold?: boolean }} [o]
   */
  async snapshot({ bold = false } = {}) {
    const r = await this.read('used', { bold, gentle: true });
    if (r.error) return r;
    const box = /** @type {NonNullable<ReturnType<typeof parseRef>>} */ (parseRef(r.range));
    /** @type {Record<string, { value: string | number | boolean, bold?: boolean }>} */
    const cells = {};
    r.rows.forEach((row, i) => row.forEach((v, j) => {
      const b = bold ? Boolean(r.bold[i]?.[j]) : undefined;
      if (v !== '' || b) cells[boxAddr(box.row + i, box.col + j)] = { value: v, ...(bold ? { bold: b } : {}) };
    }));
    const sel = parseRef(r.selection);
    return { selection: r.selection, active: sel ? boxAddr(sel.row, sel.col) : '', cells };
  }
}

/** What a cell held, as it is written back: its formula if it had one, else its value. */
function previous(value, formula) {
  // Text that only looks like a formula ("=not one") reads back as its own "formula"; a real
  // formula's value is what it works out to, never its own text.
  if (String(formula).startsWith('=') && String(value) !== String(formula)) return { kind: 'f', text: String(formula) };
  if (value === '') return { kind: 'e', text: '' };
  if (typeof value === 'boolean') return { kind: 'b', text: value ? '1' : '0' };
  if (typeof value === 'number') return { kind: 'n', text: String(value) };
  // A date comes back as the app keeps it (Excel: its day number, which the cell's format shows as the date).
  if (ISO_DATE.test(value) && formula && PLAIN_NUMBER.test(String(formula))) return { kind: 'n', text: String(formula) };
  return { kind: 't', text: String(value) };
}

/* ---------- made-up sample rows ---------- */

/** A small seeded random number source (mulberry32): the same seed gives the same rows. */
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86400000;
const day = (s) => (/^\d{4}-\d\d-\d\d$/.test(String(s)) ? Date.parse(`${s}T00:00:00Z`) : NaN);

/**
 * Sample rows from a short recipe, so the assistant doesn't write out hundreds of cells itself:
 * one generator per column, no formulas, nothing that looks at another column.
 *   { kind: 'pick', values: [...] }            one of these
 *   { kind: 'number', min, max, decimals }     a number between them (decimals: 0 when left out)
 *   { kind: 'date', from, to }                 a day between them, as "2026-03-14"
 *   { kind: 'sequence', start, step }          1, 2, 3… (start and step: 1 when left out)
 *   { kind: 'text', prefix }                   "Customer 1", "Customer 2"… (the prefix as given, then the row's number)
 * @param {{ rows?: unknown, headers?: unknown, columns?: unknown, seed?: unknown }} fill
 * @returns {any} { rows } or { error, message }
 */
export function fillRows(fill) {
  const columns = Array.isArray(fill?.columns) ? fill.columns : [];
  const count = Math.round(Number(fill?.rows));
  const headers = Array.isArray(fill?.headers) && fill.headers.length ? fill.headers : null;
  if (!columns.length || !(count >= 1)) return fail('bad_fill', 'A fill needs rows (how many) and columns (one generator for each column).');
  if (headers && headers.length !== columns.length) return fail('bad_fill', `The fill has ${headers.length} headers and ${columns.length} columns: give one generator for each header.`);
  const cells = (count + (headers ? 1 : 0)) * columns.length;
  if (cells > WRITE_MAX) return tooBig(cells);
  const random = seeded(Number.isFinite(Number(fill.seed)) && fill.seed !== undefined && fill.seed !== null ? Number(fill.seed) : Math.floor(Math.random() * 2 ** 31));
  /** @type {Array<(i: number) => string | number | boolean>} */
  const make = [];
  for (const [k, c] of columns.entries()) {
    const bad = (why) => fail('bad_fill', `Column ${k + 1} of the fill (${String(c?.kind).slice(0, 20)}): ${why}`);
    if (c?.kind === 'pick') {
      const values = Array.isArray(c.values) ? c.values.filter((v) => ['string', 'number', 'boolean'].includes(typeof v)) : [];
      if (!values.length) return bad('give the values to pick from.');
      make.push(() => values[Math.floor(random() * values.length)]);
    } else if (c?.kind === 'number') {
      const min = Number(c.min ?? 0), max = Number(c.max ?? 100), decimals = Math.min(6, Math.max(0, Math.round(Number(c.decimals ?? 0))));
      if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return bad('min and max must be numbers, min the smaller.');
      // Whole numbers land on either end as often as anywhere between.
      make.push(() => (decimals ? Number((min + random() * (max - min)).toFixed(decimals)) : Math.ceil(min) + Math.floor(random() * (Math.floor(max) - Math.ceil(min) + 1))));
    } else if (c?.kind === 'date') {
      const from = day(c.from), to = day(c.to);
      if (!(to >= from)) return bad('from and to must be days like "2026-01-31", from the earlier.');
      make.push(() => new Date(from + Math.floor(random() * ((to - from) / DAY_MS + 1)) * DAY_MS).toISOString().slice(0, 10));
    } else if (c?.kind === 'sequence') {
      const first = Number(c.start ?? 1), step = Number(c.step ?? 1);
      if (!Number.isFinite(first) || !Number.isFinite(step)) return bad('start and step must be numbers.');
      make.push((i) => first + i * step);
    } else if (c?.kind === 'text') {
      const prefix = String(c.prefix ?? '');
      make.push((i) => `${prefix}${i + 1}`);
    } else return bad('the kind must be pick, number, date, sequence or text.');
  }
  const rows = Array.from({ length: count }, (_, i) => make.map((m) => m(i)));
  return { rows: headers ? [headers.map((h) => (['number', 'boolean'].includes(typeof h) ? h : String(h ?? ''))), ...rows] : rows };
}
