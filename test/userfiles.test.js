// Small files written straight for the user (lib/userfiles.js, lib/tools/files.js). Everything
// here happens in a throwaway home folder; `open` is a fake, so nothing is ever opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('userfiles');
const { QuickActions } = await import('../lib/quick.js');
const { UserFiles, TEXT_TYPES, MAX_BYTES, USER_FOLDERS } = await import('../lib/userfiles.js');
const { Dispatcher, READ_ONLY_TOOLS, toolNote } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { saveSettings } = await import('../lib/settings.js');

const PAGE = '<!doctype html>\n<h1>Hello from the test page</h1>\n';
const logFile = path.join(dirs.data, 'quick-actions.log');
const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
const logLines = () => logText().trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

let n = 0;
/** A fresh pretend home with the three folders, and the files module on it. `turn.n` is how often the user has spoken. */
function setup({ strict = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(dirs.root, `home${n++}-`)));
  for (const f of USER_FOLDERS) fs.mkdirSync(path.join(home, f));
  fs.rmSync(logFile, { force: true });
  const calls = [];
  const quick = new QuickActions({ exec: async (file, args) => (calls.push({ file, args }), '') });
  const turn = { n: 1 };
  const files = new UserFiles({ quick, home, strict: () => strict, turn: () => turn.n });
  return { home, files, quick, calls, turn };
}
/** Every file under a folder, as paths from it. */
const tree = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => !e.isDirectory()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();

test('a new file lands in the chosen folder, with no question, and can be opened', async () => {
  const { home, files, calls } = setup();
  const r = await files.write({ name: 'index.html', content: PAGE, open_with: 'browser' });
  assert.deepEqual({ written: r.written, folder: r.folder, replaced: r.replaced, needsConfirm: r.needsConfirm }, { written: 'index.html', folder: 'Desktop', replaced: false, needsConfirm: undefined });
  assert.equal(fs.readFileSync(path.join(home, 'Desktop', 'index.html'), 'utf8'), PAGE);
  // Never executable.
  assert.equal(fs.statSync(path.join(home, 'Desktop', 'index.html')).mode & 0o111, 0);
  assert.deepEqual(calls, [{ file: 'open', args: [path.join(home, 'Desktop', 'index.html')] }]);
  assert.equal(r.opened, 'the browser');

  await files.write({ name: 'list.md', folder: 'documents', content: '- one\n' });
  await files.write({ name: 'data.json', folder: 'Downloads', content: '{}', open_with: 'default' });
  assert.deepEqual(tree(home), ['Desktop/index.html', 'Documents/list.md', 'Downloads/data.json']);
  // A script or data file opens in the text editor, never by whatever would run it.
  assert.deepEqual(calls.at(-1).args, ['-t', path.join(home, 'Downloads', 'data.json')]);
});

test('path tricks, other folders, dotfiles, other kinds and oversize content are refused, and nothing is written', async () => {
  const { home, files } = setup();
  const outside = path.join(home, 'outside.txt');
  const bad = [
    { name: '../outside.txt' }, { name: '..' }, { name: 'sub/note.txt' }, { name: outside }, { name: 'a\\b.txt' }, { name: '' },
    { name: '.env' }, { name: '.hidden.txt' },
    { name: 'run.sh' }, { name: 'tool.py' }, { name: 'go.command' }, { name: 'README' }, { name: 'page.html.sh' }, { name: 'app.plist' },
    { name: 'note.txt', folder: 'Library' }, { name: 'note.txt', folder: '../Desktop' }, { name: 'note.txt', folder: home }, { name: 'note.txt', folder: 'Desktop/sub' },
  ];
  for (const b of bad) await assert.rejects(files.write({ content: 'x', ...b }), /only write and read|just a file name|hidden files/, JSON.stringify(b));
  await assert.rejects(files.write({ name: 'big.txt', content: 'x'.repeat(MAX_BYTES + 1) }), /too much/);
  for (const b of bad) assert.throws(() => files.read(b), undefined, JSON.stringify(b));
  assert.deepEqual(tree(home), []);
  assert.ok(!TEXT_TYPES.some((t) => ['.sh', '.py', '.command', '.rb', '.pl', '.scpt', '.app'].includes(t)));
  // An app that would run the file is not somewhere to open it.
  await assert.rejects(files.write({ name: 'a.js', content: '1', open_with: 'Terminal' }), /runs things/);
  assert.deepEqual(tree(home), []);
});

