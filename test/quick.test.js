// Quick native errands, with osascript mocked: nothing here talks to Contacts, Messages or
// Calendar, sends a message, creates an event or opens anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('quick');
const { QuickActions, mask, explainOsaError } = await import('../lib/quick.js');
const { Dispatcher, fillerFor, FILLERS } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const PEOPLE = [
  { name: 'Sam', nickname: '', phones: [{ value: '+1 (555) 010-3141', label: '_$!<Mobile>!$_' }], emails: [] },
  { name: 'Sam Rivera', nickname: '', phones: [{ value: '+1 555 010 7788', label: '_$!<Home>!$_' }], emails: [{ value: 'sam.r@example.com', label: '_$!<Work>!$_' }] },
  { name: 'Maya Chen', nickname: 'May', phones: [{ value: '5550109911', label: 'iPhone' }], emails: [] },
  { name: 'No Way To Reach', nickname: '', phones: [], emails: [] },
];

/** A fake osascript/open. Records every call; answers by what the script is doing. */
/** @param {{ people?: any[], fail?: any, calendar?: any }} [opts] */
function fakeMac({ people = PEOPLE, fail = null, calendar = { calendar: 'Home', uid: 'X1' } } = {}) {
  const calls = [];
  const exec = async (file, args, input) => {
    calls.push({ file, args, input });
    if (fail) throw fail;
    if (file === 'open') return '';
    if (input.includes("Application('Contacts')")) return JSON.stringify(people);
    if (input.includes("Application('Calendar')")) return JSON.stringify(calendar);
    if (input.includes('tell application "Messages"')) return 'sent\n';
    throw new Error('unexpected script');
  };
  return { exec, calls, sends: () => calls.filter((c) => c.input?.includes('tell application "Messages"')) };
}

const logLines = () => {
  try {
    return fs.readFileSync(path.join(dirs.data, 'quick-actions.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const reset = () => {
  for (const f of ['contact-aliases.json', 'quick-actions.log']) fs.rmSync(path.join(dirs.data, f), { force: true });
};

test('masking shows only the last 4 digits or the first letter of an email', () => {
  assert.equal(mask('+1 (555) 010-3141'), '•••3141');
  assert.equal(mask('sam.r@example.com'), 's•••@example.com');
});

test('find_contact matches names, hides full numbers from the model, and caches', async () => {
  reset();
  let t = 0;
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec, now: () => t, contactsTtlMs: 1000 });
  const r = await q.findContact('sam');
  assert.deepEqual(r.matches.map((m) => m.name), ['Sam', 'Sam Rivera']);
  assert.equal(r.matches[0].exactName, true);
  assert.equal(r.unambiguous, false);
  const json = JSON.stringify(r);
  assert.ok(!json.includes('010-3141') && !json.includes('5550103141') && !json.includes('sam.r@'), 'no full numbers or emails');
  assert.equal(r.matches[0].handles[0].masked, '•••3141');
  assert.equal(r.matches[0].handles[0].label, 'mobile');
  assert.match(r.matches[0].handles[0].id, /^c_[0-9a-f]{8}$/);

  // Cached: the second search doesn't ask Contacts again, until the TTL passes.
  await q.findContact('maya');
  assert.equal(mac.calls.length, 1);
  t = 1500;
  await q.findContact('may');
  assert.equal(mac.calls.length, 2);
  // JXA script goes in on stdin, not as an argument.
  assert.deepEqual(mac.calls[0].args, ['-l', 'JavaScript', '-']);

  const one = await q.findContact('Maya Chen');
  assert.equal(one.unambiguous, true);
  assert.equal((await q.findContact('Nobody Here')).matches.length, 0);
  assert.equal((await q.findContact('No Way')).matches.length, 0, 'contacts with no number or email are left out');
  assert.equal((await q.findContact('3141')).matches[0].name, 'Sam');
});

test('concurrent lookups share one Contacts call', async () => {
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec });
  await Promise.all([q.findContact('sam'), q.findContact('maya')]);
  assert.equal(mac.calls.length, 1);
});

test('a message to an ambiguous match shows a card and sends only after Send', async () => {
  reset();
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec });
  const r = await q.findContact('sam');
  const id = r.matches[0].handles[0].id;
  const cards = [];
  const resolved = [];
  q.on('confirm_request', (c) => cards.push(c));
  q.on('confirm_resolved', (c) => resolved.push(c));

  // Even with direct, an ambiguous search needs the card.
  const out = await q.sendMessage({ to: id, text: 'Running 10 late', direct: true });
  assert.equal(out.waitingForConfirmation, true);
  assert.equal(mac.sends().length, 0);
  assert.equal(cards.length, 1);
  assert.deepEqual({ name: cards[0].name, masked: cards[0].masked, text: cards[0].text, service: cards[0].service }, { name: 'Sam', masked: '•••3141', text: 'Running 10 late', service: 'iMessage' });
  assert.ok(!JSON.stringify(cards[0]).includes('010-3141'));
  assert.deepEqual(q.pendingList().map((p) => p.id), [out.pendingId]);

  await q.resolvePending(out.pendingId, true, 'window');
  const [sent] = mac.sends();
  assert.deepEqual(sent.args, ['-', '+1 (555) 010-3141', 'Running 10 late', 'iMessage']);
  assert.ok(!sent.input.includes('Running 10 late'), 'text is an argument, never spliced into the script');
  assert.equal(resolved[0].sent, true);
  assert.equal(q.pendingList().length, 0);
  await assert.rejects(q.resolvePending(out.pendingId, true, 'window'), (/** @type {any} */ e) => e.code === 'stale');

  const log = logLines();
  assert.deepEqual(log.map((l) => l.event), ['message_card', 'message_sent']);
  assert.equal(log[1].via, 'window');
  assert.equal(log[1].masked, '•••3141');
});

