// The spreadsheet adapter (lib/sheets.js). On Oct 3 (11:16-11:24) Echo drove Excel by clicks and
// keys: `type_text` into a cell failed 8 times out of 15, "B4" was typed INTO A4 ("CoffeeB4"),
// typing that did land came back "the field is still empty", and turns took 31 to 117 seconds.
// Excel and Numbers are scriptable, so Echo now works in a sheet through the app's own scripting.
// Here the scripts are answered by the simulated Mac's sheet (lib/evalsim.js simSheets: values,
// selection, bold, edit mode, a not-allowed error), and ComputerUse and the lesson engine are the
// real ones. Nothing touches a real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('sheets');
const { Sheets, SCRIPTS, EXCEL, NUMBERS, parseRef, boxAddr, sheetApp, cellInput, encodeCell, decodeCell, parseAnswer, WRITE_MAX, SHEET_TIMEOUT_MS } = await import('../lib/sheets.js');
const { World, SimBridge, excelScene, simSheets } = await import('../lib/evalsim.js');
const { ComputerUse, COMPUTER_TOOL_NAMES } = await import('../lib/computer.js');
const { classifyByEffect, SHEET_OVERWRITE_MAX } = await import('../lib/policy.ts');
const { TeachSession, sheetAdapter, CELL_KINDS, SHEET_SEEN, TEACH_POLL_MS } = await import('../lib/teach.js');
const { QuickActions } = await import('../lib/quick.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { runTask, SHEET_TASKS, ALL_TASKS, STRESS_TASKS } = await import('../lib/evalsuite.js');
const { safeFields, readTimeline } = await import('../lib/timeline.ts');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const on = (more = {}) => (setFixedForTest({ screenAware: false }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do', ...more }));

/** Excel on the simulated Mac, with its scripting. `o.escape`: what sends Escape to the grid. */
function excel(o = {}) {
  const w = new World();
  excelScene(w, o);
  const sim = simSheets(w);
  const escapes = [];
  const sheets = new Sheets({ run: sim.run, escape: o.escape === false ? null : async (app) => { escapes.push(app); w.apps.get(EXCEL).sheet.editing = false; return true; } });
  const sheet = () => w.apps.get(EXCEL).sheet;
  return { w, sim, sheets, x: /** @type {NonNullable<ReturnType<typeof sheets.in>>} */ (sheets.in(EXCEL)), sheet, escapes };
}

/** The real ComputerUse over the simulated Mac, with (or without) the adapter. */
function driving(o = {}, { adapter = true, bridge = null } = {}) {
  on();
  const w = new World();
  excelScene(w, o);
  const sim = simSheets(w);
  const computer = new ComputerUse({ bridge: /** @type {any} */ (bridge ? bridge(w) : new SimBridge(w, 'v2')), sheets: adapter ? new Sheets({ run: sim.run }) : null, logFile, focusRetryMs: 0, confirmSettleMs: 0, expectMs: 50, settleMs: 0 });
  return { w, sim, computer, sheet: () => w.apps.get(EXCEL).sheet };
}

// Text that would be code if it were ever put into a script.
const NASTY = ['say "hi"', 'back\\slash \\" end', 'two\nlines\tand a tab', '" & do shell script "touch /tmp/echo-pwned" & "', "it's 'quoted'", 'end tell\nend run'];

test('references: A1 and B2:D10 only; a sheet name, a whole column or a formula is refused', () => {
  assert.deepEqual(parseRef('b2'), { addr: 'B2', row: 2, col: 2, rows: 1, cols: 1, cells: 1 });
  assert.equal(parseRef('$C$4')?.addr, 'C4');
  assert.deepEqual(parseRef('D10:B2'), { addr: 'B2:D10', row: 2, col: 2, rows: 9, cols: 3, cells: 27 });
  assert.equal(parseRef(' aa3 ')?.addr, 'AA3');
  assert.equal(parseRef('XFD1048576')?.addr, 'XFD1048576');
  for (const no of ['', 'Sheet2!A1', "'My Sheet'!B2", 'A:A', '1:1', 'A0', 'XFE1', 'A1048577', 'A1:B2:C3', 'Total', '=A1', 'A1 ; B2', 'A1,B2', 'R1C1:', null, undefined, 12]) assert.equal(parseRef(no), null, String(no));
  assert.equal(boxAddr(2, 2, 3, 3), 'B2:D4');
  assert.equal(boxAddr(1, 28), 'AB1');
  assert.deepEqual(['excel', 'Microsoft Excel', ' numbers ', 'Numbers', 'Google Sheets', 'Notes', ''].map(sheetApp), [EXCEL, EXCEL, NUMBERS, NUMBERS, '', '', '']);
});

test('a reference is checked before any script runs', async () => {
  const { sim, x } = excel();
  for (const bad of ['Sheet2!A1', 'A:A', 'everything', '']) {
    assert.equal((await x.select(bad)).error, 'bad_ref', bad);
    assert.equal((await x.write(bad, 'x')).error, 'bad_ref', bad);
    assert.equal((await x.writeMany(bad, [['x']])).error, 'bad_ref', bad);
    assert.equal((await x.format(bad, { bold: true })).error, 'bad_ref', bad);
  }
  assert.equal((await x.read('Sheet2!A1')).error, 'bad_ref');
  assert.match((await x.read('Sheet2!A1')).message, /no sheet names/);
  assert.equal((await x.write('A1:B2', 'x')).error, 'bad_ref', 'one value goes into one cell');
  assert.equal((await x.writeMany('XFD1', [['a', 'b']])).error, 'bad_ref', 'a block may not run off the sheet');
  assert.equal((await x.writeMany('A1', [['a', 'b'], ['c']])).error, 'bad_rows');
  assert.equal((await x.writeMany('A1', Array.from({ length: 2001 }, () => Array(10).fill(1)))).error, 'too_big');
  assert.equal(WRITE_MAX, 20000);
  assert.equal(sim.calls.length, 0, 'nothing reached the app');
});

test('where, read, headers and find: one call each, values as rows', async () => {
  const { sim, x, sheet } = excel({ cells: { B2: 'Item', C2: 'Qty', B3: 'Coffee', C3: 2, B4: 'Tea', C4: true }, sel: 'C3' });
  sheet().cells.B2.bold = true;
  assert.deepEqual(await x.where(), { app: EXCEL, doc: 'Book1', sheet: 'Sheet1', selection: 'C3', used: 'B2:C4', rows: 3, cols: 2 });
  const all = await x.read();
  assert.deepEqual(all.rows, [['Item', 'Qty'], ['Coffee', 2], ['Tea', true]]);
  assert.equal(all.range, 'B2:C4');
  assert.equal(all.bold, undefined, 'bold only when asked for');
  assert.deepEqual((await x.read('B2:C3', { bold: true })).bold, [[true, false], [false, false]]);
  assert.deepEqual((await x.read('a1')).rows, [['']], 'an empty cell is ""');
  assert.deepEqual((await x.read('selection')).rows, [[2]]);
  // Bigger than asked for: the top rows that fit, and a note saying so.
  const clipped = await x.read('A1:Z100', { max: 52 });
  assert.equal(clipped.range, 'A1:Z2');
  assert.equal(clipped.clipped, true);
  assert.match(clipped.note, /A1:Z100 is 2600 cells: only A1:Z2 is here/);
  // The header row is the first row that holds anything, with its address: one script call.
  const before = sim.calls.length;
  assert.deepEqual(await x.headers(), { doc: 'Book1', sheet: 'Sheet1', range: 'B2:C2', row: 2, values: ['Item', 'Qty'], used: 'B2:C4', selection: 'C3' });
  assert.equal(sim.calls.length - before, 1);
  assert.deepEqual((await x.find('COFF')).cells, ['B3']);
  assert.deepEqual((await x.find('e')).cells, ['B2', 'B3', 'B4', 'C4'], 'true reads as text too');
  assert.deepEqual((await x.find('nothing like it')).cells, []);
  assert.equal((await x.find(' ')).error, 'empty');
  const many = excel({ cells: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`A${i + 1}`, 'same'])) });
  const found = await many.x.find('same');
  assert.equal(found.cells.length, 10);
  assert.equal(found.more, 4);
  // An empty sheet has no header row.
  assert.deepEqual((await excel().x.headers()).values, []);
});

