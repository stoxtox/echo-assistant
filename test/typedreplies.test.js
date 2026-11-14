// Typed replies (echo-talk-design.html, section 3): when the user's last message was typed, the
// island offers its reply field after Echo's answer, and a question with a small set of answers
// comes with them as chips. Never for an open question, never while a card waits for a yes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('typedreplies');
const { quickReplies, lastQuestion } = await import('../lib/quickreplies.js');
const { createCaptionFeed } = await import('../public/caption.js');

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('chips only for a question with a small, known set of answers', () => {
  assert.deepEqual(quickReplies('Booked view open for the 9:40. Aisle or window?'), ['Aisle', 'Window']);
  assert.deepEqual(quickReplies('Do you want the red one or the blue one?'), ['Red one', 'Blue one']);
  assert.deepEqual(quickReplies('Should it be small, medium or large?'), ['Small', 'Medium', 'Large']);
  assert.deepEqual(quickReplies('I can send it now. Want me to send it?'), ['Yes', 'No']);
  assert.deepEqual(quickReplies('Is that right?'), ['Yes', 'No']);
  // Open questions, statements, and questions too long to be a choice: none.
  for (const t of ['What should it say?', 'Which file do you mean?', 'Booked. Anything else?', 'It is done.', 'Two options: 9:40 direct, or 7:15 with a stop. Which one?', '',
    'Should I go through every folder on the drive and rename each of the files by the date it was taken or by the place it was taken in?']) assert.deepEqual(quickReplies(t), [], t);
  assert.equal(lastQuestion('All set. Want me to send it?'), 'Want me to send it');
  assert.equal(lastQuestion('All set.'), '');
});

test('the caption feed offers the field with its chips, and for less long when it is only because you typed', () => {
  const posts = [], timers = [];
  const feed = createCaptionFeed({ post: (m) => posts.push(m), throttleMs: 0, setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length), clearTimer: () => {}, now: () => 0 });
  feed.update({ echo: 'Aisle or window?', asks: true, chips: 'Aisle\nWindow' });
  const asked = posts.filter((m) => m.type === 'caption').at(-1);
  assert.equal(asked.asks, true);
  assert.deepEqual(asked.chips, ['Aisle', 'Window']);
  assert.equal(timers.filter((t) => t.ms === 120000).length, 1, 'a question waits two minutes');
  // You started to answer by voice: the field and its chips go.
  feed.update({ hearing: true });
  const answered = posts.filter((m) => m.type === 'caption').at(-1);
  assert.equal(answered.asks, false);
  assert.equal('chips' in answered, false);
  // No question, but you typed last: offered for half a minute.
  feed.update({ hearing: false, asks: true, chips: '', offerMs: 30000 });
  assert.ok(timers.some((t) => t.ms === 30000));
  assert.equal('chips' in posts.filter((m) => m.type === 'caption').at(-1), false);
});

test('the wiring: typed last, chips with the reply, the key tap, and no chips while a card waits', () => {
  const page = read('public/app.js');
  assert.match(page, /typedLast = Boolean\(msg\.typed\);/);
  assert.match(page, /const offer = awaits \|\| typedLast;/);
  assert.match(page, /showQuickReplies\(awaits && typedLast \? chips : \[\]\);/, 'in the window, chips show only when you are typing');
  assert.match(page, /send\(\{ type: 'user_text', text: c, typed: true \}\);/);
  const server = read('server.js');
  assert.match(server, /const chips = awaitsReply && !computer\.pending\.size && !quick\.pendingList\(\)\.length \? quickReplies\(dispatcher\.lastReply\) : \[\];/);
  const swift = (f) => read(`macos/Sources/${f}`);
  assert.match(swift('Caption.swift'), /ReplyField\.shared\.setChips\(\(b\["asks"\] as\? Bool \?\? false\) \? \(b\["chips"\] as\? \[String\] \?\? \[\]\) : \[\]\)/);
  assert.match(swift('ScreenBridge.swift'), /ptt\.onSingleTap = \{ ReplyField\.shared\.focusIfOffered\(\) \}/);
  assert.match(swift('ReplyField.swift'), /guard expanded, !\(panel\?\.isKeyWindow \?\? false\) else \{ return false \}/, 'a tap never steals a field you are already typing in');
  assert.match(read('public/index.html'), /<div class="quick-replies" id="quickReplies" aria-label="Quick answers" hidden><\/div>/);
});
