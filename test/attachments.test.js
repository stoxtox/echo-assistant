import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('attachments');
const { saveAttachment, findAttachment, resolveAttachments, imageBlocks, MAX_IMAGES_PER_MESSAGE } = await import('../lib/attachments.js');
const { Dispatcher, researchFolders } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');
const { config } = await import('../lib/config.js');

// A 1x1 PNG and a few bytes that start like a JPEG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

test('attachments are saved in the research folder under the date, with a safe id', () => {
  const a = saveAttachment(PNG, 'image/png');
  assert.match(a.id, /^\d{4}-\d{2}-\d{2}\/\d{6}-[0-9a-f]{8}\.png$/);
  assert.equal(path.dirname(path.dirname(a.path)), path.join(dirs.research, 'attachments'));
  assert.deepEqual(fs.readFileSync(a.path), PNG);
  assert.equal(a.url, `/api/attachments/${a.id}`);
  assert.equal(findAttachment(a.id)?.mime, 'image/png');
  assert.equal(saveAttachment(JPEG, 'image/jpeg; charset=binary').mime, 'image/jpeg');
});

test('only real images of the allowed types are accepted', () => {
  assert.throws(() => saveAttachment(PNG, 'text/html'), /Only JPEG, PNG, GIF or WebP/);
  assert.throws(() => saveAttachment(Buffer.from('<svg/>'), 'image/png'), /isn't the image type/);
  assert.throws(() => saveAttachment(Buffer.alloc(0), 'image/png'), /empty/);
  assert.throws(() => saveAttachment(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]), 'image/png'), /too large/);
});

test('ids from a message can never point outside the attachments folder', () => {
  for (const bad of ['../../etc/passwd', '2026-01-01/../../x.png', '/etc/hosts', '2026-01-01/123456-deadbeef.svg', 42, null]) {
    assert.equal(findAttachment(bad), null, String(bad));
  }
  const a = saveAttachment(PNG, 'image/png');
  const many = Array.from({ length: 10 }, () => saveAttachment(PNG, 'image/png').id);
  const got = resolveAttachments([a.id, a.id, 'nope', ...many]);
  assert.equal(got[0].id, a.id);
  assert.equal(got.length, MAX_IMAGES_PER_MESSAGE, 'repeats and extras dropped');
  assert.deepEqual(resolveAttachments('not a list'), []);
});

test('the dispatcher gets attached images as image blocks, plus their paths for workers', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const pushed = [];
  d.input = /** @type {any} */ ({ push: (content) => pushed.push(content) });
  const a = saveAttachment(PNG, 'image/png');
  d.send('What is wrong with this screen?', {}, [findAttachment(a.id)]);
  const [content] = pushed;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], imageBlocks([{ path: a.path, mime: 'image/png' }])[0]);
  assert.equal(content[0].source.data, PNG.toString('base64'));
  assert.equal(content.at(-1).type, 'text');
  assert.match(content.at(-1).text, /What is wrong with this screen\?/);
  assert.ok(content.at(-1).text.includes(a.path), 'the path is there to hand to a worker');
  // Images alone still make a message; plain text stays plain.
  d.send('', {}, [findAttachment(a.id)]);
  assert.match(pushed[1].at(-1).text, /just the attached image/);
  d.send('hello');
  assert.equal(typeof pushed[2], 'string');
  assert.match(new Dispatcher(new TaskManager({ queryFn: async function* () {} })).systemPrompt(), /attach images/);
});

test('the attachments folder is not listed as a research topic', () => {
  fs.mkdirSync(path.join(dirs.research, 'job-search'), { recursive: true });
  const folders = researchFolders().map((f) => f.folder);
  assert.ok(folders.includes('job-search'));
  assert.ok(!folders.includes('attachments'));
  assert.equal(config.attachmentsDir, path.join(dirs.research, 'attachments'));
});