test('write: numbers as numbers, text as text, "=" a formula only when said so; then read back', async () => {
  const { x, sheet } = excel({ cells: { A5: 'Total' }, sel: 'A5' });
  const one = await x.write('b2', 'Coffee');
  assert.deepEqual([one.cell, one.holds, one.verified, one.cells], ['B2', 'Coffee', true, 1]);
  assert.equal(sheet().cells.B2.v, 'Coffee');
  assert.equal(sheet().sel, 'A5', 'the selection stays where it was');
  assert.strictEqual((await x.write('C2', '12')).holds, 12, 'text that is a number goes in as a number');
  assert.strictEqual((await x.write('C3', 3.5)).holds, 3.5);
  assert.strictEqual((await x.write('C4', '-0.25')).holds, -0.25);
  assert.strictEqual((await x.write('C5', true)).holds, true);
  // A leading "=" without formula: true stays text (in Excel it is marked as text for the app).
  const literal = await x.write('D1', '=SUM(C2:C4)');
  assert.deepEqual([literal.holds, literal.verified, sheet().cells.D1.f], ['=SUM(C2:C4)', true, undefined]);
  const formula = await x.write('D2', '=SUM(C2:C4)', { formula: true });
  assert.equal(formula.verified, true);
  assert.equal(sheet().cells.D2.f, '=SUM(C2:C4)');
  assert.equal((await x.write('D3', "'quoted")).holds, "'quoted", 'text that starts with an apostrophe keeps it');
  assert.equal((await x.write('D4', '- a dash')).holds, '- a dash');
  // An empty value clears the cell.
  assert.equal((await x.write('B2', '')).holds, '');
  assert.equal(sheet().cells.B2.v, '');
  assert.equal(sheet().cells.A5.v, 'Total', 'nothing else changed');
  assert.deepEqual([cellInput('12'), cellInput('1e3'), cellInput(' 7 '), cellInput('7 apples'), cellInput('=1', { formula: true }), cellInput('=1'), cellInput(null), cellInput(false)],
    [{ kind: 'n', text: '12' }, { kind: 'n', text: '1e3' }, { kind: 'n', text: '7' }, { kind: 't', text: '7 apples' }, { kind: 'f', text: '=1' }, { kind: 't', text: '=1' }, { kind: 'e', text: '' }, { kind: 'b', text: '0' }]);
  // What isn't what was asked for is said, with what the cell holds (a sheet that changed it).
  const w = excel();
  const run = w.sim.run;
  w.sheets.run = async (script, args) => { const out = await run(script, args); if (args[0] === 'set') w.sheet().cells.A1.v = 'something else'; return args[0] === 'set' ? out.replace('sHello', 'ssomething else') : out; };
  const wrong = await w.x.write('A1', 'Hello');
  assert.equal(wrong.verified, false);
  assert.deepEqual(wrong.wrong, [{ cell: 'A1', holds: 'something else' }]);
});

test('writeMany: a block in one script call, read back; select and format read back too', async () => {
  const { sim, x, sheet } = excel({ cells: { E5: 'Notes' }, sel: 'E5' });
  const r = await x.writeMany('A1', [['Item', 'Qty', 'Price'], ['Coffee', 2, '3.5'], ['Tea', '10', 4]]);
  assert.deepEqual([r.range, r.cells, r.verified, r.overwrote], ['A1:C3', 9, true, 0]);
  assert.deepEqual(r.rows, [['Item', 'Qty', 'Price'], ['Coffee', 2, 3.5], ['Tea', 10, 4]]);
  assert.equal(sim.calls.filter((c) => c.args[0] === 'set').length, 1, 'one call for the whole block');
  assert.equal(sim.calls.filter((c) => c.script === SCRIPTS[EXCEL]).length, 1, 'and nothing else');
  const sel = await x.select('c3:a1');
  assert.deepEqual([sel.selection, sel.verified], ['A1:C3', true]);
  assert.equal(sheet().sel, 'A1:C3');
  const f = await x.format('A1:C1', { bold: true });
  assert.deepEqual([f.range, f.bold, f.italic, f.verified], ['A1:C1', true, false, true]);
  assert.equal(sheet().cells.B1.bold, true);
  assert.equal(sheet().cells.A2.bold, false);
  assert.equal((await x.format('A1:C2')).bold, 'mixed', 'with nothing to set it only reads');
  assert.deepEqual([(await x.format('selection', { italic: true, underline: true })).range, sheet().cells.C3.italic, sheet().cells.C3.underline], ['A1:C3', true, true]);
  assert.equal((await x.format('A1', { bold: false })).bold, false);
  // A format that didn't take is not verified.
  const run = x.sheets.run;
  x.sheets.run = async (script, args) => (await run(script, args)).replace(/^fmt\t1/m, 'fmt\t0');
  assert.equal((await x.format('B1', { bold: true })).verified, false);
});

