// Big writes and sample data in a spreadsheet. On Oct 4 the user asked for "a hundred lines of
// sample data": sheet_write refused it three times as too_big (505, 455, then 305 cells; the
// limit was 200) until the assistant split it by hand, the assistant had spent 35 seconds writing
// the rows out itself, and then Echo asked for a yes before typing "the made-up dates", because
// the read-back rule took the "hundred" in the request to mean the user had dictated numbers.
// Here the scripts are answered by the simulated Mac's sheet (lib/evalsim.js); nothing touches a
// real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('sheetbig');
const { Sheets, EXCEL, NUMBERS, WRITE_MAX, fillRows } = await import('../lib/sheets.js');
const { World, SimBridge, excelScene, simSheets } = await import('../lib/evalsim.js');
const { ComputerUse, dictated } = await import('../lib/computer.js');
const { SHEET_OVERWRITE_MAX } = await import('../lib/policy.ts');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function excel(o = {}) {
  const w = new World();
  excelScene(w, o);
  const sim = simSheets(w);
  const sheets = new Sheets({ run: sim.run });
  return { w, sim, x: /** @type {NonNullable<ReturnType<typeof sheets.in>>} */ (sheets.in(EXCEL)), sheet: () => w.apps.get(EXCEL).sheet };
}

function driving(o = {}) {
  (setFixedForTest({ screenAware: false }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do' }));
  const w = new World();
  excelScene(w, o);
  const sim = simSheets(w);
  const computer = new ComputerUse({ bridge: /** @type {any} */ (new SimBridge(w, 'v2')), sheets: new Sheets({ run: sim.run }), logFile, focusRetryMs: 0, confirmSettleMs: 0, expectMs: 50, settleMs: 0 });
  return { w, sim, computer, sheet: () => w.apps.get(EXCEL).sheet };
}

/** 100 rows by 5 columns, with a header row: the 505 cells of Oct 4. */
const block = () => [['Id', 'Name', 'Region', 'Amount', 'Date'], ...Array.from({ length: 100 }, (_, i) => [i + 1, `Customer ${i + 1}`, i % 2 ? 'North' : 'South', 10.5 + i, `2026-03-${String((i % 28) + 1).padStart(2, '0')}`])];
const sets = (sim) => sim.calls.filter((c) => c.args[0] === 'set');

test('a 100 by 5 block is one write: sent in parts of whole rows, every cell read back, one result', async () => {
  const { sim, x, sheet } = excel();
  const rows = block();
  const r = await x.writeMany('A1', rows);
  assert.equal(r.error, undefined, JSON.stringify(r).slice(0, 200));
  assert.deepEqual([r.range, r.cells, r.verified, r.overwrote, r.wrong], ['A1:E101', 505, true, 0, undefined]);
  assert.deepEqual(r.rows, rows, 'what the cells hold now, all of it');
  assert.deepEqual([sheet().cells.A1.v, sheet().cells.B101.v, sheet().cells.D51.v, sheet().cells.E101.v], ['Id', 'Customer 100', 59.5, '2026-03-16']);
  // No script call sets more than 200 cells, the parts are whole rows, and together they are the block.
  const parts = sets(sim);
  assert.deepEqual(parts.map((c) => c.args[1]), ['A1:E40', 'A41:E80', 'A81:E101']);
  assert.ok(parts.every((c) => Number(c.args[3]) * Number(c.args[4]) <= 200));
  // After the first part the rest must be the same document and sheet.
  assert.deepEqual(parts.map((c) => c.args.slice(6, 8)), [['', ''], ['Book1', 'Sheet1'], ['Book1', 'Sheet1']]);
  // Values still go in as arguments only: the script's text is the one fixed script.
  assert.ok(parts.every((c) => !c.script.includes('Customer 100')));
  // 2,000 cells and more go the same way.
  const big = excel();
  const wide = Array.from({ length: 300 }, (_, i) => Array.from({ length: 8 }, (_, j) => i * 8 + j));
  const b = await big.x.writeMany('B2', wide);
  assert.deepEqual([b.range, b.cells, b.verified], ['B2:I301', 2400, true]);
  assert.equal(big.sheet().cells.I301.v, 2399);
});

test('undo puts the whole block back, whatever it replaced', async () => {
  const { x, sheet } = excel({ cells: { A1: 'Old header', C50: 7, E101: 'last' } });
  sheet().cells.D60 = { v: 0, f: '=C50*2', bold: false };
  const r = await x.writeMany('A1', block(), { maxOverwrite: Infinity });
  assert.deepEqual([r.verified, r.overwrote], [true, 4]);
  const u = await x.undo();
  assert.deepEqual([u.range, u.restored, u.verified], ['A1:E101', 505, true]);
  assert.deepEqual([sheet().cells.A1.v, sheet().cells.C50.v, sheet().cells.E101.v, sheet().cells.D60.f], ['Old header', 7, 'last', '=C50*2']);
  const left = Object.entries(sheet().cells).filter(([, c]) => c.v !== '' && c.v !== undefined).map(([k]) => k).sort();
  assert.deepEqual(left, ['A1', 'C50', 'D60', 'E101'], 'nothing of the block is left');
  assert.equal((await x.undo()).error, 'nothing', 'it was one write, so one undo');
});

test('over the limit is refused in plain words before anything reaches the app', async () => {
  const { sim, x } = excel();
  const r = await x.writeMany('A1', Array.from({ length: 2001 }, () => Array(10).fill(1)));
  assert.equal(r.error, 'too_big');
  assert.match(r.message, /That is 20010 cells; one write takes at most 20000\./);
  assert.equal(WRITE_MAX, 20000);
  assert.equal(sim.calls.length, 0);
  // Numbers sets a block cell by cell, so it takes less.
  const w = new World();
  excelScene(w);
  const numbers = new Sheets({ run: simSheets(w).run }).in(NUMBERS);
  assert.match((await numbers.writeMany('A1', Array.from({ length: 401 }, () => Array(10).fill(1)))).message, /at most 4000/);
  // The tool says the same, and a fill is counted before a single row is made.
  const d = driving();
  const t = await d.computer.sheet('write', { cell: 'A1', fill: { rows: 5_000_000, columns: [{ kind: 'sequence' }] } });
  assert.deepEqual([t.error, t.done], ['too_big', false]);
  assert.equal(sets(d.sim).length, 0);
});

test('a big write over filled cells asks before any part is written; after the yes it all goes in', async () => {
  const filled = Object.fromEntries(Array.from({ length: SHEET_OVERWRITE_MAX + 5 }, (_, i) => [`B${i + 60}`, `old ${i}`]));
  const { sim, x, sheet } = excel({ cells: filled });
  const ask = await x.writeMany('A1', block(), { maxOverwrite: SHEET_OVERWRITE_MAX });
  assert.deepEqual(ask, { overwrite: SHEET_OVERWRITE_MAX + 5, range: 'A1:E101', doc: 'Book1', sheet: 'Sheet1' });
  assert.equal(sets(sim).length, 0, 'nothing was written');
  assert.equal(sheet().cells.B60.v, 'old 0');
  // A few filled cells don't ask.
  const few = excel({ cells: { B60: 'old' } });
  assert.equal((await few.x.writeMany('A1', block(), { maxOverwrite: SHEET_OVERWRITE_MAX })).overwrote, 1);
  // Through the tool: a card, then the whole write, then one undo.
  const d = driving({ cells: filled });
  const held = await d.computer.sheet('write', { cell: 'A1', rows: block() });
  assert.equal(held.waitingForConfirmation, true, JSON.stringify(held).slice(0, 300));
  assert.equal(sets(d.sim).length, 0, 'no part was written before the yes');
  assert.ok(!d.sheet().cells.A1?.v);
  const yes = await d.computer.confirm(held.confirmId, true, 'window');
  assert.equal(yes.done, true, JSON.stringify(yes).slice(0, 300));
  assert.equal(d.sheet().cells.B101.v, 'Customer 100');
});

test('a part that fails puts back the parts before it: a write is all or nothing', async () => {
  const { sim, x, sheet, w } = excel({ cells: { A1: 'keep' } });
  const run = sim.run;
  let n = 0;
  const sheets = new Sheets({ run: async (script, args) => {
    // The second part of the block times out.
    if (args[0] === 'set' && ++n === 2) throw Object.assign(new Error('timed out'), { killed: true });
    return run(script, args);
  } });
  const y = /** @type {any} */ (sheets.in(EXCEL));
  const r = await y.writeMany('A1', block(), { maxOverwrite: Infinity });
  assert.equal(r.error, 'timeout');
  assert.match(r.message, /the rows already written were put back/);
  assert.equal(sheet().cells.A1.v, 'keep');
  assert.equal(sheet().cells.B40.v, '', 'the first part is gone again');
  assert.equal((await y.undo()).error, 'nothing');
  // Another sheet came to the front part way: nothing can be put back there, so the write stays undoable.
  n = -100;
  const z = excel();
  const run2 = z.sim.run;
  let m = 0;
  const moved = /** @type {any} */ (new Sheets({ run: async (script, args) => {
    if (args[0] === 'set' && ++m === 2) z.w.apps.get(EXCEL).window = 'Another book';
    return run2(script, args);
  } }).in(EXCEL));
  const c = await moved.writeMany('A1', block());
  assert.equal(c.error, 'changed');
  assert.equal(c.written, 'A1:E40');
  assert.match(c.message, /sheet_undo puts A1:E40 back/);
  z.w.apps.get(EXCEL).window = 'Book1';
  assert.deepEqual([(await moved.undo()).restored, z.sheet().cells.A1.v], [200, '']);
  void x; void w;
});

test('fill: the same seed makes the same rows, of the shape asked for', async () => {
  const fill = {
    rows: 100, seed: 7, headers: ['Id', 'Name', 'Region', 'Amount', 'Date'],
    columns: [{ kind: 'sequence', start: 1000, step: 5 }, { kind: 'text', prefix: 'Customer ' }, { kind: 'pick', values: ['North', 'South', 'East'] }, { kind: 'number', min: 10, max: 500, decimals: 2 }, { kind: 'date', from: '2026-01-01', to: '2026-01-31' }],
  };
  const a = fillRows(fill), b = fillRows(fill);
  assert.deepEqual(a, b);
  assert.notDeepEqual(fillRows({ ...fill, seed: 8 }), a);
  const rows = /** @type {any[][]} */ (a.rows);
  assert.equal(rows.length, 101);
  assert.ok(rows.every((r) => r.length === 5));
  assert.deepEqual(rows[0], fill.headers);
  assert.deepEqual([rows[1][0], rows[2][0], rows[100][0]], [1000, 1005, 1495]);
  assert.deepEqual([rows[1][1], rows[100][1]], ['Customer 1', 'Customer 100']);
  const data = rows.slice(1);
  assert.deepEqual([...new Set(data.map((r) => r[2]))].sort(), ['East', 'North', 'South']);
  assert.ok(data.every((r) => typeof r[3] === 'number' && r[3] >= 10 && r[3] <= 500 && Number(r[3].toFixed(2)) === r[3]));
  assert.ok(data.every((r) => /^2026-01-(0[1-9]|[12]\d|3[01])$/.test(r[4])));
  assert.ok(new Set(data.map((r) => r[4])).size > 10, 'the days vary');
  // Whole numbers reach both ends; no headers, no header row.
  const whole = /** @type {any[][]} */ (fillRows({ rows: 200, seed: 1, columns: [{ kind: 'number', min: 1, max: 3 }] }).rows);
  assert.deepEqual([whole.length, [...new Set(whole.flat())].sort()], [200, [1, 2, 3]]);
  // What can't be made says why.
  for (const bad of [{}, { rows: 0, columns: [{ kind: 'sequence' }] }, { rows: 3, columns: [] }, { rows: 3, columns: [{ kind: 'formula' }] }, { rows: 3, columns: [{ kind: 'pick', values: [] }] }, { rows: 3, columns: [{ kind: 'date', from: 'soon', to: '2026-01-01' }] }, { rows: 3, columns: [{ kind: 'number', min: 5, max: 1 }] }, { rows: 3, headers: ['a', 'b'], columns: [{ kind: 'sequence' }] }]) {
    assert.equal(/** @type {any} */ (fillRows(bad)).error, 'bad_fill', JSON.stringify(bad));
  }
});

test('"a hundred lines of sample data": one sheet_write with fill, no read-back of made-up dates', async () => {
  const d = driving();
  d.computer.newTurn('add a hundred lines of sample data at the bottom, with emails');
  const fill = {
    rows: 100, seed: 3, headers: ['Order', 'Email', 'Amount', 'Date'],
    columns: [{ kind: 'sequence', start: 100001 }, { kind: 'pick', values: ['kim@example.com', 'ravi@example.com'] }, { kind: 'number', min: 10000, max: 99999 }, { kind: 'date', from: '2026-01-01', to: '2026-12-31' }],
  };
  const r = await d.computer.sheet('write', { cell: 'A1', fill });
  assert.equal(r.needsReadBack, undefined, JSON.stringify(r).slice(0, 300));
  assert.deepEqual([r.done, r.range, r.cells], [true, 'A1:D101', 404]);
  assert.equal(r.firstRow.length, 4);
  assert.equal(r.firstRow[0], 100001);
  assert.deepEqual([d.sheet().cells.A1.v, d.sheet().cells.A101.v], ['Order', 100100]);
  assert.match(String(d.sheet().cells.D101.v), /^2026-\d\d-\d\d$/);
  assert.equal(logged().filter((e) => e.event === 'readback_asked').length, 0);
  // One line in the log for the whole write, with its size and never a cell's contents.
  const line = logged().filter((e) => e.event === 'sheet' && e.tool === 'write').at(-1);
  assert.deepEqual([line.cells, line.ok, line.verified], [404, true, true]);
  assert.ok(!JSON.stringify(logged()).includes('kim@example.com'));
  // "Undo that" takes all of it away.
  assert.equal((await d.computer.sheet('undo', {})).restored, 404);
  assert.equal(d.sheet().cells.A50.v, '');
  // A fill never types a password or a card number either.
  const card = await d.computer.sheet('write', { cell: 'A1', fill: { rows: 2, columns: [{ kind: 'pick', values: [['4111', '1111', '1111', '1111'].join(' ')] }] } });
  assert.equal(card.refused, true);
  // A bad fill is said plainly.
  assert.equal((await d.computer.sheet('write', { cell: 'A1', fill: { rows: 2, columns: [{ kind: 'nope' }] } })).error, 'bad_fill');
});

test('read back only what the user said: invented dates and numbers go in, a dictated number waits', async () => {
  const d = driving();
  // The assistant wrote the rows out itself; the user's words hold a number word and "at".
  d.computer.newTurn('put a hundred lines of sample data at the bottom');
  const invented = await d.computer.sheet('write', { cell: 'A1', rows: [['2026-03-14', 4815162, 'kim@example.com'], ['2026-03-15', 90210, 'ravi@example.com']] });
  assert.equal(invented.needsReadBack, undefined, JSON.stringify(invented));
  assert.equal(invented.done, true);
  assert.equal(logged().filter((e) => e.event === 'readback_asked').length, 0);
  // A number the user dictated is read back before it is typed, in digits or said one by one.
  d.computer.newTurn('put the order number 48151623 in C5');
  const rb = await d.computer.sheet('write', { cell: 'C5', value: 48151623 });
  assert.equal(rb.needsReadBack, true);
  assert.deepEqual(rb.readBack, ['48151623']);
  assert.equal(d.sheet().cells.C5, undefined);
  assert.equal(logged().filter((e) => e.event === 'readback_asked').length, 1);
  // …and typed after Echo read it back and the user said yes.
  d.computer.noteSaid("That's 48151623, right?");
  d.computer.newTurn('yes');
  assert.equal((await d.computer.sheet('write', { cell: 'C5', value: 48151623 })).done, true);
  // The rule itself.
  assert.equal(dictated('555 010 3141', 'call 555-010-3141 for me'), true);
  assert.equal(dictated('02134', 'the zip is oh two one three four'), true);
  assert.equal(dictated('2026-03-14', 'add a hundred rows with dates in 2026'), false);
  assert.equal(dictated('90210', 'add 100 rows, 5 columns'), false);
  assert.equal(dictated('sam.lee@example.com', 'put sam dot lee at example dot com in D2'), true);
  assert.equal(dictated('sam.lee@example.com', 'send it to sam.lee@example.com'), true);
  assert.equal(dictated('kim@example.com', 'add sample emails at the bottom'), false);
  assert.equal(dictated('info@example.com', 'add contact info at the bottom'), false);
  assert.equal(dictated('5550103141', 'my number is five five five oh one oh'), true, 'heard only in part still counts');
});