test('cancel and expiry never send', async () => {
  reset();
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec, confirmTtlMs: 30 });
  const r = await q.findContact('Maya');
  const a = await q.sendMessage({ to: r.matches[0].handles[0].id, text: 'hi' });
  const res = await q.resolvePending(a.pendingId, false, 'voice');
  assert.equal(res.cancelled, true);
  const resolved = [];
  q.on('confirm_resolved', (c) => resolved.push(c));
  await q.sendMessage({ to: r.matches[0].handles[0].id, text: 'hi again' });
  await new Promise((ok) => setTimeout(ok, 80));
  assert.equal(resolved[0].by, 'expired');
  assert.equal(resolved[0].sent, false);
  assert.equal(mac.sends().length, 0);
  assert.deepEqual(logLines().map((l) => l.event), ['message_card', 'message_cancelled', 'message_card', 'message_expired']);
});

test('direct send only for a favorite or an unambiguous match, and only when asked', async () => {
  reset();
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec });

  // Unambiguous search + direct: sent right away.
  const pri = await q.findContact('Maya');
  const out = await q.sendMessage({ to: pri.matches[0].handles[0].id, text: 'On my way', direct: true });
  assert.equal(out.sent, true);
  assert.equal(mac.sends().length, 1);

  // Unambiguous but not direct: card.
  assert.equal((await q.sendMessage({ to: pri.matches[0].handles[0].id, text: 'x' })).waitingForConfirmation, true);

  // A dictated number is never trusted for a direct send.
  assert.equal((await q.sendMessage({ to: '+1 555 010 1234', text: 'x', direct: true })).waitingForConfirmation, true);

  // A bare name must be looked up first.
  await assert.rejects(q.sendMessage({ to: 'Sam', text: 'x', direct: true }), /find_contact/);

  // Save the favorite after the user picked the right Sam; then direct works by alias.
  const al = await q.findContact('Sam');
  const saved = q.setAlias('Sam', al.matches[0].handles[0].id);
  assert.deepEqual(saved, { alias: 'Sam', name: 'Sam', masked: '•••3141' });
  const fav = await q.sendMessage({ to: 'sam', text: 'Dinner at 8?', direct: true });
  assert.equal(fav.sent, true);
  assert.deepEqual(mac.sends().at(-1).args, ['-', '+1 (555) 010-3141', 'Dinner at 8?', 'iMessage']);

  // Favorites survive a restart (new instance, no search) and stay masked for the model.
  const q2 = new QuickActions({ exec: mac.exec });
  assert.deepEqual(q2.favorites(), [{ alias: 'Sam', name: 'Sam', id: al.matches[0].handles[0].id, masked: '•••3141', label: 'mobile' }]);
  assert.equal((await q2.sendMessage({ to: 'Sam', text: 'hey', direct: true })).sent, true);
  assert.equal((await q2.findContact('Sam')).savedFavorite.masked, '•••3141');

  // SMS only when asked for.
  await q2.sendMessage({ to: 'Sam', text: 'sms', direct: true, sms: true });
  assert.equal(mac.sends().at(-1).args[3], 'SMS');

  await assert.rejects(q2.sendMessage({ to: 'Sam', text: '   ' }), /empty/);
  assert.throws(() => q2.setAlias('Bob', 'c_deadbeef'), /find_contact/);
  assert.ok(logLines().filter((l) => l.event === 'message_sent').length >= 4);
});

test('permission errors become a spoken pointer to System Settings', async () => {
  reset();
  const denied = Object.assign(new Error('Command failed'), { stderr: 'execution error: Not authorized to send Apple events to Contacts. (-1743)' });
  const q = new QuickActions({ exec: fakeMac({ fail: denied }).exec });
  await assert.rejects(q.findContact('sam'), (/** @type {any} */ e) => e.code === 'permission' && /System Settings, then Privacy and Security, then Automation/.test(e.message) && /Contacts/.test(e.message));

  // A failed send is logged and reported, and the card is closed.
  const mac = fakeMac();
  const q2 = new QuickActions({ exec: mac.exec });
  const r = await q2.findContact('Maya');
  const p = await q2.sendMessage({ to: r.matches[0].handles[0].id, text: 'hi' });
  q2.exec = fakeMac({ fail: Object.assign(new Error('x'), { stderr: 'Not authorized to send Apple events to Messages. (-1743)' }) }).exec;
  const resolved = [];
  q2.on('confirm_resolved', (c) => resolved.push(c));
  await assert.rejects(q2.resolvePending(p.pendingId, true, 'window'), /Automation/);
  assert.equal(resolved[0].sent, false);
  assert.match(resolved[0].error, /Messages/);
  assert.equal(logLines().at(-1).event, 'message_failed');

  assert.equal(explainOsaError(Object.assign(new Error('spawn osascript ENOENT'), { code: 'ENOENT' }), 'Calendar').code, 'unavailable');
});