test('a cell\'s text can never become code: one fixed script, every value an argument', async () => {
  const { sim, x, sheet } = excel();
  for (const [i, text] of NASTY.entries()) {
    const r = await x.write(`A${i + 1}`, text);
    assert.equal(r.holds, text, JSON.stringify(text));
    assert.equal(r.verified, true);
    assert.equal(sheet().cells[`A${i + 1}`].v, text);
  }
  assert.deepEqual((await x.read(`A1:A${NASTY.length}`)).rows.map((r) => r[0]), NASTY, 'and they read back as the same text');
  const block = await x.writeMany('C1', [NASTY.slice(0, 3), NASTY.slice(3)]);
  assert.deepEqual(block.rows, [NASTY.slice(0, 3), NASTY.slice(3)]);
  assert.deepEqual((await x.find('do shell script')).cells, ['C2', 'A4'], 'row by row');
  // The script the app was sent is the same text every time, and holds none of the values.
  const scripts = new Set(sim.calls.filter((c) => c.script !== SCRIPTS.running).map((c) => c.script));
  assert.deepEqual([...scripts], [SCRIPTS[EXCEL]]);
  for (const text of NASTY) assert.equal(SCRIPTS[EXCEL].includes(text), false);
  assert.ok(sim.calls.some((c) => c.args.includes(NASTY[3])), 'the value went in as an argument');
  // The scripts read what to do from argv, and build nothing from it.
  for (const app of [EXCEL, NUMBERS]) {
    assert.match(SCRIPTS[app], /^\s*on run argv\n\s*set \|theOp\| to item 1 of argv/);
    assert.doesNotMatch(SCRIPTS[app], /run script|do shell script|\$\{/);
    assert.match(SCRIPTS[app], new RegExp(`if application "${app}" is not running then return "ERR"`), 'a script never starts the app');
    assert.match(SCRIPTS[app], /with timeout of 3 seconds/);
  }
  // Every name a script makes up is between bars, so it can't be one of the app's own words
  // (a variable called rowS is Excel's "rows": `set rowS to …` writes to every row).
  assert.doesNotMatch(SCRIPTS[EXCEL].split('end run')[0], /^\s*set (?!\|)(?!(?:value|bold|italic|underline|end) )\w+ to /m);
  assert.doesNotMatch(SCRIPTS[NUMBERS].split('end run')[0], /^\s*set (?!\|)(?!(?:value|selection range|row count|column count|end) )\w+ to /m);
  // The wire format round-trips any text, number or true/false.
  for (const v of [...NASTY, '', 0, -2.5, 1e21, true, false, 'sstarts with s', 'e', 'n5']) assert.strictEqual(decodeCell(encodeCell(v)), v, JSON.stringify(v));
  assert.equal(decodeCell('n3,5'), 3.5, 'a number as a comma-decimal Mac writes it');
  assert.deepEqual(parseAnswer('OK\ndoc\tBook 1\nsel\t$B$2\nr\tsa\\tb\tn2\te\tb1\n').rows, [['a\tb', 2, '', true]]);
  assert.deepEqual(parseAnswer('ERR\tscript\t-1743\tNot authorized'), { error: 'script', num: -1743, message: 'Not authorized' });
  assert.equal(parseAnswer('garbage').error, 'failed');
});

test('errors are plain: not running, not allowed (with the Settings pane), no answer in time', async () => {
  // Nothing open: the app's script is never run (so macOS never has to find, or start, the app).
  const none = new World();
  const sim = simSheets(none);
  const sheets = new Sheets({ run: sim.run });
  const r = await /** @type {any} */ (sheets.in('Numbers')).where();
  assert.equal(r.error, 'not_running');
  assert.match(r.message, /Numbers isn't open/);
  assert.deepEqual(sim.calls.map((c) => c.script === SCRIPTS.running), [true]);
  assert.equal(sheets.in('Pages'), null);
  assert.equal(await sheets.front(), '');
  // macOS hasn't allowed Echo to control the app: which pane fixes it.
  const a = excel();
  a.sheet().notAllowed = true;
  const no = await a.x.write('C7', 'x');
  assert.equal(no.error, 'not_allowed');
  assert.match(no.message, /System Settings, Privacy & Security, Automation, and switch on Microsoft Excel under Echo/);
  assert.equal(a.escapes.length, 0, 'no Escape for that');
  assert.equal(a.sheet().cells.C7, undefined);
  // No answer in time.
  a.sheet().notAllowed = false;
  a.sheet().slow = true;
  const late = await a.x.read('A1');
  assert.equal(late.error, 'timeout');
  // The runner's own failures: the error number osascript printed, or a kill at the time limit.
  const failing = (err) => new Sheets({ run: async (script) => { if (script === SCRIPTS.running) return `${EXCEL}\ttrue\n`; throw err; } }).in(EXCEL);
  assert.equal((await /** @type {any} */ (failing(Object.assign(new Error('x'), { stderr: 'execution error: Not authorized to send Apple events to Microsoft Excel. (-1743)' }))).where()).error, 'not_allowed');
  assert.equal((await /** @type {any} */ (failing(Object.assign(new Error('x'), { killed: true }))).where()).error, 'timeout');
  assert.equal((await /** @type {any} */ (failing(Object.assign(new Error('x'), { stderr: 'Microsoft Excel got an error: Connection is invalid. (-609)' }))).where()).error, 'not_running');
  // Every call carries the time limit to the runner (4 seconds).
  const limits = [];
  const timed = new Sheets({ run: async (script, args, o) => { limits.push(o?.timeoutMs); return script === SCRIPTS.running ? `${EXCEL}\ttrue\n` : 'OK\nused\tA1\n'; } });
  await /** @type {any} */ (timed.in(EXCEL)).where();
  assert.deepEqual(limits, [SHEET_TIMEOUT_MS, SHEET_TIMEOUT_MS]);
  assert.equal(SHEET_TIMEOUT_MS, 4000);
  // The AppleScript runner takes that limit (lib/quick.js osa).
  const execs = [];
  const quick = new QuickActions({ exec: async (...a) => { execs.push(a); return ''; } });
  await quick.osa('return 1', ['a'], { timeoutMs: 4000 });
  await quick.osa('return 1', ['a']);
  assert.deepEqual(execs, [['osascript', ['-', 'a'], 'return 1', { timeoutMs: 4000 }], ['osascript', ['-', 'a'], 'return 1']]);
});

test('Excel in the middle of an edit refuses scripts: Escape to the grid once, then once more', async () => {
  const a = excel({ cells: { A4: 'Coffee' }, sel: 'A4' });
  a.sheet().editing = true;
  const r = await a.x.write('B4', 4);
  assert.equal(r.verified, true);
  assert.deepEqual(a.escapes, [EXCEL], 'one Escape');
  assert.equal(a.sheet().cells.A4.v, 'Coffee', 'never "CoffeeB4"');
  assert.equal(a.sheet().cells.B4.v, 4);
  assert.equal(a.sim.calls.filter((c) => c.args[0] === 'set').length, 2, 'tried, then tried once more');
  // Escape that doesn't help: one retry, then a plain error, and nothing written.
  const stuck = excel({ escape: false });
  const tries = [];
  stuck.sheets.escape = async () => { tries.push(1); return true; };
  stuck.sheet().editing = true;
  const no = await stuck.x.write('B4', 4);
  assert.equal(no.error, 'failed');
  assert.match(no.message, /may be editing a cell/);
  assert.equal(tries.length, 1);
  assert.equal(stuck.sim.calls.filter((c) => c.args[0] === 'set').length, 2);
  // Nothing to send Escape with: no retry.
  const bare = excel({ escape: false });
  bare.sheet().editing = true;
  assert.equal((await bare.x.read('A1')).error, 'failed');
  assert.equal(bare.sim.calls.filter((c) => c.args[0] === 'read').length, 1);
  // While a lesson watches, the one typing in the cell is the user: never Escape.
  const lesson = excel();
  lesson.sheet().editing = true;
  assert.equal((await lesson.x.snapshot()).error, 'editing');
  assert.equal(lesson.escapes.length, 0);
});

test('undo: Echo remembers what a write replaced and puts it back, on the same sheet only', async () => {
  const { x, sheet, w } = excel({ cells: { A1: 'Item', B1: 7 } });
  sheet().cells.C1 = { v: 0, f: '=B1*2', bold: false };
  await x.writeMany('A1', [['X', 'Y', 'Z', 'new']]);
  assert.deepEqual(['A1', 'B1', 'C1', 'D1'].map((k) => sheet().cells[k].v), ['X', 'Y', 'Z', 'new']);
  await x.write('A2', 'second');
  const last = await x.undo();
  assert.deepEqual([last.range, last.restored], ['A2', 1]);
  assert.equal(sheet().cells.A2.v, '');
  const first = await x.undo();
  assert.deepEqual([first.range, first.restored], ['A1:D1', 4]);
  assert.deepEqual(['A1', 'B1', 'D1'].map((k) => sheet().cells[k].v), ['Item', 7, ''], 'text, a number, and a cell that was empty');
  assert.equal(sheet().cells.C1.f, '=B1*2', 'a formula comes back as a formula');
  assert.equal((await x.undo()).error, 'nothing');
  // Another document in front: nothing is put back, and the write can still be undone later.
  await x.write('A1', 'changed');
  w.apps.get(EXCEL).window = 'Another book';
  const other = await x.undo();
  assert.equal(other.error, 'changed');
  assert.match(other.message, /that write was in Sheet1 of Book1/);
  assert.equal(sheet().cells.A1.v, 'changed');
  w.apps.get(EXCEL).window = 'Book1';
  assert.equal((await x.undo()).restored, 1);
  assert.equal(sheet().cells.A1.v, 'Item');
  // Text that looks like a number, or like a formula, comes back as the text it was.
  sheet().cells.E1 = { v: '007', bold: false };
  sheet().cells.E2 = { v: '=not a formula', bold: false };
  await x.writeMany('E1', [['a'], ['b']]);
  await x.undo();
  assert.deepEqual([sheet().cells.E1.v, sheet().cells.E2.v, sheet().cells.E2.f], ['007', '=not a formula', undefined]);
});

test('replacing more than 20 filled cells asks first; a card, then the write, then an Undo chip', async () => {
  assert.equal(SHEET_OVERWRITE_MAX, 20);
  assert.deepEqual(classifyByEffect({ action: 'sheet_write', overwrites: 20 }), { level: 'ok', tier: 1 });
  const v = classifyByEffect({ action: 'sheet_write', overwrites: 21 });
  assert.deepEqual([v.level, v.tier, v.category], ['risky', 2, 'overwrite']);
  assert.match(String(v.reason), /replace or clear 21 cells that hold something/);
  // The adapter: nothing is written when more is held than allowed.
  const filled = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`A${i + 1}`, `old ${i + 1}`]));
  const a = excel({ cells: filled(21) });
  const rows = Array.from({ length: 21 }, (_, i) => [`new ${i + 1}`]);
  assert.deepEqual(await a.x.writeMany('A1', rows, { maxOverwrite: 20 }), { overwrite: 21, range: 'A1:A21', doc: 'Book1', sheet: 'Sheet1' });
  assert.equal(a.sheet().cells.A1.v, 'old 1');
  assert.equal((await a.x.undo()).error, 'nothing', 'and there is nothing to undo');
  assert.equal((await a.x.writeMany('A1', rows.slice(0, 20), { maxOverwrite: 20 })).verified, true, '20 go ahead');
  // The tool: a card, no write; the user's yes writes it and offers Undo; Undo puts it all back.
  const d = driving({ cells: filled(21) });
  const events = [];
  d.computer.on('confirm_request', (r) => events.push(['card', r]));
  d.computer.on('undo_offer', (o) => events.push(['undo', o]));
  const asked = await d.computer.sheet('write', { cell: 'A1', rows, app: 'excel' });
  assert.equal(asked.waitingForConfirmation, true);
  assert.equal(asked.what, 'replace 21 filled cells in A1:A21 in Microsoft Excel');
  assert.equal(asked.why, 'This would replace or clear 21 cells that hold something.');
  assert.equal(d.sheet().cells.A1.v, 'old 1', 'nothing written yet');
  assert.equal(events[0][0], 'card');
  assert.doesNotMatch(JSON.stringify(events[0][1]), /new 1|old 1/, 'the card names the range, never what the cells hold');
  // Clearing counts the same as replacing.
  const clear = driving({ cells: filled(21) });
  assert.equal((await clear.computer.sheet('write', { cell: 'A1', rows: Array.from({ length: 21 }, () => ['']), app: 'excel' })).waitingForConfirmation, true);
  assert.equal(clear.sheet().cells.A1.v, 'old 1');
  clear.computer.end('done');
  // The sheet changed while the card waited: nothing is written.
  const moved = driving({ cells: filled(21) });
  const card = await moved.computer.sheet('write', { cell: 'A1', rows, app: 'excel' });
  moved.w.apps.get(EXCEL).window = 'Another book';
  const gone = await moved.computer.confirm(card.confirmId, true, 'window');
  assert.equal(gone.error, 'changed');
  assert.equal(moved.sheet().cells.A1.v, 'old 1');
  moved.computer.end('done');
  // A yes: written, read back, and an Undo chip.
  const done = await d.computer.confirm(asked.confirmId, true, 'window');
  assert.equal(done.done, true);
  assert.equal(done.replaced, 21);
  assert.equal(d.sheet().cells.A21.v, 'new 21');
  assert.equal(events.at(-1)[0], 'undo');
  assert.equal(events.at(-1)[1].label, 'Replaced');
  const undone = await d.computer.undo(done.undo.id);
  assert.equal(undone.done, true);
  assert.equal(d.sheet().cells.A21.v, 'old 21');
  // A no: nothing.
  const again = await d.computer.sheet('write', { cell: 'A1', rows, app: 'excel' });
  assert.equal((await d.computer.confirm(again.confirmId, false, 'window')).cancelled, true);
  assert.equal(d.sheet().cells.A1.v, 'old 1');
  // A small write the user asked for needs no card, and "undo that" puts it back.
  const small = await d.computer.sheet('write', { cell: 'C1', value: 'Coffee' });
  assert.deepEqual([small.done, small.holds, small.waitingForConfirmation], [true, 'Coffee', undefined]);
  assert.deepEqual(await d.computer.sheet('undo', {}), { done: true, range: 'C1', restored: 1, note: 'Put back what C1 held before Echo wrote there.' });
  assert.equal(d.sheet().cells.C1.v, '');
  d.computer.end('done');
});