test('links out of the folders are never followed', async () => {
  const { home, files } = setup();
  const secret = path.join(home, 'secret.txt');
  fs.writeFileSync(secret, 'keep me');
  fs.symlinkSync(secret, path.join(home, 'Desktop', 'link.txt'));
  await assert.rejects(files.write({ name: 'link.txt', content: 'gone', confirmed: true }), /link/);
  assert.throws(() => files.read({ name: 'link.txt' }), /link/);
  fs.linkSync(secret, path.join(home, 'Desktop', 'hard.txt'));
  await assert.rejects(files.write({ name: 'hard.txt', content: 'gone' }), /link/);
  // The folder itself is a link to somewhere else.
  fs.rmdirSync(path.join(home, 'Downloads'));
  fs.mkdirSync(path.join(home, 'elsewhere'));
  fs.symlinkSync(path.join(home, 'elsewhere'), path.join(home, 'Downloads'));
  await assert.rejects(files.write({ name: 'a.txt', folder: 'Downloads', content: 'x' }), /points somewhere else/);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(path.join(home, 'elsewhere')), []);
});

test("replacing a file Echo did not write asks first, and only the user's later yes lets it through", async () => {
  const { home, files, turn } = setup();
  const file = path.join(home, 'Desktop', 'notes.txt');
  fs.writeFileSync(file, 'mine, by hand');
  const asked = await files.write({ name: 'notes.txt', content: 'new text' });
  assert.equal(asked.needsConfirm, true);
  assert.equal(asked.written, false);
  assert.match(asked.question, /already a file called notes\.txt on your Desktop\. Replace it\?/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine, by hand');

  // confirmed: true in the same turn (the user has not spoken since): still not written.
  const early = await files.write({ name: 'notes.txt', confirmed: true });
  assert.equal(early.needsConfirm, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine, by hand');
  // confirmed: true for a file nobody was asked about: it asks, it does not write.
  fs.writeFileSync(path.join(home, 'Desktop', 'other.txt'), 'also mine');
  turn.n++;
  assert.equal((await files.write({ name: 'other.txt', content: 'x', confirmed: true })).needsConfirm, true);
  assert.equal(fs.readFileSync(path.join(home, 'Desktop', 'other.txt'), 'utf8'), 'also mine');

  // The user answered: the kept content goes in, with no need to send it again.
  const done = await files.write({ name: 'notes.txt', confirmed: true });
  assert.equal(done.written, 'notes.txt');
  assert.equal(done.replaced, true);
  assert.match(done.undo, /undo_write/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new text');

  // A no drops what was waiting.
  const no = await files.write({ name: 'other.txt', confirmed: false });
  assert.equal(no.cancelled, true);
  turn.n++;
  assert.equal((await files.write({ name: 'other.txt', confirmed: true, content: 'y' })).needsConfirm, true);
  assert.equal(fs.readFileSync(path.join(home, 'Desktop', 'other.txt'), 'utf8'), 'also mine');
});

test('a question that went unanswered for too long no longer counts', async () => {
  const { home, quick } = setup();
  let now = 1000;
  const turn = { n: 1 };
  const files = new UserFiles({ quick, home, now: () => now, turn: () => turn.n, confirmTtlMs: 500 });
  fs.writeFileSync(path.join(home, 'Desktop', 'a.txt'), 'old');
  await files.write({ name: 'a.txt', content: 'new' });
  now += 501;
  turn.n++;
  await assert.rejects(files.write({ name: 'a.txt', confirmed: true }), /nothing to write/);
  assert.equal(fs.readFileSync(path.join(home, 'Desktop', 'a.txt'), 'utf8'), 'old');
});

test('replacing a file Echo wrote needs no question, unless the user changed it or extra safety is on', async () => {
  const { home, files } = setup();
  const file = path.join(home, 'Desktop', 'index.html');
  await files.write({ name: 'index.html', content: PAGE });
  const again = await files.write({ name: 'index.html', content: PAGE + '<p>Nicer.</p>\n' });
  assert.equal(again.replaced, true);
  assert.equal(fs.readFileSync(file, 'utf8'), PAGE + '<p>Nicer.</p>\n');
  // The user edited it since: it is theirs again.
  fs.appendFileSync(file, '<p>typed by hand</p>');
  assert.equal((await files.write({ name: 'index.html', content: 'x' })).needsConfirm, true);
  assert.match(fs.readFileSync(file, 'utf8'), /typed by hand/);

  const safe = setup({ strict: true });
  await safe.files.write({ name: 'a.txt', content: 'one' });
  assert.equal((await safe.files.write({ name: 'a.txt', content: 'two' })).needsConfirm, true);
  assert.equal(fs.readFileSync(path.join(safe.home, 'Desktop', 'a.txt'), 'utf8'), 'one');
});

test('undo puts back what the last write replaced, and leaves no backup file behind', async () => {
  const { home, files, turn } = setup();
  const file = path.join(home, 'Documents', 'plan.md');
  fs.writeFileSync(file, '# The old plan\n');
  await files.write({ name: 'plan.md', folder: 'Documents', content: '# The new plan\n' });
  turn.n++;
  await files.write({ name: 'plan.md', folder: 'Documents', confirmed: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '# The new plan\n');
  assert.deepEqual(tree(home), ['Documents/plan.md']);
  assert.deepEqual(files.undo(), { restored: 'plan.md', folder: 'Documents', bytes: 15 });
  assert.equal(fs.readFileSync(file, 'utf8'), '# The old plan\n');
  // One step only; and the file is the user's again, so replacing it asks.
  assert.throws(() => files.undo(), /nothing to undo/);
  assert.equal((await files.write({ name: 'plan.md', folder: 'Documents', content: 'z' })).needsConfirm, true);

  // A file that was new has nothing to put back, and is not deleted.
  await files.write({ name: 'fresh.txt', content: 'hi' });
  assert.throws(() => files.undo(), /new file/);
  assert.ok(fs.existsSync(path.join(home, 'Desktop', 'fresh.txt')));
  // Changed by the user after Echo's write: their edit is not thrown away.
  await files.write({ name: 'fresh.txt', content: 'hi again' });
  fs.writeFileSync(path.join(home, 'Desktop', 'fresh.txt'), 'the user typed this');
  assert.throws(() => files.undo(), /changed since/);
  assert.equal(fs.readFileSync(path.join(home, 'Desktop', 'fresh.txt'), 'utf8'), 'the user typed this');
});

test('read_text_file gives the text back, up to the cap, and says when it is cut', async () => {
  const { home, files } = setup();
  await files.write({ name: 'index.html', content: PAGE });
  assert.deepEqual(files.read({ name: 'index.html' }), { file: 'index.html', folder: 'Desktop', bytes: Buffer.byteLength(PAGE), content: PAGE });
  assert.throws(() => files.read({ name: 'missing.txt' }), /no file called missing\.txt/);
  fs.writeFileSync(path.join(home, 'Desktop', 'long.csv'), 'a,b\n'.repeat(MAX_BYTES));
  const long = files.read({ name: 'long.csv' });
  assert.equal(long.truncated, true);
  assert.equal(Buffer.byteLength(long.content), MAX_BYTES);
  assert.match(long.note, /Do NOT write this back/);
  fs.writeFileSync(path.join(home, 'Desktop', 'bin.txt'), Buffer.from([1, 0, 2]));
  assert.throws(() => files.read({ name: 'bin.txt' }), /isn't a text file/);
});

test('the log has the name, the folder and the size, and never the content', async () => {
  const { home, files, turn } = setup();
  const MARKER = 'zebra-content-marker';
  fs.writeFileSync(path.join(home, 'Desktop', 'old.txt'), `before ${MARKER}`);
  await files.write({ name: 'page.html', content: `<p>${MARKER}</p>`, open_with: 'browser' });
  await files.write({ name: 'old.txt', content: `after ${MARKER}` });
  turn.n++;
  await files.write({ name: 'old.txt', confirmed: true });
  files.read({ name: 'old.txt' });
  files.undo();
  assert.ok(!logText().includes(MARKER));
  assert.ok(!logText().includes(home));
  assert.deepEqual(logLines().map((l) => l.event), ['file_written', 'file_opened', 'file_write_asked', 'file_written', 'file_read', 'file_write_undone']);
  const { at, ...first } = logLines()[0];
  assert.deepEqual(first, { event: 'file_written', file: 'page.html', folder: 'Desktop', bytes: Buffer.byteLength(`<p>${MARKER}</p>`), replaced: false });
});

test('the assistant has the tools: reading is read-only, the content stays out of the turn record, the prompt steers to them', async () => {
  const { home, quick } = setup();
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, quick);
  /** @type {any} */ (d).userFiles = new UserFiles({ quick, home, strict: () => Boolean(saveSettings({ safeMode: false }).safeMode), turn: () => d.computer.turns });
  const tools = d.toolList();
  const byName = (name) => /** @type {any} */ (tools.find((t) => t.name === name));
  for (const name of ['write_file', 'read_text_file', 'undo_write']) assert.ok(byName(name), name);
  assert.ok(READ_ONLY_TOOLS.has('read_text_file'));
  assert.equal(byName('read_text_file').annotations?.readOnlyHint, true);
  assert.ok(!READ_ONLY_TOOLS.has('write_file') && !READ_ONLY_TOOLS.has('undo_write'));
  assert.notEqual(byName('write_file').annotations?.readOnlyHint, true);
  assert.equal(toolNote({ name: 'mcp__ops__write_file', input: { name: 'a.txt', content: 'private words' } }), 'write_file');

  const said = (r) => (r.content[0].type === 'text' ? r.content[0].text : '');
  const made = await byName('write_file').handler({ name: 'hello.txt', content: 'hi' }, {});
  assert.equal(made.isError, undefined);
  assert.equal(JSON.parse(said(made)).written, 'hello.txt');
  assert.equal(fs.readFileSync(path.join(home, 'Desktop', 'hello.txt'), 'utf8'), 'hi');
  assert.equal(JSON.parse(said(await byName('read_text_file').handler({ name: 'hello.txt' }, {}))).content, 'hi');
  const refused = await byName('write_file').handler({ name: 'run.sh', content: 'rm -rf x' }, {});
  assert.equal(refused.isError, true);
  assert.match(said(refused), /never anything that runs/);

  // Through the tool, the yes has to follow a new turn of the user's (the dispatcher's own count).
  fs.writeFileSync(path.join(home, 'Desktop', 'theirs.txt'), 'by hand');
  assert.equal(JSON.parse(said(await byName('write_file').handler({ name: 'theirs.txt', content: 'x' }, {}))).needsConfirm, true);
  assert.equal(JSON.parse(said(await byName('write_file').handler({ name: 'theirs.txt', confirmed: true }, {}))).needsConfirm, true);
  d.computer.userSpoke('yes, replace it');
  assert.equal(JSON.parse(said(await byName('write_file').handler({ name: 'theirs.txt', confirmed: true }, {}))).written, 'theirs.txt');
  assert.equal(fs.readFileSync(path.join(home, 'Desktop', 'theirs.txt'), 'utf8'), 'x');

  const p = d.systemPrompt();
  assert.match(p, /call write_file with the finished content/);
  assert.match(p, /read_text_file, then write_file/);
  assert.match(p, /Never type code or prose into an editor by keystrokes, unless the user asked to be TAUGHT/);
});
