// Drawing with the light, and notes that stay (echo-talk-design.html, sections 4 and 6). What the
// user circles is "this" for two minutes; a message right after it, or one that points ("fix
// this"), is about it. Circling is never a yes. A pinned note is one line, by a tool call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('drawlight');
const { Dispatcher, circledNote, CIRCLED_MS, CIRCLED_NOW_MS } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const box = { x0: 0.2, y0: 0.4, x1: 0.55, y1: 0.6 };

test('what was circled is "this": right after the drawing, and later when the words point at it', () => {
  const now = 1_000_000_000, c = { box, at: now };
  const note = circledNote(c, 'fix it', now + 1000);
  assert.match(note, /from 20% to 55% of the screen's width \(left to right\) and from 40% to 60% of its height \(top to bottom\)/);
  assert.match(note, /Circling is pointing, never a yes/);
  assert.ok(circledNote(c, 'open my calendar', now + 2000), 'anything said in the first moments is about it');
  assert.equal(circledNote(c, 'open my calendar', now + CIRCLED_NOW_MS + 1000), '', 'later, other talk is not');
  assert.ok(circledNote(c, 'can you make this shorter', now + 60_000), 'later, "this" still is');
  assert.equal(circledNote(c, 'make this shorter', now + CIRCLED_MS + 1), '', 'after two minutes it is forgotten');
  assert.equal(circledNote(null, 'fix this', now), '');
});

test('the dispatcher keeps a sensible box only, and tells the assistant with the message', () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const sent = [];
  d.input = /** @type {any} */ ({ push: (body) => sent.push(typeof body === 'string' ? body : body.at(-1).text), size: 0, close() {} });
  for (const bad of [null, {}, { x0: 0.5, y0: 0.5, x1: 0.2, y1: 0.9 }, { x0: -1, y0: 0, x1: 1, y1: 1 }, { x0: 'a', y0: 0, x1: 1, y1: 1 }]) assert.equal(d.circle(bad), false);
  assert.equal(d.circled, null);
  assert.equal(d.circle(box), true);
  d.send('fix it');
  assert.match(sent.at(-1), /circled part of their screen with your light/);
  assert.match(d.systemPrompt(), /call pin_note with the one line worth keeping/);
});

test('pin_note keeps one short line on screen', async () => {
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }));
  const pinned = [];
  d.on('pin_note', (t) => pinned.push(t));
  const tool = d.allTools().find((t) => t.name === 'pin_note');
  assert.ok(tool);
  await tool.handler({ text: '  Renewal date:\n 3 March ' }, {});
  assert.deepEqual(pinned, ['Renewal date: 3 March']);
  assert.equal((await tool.handler({ text: '   ' }, {})).isError, true);
  assert.equal(pinned.length, 1);
});

test('the wiring: the key draws, the page tells Echo and opens the box only when nothing was said, and it is all in the Aurora look', () => {
  const page = read('public/app.js'), swift = (f) => read(`macos/Sources/${f}`);
  assert.match(page, /send\(\{ type: 'circled', box \}\);/);
  assert.match(page, /if \(drewAt === at && heardAt < at\) toApp\(\{ type: 'drawBox' \}\);/, 'the box only when nothing was heard after the drawing');
  assert.match(page, /case 'pin_note': toApp\(\{ type: 'pinNote', text: String\(msg\.text \|\| ''\) \}\); break;/);
  assert.match(read('lib/server/window.js'), /case 'circled':[^]*?dispatcher\.circle\(msg\.box\);/);
  const bridge = swift('ScreenBridge.swift'), layer = swift('TalkLayer.swift');
  assert.match(bridge, /DrawLight\.shared\.begin\(\)/);
  assert.match(bridge, /DrawLight\.shared\.end\(\)/);
  assert.match(bridge, /DrawLight\.shared\.cancel\(\)/, 'a shortcut with the same keys draws nothing');
  assert.match(layer, /p\.ignoresMouseEvents = true \/\/ clicks go straight through/);
  assert.match(layer, /glass\.layer\?\.addSublayer\(Aurora\.rim\(glass\.bounds, radius: DrawMath\.fieldHeight \/ 2\)\)/, 'the box waiting for your words has the lit rim');
  assert.match(layer, /Settled glass: Echo is not saying this now, it is yours\. A quiet hairline, no colour\./);
  assert.match(layer, /while all\.count >= PinMath\.most, let first = all\.first/);
  assert.match(swift('main.swift'), /item\("Clear Pinned Notes", #selector\(clearPinnedNotes\), ""\)/);
});