test('the sheet tools: lean results, off with computer use off, and never a secret', async () => {
  const d = driving({ cells: { A1: 'Item', B1: 'Qty', A2: 'Coffee', B2: 2 }, sel: 'B2' });
  d.sheet().cells.A1.bold = true;
  // With no range: the header row and where things are, in one script call.
  assert.deepEqual(await d.computer.sheet('read', { app: 'Microsoft Excel' }), { doc: 'Book1', sheet: 'Sheet1', used: 'A1:B2', headers: ['Item', 'Qty'], headerRow: 'A1:B1', selection: 'B2' });
  assert.equal(d.sim.calls.filter((c) => c.script === SCRIPTS[EXCEL]).length, 1);
  // The app, once named, stays the one being worked in.
  assert.deepEqual(await d.computer.sheet('read', { range: 'used', bold: true }), { doc: 'Book1', sheet: 'Sheet1', range: 'A1:B2', rows: [['Item', 'Qty'], ['Coffee', 2]], bold: ['A1'], selection: 'B2', used: 'A1:B2' });
  assert.deepEqual(await d.computer.sheet('find', { text: 'coffee' }), { cells: ['A2'], searched: 'A1:B2' });
  assert.deepEqual(await d.computer.sheet('select', { range: 'A1:B1' }), { done: true, selection: 'A1:B1' });
  assert.deepEqual(await d.computer.sheet('format', { range: 'A1:B1', bold: true }), { done: true, range: 'A1:B1', bold: true });
  assert.equal((await d.computer.sheet('format', { range: 'A1' })).error, 'empty');
  assert.deepEqual(await d.computer.sheet('write', { cell: 'A3', rows: [['Tea', 10]] }), { done: true, range: 'A3:B3', cells: 2 });
  assert.equal((await d.computer.sheet('write', { cell: 'A3' })).error, 'empty');
  assert.equal((await d.computer.sheet('read', { range: 'Sheet2!A1' })).error, 'bad_ref');
  assert.equal((await d.computer.sheet('read', { app: 'Google Sheets' })).error, 'unsupported');
  // A password or a card number is refused, as with typing.
  const secret = await d.computer.sheet('write', { cell: 'D1', value: ['4111', '1111', '1111', '1111'].join(' ') });
  assert.equal(secret.refused, true);
  assert.equal(d.sheet().cells.D1, undefined);
  // An email address the user dictated is read back first.
  d.computer.newTurn('put sam dot lee at example dot com in D2');
  const rb = await d.computer.sheet('write', { cell: 'D2', value: 'sam.lee@example.com' });
  assert.equal(rb.needsReadBack, true);
  assert.equal(d.sheet().cells.D2, undefined);
  // Show-me mode: reading is fine, nothing is changed.
  on({ driveMode: 'show' });
  assert.equal((await d.computer.sheet('write', { cell: 'D3', value: 'x' })).shown, true);
  assert.equal(d.sheet().cells.D3, undefined);
  assert.equal((await d.computer.sheet('read', { range: 'A1' })).rows[0][0], 'Item');
  // The user took back control: nothing more until they speak.
  on();
  d.computer.abort('pressed Escape');
  assert.equal((await d.computer.sheet('write', { cell: 'D4', value: 'x' })).error, 'stopped');
  d.computer.newTurn('carry on');
  // Off in Settings: nothing reaches the app.
  saveSettings({ computerUse: false });
  const n = d.sim.calls.length;
  assert.equal((await d.computer.sheet('read', {})).error, 'off');
  assert.equal(d.sim.calls.length, n);
  on();
  // No adapter (an older setup): said plainly.
  assert.equal((await new ComputerUse({ bridge: null, logFile }).sheet('read', {})).error, 'unsupported');
  // With no app named and none in the session: the spreadsheet app that is open.
  const fresh = driving({ cells: { A1: 'Only' } });
  assert.deepEqual((await fresh.computer.sheet('read', {})).headers, ['Only']);
  const nothing = new World();
  on();
  assert.equal((await new ComputerUse({ bridge: /** @type {any} */ (new SimBridge(nothing, 'v2')), sheets: new Sheets({ run: simSheets(nothing).run }), logFile }).sheet('read', {})).error, 'not_running');
  // The tools exist, with the guidance, and only with computer use on.
  for (const name of ['sheet_read', 'sheet_write', 'sheet_select', 'sheet_format', 'sheet_find', 'sheet_undo']) assert.ok(COMPUTER_TOOL_NAMES.includes(name), name);
  const tools = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib/tools/computer.js'), 'utf8');
  assert.match(tools, /In Excel or Numbers ALWAYS use the sheet_ tools instead of clicking, typing or looking in the grid/);
  assert.match(tools, /Call it with no range FIRST: it gives the header row/);
  assert.match(tools, /a whole block in ONE call \(rows, from the top-left cell\), never cell by cell/);
  assert.match(tools, /ALWAYS use the sheet tools instead of clicking or typing in the grid/);
  const drive = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib/dispatcher.js'), 'utf8').split('const DRIVE_TOOLS')[1].split('\n')[0];
  for (const name of ['sheet_read', 'sheet_write', 'sheet_select', 'sheet_format', 'sheet_find', 'sheet_undo']) assert.match(drive, new RegExp(`'${name}'`), `${name} is offered only with computer use on`);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8'), /computer\.sheets = new Sheets\(\{ run: \(script, args, opts\) => quick\.osa\(script, args, opts\)/);
});

