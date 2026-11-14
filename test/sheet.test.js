// Spreadsheets (Oct 3): Echo was asked to type one word into A1 of an Excel sheet and make it bold.
// It took 18 steps: the grid refused typing (focus_guard), the Formula Bar took "Hello" after the
// "hello" that was there, "replace" there left the old text and still said verified, and the bold
// couldn't be confirmed. These replay that session on the simulated Mac (lib/evalsim.js excelScene,
// which behaves as Excel did) through the real ComputerUse, and check the server's side with a fake
// Mac app. Nothing touches a real screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('sheet');
const { ComputerUse, cleanAnswer } = await import('../lib/computer.js');
const { ScreenBridge } = await import('../lib/screen.js');
const { saveSettings, setFixedForTest } = await import('../lib/settings.js');
const { World, SimBridge, excelScene, notesScene, cellRef, typedExactly, alreadyHolds } = await import('../lib/evalsim.js');
const { runTask, SHEET_TASKS, ALL_TASKS, STRESS_TASKS } = await import('../lib/evalsuite.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const on = () => (setFixedForTest({ screenAware: false }), saveSettings({ computerUse: true, pointer: true, driveMode: 'do' }));
const EXCEL = 'Microsoft Excel';

/** Excel on the simulated Mac, driven by the real ComputerUse. */
function excel(o = {}) {
  on();
  const w = new World();
  excelScene(w, o);
  const computer = new ComputerUse({ bridge: /** @type {any} */ (new SimBridge(w, 'v2')), logFile, focusRetryMs: 0, confirmSettleMs: 0, expectMs: 50, settleMs: 0 });
  const sheet = () => w.apps.get(EXCEL).sheet;
  const type = (text, into, extra = {}) => computer.act('type_text', { text, target: into, app: EXCEL, ...extra });
  return { w, computer, sheet, type };
}

test('the grid takes typing: what is typed replaces what the selected cell holds, and is read back', async () => {
  const { computer, sheet, type } = excel({ cells: { A1: 'old' }, sel: 'A1' });
  const r = await type('Hello', 'Content Area');
  assert.equal(r.error, undefined, 'no focus_guard: the grid is somewhere you can type');
  assert.equal(r.done, true);
  assert.equal(r.verified, true);
  assert.equal(sheet().cells.A1.v, 'Hello', 'replaced, as when a person types in a cell');
  assert.equal(sheet().sel, 'A1', 'and the cell stays selected');
  // Adding to a cell only when asked for.
  const more = await type(' there', 'Content Area', { mode: 'append' });
  assert.equal(more.done, true);
  assert.equal(sheet().cells.A1.v, 'Hello there');
  // With nothing named: the grid has the keyboard, so the selected cell takes it.
  const bare = await computer.act('type_text', { text: 'Again', app: EXCEL });
  assert.equal(bare.done, true);
  assert.equal(sheet().cells.A1.v, 'Again');
  computer.end('done');
});

test('going to a cell is one step: a cell reference as the target of a click or of typing', async () => {
  const { computer, sheet, type } = excel({ cells: { A5: 'Total' }, sel: 'A5' });
  const click = await computer.act('click', { target: 'B12', app: EXCEL });
  assert.equal(click.done, true);
  assert.equal(click.verified, true);
  assert.equal(sheet().sel, 'B12');
  const typed = await type('Hello', 'cell a1');
  assert.equal(typed.done, true);
  assert.equal(typed.step, 2, 'one step each: no Name Box click, no Return');
  assert.equal(sheet().sel, 'A1');
  assert.equal(sheet().cells.A1.v, 'Hello');
  assert.equal(sheet().cells.A5.v, 'Total', 'the cell that was selected before is untouched');
  assert.equal(sheet().cells.B12?.v || '', '');
  const cleared = await computer.act('clear_field', { target: 'A5', app: EXCEL });
  assert.equal(cleared.done, true);
  assert.equal(sheet().cells.A5.v, '');
  // A label that is not a cell reference is still looked up by name.
  const bold = await computer.act('click', { target: 'Bold', app: EXCEL });
  assert.equal(bold.found, undefined);
  assert.equal(sheet().sel, 'A5');
  computer.end('done');
});

test('cell references: A1, b12, AA3, "cell A1"; never an ordinary label', () => {
  assert.equal(cellRef('A1'), 'A1');
  assert.equal(cellRef('b12'), 'B12');
  assert.equal(cellRef('AA3'), 'AA3');
  assert.equal(cellRef('cell A1'), 'A1');
  assert.equal(cellRef('$C$4'), 'C4');
  for (const no of ['Save', 'A', '12', 'A0', 'Q4 results', 'A1:B2', 'ABCD1', 'XFE1', 'Name Box', '']) assert.equal(cellRef(no), '', no);
  // In another app "A1" is a label like any other.
  on();
  const w = new World();
  notesScene(w);
  const bridge = new SimBridge(w, 'v2');
  assert.equal(bridge.cellTarget('Notes', { action: 'click', target: 'A1' }), '');
  // A right-click or a double-click needs the cell itself, so it is looked up on screen.
  const x = new World();
  excelScene(x);
  const xb = new SimBridge(x, 'v2');
  assert.equal(xb.cellTarget(EXCEL, { action: 'click', target: 'A1' }), 'A1');
  assert.equal(xb.cellTarget(EXCEL, { action: 'click', target: 'A1', button: 'right' }), '');
  assert.equal(xb.cellTarget(EXCEL, { action: 'click', target: 'A1', clicks: 2 }), '');
});

test('nothing is typed into a field that already says it: the assistant is told and decides', async () => {
  const { computer, sheet, type } = excel({ cells: { A1: 'hello' }, sel: 'A1' });
  fs.rmSync(logFile, { force: true });
  const r = await type('Hello', 'A1');
  assert.equal(r.done, false, 'other capitals: not done, not typed');
  assert.equal(r.already, true);
  assert.equal(r.holds, 'hello');
  assert.match(r.note, /Nothing was typed: it already says "hello"; you asked for "Hello"\./);
  assert.match(r.note, /mode "replace"/);
  assert.equal(sheet().cells.A1.v, 'hello', 'never "helloHello"');
  // The Formula Bar the same (the session's step 3).
  const bar = await type('Hello', 'Formula Bar');
  assert.equal(bar.already, true);
  assert.equal(sheet().cells.A1.v, 'hello');
  // The assistant decides to fix the capitals: an asked-for replace types.
  const fixed = await type('Hello', 'A1', { mode: 'replace' });
  assert.equal(fixed.done, true);
  assert.equal(fixed.verified, true);
  assert.equal(sheet().cells.A1.v, 'Hello');
  // Exactly what was asked for: done, and nothing typed.
  const same = await type('Hello', 'A1');
  assert.equal(same.done, true);
  assert.equal(same.already, true);
  assert.match(same.note, /^Nothing was typed: it already says "Hello"\.$/);
  assert.equal(sheet().cells.A1.v, 'Hello');
  computer.end('done');
  // What the cell held is for the assistant, never for the log.
  const log = fs.readFileSync(logFile, 'utf8');
  assert.doesNotMatch(log, /"holds"/);
  const entries = log.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.event === 'action' && e.already === 'case' && e.verified === false));
});