test('calendar events: default length, alerts, local dates, errors', async () => {
  reset();
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec });
  const r = await q.addCalendarEvent({ title: 'Dinner with Sam', start: '2026-09-26T19:00', location: 'Pho House', alert_minutes: 30 });
  assert.equal(r.added, true);
  assert.equal(r.calendar, 'Home');
  const sent = JSON.parse(mac.calls[0].args.at(-1));
  assert.equal(sent.end - sent.start, 3600 * 1000);
  assert.equal(sent.start, new Date(2026, 8, 26, 19, 0).getTime());
  assert.equal(sent.alert, 1800);
  assert.equal(sent.location, 'Pho House');
  assert.ok(!mac.calls[0].input.includes('Dinner with Sam'), 'details go in as arguments');

  await q.addCalendarEvent({ title: 'Trip', start: '2026-10-01', all_day: true });
  const allDay = JSON.parse(mac.calls[1].args.at(-1));
  assert.equal(allDay.start, new Date(2026, 9, 1).getTime(), 'a bare date is local midnight');
  assert.equal(allDay.allDay, true);

  await assert.rejects(q.addCalendarEvent({ title: 'x', start: 'tomorrowish' }), /start time/);
  await assert.rejects(q.addCalendarEvent({ title: 'x', start: '2026-09-26T19:00', end: '2026-09-26T18:00' }), /ends before/);
  await assert.rejects(q.addCalendarEvent({ title: '', start: '2026-09-26T19:00' }), /title/);

  const noCal = new QuickActions({ exec: fakeMac({ calendar: { error: 'no_calendar', calendars: ['Home', 'Work'] } }).exec });
  await assert.rejects(noCal.addCalendarEvent({ title: 'x', start: '2026-09-26T19:00', calendar: 'Gym' }), /no writable calendar called "Gym".*Home, Work/);
  assert.equal(logLines().filter((l) => l.event === 'event_added').length, 2);
});

test('open_url and open_app only open safe things', async () => {
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec });
  assert.deepEqual(await q.openUrl('https://example.com/a?b=1'), { opened: 'https://example.com/a?b=1' });
  assert.deepEqual(mac.calls[0], { file: 'open', args: ['https://example.com/a?b=1'], input: undefined });
  await assert.rejects(q.openUrl('file:///etc/passwd'), /web and email/);
  await assert.rejects(q.openUrl('javascript:alert(1)'), /web and email/);
  await assert.rejects(q.openUrl('not a url'), /valid link/);
  await q.openApp('Spotify');
  assert.deepEqual(mac.calls.at(-1).args, ['-a', 'Spotify']);
  await assert.rejects(q.openApp('-n; rm -rf'), /app name/);
  q.exec = async () => {
    throw Object.assign(new Error('x'), { stderr: 'Unable to find application named \'Nope\'' });
  };
  await assert.rejects(q.openApp('Nope'), /no app called Nope/);
});

test('the dispatcher has the quick tools and the prompt steers errands to them', async () => {
  reset();
  const mac = fakeMac();
  const q = new QuickActions({ exec: mac.exec });
  const al = await q.findContact('Sam');
  q.setAlias('Sam', al.matches[0].handles[0].id);
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, q);
  const p = d.systemPrompt();
  for (const name of ['find_contact', 'send_imessage', 'confirm_message', 'set_contact_alias', 'add_calendar_event', 'open_url', 'open_app']) assert.ok(p.includes(name), name);
  assert.match(p, /ONE short question/);
  assert.match(p, /Never start a worker for a text/);
  assert.match(p, /Privacy and Security, Automation/);
  assert.match(p, /"Sam": Sam \(mobile •••3141\)/);
  assert.ok(!p.includes('010-3141'));
  const names = d.quickTools().map((t) => t.name);
  assert.deepEqual(names, ['find_contact', 'send_imessage', 'confirm_message', 'set_contact_alias', 'add_calendar_event', 'open_url', 'open_app', 'find_file']);
  assert.ok(FILLERS.quick.includes(fillerFor('mcp__ops__send_imessage')));
  assert.equal(mac.sends().length, 0);
});

test('tool handlers turn permission errors into a message to say', async () => {
  const denied = Object.assign(new Error('x'), { stderr: 'Not authorized to send Apple events to Calendar. (-1743)' });
  const q = new QuickActions({ exec: fakeMac({ fail: denied }).exec });
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, q);
  const add = /** @type {any} */ (d.quickTools().find((t) => t.name === 'add_calendar_event'));
  const out = await add.handler({ title: 'x', start: '2026-09-26T19:00' }, {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].type === 'text' ? out.content[0].text : '', /^Permission needed\. Tell the user: .*Automation/);
});