test('privacy: what a cell holds goes to the assistant, never into the log or the timeline', async () => {
  fs.rmSync(logFile, { force: true });
  const since = Date.now() - 1000;
  const d = driving({ cells: { A1: 'Salary of Robin', B1: 'zebra-private' }, sel: 'A1' });
  const words = ['Salary', 'Robin', 'zebra-private', 'Quarterly-secret', 'typed-secret'];
  assert.equal((await d.computer.sheet('read', { range: 'used', app: 'excel' })).rows[0][1], 'zebra-private', 'the assistant sees it');
  await d.computer.sheet('find', { text: 'zebra-private' });
  await d.computer.sheet('write', { cell: 'A2', rows: [['Quarterly-secret', 12]] });
  await d.computer.sheet('format', { range: 'A2', bold: true });
  await d.computer.sheet('undo', {});
  await d.computer.sheet('read', { range: 'Sheet9!A1' });
  await d.computer.act('type_text', { text: 'typed-secret', target: 'C3', app: EXCEL });
  await d.computer.act('click', { target: 'A1', app: EXCEL });
  d.computer.end('done');
  const text = fs.readFileSync(logFile, 'utf8');
  for (const w of words) assert.equal(text.includes(w), false, `${w} is not in the computer log`);
  const sheetLines = logged().filter((e) => e.event === 'sheet');
  assert.deepEqual(sheetLines.map((e) => [e.tool, e.cells, e.ok]), [['read', 2, true], ['find', 0, true], ['write', 2, true], ['format', 1, true], ['undo', 2, true], ['read', 0, false]]);
  for (const e of sheetLines) assert.deepEqual(Object.keys(e).filter((k) => !['at', 'event', 'tool', 'app', 'cells', 'ms', 'ok', 'why', 'verified'].includes(k)), [], 'only the tool, the size, the time and how it went');
  assert.equal(sheetLines.at(-1).why, 'bad_ref');
  const typed = logged().find((e) => e.event === 'action' && e.action === 'type_text');
  assert.deepEqual([typed.target, typed.via, typed.verified, typed.text], ['C3', 'script', true, undefined]);
  // The timeline: the tool and the size, nothing else of it.
  assert.deepEqual(safeFields('mac.sheet', { tool: 'write', cells: 9, ms: 12, ok: true, app: EXCEL, range: 'A1:C3', rows: [['x']], holds: 'x' }), { ok: true, ms: 12, tool: 'write', cells: 9 });
  const rows = readTimeline(dirs.data, since).filter((r) => r.type.startsWith('mac.sheet'));
  assert.ok(rows.some((r) => r.type === 'mac.sheet' && r.f.tool === 'write' && r.f.cells === 2));
  assert.ok(rows.some((r) => r.type === 'mac.sheet.error' && r.f.tool === 'read'));
  for (const w of words) assert.equal(JSON.stringify(readTimeline(dirs.data, since)).includes(w), false, `${w} is not in the timeline`);
});