test('replace must replace: a field that cannot be emptied fails the step, and wrong text is never verified', async () => {
  // Excel's formula bar: ⌘A selects the cells, not its text, and here its value can't be set either.
  const stuck = excel({ cells: { A1: 'helloHello' }, sel: 'A1' });
  const r = await stuck.type('Hello', 'Formula Bar', { mode: 'replace' });
  assert.equal(r.error, 'cant_clear');
  assert.equal(r.done, false);
  assert.match(r.message, /Couldn't empty that field first, so nothing was typed over it\./);
  assert.match(r.message, /Don't type it again in append mode/);
  assert.equal(stuck.sheet().cells.A1.v, 'helloHello', 'left as it was: no "HellohelloHello"');
  stuck.computer.end('done');
  // Where the value can be set through Accessibility, it is emptied that way and then typed.
  const ok = excel({ cells: { A1: 'helloHello' }, sel: 'A1', barSettable: true });
  const done = await ok.type('Hello', 'Formula Bar', { mode: 'replace' });
  assert.equal(done.done, true);
  assert.equal(done.verified, true);
  assert.equal(ok.sheet().cells.A1.v, 'Hello');
  ok.computer.end('done');
  // The exact check itself (VerifyMath.typed): the session's result is not "Hello".
  assert.equal(typedExactly('Hello', 'HellohelloHello', { replaced: true }), false);
  assert.equal(typedExactly('Hello', 'Hello', { replaced: true }), true);
  assert.equal(typedExactly('Hello', 'helloHello', { before: 'hello' }), true, 'adding: the field grew by the text');
  assert.equal(typedExactly('Hello', 'Hello', { before: 'Hello' }), false, 'adding: it was there already, nothing landed');
  assert.equal(alreadyHolds('Hello', 'hello', false), 'case');
  assert.equal(alreadyHolds('Hello', 'hello', true), '');
  assert.equal(alreadyHolds('Hello', ' Hello ', true), 'same');
});

test('the server side: a wrong result from the Mac app is not done, whatever else changed', async () => {
  on();
  const bridge = new ScreenBridge({ logFile: path.join(dirs.data, 'screen-log.jsonl'), timeoutMs: 500, browserTimeoutMs: 500 });
  bridge.nativeClients = () => 1;
  let answer = {};
  bridge.on('request', (r) => {
    const p = r.params;
    if (r.kind === 'act' && p.step === 'resolve') setImmediate(() => bridge.deliver(r.id, { ok: true, found: true, token: 't', label: 'Formula Bar', role: 'AXTextArea', app: EXCEL, window: 'Book1' }));
    else if (r.kind === 'act' && p.step === 'do') setImmediate(() => bridge.deliver(r.id, { ok: true, via: 'keys', app: EXCEL, window: 'Book1', ...answer }));
  });
  const c = new ComputerUse({ bridge, logFile });
  // The Mac app read the field back and it isn't the text: not done, and the assistant sees what it holds.
  answer = { verified: false, changes: ['value', 'content'], observed: { value: 'HellohelloHello' } };
  const wrong = await c.act('type_text', { target: 'Formula Bar', text: 'Hello', mode: 'replace' });
  assert.equal(wrong.done, false);
  assert.match(wrong.note, /NOT confirmed: the text isn't in the field \(the field now holds "HellohelloHello"\)/);
  // "Already there" from the Mac app: bounded, and passed on.
  assert.equal(cleanAnswer({ ok: true, already: 'case', holds: 'x'.repeat(500) }).holds.length, 160);
  assert.equal(cleanAnswer({ ok: true, already: 'whatever', holds: 'x' }).already, undefined);
  assert.equal(cleanAnswer({ ok: true, holds: 'x' }).holds, undefined);
  answer = { already: 'case', holds: 'hello', verified: false, changes: [] };
  const held = await c.act('type_text', { target: 'Formula Bar', text: 'Hello' });
  assert.equal(held.done, false);
  assert.equal(held.holds, 'hello');
  // A cell that couldn't be selected: nothing was done, and the message says which is selected.
  answer = { ok: false, error: 'cell', message: "Couldn't select cell A1 (B2 is selected), so nothing was done there." };
  const cell = await c.act('type_text', { target: 'A1', text: 'Hello' });
  assert.equal(cell.error, 'cell');
  assert.match(cell.message, /B2 is selected/);
  c.end('done');
});

test('bold on a cell is confirmed by the ribbon\'s Bold button', async () => {
  const { w, computer, sheet } = excel({ cells: { A1: 'Hello' }, sel: 'A1' });
  const r = await computer.act('press_keys', { keys: 'cmd+b', app: EXCEL });
  assert.equal(sheet().cells.A1.bold, true);
  assert.equal(r.done, true);
  assert.equal(r.verified, true, 'seen on the Bold button, though nothing else on screen changed');
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.filter((e) => e.event === 'action' && e.keys === 'cmd+b').at(-1).changes, ['format']);
  // With the keyboard somewhere else nothing turns bold, and Echo says it can't confirm it.
  const box = [...w.els.values()].find((e) => e.title === 'Name Box');
  w.focus(box);
  const no = await computer.act('press_keys', { keys: 'cmd+b', app: EXCEL });
  assert.equal(no.done, false);
  assert.equal(sheet().cells.A1.bold, true, 'unchanged');
  computer.end('done');
});

test('golden task: a word into A1 of a sheet with text in A5, then bold, in at most 4 actions', async () => {
  on();
  const task = SHEET_TASKS.find((t) => t.id === 'excel-type-bold');
  assert.ok(task);
  const r = await runTask(task, 'v2', { logFile });
  assert.equal(r.success, true);
  assert.equal(r.falseSuccess, false);
  assert.ok(r.steps <= 4, `${r.steps} actions`);
  // The way it went on Oct 3 (Name Box, Return, the grid, the Formula Bar) still gets there, and
  // every step of it now works: nothing is refused and nothing is typed twice.
  const session = { ...task, v0: [
    { tool: 'click', args: { target: 'Name Box', app: EXCEL } },
    { tool: 'type_text', args: { text: 'A1', mode: 'replace', app: EXCEL } },
    { tool: 'press_keys', args: { keys: 'return', app: EXCEL } },
    { tool: 'type_text', args: { text: 'Hello', into: 'Content Area', app: EXCEL } },
    { tool: 'press_keys', args: { keys: 'cmd+b', app: EXCEL } },
  ] };
  const old = await runTask(session, 'v2', { logFile });
  assert.equal(old.success, true);
  // The golden run (scripts/golden.js) covers the 60 tasks, the sheet tasks and the 4 stress tasks.
  assert.equal(ALL_TASKS.length + SHEET_TASKS.length + STRESS_TASKS.length, 68);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts/golden.js'), 'utf8'), /const tasks = \[\.\.\.ALL_TASKS, \.\.\.SHEET_TASKS, \.\.\.STRESS_TASKS\];/);
});

test('the assistant is told: give a cell reference, Echo goes there itself', () => {
  const tools = fs.readFileSync(path.join(import.meta.dirname, '..', 'lib/tools/computer.js'), 'utf8');
  assert.match(tools, /In Excel or Numbers, give a cell reference as the target \("A1"\); Echo goes there itself\./);
  assert.match(tools, /In Excel or Numbers, give a cell reference \("A1"\) and Echo goes there itself/);
  assert.doesNotMatch(tools, /click the Name Box, type the cell/);
});

test('the Mac app: the grid takes typing, a cell is gone to and read back, a field is seen to be empty before it is typed over', () => {
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', 'macos/Sources', f), 'utf8');
  const driver = src('Driver.swift');
  const math = src('PointMath.swift');
  // A. The focus guard accepts a spreadsheet's grid, and never clicks in the middle of it.
  assert.match(driver, /private func takesTyping\(_ el: AXUIElement\) -> Bool \{ isEditable\(el\) \|\| gridOf\(el\) != nil \}/);
  assert.match(driver, /guard let f = current\(\), takesTyping\(f\) else \{/);
  assert.match(driver, /if toGrid, let f = current\(\), gridOf\(f\) != nil \{ return done\(f, nil\) \}/);
  assert.match(driver, /if self\.gridOf\(focus\) != nil \{\n\s+return self\.typeInCell\(/);
  assert.match(math, /static let gridRoles: Set<String> = \["AXLayoutArea", "AXTable", "AXCell", "AXLayoutItem"\]/);
  // Adding to a cell opens it for editing first; the entry is entered with the cell kept selected.
  const cellTyping = driver.split('private func typeInCell(')[1].split('\n  }\n')[0];
  assert.match(cellTyping, /if append, [^\n]*SheetMath\.editKeys\(app\)/);
  assert.match(cellTyping, /SheetMath\.commitKeys\(app\)/);
  assert.match(cellTyping, /VerifyMath\.typed\(entry, into: value, replaced: !append \|\| many/);
  // B. A cell reference resolves without touching the screen; the step goes there and reads it back.
  assert.match(driver, /if let app, SheetMath\.isSheet\(app\.bundleIdentifier\), let cell = SheetMath\.cellRef\(target\), plainClick \|\| wantsField \{/);
  const resolve = driver.split('private func resolve(_ p: [String: Any], in app')[1].split('private func verb(')[0];
  assert.doesNotMatch(resolve, /postClick|postKey|postText/, 'finding a target never acts');
  const go = driver.split('private func goToCell(')[1].split('\n  }\n')[0];
  assert.match(go, /sheetParts\(pid\)\[\.nameBox\]/);
  assert.match(go, /SheetMath\.goToKeys\(app\)/);
  assert.match(go, /if now == cell \{ return done\(nil\) \}/);
  assert.match(driver, /out\["verified"\] = selected == cell \|\| \(selected == nil && !changes\.isEmpty\)/);
  // C. Replace: emptied and seen to be empty, or the step fails; never ⌘A in a spreadsheet.
  assert.doesNotMatch(driver, /private func selectAll\(/);
  const clear = driver.split('private func clearField(')[1].split('\n  }\n')[0];
  assert.match(clear, /ClearMath\.plan\(sheet: sheet, web: inWebPage\(el\)/);
  assert.match(clear, /guard i < ways\.count else \{ return done\(cant\) \}/);
  assert.match(clear, /guard ClearMath\.mayDelete\(sheet: sheet, selected: selected, count: count\) else \{ return attempt\(i \+ 1\) \}/);
  assert.match(driver, /self\.clearField\(focus, started: started\) \{ problem in\n\s+if let problem \{ return answer\(problem\) \}\n\s+typeIt\(\)/);
  assert.match(math, /if !sheet \{ ways\.append\(\.selectAll\) \}/);
  // D. It already says that: nothing is typed.
  assert.match(driver, /VerifyMath\.already\(text, in: held, replace: replace\), holds != \.no \{\n\s+return answer\(self\.alreadyThere\(/);
  // E. Bold in a spreadsheet: the control that shows it is read before and after the keys.
  assert.match(driver, /let formatBefore = format\.flatMap \{ formatState\(r\.pid, \$0\) \}\n\s+postKey\(code, flags: flags\)/);
  assert.match(driver, /now != was \{ changes\.append\("format"\) \}/);
});
