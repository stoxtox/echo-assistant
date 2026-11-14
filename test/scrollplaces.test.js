// Scrolling goes to places (lib/tools/computer.js scrollTo, lib/computer.js scrollPlace,
// lib/thread.js places): a heading comes into view in one move, the page says where it is, each
// point of the thread remembers its place, and "back", "a little", "find" and "read along" each
// have a word. Before, every scroll was a blind page and a second look at the screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sandbox } from './helpers.js';

sandbox('scrollplaces');
const { scrollPlace, cleanAnswer } = await import('../lib/computer.js');
const { scrollTo } = await import('../lib/tools/computer.js');
const { ThreadKeeper } = await import('../lib/thread.js');

/** A stand-in for the computer: it keeps what it was asked. */
function fake(extra = {}) {
  /** @type {any[]} */
  const asked = [];
  return { asked, scrollBefore: null, threadFor: null, act: async (/** @type {string} */ action, /** @type {any} */ params) => { asked.push({ action, ...params }); return { done: true, scroll: { position: 0.4, place: '40% down' } }; }, ...extra };
}

test('what the Mac app says about a scroll becomes where the page is', () => {
  assert.equal(scrollPlace({}), null, 'no scroll bar to read: nothing is claimed');
  assert.deepEqual(scrollPlace({ position: 0.4, pageAt: '40% down', moved: true }), { position: 0.4, place: '40% down' });
  assert.deepEqual(scrollPlace({ position: 1.2, pageAt: 'at the bottom', atEnd: true, moved: false }), { position: 1, place: 'at the bottom', atEnd: true, moved: false });
  assert.deepEqual(scrollPlace({ position: 0.3, pageAt: '30% down', found: true, label: 'Pricing' }), { position: 0.3, place: '30% down', broughtIntoView: 'Pricing' });
  assert.deepEqual(scrollPlace({ gliding: true }), { gliding: true });
  // The answer's scroll fields survive the cleaning every answer from the Mac app goes through.
  const kept = cleanAnswer({ ok: true, position: 0.4, pageAt: '40% down', moved: true, atEnd: false, gliding: false, junk: 'x' });
  assert.deepEqual(scrollPlace(kept), { position: 0.4, place: '40% down', gliding: false });
});

test('each word of the scroll tool asks the app for a place', async () => {
  let c = fake();
  await scrollTo(c, { into_view: 'Pricing', app: 'Safari' });
  assert.deepEqual(c.asked, [{ action: 'scroll', direction: 'down', app: 'Safari', scrollTo: { into: 'Pricing' } }]);

  c = fake();
  await scrollTo(c, { to: 'top' });
  await scrollTo(c, { to: 'where' });
  assert.deepEqual(c.asked.map((a) => a.scrollTo), [{ place: 'top' }, { place: 'where' }]);

  c = fake();
  await scrollTo(c, { read_along: 'start' });
  await scrollTo(c, { read_along: 'slower' });
  await scrollTo(c, { read_along: 'hold' });
  assert.deepEqual(c.asked.map((a) => a.scrollTo), [{ glide: 'start' }, { glide: 'start', pace: 'slow' }, { glide: 'hold' }]);

  c = fake();
  await scrollTo(c, { direction: 'up', amount: 0.15 });
  await scrollTo(c, {});
  assert.deepEqual(c.asked, [{ action: 'scroll', direction: 'up', amount: 0.15 }, { action: 'scroll', direction: 'down', amount: 1 }], 'a little, and a page when nothing is said');
});

test('"back where we were" goes to the place before the last scroll, or says there is none', async () => {
  let c = fake();
  const none = await scrollTo(c, { back: true });
  assert.equal(none.done, false);
  assert.equal(c.asked.length, 0);
  c = fake({ scrollBefore: { app: 'Safari', position: 0.25, at: 1 } });
  await scrollTo(c, { back: true });
  assert.deepEqual(c.asked[0].scrollTo, { position: 0.25 });
});

test('a point of the thread goes to its remembered place, else its words are brought into view', async () => {
  const k = new ThreadKeeper({ now: () => 1_000_000 });
  k.keep({ doing: 'going through a long reply', items: ['Summary', 'Risks', 'Next steps'], where: 'the reply' });
  k.keep({ at: 0 });
  k.placed(0.1);
  k.keep({ at: 1 });
  k.placed(0.45);
  k.placed(7);
  assert.equal(k.placeOf(0), 0.1);
  assert.equal(k.placeOf(1), 1, 'the latest place of the point, kept within the page');
  assert.equal(k.placeOf(2), null);

  const c = fake({ threadFor: () => k });
  await scrollTo(c, { item: 1 });
  await scrollTo(c, { item: 3 });
  const gone = await scrollTo(c, { item: 9 });
  assert.deepEqual(c.asked.map((a) => a.scrollTo), [{ position: 0.1 }, { into: 'Next steps' }]);
  assert.equal(gone.error, 'no_item');
});

test('far-away words are found with the app\'s own Find, and the bar is closed again', async () => {
  const c = fake();
  const r = await scrollTo(c, { find: 'refund policy', app: 'Safari' });
  assert.deepEqual(c.asked.map((a) => [a.action, a.keys || a.text || a.scrollTo?.place]), [['press_keys', 'cmd+f'], ['type_text', 'refund policy'], ['press_keys', 'return'], ['press_keys', 'escape'], ['scroll', 'where']]);
  assert.match(r.did, /find "refund policy"/);
  assert.equal(r.scroll.place, '40% down');
});

test('the Mac app: into view, places, the glide and the line for the eye', () => {
  const driver = readFileSync(new URL('../macos/Sources/Driver.swift', import.meta.url), 'utf8');
  const pointer = readFileSync(new URL('../macos/Sources/Pointer.swift', import.meta.url), 'utf8');
  assert.match(driver, /scrollSmart\(/);
  assert.match(driver, /AXScrollToVisible/);
  assert.match(driver, /final class ScrollGlide/);
  assert.match(driver, /"position"|position/);
  assert.match(pointer, /func seam\(across area: CGRect, y: CGFloat\)/);
  // Stopping Echo stops a glide too.
  for (const fn of ['func pause(', 'func abort(']) {
    const at = driver.indexOf(fn);
    assert.ok(at > 0 && driver.slice(at, at + 900).includes('glide.stop()'), `${fn} stops the glide`);
  }
});

test('the instructions teach places, not pages', async () => {
  const src = readFileSync(new URL('../lib/tools/computer.js', import.meta.url), 'utf8');
  assert.match(src, /Scrolling goes to places, not by pages/);
  assert.match(src, /when it says the page is at the bottom, stop scrolling/);
});