test('a click or typing with a cell as its target goes through the adapter: no Name Box, read back from the sheet', async () => {
  fs.rmSync(logFile, { force: true });
  const d = driving({ cells: { A5: 'Total' }, sel: 'A5' });
  const requests = [];
  const request = d.computer.bridge.request.bind(d.computer.bridge);
  d.computer.bridge.request = async (kind, p) => { requests.push(kind); return request(kind, p); };
  const typed = await d.computer.act('type_text', { text: 'Hello', target: 'b3', app: EXCEL });
  assert.deepEqual([typed.done, typed.verified, typed.via, typed.holds, typed.step], [true, true, 'script', 'Hello', 1]);
  assert.match(typed.note, /Confirmed: read back from the sheet, B3 holds it\./);
  assert.equal(d.sheet().cells.B3.v, 'Hello');
  assert.equal(d.sheet().sel, 'B3', 'and the cell is selected, so formatting comes straight after');
  assert.deepEqual(requests, [], 'the Mac app was not asked to find, click or type anything');
  // Typing replaces what the cell holds; "append" adds to it; a number goes in as one; "=" is a formula, as typed.
  assert.equal((await d.computer.act('type_text', { text: 'Again', target: 'B3', app: EXCEL })).holds, 'Again');
  assert.equal((await d.computer.act('type_text', { text: ' and more', target: 'B3', app: EXCEL, mode: 'append' })).holds, 'Again and more');
  assert.strictEqual((await d.computer.act('type_text', { text: '42', target: 'cell C3', app: EXCEL })).holds, 42);
  assert.equal((await d.computer.act('type_text', { text: '=C3*2', into: 'D3', app: EXCEL })).done, true);
  assert.equal(d.sheet().cells.D3.f, '=C3*2');
  // A click selects (a range too); clearing empties.
  const click = await d.computer.act('click', { target: 'B12', app: EXCEL });
  assert.deepEqual([click.done, click.selection, click.via], [true, 'B12', 'script']);
  assert.equal((await d.computer.act('click', { target: 'A1:C1', app: EXCEL })).selection, 'A1:C1');
  assert.equal((await d.computer.act('clear_field', { target: 'A5', app: EXCEL })).done, true);
  assert.equal(d.sheet().cells.A5.v, '');
  assert.deepEqual(requests, []);
  // A right-click, a double-click or a label still goes to the screen.
  await d.computer.act('click', { target: 'A1', app: EXCEL, button: 'right' });
  await d.computer.act('click', { target: 'Bold', app: EXCEL });
  assert.ok(requests.length >= 2);
  // What didn't land is said from the sheet, never "the field is still empty".
  const run = d.computer.sheets.run;
  d.computer.sheets.run = async (script, args) => (args[0] === 'set' ? (await run(script, args)).replace(/^r\ts.*$/m, 'r\tsCoffeeB4') : run(script, args));
  const wrong = await d.computer.act('type_text', { text: 'B4 value', target: 'B4', app: EXCEL });
  assert.equal(wrong.done, false);
  assert.match(wrong.note, /NOT confirmed: B4 now holds "CoffeeB4", read back from the sheet/);
  assert.doesNotMatch(JSON.stringify(wrong), /still empty/);
  d.computer.sheets.run = run;
  // In another app "A1" is a label like any other.
  d.computer.end('done');
  const actions = logged().filter((e) => e.event === 'action' && e.via === 'script');
  assert.equal(actions.length, 9);
  assert.equal(JSON.stringify(actions).includes('Hello'), false, 'and the log has no typed text for a cell');
});

test('the fallback: macOS has not allowed it, so the step goes by keys, and the log says why', async () => {
  fs.rmSync(logFile, { force: true });
  const d = driving({ cells: { A5: 'Total' }, sel: 'A5' });
  d.sheet().notAllowed = true;
  const typed = await d.computer.act('type_text', { text: 'Hello', target: 'A1', app: EXCEL });
  assert.deepEqual([typed.done, typed.via], [true, 'keys'], 'still done, the old way');
  assert.equal(d.sheet().cells.A1.v, 'Hello');
  assert.equal((await d.computer.act('click', { target: 'B2', app: EXCEL })).done, true);
  assert.deepEqual(logged().filter((e) => e.event === 'sheet_fallback').map((e) => [e.action, e.why]), [['type_text', 'not_allowed'], ['click', 'not_allowed']]);
  // The tool itself says which Settings pane fixes it.
  assert.match((await d.computer.sheet('write', { cell: 'A1', value: 'x', app: EXCEL })).message, /Privacy & Security, Automation/);
  // Any other trouble (no answer in time) is an error, not a silent switch to keys.
  d.sheet().notAllowed = false;
  d.sheet().slow = true;
  const late = await d.computer.act('type_text', { text: 'Later', target: 'A2', app: EXCEL });
  assert.equal(late.error, 'timeout');
  assert.equal(d.sheet().cells.A2, undefined);
  d.computer.end('done');
  // No adapter at all: as before (the Mac app goes to the cell itself).
  const old = driving({ sel: 'A5' }, { adapter: false });
  assert.equal((await old.computer.act('type_text', { text: 'Hello', target: 'A1', app: EXCEL })).via, 'keys');
  old.computer.end('done');
  // Show-me mode never writes.
  on({ driveMode: 'show' });
  const show = driving();
  on({ driveMode: 'show' });
  assert.equal((await show.computer.act('type_text', { text: 'Hello', target: 'C7', app: EXCEL })).shown, true);
  assert.equal(show.sheet().cells.C7, undefined);
  show.computer.end('done');
  on();
});

test('Cmd+B on a selection is verified by reading the bold state, whatever the screen showed', async () => {
  // A Mac app that sees nothing change on screen after the keys (Oct 3: "bold could not be confirmed").
  class Unseeing extends SimBridge {
    act(p) {
      const r = super.act(p);
      return p.action === 'press_keys' ? { ...r, verified: false, changes: [] } : r;
    }
  }
  const blind = (w) => new Unseeing(w, 'v2');
  const d = driving({ cells: { A1: 'Item', B1: 'Qty' }, sel: 'A1' }, { bridge: blind });
  await d.computer.act('click', { target: 'A1:B1', app: EXCEL });
  const bold = await d.computer.act('press_keys', { keys: 'cmd+b', app: EXCEL });
  assert.deepEqual([bold.done, bold.verified], [true, true]);
  assert.deepEqual([d.sheet().cells.A1.bold, d.sheet().cells.B1.bold], [true, true]);
  assert.deepEqual(logged().filter((e) => e.keys === 'cmd+b').at(-1).changes, ['format']);
  // Without the adapter the same step can't be confirmed.
  const old = driving({ cells: { A1: 'Item' }, sel: 'A1' }, { bridge: blind, adapter: false });
  assert.equal((await old.computer.act('press_keys', { keys: 'cmd+b', app: EXCEL })).done, false);
  old.computer.end('done');
  // Keys that changed nothing in the sheet are not done, even if the screen flickered.
  const none = driving({ cells: { A1: 'Item' }, sel: 'A1' });
  const box = [...none.w.els.values()].find((e) => e.title === 'Name Box');
  none.w.focus(box);
  const no = await none.computer.act('press_keys', { keys: 'cmd+b', app: EXCEL });
  assert.equal(no.done, false);
  assert.equal(none.sheet().cells.A1.bold, false);
  none.computer.end('done');
  d.computer.end('done');
});

/** A lesson over the simulated sheet, read through the adapter, on a fake clock. */
function lesson(steps, o = {}) {
  const a = excel(o);
  let t = 1_000_000;
  const said = [], reports = [], notes = [];
  // What the Mac app's state shows of a spreadsheet: the app and window, no cells.
  const base = { cannotSee: CELL_KINDS, async snapshot() { return { cells: {}, labels: {}, ui: { app: EXCEL, window: 'Book1', focus: {} } }; } };
  const adapter = sheetAdapter(base, a.sheets);
  const s = new TeachSession({ adapter, say: (x) => said.push(x), report: (r) => reports.push(r), log: (e) => notes.push(e.kind), now: () => t, autoPoll: false });
  s.start({ title: 'A table', steps });
  return {
    ...a, s, said, reports, notes, adapter,
    async tick(ms = TEACH_POLL_MS) { t += ms; await s.poll(); },
    async settle() { for (let k = 0; k < 4; k++) { t += TEACH_POLL_MS; await s.poll(); } },
    last: () => said.at(-1),
  };
}

test('lessons see cells: cell_value, selection and bold pass by themselves in Excel', async () => {
  assert.deepEqual(SHEET_SEEN, ['selection', 'cell_value', 'bold']);
  const h = lesson([
    { say: 'Click cell A1.', target: 'A1', check: { kind: 'selection', cell: 'A1' } },
    { say: 'Type Hello, then press Return.', check: { kind: 'cell_value', cell: 'A1', equals: 'Hello' } },
    { say: 'Press Command B.', check: { kind: 'bold', range: 'A1' } },
  ], { sel: 'C3' });
  await h.tick(0);
  assert.equal(h.last(), 'Click cell A1.', 'no "tell me when you\'ve done it": Echo can see it');
  assert.deepEqual(h.adapter.cannotSee, CELL_KINDS.filter((k) => !SHEET_SEEN.includes(k)));
  await h.tick();
  assert.equal(h.said.length, 1);
  h.w.select(EXCEL, 'A1');
  await h.settle();
  assert.deepEqual(h.said.slice(-2), ['A1 is selected.', 'Type Hello, then press Return.']);
  // The user is typing in the cell: Excel refuses scripts, Echo stays quiet and sends nothing.
  h.sheet().editing = true;
  await h.tick(); await h.tick();
  assert.equal(h.said.length, 3);
  assert.equal(h.escapes.length, 0, 'never Escape while the user types');
  h.sheet().editing = false;
  h.w.enter(EXCEL, 'Hello');
  await h.settle();
  assert.equal(h.last(), 'Press Command B.');
  // Bold is only read when a step in view checks for it.
  assert.ok(h.sim.calls.some((c) => c.args[0] === 'read' && c.args[2] === '1'));
  h.w.cell(EXCEL).bold = true;
  await h.settle();
  assert.equal(h.s.active, false, 'the lesson finished by itself');
  assert.equal(h.reports.at(-1).kind, 'finished');
});

test('lessons keep "close enough": the right text in another cell passes with "That works too"', async () => {
  const h = lesson([
    { say: 'Click cell B1.', target: 'B1', check: { kind: 'selection', cell: 'B1' } },
    { say: 'Type Hello into cell A1.', target: 'A1', check: { kind: 'cell_value', cell: 'A1', equals: 'Hello' } },
    { say: 'Click cell A1.', target: 'A1', check: { kind: 'selection', cell: 'A1' } },
  ], { sel: 'C3' });
  await h.tick(0);
  h.w.select(EXCEL, 'B1');
  await h.settle();
  assert.equal(h.last(), 'Type Hello into cell A1.');
  h.w.select(EXCEL, 'A5');
  h.w.enter(EXCEL, 'Hello');
  await h.tick(); await h.tick();
  await h.s.hear('done');
  assert.equal(h.last(), 'I can see Hello in A5, not A1. That works too.');
  assert.ok(h.notes.includes('close_enough'));
  // A typo is corrected by what the cell really holds.
  const typo = lesson([
    { say: 'Click cell A1.', target: 'A1', check: { kind: 'selection', cell: 'A1' } },
    { say: 'Type Coffee.', check: { kind: 'cell_value', cell: 'A1', equals: 'Coffee' } },
  ], { sel: 'C3' });
  await typo.tick(0);
  typo.w.select(EXCEL, 'A1');
  await typo.settle();
  typo.w.enter(EXCEL, 'Cofee');
  await typo.tick(); await typo.tick();
  assert.equal(typo.last(), 'Almost. It says Cofee. Try Coffee.');
});

test('lessons where the sheet can\'t be read are as before: Echo asks the user to say when it\'s done', async () => {
  const h = lesson([{ say: 'Type Hello into cell A1.', target: 'A1', check: { kind: 'cell_value', cell: 'A1', equals: 'Hello' } }, { say: 'Click B2.', check: { kind: 'selection', cell: 'B2' } }], { sel: 'C3' });
  h.sheet().notAllowed = true;
  await h.tick(0);
  assert.equal(h.last(), 'Type Hello into cell A1. Tell me when you\'ve done it.');
  assert.deepEqual(h.adapter.cannotSee, CELL_KINDS);
  // Another app in front: its "cells" are not looked for at all.
  const w = new World();
  excelScene(w);
  const sim = simSheets(w);
  const other = sheetAdapter({ cannotSee: CELL_KINDS, async snapshot() { return { cells: {}, ui: { app: 'Notes' } }; } }, new Sheets({ run: sim.run }));
  assert.deepEqual(await other.snapshot({ labels: [] }), { cells: {}, ui: { app: 'Notes' } });
  assert.equal(sim.calls.length, 0);
  assert.deepEqual(other.cannotSee, CELL_KINDS);
  // The lesson's app, named, wins over what is in front.
  const named = sheetAdapter({ cannotSee: CELL_KINDS, async snapshot() { return { cells: {}, ui: { app: 'Echo' } }; } }, new Sheets({ run: sim.run }), { app: EXCEL });
  assert.equal((await named.snapshot({ labels: [] })).selection, 'A1');
  // A lesson started by the assistant gets this adapter whenever Echo has the spreadsheet scripting.
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', 'lib/computer.js'), 'utf8'), /const adapter = this\.sheets \? sheetAdapter\(ui, this\.sheets, \{ app \}\) : ui;/);
  // A screen Echo can't see at all stays an error.
  const unseen = sheetAdapter({ async snapshot() { return { cells: {}, error: 'no state' }; } }, new Sheets({ run: sim.run }));
  assert.equal((await unseen.snapshot({ labels: [] })).error, 'no state');
});

test('Numbers: the same interface; bold can\'t be set from a script, so it says how', async () => {
  const w = new World();
  w.app(NUMBERS, { window: 'Budget', sheet: { sel: 'B2', name: 'Sheet 1', cells: { A1: { v: 'Item', bold: true }, A2: { v: 'Coffee', bold: false } } } });
  const sim = simSheets(w);
  const n = /** @type {any} */ (new Sheets({ run: sim.run }).in('numbers'));
  assert.deepEqual((await n.where()).selection, 'B2');
  assert.equal((await n.write('B2', 3)).verified, true);
  assert.deepEqual((await n.read(undefined, { bold: true })).bold, [[true, false], [false, false]]);
  const f = await n.format('A2', { bold: true });
  assert.equal(f.error, 'unsupported');
  assert.match(f.message, /Select the cells \(sheet_select\), then use the keyboard: press_keys cmd\+b/);
  assert.equal((await n.format('A1')).bold, true, 'reading it works');
  // In Numbers a value that starts with "=" always becomes a formula: said, not hidden.
  const lit = await n.write('C1', '=A1');
  assert.equal(lit.verified, false);
  assert.deepEqual(lit.wrong.map((x) => x.cell), ['C1']);
  assert.deepEqual(sim.calls.filter((c) => c.script !== SCRIPTS.running).every((c) => c.script === SCRIPTS[NUMBERS]), true);
  // The real script reads bold from the font's name and grows the table for a block past its edge.
  assert.match(SCRIPTS[NUMBERS], /font name of every cell of \|theRange\|/);
  assert.match(SCRIPTS[NUMBERS], /set row count of \|theTable\| to/);
  assert.match(SCRIPTS[NUMBERS], /first table of \|theSheet\| whose class of selection range is range/);
});

test('golden tasks: a 3x3 block with a bold header row takes at most 3 tool calls', async () => {
  on();
  const task = SHEET_TASKS.find((t) => t.id === 'excel-fill-block-bold-header');
  assert.ok(task);
  const r = await runTask(task, 'v2', { logFile });
  assert.equal(r.success, true);
  assert.equal(r.falseSuccess, false);
  assert.ok(r.steps <= 3, `${r.steps} tool calls`);
  for (const id of ['excel-type-bold', 'excel-write-while-editing', 'excel-row-under-headers']) {
    const t = SHEET_TASKS.find((x) => x.id === id);
    assert.ok(t, id);
    const res = await runTask(t, 'v2', { logFile });
    assert.deepEqual([res.success, res.falseSuccess], [true, false], id);
    assert.ok(res.steps <= 2, `${id}: ${res.steps} tool calls`);
  }
  // The golden run (scripts/golden.js) covers the 60 tasks, the 4 sheet tasks and the 4 stress tasks.
  assert.equal(ALL_TASKS.length + SHEET_TASKS.length + STRESS_TASKS.length, 68);
});
