// The everyday-app adapters (lib/apps): Finder, Notes, Reminders, Calendar and Mail through
// their own scripting instead of clicks. Here every script is answered by a fake runner (small
// pretend apps below, answering in the scripts' own wire format), and the files are in a
// throwaway "home" folder. Nothing touches a real app, the real home folder or the real Trash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';

const dirs = sandbox('apps');
const { Apps, APP_TOOL_NAMES } = await import('../lib/apps/index.js');
const { APP_TIMEOUT_MS, escapeText, parseAnswer, localDate, dateArgs } = await import('../lib/apps/osa.js');
const { checkPath, FINDER_SCRIPT, LIST_MAX } = await import('../lib/apps/finder.js');
const { NOTES_SCRIPT, toHtml } = await import('../lib/apps/notes.js');
const { REMINDERS_SCRIPT } = await import('../lib/apps/reminders.js');
const { CALENDAR_SCRIPT } = await import('../lib/apps/calendar.js');
const { MAIL_SCRIPT } = await import('../lib/apps/mail.js');
const { ComputerUse } = await import('../lib/computer.js');
const { classifyByEffect, FILES_MAX, SAY_SO_CATEGORIES } = await import('../lib/policy.ts');
const { saveSettings } = await import('../lib/settings.js');
const { safeFields, readTimeline } = await import('../lib/timeline.ts');
const { QuickActions } = await import('../lib/quick.js');
const { Dispatcher } = await import('../lib/dispatcher.js');
const { TaskManager } = await import('../lib/tasks.js');

const logFile = path.join(dirs.data, 'computer-log.jsonl');
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Text that would be code if it were ever put into a script, or would break the answer's lines.
const NASTY = ['say "hi"', 'back\\slash \\" end', 'two\nlines\tand a tab', '" & do shell script "touch /tmp/echo-pwned" & "', "it's 'quoted'", 'end tell\nend run', '<b>&amp;</b>'];

const line = (...f) => f.map(escapeText).join('\t');
const SCRIPT_NAMES = new Map([[FINDER_SCRIPT, 'Finder'], [NOTES_SCRIPT, 'Notes'], [REMINDERS_SCRIPT, 'Reminders'], [CALENDAR_SCRIPT, 'Calendar'], [MAIL_SCRIPT, 'Mail']]);

/**
 * The pretend Mac: what each fixed script would answer, from a little state.
 * @param {{ closed?: string[], fail?: any, answer?: string, trashWorks?: boolean }} [o] closed: apps that aren't open;
 *   fail: thrown instead of answering; answer: said instead of the real answer; trashWorks false: Finder says OK and moves nothing
 */
function fakeMac({ closed = [], fail = null, answer = '', trashWorks = true } = {}) {
  const calls = [];
  const state = {
    trash: path.join(dirs.root, `trash-${Math.random().toString(36).slice(2)}`),
    notes: [
      { id: 'x-coredata://A1/ICNote/p1', name: 'Shopping', text: 'Shopping\noat milk\nthe blue cheese', folder: 'Notes', locked: false, files: 0 },
      { id: 'x-coredata://A1/ICNote/p2', name: 'Diary', text: 'Diary\nprivate thoughts about cheese', folder: 'Notes', locked: true, files: 0 },
      { id: 'x-coredata://A1/ICNote/p3', name: 'Trip', text: 'Trip\nboarding pass', folder: 'Travel', locked: false, files: 1 },
    ],
    reminders: [
      { id: 'x-apple-reminder://R1', name: 'Call the dentist', due: '2026-10-05T09:00:00', list: 'Reminders', done: false },
      { id: 'x-apple-reminder://R2', name: 'Buy stamps', due: '', list: 'Errands', done: false },
      { id: 'x-apple-reminder://R3', name: 'Old one', due: '', list: 'Errands', done: true },
    ],
    events: [
      { title: 'Standup', start: '2026-10-03T09:30:00', end: '2026-10-03T09:45:00', allDay: false, location: '', cal: 'Work' },
      { title: 'Dinner with Sam', start: '2026-10-03T19:00:00', end: '2026-10-03T21:00:00', allDay: false, location: 'The Corner Place', cal: 'Home' },
      { title: 'Conference', start: '2026-10-06T00:00:00', end: '2026-10-08T00:00:00', allDay: true, location: '', cal: 'Work' },
    ],
    mail: [
      { id: 501, subject: 'Your invoice 4471', from: 'Billing <billing@example.com>', at: '2026-10-03T08:01:00', text: 'Amount due: 42 dollars. Secret code 9911.', read: false },
      { id: 502, subject: 'Lunch?', from: 'Sam Lee <sam@example.com>', at: '2026-10-03T08:30:00', text: 'Are you free at noon?', read: false },
      { id: 503, subject: 'Read already', from: 'x@example.com', at: '2026-10-02T08:30:00', text: 'old', read: true },
    ],
    drafts: [],
  };
  fs.mkdirSync(state.trash, { recursive: true });
  const iso = (y, m, d, s) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${new Date(Number(s) * 1000).toISOString().slice(11, 19)}`;
  const noteLine = (n) => line('note', n.id, n.name, '2026-10-01T10:00:00', n.folder);
  const remLine = (r, more = []) => line('rem', r.id, r.name, r.due, r.list, ...more);
  const msgLine = (m) => line('msg', String(m.id), m.subject, m.from, m.at);
  const apps = {
    Finder(args) {
      for (const p of args) if (!fs.existsSync(p)) return 'ERR\tnot_found';
      if (trashWorks) for (const p of args) fs.renameSync(p, path.join(state.trash, path.basename(p)));
      return 'OK';
    },
    Notes([op, a, b]) {
      if (op === 'find') {
        const q = a.toLowerCase();
        const hits = state.notes.filter((n) => !q || n.name.toLowerCase().includes(q) || n.text.toLowerCase().includes(q));
        return ['OK', `count\t${hits.length}`, ...hits.slice(0, Number(b)).map(noteLine)].join('\n');
      }
      if (op === 'create') {
        const n = { id: `x-coredata://A1/ICNote/p${state.notes.length + 1}`, name: a.replace(/<[^>]+>/g, ' ').trim().split(/\s{2,}/)[0], html: a, text: a, folder: b || 'Notes', locked: false, files: 0 };
        state.notes.push(n);
        return ['OK', noteLine(n)].join('\n');
      }
      const n = state.notes.find((x) => (a.startsWith('x-coredata://') ? x.id === a : x.name === a));
      if (!n) return 'ERR\tscript\t-1728\tCan’t get note.';
      if (n.locked) return 'ERR\tlocked';
      if (op === 'append') {
        if (n.files) return 'ERR\thas_attachments';
        n.html = (n.html || '') + b;
        n.text += b;
        return ['OK', `grew\t${b.length}`, noteLine(n)].join('\n');
      }
      return ['OK', `size\t${n.text.length}`, line('text', n.text.slice(0, Number(b))), noteLine(n)].join('\n');
    },
    Reminders([op, a, b, kind, y, m, d, s, notes]) {
      if (op === 'list') {
        if (a && !state.reminders.some((r) => r.list === a)) return 'ERR\tscript\t-1719\tCan’t get list.';
        const open = state.reminders.filter((r) => !r.done && (!a || r.list === a));
        return ['OK', ...open.slice(0, Number(b)).map((r) => remLine(r)), `count\t${open.length}`].join('\n');
      }
      if (op === 'add') {
        const r = { id: `x-apple-reminder://R${state.reminders.length + 1}`, name: a, due: kind === '0' ? '' : iso(y, m, d, kind === '2' ? 0 : s), allDay: kind === '2', list: b || 'Reminders', notes, done: false };
        state.reminders.push(r);
        return ['OK', remLine(r, ['0'])].join('\n');
      }
      const r = state.reminders.find((x) => (a.startsWith('x-apple-reminder://') ? x.id === a : x.name === a && !x.done));
      if (!r) return 'ERR\tscript\t-1728\tCan’t get reminder.';
      r.done = true;
      return ['OK', remLine(r, ['1'])].join('\n');
    },
    Calendar([y1, m1, d1, s1, y2, m2, d2, s2, max]) {
      const from = iso(y1, m1, d1, s1), to = iso(y2, m2, d2, s2);
      const hits = state.events.filter((e) => e.start < to && e.end > from);
      return ['OK', ...hits.slice(0, Number(max)).map((e) => line('ev', e.title, e.start, e.end, e.allDay ? '1' : '0', e.location, e.cal)), `count\t${hits.length}`].join('\n');
    },
    Mail([op, a, b, ...rest]) {
      if (op === 'unread') {
        const hits = state.mail.filter((m) => !m.read);
        return ['OK', `count\t${hits.length}`, ...hits.slice(0, Number(a)).map(msgLine)].join('\n');
      }
      if (op === 'read') {
        const m = state.mail.find((x) => x.id === Number(a));
        if (!m) return 'ERR\tscript\t-1719\tCan’t get message.';
        return ['OK', `size\t${m.text.length}`, line('text', m.text.slice(0, Number(b))), msgLine(m)].join('\n');
      }
      state.drafts.push({ subject: a, text: b, to: rest });
      return ['OK', `draft\t${rest.length}`].join('\n');
    },
  };
  const run = async (script, args, opts) => {
    const app = SCRIPT_NAMES.get(script);
    calls.push({ app, script, args, opts });
    assert.ok(app, 'only the fixed scripts are ever run');
    for (const a of args) assert.equal(typeof a, 'string', 'every argument is text');
    if (fail) throw fail;
    if (closed.includes(/** @type {string} */ (app))) return 'ERR\tnot_running';
    return `${answer || apps[/** @type {string} */ (app)](args)}\n`;
  };
  return { run, calls, state };
}

/** A throwaway home folder with a few things in it. */
function fakeHome() {
  const home = path.join(dirs.root, `home-${Math.random().toString(36).slice(2)}`);
  for (const d of ['Documents/Taxes', 'Desktop', 'Downloads', 'Library/Mail', '.ssh']) fs.mkdirSync(path.join(home, d), { recursive: true });
  for (const f of ['Documents/Taxes/2025.pdf', 'Documents/letter.txt', 'Desktop/shot.png', 'Library/Mail/secret.mbox', '.ssh/id_key']) fs.writeFileSync(path.join(home, f), 'x');
  return home;
}

/** The adapters over the pretend Mac, and the real ComputerUse in front of them. */
function setup(o = {}) {
  const mac = fakeMac(o);
  const home = fakeHome();
  const revealed = [];
  const apps = new Apps({ run: mac.run, home, now: () => new Date(2026, 9, 3, 15, 0).getTime(), reveal: async (p) => { revealed.push(p); return { revealed: path.basename(p) }; }, resolve: (to) => { if (to === 'c_1234abcd') return { name: 'Sam Lee', handle: 'sam.lee42@example.com' }; throw new Error('unknown'); } });
  const computer = new ComputerUse({ apps, logFile, confirmSettleMs: 0 });
  const at = (...p) => path.join(home, ...p);
  return { ...mac, home, apps, computer, at, revealed };
}

test('the wire format: any text comes back whole, and an answer Echo cannot read is an error', () => {
  for (const s of NASTY) assert.deepEqual(parseAnswer(`OK\n${line('note', s, s)}\n`).rows, [['note', s, s]], s);
  assert.deepEqual(parseAnswer('ERR\tlocked'), { error: 'locked', num: 0, message: '' });
  assert.deepEqual(parseAnswer('ERR\tscript\t-1743\tNot authorised'), { error: 'script', num: -1743, message: 'Not authorised' });
  assert.equal(parseAnswer('').error, 'failed');
  assert.equal(parseAnswer('something else').error, 'failed');
});

test('dates go in as numbers, in this Mac\'s own time', () => {
  assert.deepEqual(dateArgs(/** @type {Date} */ (localDate('2026-10-03'))), ['2026', '10', '3', '0']);
  assert.deepEqual(dateArgs(/** @type {Date} */ (localDate('2026-10-03T14:05'))), ['2026', '10', '3', String(14 * 3600 + 5 * 60)]);
  for (const no of ['', 'tomorrow', '10/03/2026', '2026-13-40', '2026-10-03T25:00', '2026-10-03"; do shell script "x', null]) assert.equal(localDate(no), null, String(no));
});

test('the scripts are fixed text: never an app started, a shell run, or mail put on its way', () => {
  for (const [script, app] of SCRIPT_NAMES) {
    assert.doesNotMatch(script, /do shell script|run script|\$\{/, `${app}: nothing spliced in, no shell`);
    assert.doesNotMatch(script, /\b(?:launch|quit)\b/, `${app}: never starts or quits an app`);
    assert.match(script, /with timeout of 5 seconds/, `${app}: the app's own answer has a time limit`);
    if (app !== 'Finder') assert.match(script, new RegExp(`if application "${app}" is not running then return "ERR" & \\|TB\\| & "not_running"`), `${app}: answers not_running rather than opening`);
  }
  assert.doesNotMatch(MAIL_SCRIPT, /\bsend\b/i, 'the Mail script has no send in it at all');
  for (const s of [NOTES_SCRIPT, REMINDERS_SCRIPT, MAIL_SCRIPT, CALENDAR_SCRIPT]) assert.doesNotMatch(s, /\bdelete\b/i, 'only Finder has a delete (its move to the Trash)');
  assert.equal((FINDER_SCRIPT.match(/\bdelete\b/g) || []).length, 1);
});

test('Notes: find, read, create and append against the fake app; a locked note is never opened', async () => {
  const { apps, calls, state } = setup();
  const found = await apps.call('notes_find', { text: 'cheese' });
  assert.equal(found.found, 2);
  assert.deepEqual(found.notes.map((n) => n.title), ['Shopping', 'Diary']);
  assert.equal(found.notes[0].id, 'x-coredata://A1/ICNote/p1');
  assert.equal(JSON.stringify(found).includes('private thoughts'), false, 'a search gives titles, not text');
  const read = await apps.call('notes_read', { note: found.notes[0].id });
  assert.equal(read.text, 'Shopping\noat milk\nthe blue cheese');
  assert.equal(read.title, 'Shopping');
  assert.equal((await apps.call('notes_read', { note: 'Diary' })).error, 'locked');
  assert.equal((await apps.call('notes_read', { note: 'No such note' })).error, 'not_found');
  assert.equal((await apps.call('notes_read', {})).error, 'not_found');
  const made = await apps.call('notes_create', { title: 'Gift ideas', text: 'a scarf\n\na <big> book & pen', folder: 'Travel' });
  assert.equal(made.done, true);
  assert.deepEqual(calls.at(-1).args, ['create', '<div><h1>Gift ideas</h1></div><div>a scarf</div><div><br></div><div>a &lt;big&gt; book &amp; pen</div>', 'Travel']);
  assert.equal((await apps.call('notes_create', { text: 'no title' })).error, 'bad_note');
  const added = await apps.call('notes_append', { note: 'Shopping', text: 'eggs' });
  assert.equal(added.done, true);
  assert.equal(state.notes[0].html, '<div>eggs</div>');
  assert.equal((await apps.call('notes_append', { note: 'Trip', text: 'x' })).error, 'has_attachments', 'a note with a picture in it is left alone');
  assert.match((await apps.call('notes_append', { note: 'Trip', text: 'x' })).message, /Nothing was changed/);
  assert.equal((await apps.call('notes_append', { note: 'Shopping', text: '  ' })).error, 'bad_note');
  assert.equal(toHtml('a\r\nb'), '<div>a</div><div>b</div>');
  assert.ok(calls.every((c) => c.script === NOTES_SCRIPT && c.opts.timeoutMs === APP_TIMEOUT_MS));
  assert.equal(APP_TIMEOUT_MS, 6000);
});

test('an append that did not land is not called done', async () => {
  const { apps } = setup({ answer: 'OK\ngrew\t0\nnote\tx-coredata://A1/ICNote/p1\tShopping\t\tNotes' });
  const r = await apps.call('notes_append', { note: 'Shopping', text: 'eggs' });
  assert.equal(r.done, false);
  assert.match(r.note, /NOT confirmed/);
});

test('Reminders: list, add (a day or a time) and complete, read back', async () => {
  const { apps, calls, state } = setup();
  const all = await apps.call('reminders_list', {});
  assert.equal(all.open, 2);
  assert.deepEqual(all.reminders, [{ id: 'x-apple-reminder://R1', title: 'Call the dentist', due: '2026-10-05T09:00', list: 'Reminders' }, { id: 'x-apple-reminder://R2', title: 'Buy stamps', list: 'Errands' }]);
  assert.equal((await apps.call('reminders_list', { list: 'Errands' })).reminders.length, 1);
  assert.equal((await apps.call('reminders_list', { list: 'Nope' })).error, 'not_found');
  const timed = await apps.call('reminders_add', { title: 'Water the plants', due: '2026-10-04T18:30', list: 'Errands', notes: 'the fern too' });
  assert.equal(timed.done, true);
  assert.deepEqual(calls.at(-1).args, ['add', 'Water the plants', 'Errands', '1', '2026', '10', '4', String(18 * 3600 + 30 * 60), 'the fern too']);
  assert.equal(timed.added.due, '2026-10-04T18:30');
  await apps.call('reminders_add', { title: 'Passport', due: '2026-11-01' });
  assert.deepEqual(calls.at(-1).args.slice(2, 8), ['', '2', '2026', '11', '1', '0'], 'a bare date is a whole day');
  await apps.call('reminders_add', { title: 'Someday' });
  assert.equal(calls.at(-1).args[3], '0');
  assert.equal((await apps.call('reminders_add', { title: 'x', due: 'next tuesday' })).error, 'bad_date');
  assert.equal((await apps.call('reminders_add', { title: ' ' })).error, 'bad_reminder');
  const done = await apps.call('reminders_complete', { reminder: 'x-apple-reminder://R2' });
  assert.equal(done.done, true);
  assert.equal(state.reminders[1].done, true);
  assert.equal((await apps.call('reminders_complete', { reminder: 'Never existed' })).error, 'not_found');
});

test('a reminder Reminders still shows as open is not called done', async () => {
  const { apps } = setup({ answer: 'OK\nrem\tx-apple-reminder://R2\tBuy stamps\t\tErrands\t0' });
  const r = await apps.call('reminders_complete', { reminder: 'Buy stamps' });
  assert.equal(r.done, false);
  assert.match(r.note, /NOT confirmed/);
});

test('Calendar: today by default, one day, or a stretch of days; soonest first', async () => {
  const { apps, calls } = setup();
  const today = await apps.call('calendar_today', {});
  assert.deepEqual(calls.at(-1).args, ['2026', '10', '3', '0', '2026', '10', '4', '0', '40']);
  assert.deepEqual(today.events.map((e) => e.title), ['Standup', 'Dinner with Sam']);
  assert.deepEqual(today.events[1], { title: 'Dinner with Sam', start: '2026-10-03T19:00', end: '2026-10-03T21:00', location: 'The Corner Place', calendar: 'Home' });
  assert.match(today.note, /Repeating events/);
  const week = await apps.call('calendar_today', { from: '2026-10-03', to: '2026-10-07' });
  assert.deepEqual(calls.at(-1).args.slice(4, 8), ['2026', '10', '8', '0'], 'the last day is included');
  assert.equal(week.events.length, 3);
  assert.equal(week.events[2].all_day, true);
  assert.equal((await apps.call('calendar_today', { from: '2026-10-05' })).events.length, 0);
  assert.equal((await apps.call('calendar_today', { from: 'friday' })).error, 'bad_date');
  assert.equal((await apps.call('calendar_today', { from: '2026-10-05', to: '2026-10-01' })).error, 'bad_date');
  assert.equal((await apps.call('calendar_today', { from: '2026-01-01', to: '2026-12-31' })).error, 'too_big');
  assert.ok(!APP_TOOL_NAMES.some((n) => /calendar_(add|create)/.test(n)), 'adding an event stays add_calendar_event');
});

test('Mail: unread is senders and subjects only; one message is read by id; a draft stays a draft', async () => {
  const { apps, calls, state } = setup();
  const unread = await apps.call('mail_unread', {});
  assert.equal(unread.unread, 2);
  assert.deepEqual(unread.messages[0], { id: 501, subject: 'Your invoice 4471', from: 'Billing <billing@example.com>', received: '2026-10-03T08:01' });
  assert.equal(JSON.stringify(unread).includes('Secret code'), false, 'never what a message says');
  const one = await apps.call('mail_read', { id: 501 });
  assert.equal(one.text, 'Amount due: 42 dollars. Secret code 9911.');
  assert.equal(state.mail[0].read, false, 'reading it here does not mark it read');
  assert.equal((await apps.call('mail_read', { id: 999 })).error, 'not_found');
  for (const bad of ['501; delete', -1, 1.5, undefined]) assert.equal((await apps.call('mail_read', { id: bad })).error, 'not_found', String(bad));
  const n = calls.length;
  const d = await apps.call('mail_draft', { to: ['c_1234abcd', 'pat@example.org'], subject: 'Lunch', text: 'Noon works.\nSee you there.' });
  assert.equal(d.done, true);
  assert.match(d.note, /has NOT gone out/);
  assert.equal(JSON.stringify(d).includes('sam.lee42'), false, 'the assistant never sees the address behind a contact id');
  assert.deepEqual(state.drafts, [{ subject: 'Lunch', text: 'Noon works.\nSee you there.', to: ['sam.lee42@example.com', 'pat@example.org'] }]);
  assert.equal((await apps.call('mail_draft', { to: ['someone'], text: 'hi' })).error, 'bad_recipient');
  assert.equal((await apps.call('mail_draft', { to: ['a@b.c, x@y.z'], text: 'hi' })).error, 'bad_recipient', 'one address each');
  assert.equal((await apps.call('mail_draft', {})).error, 'bad_draft');
  assert.equal(calls.length, n + 1, 'a draft that is refused never reaches Mail');
  assert.ok(!APP_TOOL_NAMES.some((name) => /send/.test(name)));
});

test('hostile text goes in as arguments and comes back whole, through one unchanging script', async () => {
  const { apps, calls, state } = setup();
  for (const s of NASTY) {
    await apps.call('notes_find', { text: s });
    assert.equal(calls.at(-1).args[1], s.trim());
    await apps.call('notes_create', { title: 'T', text: s });
    await apps.call('reminders_add', { title: s, notes: s, list: s });
    assert.deepEqual([calls.at(-1).args[1], calls.at(-1).args[2], calls.at(-1).args[8]], [s.trim(), s.trim(), s]);
    await apps.call('reminders_complete', { reminder: s });
    assert.equal(calls.at(-1).args[1], s.trim());
    await apps.call('mail_draft', { subject: s, text: s });
    assert.deepEqual(state.drafts.at(-1), { subject: s.trim(), text: s, to: [] });
    // And back out: a title with tabs, quotes and line ends is one field again.
    state.reminders.push({ id: 'x-apple-reminder://N', name: s, due: '', list: s, done: false });
    const back = (await apps.call('reminders_list', {})).reminders.at(-1);
    assert.deepEqual([back.title, back.list], [s, s]);
    state.reminders.pop();
  }
  for (const c of calls) {
    assert.ok([NOTES_SCRIPT, REMINDERS_SCRIPT, MAIL_SCRIPT].includes(c.script), 'the script is the fixed one, byte for byte');
    for (const s of NASTY) assert.equal(c.script.includes(s), false);
  }
});

test('errors: not running (offer to open it), not allowed (which Settings page), not found, too slow', async () => {
  const closed = setup({ closed: ['Notes', 'Mail', 'Calendar', 'Reminders'] });
  for (const [tool, args, app] of /** @type {Array<[string, any, string]>} */ ([['notes_find', {}, 'Notes'], ['mail_unread', {}, 'Mail'], ['calendar_today', {}, 'Calendar'], ['reminders_list', {}, 'Reminders']])) {
    const r = await closed.apps.call(tool, args);
    assert.equal(r.error, 'not_running', tool);
    assert.match(r.message, new RegExp(`${app} isn't open.*Offer to open it \\(open_app "${app}"\\)`), tool);
  }
  const denied = setup({ fail: Object.assign(new Error('Command failed'), { stderr: 'execution error: Not authorized to send Apple events to Notes. (-1743)' }) });
  const no = await denied.apps.call('notes_find', {});
  assert.equal(no.error, 'not_allowed');
  assert.match(no.message, /System Settings, Privacy & Security, Automation, and switch on Notes under Echo/);
  assert.match((await denied.apps.call('calendar_today', {})).message, /Automation.*Privacy & Security, Calendars/);
  assert.match((await denied.apps.call('reminders_list', {})).message, /Privacy & Security, Reminders/);
  assert.equal((await setup({ answer: 'ERR\tscript\t-1743\tNot authorised' }).apps.call('mail_unread', {})).error, 'not_allowed');
  assert.equal((await setup({ answer: 'ERR\tscript\t-600\tApplication isn’t running.' }).apps.call('mail_unread', {})).error, 'not_running');
  assert.equal((await setup({ answer: 'ERR\tscript\t-1728\tCan’t get it.' }).apps.call('notes_read', { note: 'x' })).error, 'not_found');
  const slow = await setup({ fail: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) }).apps.call('mail_unread', {});
  assert.equal(slow.error, 'timeout');
  assert.match(slow.message, /didn't answer in time/);
  assert.equal((await setup({ answer: 'ERR\tscript\t-1712\tAppleEvent timed out.' }).apps.call('mail_unread', {})).error, 'timeout');
  assert.equal((await setup({ answer: 'ERR\tscript\t-50\tSomething odd' }).apps.call('mail_unread', {})).error, 'failed');
  assert.equal((await setup({ answer: 'garbage' }).apps.call('mail_unread', {})).error, 'failed');
  assert.equal((await closed.apps.call('notes_delete', {})).error, 'bad_action');
});

test('paths: only the user\'s own things inside home; never "..", a hidden file, the Library, a system folder or a link out', () => {
  const home = fakeHome();
  const outside = path.join(dirs.root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'theirs.txt'), 'x');
  fs.symlinkSync(outside, path.join(home, 'Documents', 'way-out'));
  fs.symlinkSync(path.join(home, 'Library'), path.join(home, 'Documents', 'to-library'));
  fs.symlinkSync(path.join(home, 'Documents', 'Taxes'), path.join(home, 'Desktop', 'taxes-link'));
  const ok = (p, o = {}) => checkPath(p, { home, ...o });
  assert.equal(ok(path.join(home, 'Documents', 'letter.txt')).path, path.join(home, 'Documents', 'letter.txt'));
  assert.equal(ok('~/Documents/Taxes').path, path.join(home, 'Documents', 'Taxes'));
  assert.equal(ok('~').path, home);
  assert.equal(ok(`${home}/Documents/./Taxes/../letter.txt`).path, path.join(home, 'Documents', 'letter.txt'), 'a path is made plain first');
  assert.equal(ok('~/Desktop/taxes-link').path, path.join(home, 'Desktop', 'taxes-link'), 'a link that stays inside home is fine');
  for (const no of [
    '', 'Documents/letter.txt', './x', `${home}/../outside/theirs.txt`, '~/Documents/../../outside/theirs.txt', '~/../..',
    '/', '/System', '/System/Library/CoreServices', '/Applications', '/etc/hosts', '/usr/bin', '/private/var/db', '/Library/Preferences', '/Volumes/Backup/x', path.join(outside, 'theirs.txt'),
    '~/Library', '~/Library/Mail/secret.mbox', '~/.ssh/id_key', '~/.ssh', '~/Documents/.hidden',
    '~/Documents/way-out', '~/Documents/way-out/theirs.txt', '~/Documents/to-library/Mail/secret.mbox',
    `${home}/Documents/letter.txt\0.png`, null, undefined, 42,
  ]) assert.match(String(ok(no).error), /bad_path|not_found/, String(no));
  assert.equal(ok('~/Documents/way-out/theirs.txt').error, 'bad_path');
  assert.match(ok('~/Documents/way-out').message, /link to somewhere outside/);
  assert.equal(ok('~/Documents/nothing-here.txt').error, 'not_found');
  // The home folder and the Mac's own folders in it can be looked into, never moved, renamed or trashed.
  for (const own of ['~', '~/Desktop', '~/Documents', '~/Downloads']) {
    assert.equal(ok(own).error, undefined, own);
    assert.equal(ok(own, { change: true }).error, 'bad_path', own);
  }
  assert.equal(ok('~/Documents/Taxes', { change: true }).error, undefined);
  // Echo's own files, even inside a home.
  assert.equal(checkPath(dirs.data, { home: dirs.root }).error, 'bad_path');
});

test('Finder: list, new folder, move and rename by the file system; nothing is ever replaced', async () => {
  const { apps, at, calls, revealed } = setup();
  const top = await apps.call('finder_list', {});
  assert.deepEqual(top.items.map((i) => i.name), ['Desktop', 'Documents', 'Downloads'], 'no hidden files, no Library');
  const docs = await apps.call('finder_list', { path: '~/Documents' });
  assert.equal(docs.count, 2);
  assert.deepEqual(docs.items.map((i) => [i.name, Boolean(i.folder), i.size]), [['letter.txt', false, 1], ['Taxes', true, undefined]]);
  assert.match(docs.items[0].changed, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await apps.call('finder_list', { path: '~/Documents/letter.txt' })).error, 'not_found');
  assert.equal((await apps.call('finder_list', { path: '/etc' })).error, 'bad_path');
  fs.mkdirSync(at('Downloads', 'many'));
  for (let i = 0; i < LIST_MAX + 5; i++) fs.writeFileSync(at('Downloads', 'many', `f${i}.txt`), '');
  const big = await apps.call('finder_list', { path: at('Downloads', 'many') });
  assert.equal(big.items.length, LIST_MAX);
  assert.match(big.note, /first 100 of 105/);

  const made = await apps.call('finder_new_folder', { name: 'Receipts', in: '~/Documents' });
  assert.equal(made.created, at('Documents', 'Receipts'));
  assert.ok(fs.statSync(at('Documents', 'Receipts')).isDirectory());
  assert.equal((await apps.call('finder_new_folder', { name: 'Receipts', in: '~/Documents' })).error, 'exists');
  for (const bad of ['', '.hidden', 'a/b', '../up', 'a:b', '..']) assert.equal((await apps.call('finder_new_folder', { name: bad, in: '~/Documents' })).error, 'bad_name', bad);
  assert.equal((await apps.call('finder_new_folder', { name: 'x', in: '/tmp' })).error, 'bad_path');

  const moved = await apps.call('finder_move', { paths: ['~/Documents/letter.txt', '~/Desktop/shot.png'], to: '~/Documents/Receipts' });
  assert.equal(moved.moved, 2);
  assert.ok(fs.existsSync(at('Documents', 'Receipts', 'letter.txt')) && fs.existsSync(at('Documents', 'Receipts', 'shot.png')));
  assert.ok(!fs.existsSync(at('Documents', 'letter.txt')));
  fs.writeFileSync(at('Desktop', 'letter.txt'), 'the other one');
  const clash = await apps.call('finder_move', { paths: ['~/Desktop/letter.txt'], to: '~/Documents/Receipts' });
  assert.equal(clash.error, 'exists');
  assert.equal(fs.readFileSync(at('Documents', 'Receipts', 'letter.txt'), 'utf8'), 'x', 'the one already there is untouched');
  assert.equal((await apps.call('finder_move', { paths: ['~/Documents/Receipts'], to: '~/Documents/Receipts' })).error, 'bad_path', 'not into itself');
  assert.equal((await apps.call('finder_move', { paths: ['~/Documents'], to: '~/Desktop' })).error, 'bad_path', 'never one of the Mac\'s own folders');
  assert.equal((await apps.call('finder_move', { paths: ['~/Desktop/letter.txt'], to: '/tmp' })).error, 'bad_path');
  assert.equal((await apps.call('finder_move', { paths: ['~/Desktop/letter.txt'], to: '~/Documents/Receipts/shot.png' })).error, 'not_found', 'into a folder, not a file');
  assert.equal((await apps.call('finder_move', { paths: [], to: '~/Desktop' })).error, 'bad_path');

  const renamed = await apps.call('finder_rename', { items: [{ path: '~/Desktop/letter.txt', name: 'Letter to the bank.txt' }] });
  assert.equal(renamed.renamed, 1);
  assert.ok(fs.existsSync(at('Desktop', 'Letter to the bank.txt')));
  assert.equal((await apps.call('finder_rename', { items: [{ path: '~/Documents/Receipts/shot.png', name: 'letter.txt' }] })).error, 'exists');
  assert.equal((await apps.call('finder_rename', { items: [{ path: '~/Documents/Receipts/shot.png', name: '../../shot.png' }] })).error, 'bad_name');
  assert.equal((await apps.call('finder_rename', { items: [{ path: '~/Documents/Receipts/shot.png', name: 'a.png' }, { path: '~/Documents/Receipts/letter.txt', name: 'A.png' }] })).error, 'exists', 'two things may not end up with one name');
  assert.ok(fs.existsSync(at('Documents', 'Receipts', 'shot.png')), 'nothing was renamed when one of them could not be');
  assert.equal((await apps.call('finder_rename', { items: [{ path: '~/Desktop', name: 'Stuff' }] })).error, 'bad_path');

  const shown = await apps.call('finder_reveal', { path: '~/Documents/Receipts/shot.png' });
  assert.equal(shown.revealed, 'shot.png');
  assert.deepEqual(revealed, [at('Documents', 'Receipts', 'shot.png')]);
  assert.equal((await apps.call('finder_reveal', { path: '/etc/hosts' })).error, 'bad_path');
  assert.equal(calls.length, 0, 'none of that needed a script');
});

test('the Trash: through Finder, never a link, and checked afterwards', async () => {
  const { apps, at, calls, state } = setup();
  fs.symlinkSync(at('Documents', 'Taxes'), at('Desktop', 'taxes-link'));
  assert.equal((await apps.call('finder_trash', { paths: ['~/Desktop/taxes-link'] })).error, 'bad_path', 'Finder would trash what the link points at');
  assert.equal((await apps.call('finder_trash', { paths: ['~/Documents'] })).error, 'bad_path');
  assert.equal((await apps.call('finder_trash', { paths: ['~/Library/Mail/secret.mbox'] })).error, 'bad_path');
  assert.equal((await apps.call('finder_trash', { paths: ['/etc/hosts'] })).error, 'bad_path');
  assert.equal((await apps.call('finder_trash', { paths: ['~/Documents/letter.txt', '~/Documents/gone.txt'] })).error, 'not_found');
  assert.equal(calls.length, 0, 'none of those reached Finder');
  const r = await apps.call('finder_trash', { paths: ['~/Documents/letter.txt', '~/Documents/Taxes'] });
  assert.equal(r.done, true);
  assert.equal(r.trashed, 2);
  assert.match(r.note, /not deleted/);
  assert.deepEqual(calls[0].args, [at('Documents', 'letter.txt'), at('Documents', 'Taxes')]);
  assert.equal(calls[0].script, FINDER_SCRIPT);
  assert.equal(calls[0].opts.timeoutMs, 6000);
  assert.ok(fs.existsSync(path.join(state.trash, 'letter.txt')) && fs.existsSync(path.join(state.trash, 'Taxes', '2025.pdf')), 'moved, with what was inside, not deleted');
  // Finder said OK but the file is still there: never "it's in the Trash".
  const stuck = setup({ trashWorks: false });
  const s = await stuck.apps.call('finder_trash', { paths: ['~/Desktop/shot.png'] });
  assert.equal(s.error, 'failed');
  assert.match(s.message, /still where they were/);
});

test('policy: the Trash always asks; a move or a rename asks above ten', () => {
  assert.equal(FILES_MAX, 10);
  for (const n of [1, 3, 50]) {
    const v = classifyByEffect({ action: 'app_files', op: 'trash', count: n });
    assert.deepEqual([v.level, v.tier, v.category], ['risky', 2, 'trash'], `trash ${n}`);
  }
  assert.ok(!SAY_SO_CATEGORIES.includes('trash') && !SAY_SO_CATEGORIES.includes('move'), 'no words of the user\'s wave these through');
  for (const op of ['move', 'rename']) {
    assert.equal(classifyByEffect({ action: 'app_files', op, count: 10 }).level, 'ok', `${op} 10`);
    const v = classifyByEffect({ action: 'app_files', op, count: 11 });
    assert.deepEqual([v.level, v.tier, v.category], ['risky', 2, 'move'], `${op} 11`);
    assert.match(String(v.reason), new RegExp(`^${op} 11 things at once`));
  }
});

test('the confirmation card: any trash waits for a yes, and a no leaves the file where it was', async (t) => {
  saveSettings({ computerUse: true });
  process.env.ECHO_FLAG_POLICY = '1';
  t.after(() => delete process.env.ECHO_FLAG_POLICY);
  const { computer, at, calls } = setup();
  const cards = [];
  computer.on('confirm_request', (c) => cards.push(c));
  // Even when the user's own words this turn were "delete it".
  computer.instruct('delete it');
  const asked = await computer.app('finder_trash', { paths: ['~/Documents/letter.txt'] });
  assert.equal(asked.waitingForConfirmation, true);
  assert.equal(asked.what, 'move “letter.txt” to the Trash');
  assert.match(asked.why, /move one thing to the Trash/);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].category, 'trash');
  assert.equal(calls.length, 0, 'nothing reached Finder');
  assert.ok(fs.existsSync(at('Documents', 'letter.txt')));
  // While the card is up, nothing else changes.
  assert.equal((await computer.app('notes_create', { title: 'x' })).error, 'waiting_for_confirmation');
  assert.equal((await computer.app('finder_new_folder', { name: 'x' })).error, 'waiting_for_confirmation');
  assert.equal((await computer.app('notes_find', {})).found, 3, 'reading is still fine');
  const no = await computer.confirm(asked.confirmId, false, 'window');
  assert.equal(no.cancelled, true);
  assert.ok(fs.existsSync(at('Documents', 'letter.txt')));

  const again = await computer.app('finder_trash', { paths: ['~/Documents/letter.txt', '~/Desktop/shot.png'] });
  assert.equal(again.what, 'move 2 items to the Trash');
  const yes = await computer.confirm(again.confirmId, true, 'window');
  assert.equal(yes.done, true);
  assert.equal(yes.trashed, 2);
  assert.equal(yes.undo, undefined, 'the Trash itself is the way back');
  assert.ok(!fs.existsSync(at('Documents', 'letter.txt')) && !fs.existsSync(at('Desktop', 'shot.png')));
  assert.equal((await computer.confirm(again.confirmId, true, 'window')).error, 'stale');
  // A bad path is refused before any card goes up.
  assert.equal((await computer.app('finder_trash', { paths: ['/etc/hosts'] })).error, 'bad_path');
  assert.equal(computer.pendingList().length, 0);
});

test('the confirmation card: ten files move at once, eleven wait; and what was approved is checked again', async () => {
  saveSettings({ computerUse: true });
  const { computer, at } = setup();
  fs.mkdirSync(at('Documents', 'Sorted'));
  const files = Array.from({ length: 21 }, (_, i) => `~/Downloads/photo-${i}.jpg`);
  for (let i = 0; i < 21; i++) fs.writeFileSync(at('Downloads', `photo-${i}.jpg`), 'x');
  const ten = await computer.app('finder_move', { paths: files.slice(0, 10), to: '~/Documents/Sorted' });
  assert.equal(ten.moved, 10);
  assert.equal(ten.count, undefined, 'the count is for the log, not the assistant');
  const eleven = await computer.app('finder_move', { paths: files.slice(10), to: '~/Documents/Sorted' });
  assert.equal(eleven.waitingForConfirmation, true);
  assert.equal(eleven.what, 'move 11 items into “Sorted”');
  assert.ok(fs.existsSync(at('Downloads', 'photo-10.jpg')), 'nothing moved yet');
  const went = await computer.confirm(eleven.confirmId, true, 'window');
  assert.equal(went.moved, 11);
  assert.equal(fs.readdirSync(at('Documents', 'Sorted')).length, 21);

  const names = fs.readdirSync(at('Documents', 'Sorted')).map((n, i) => ({ path: at('Documents', 'Sorted', n), name: `Holiday ${i + 1}.jpg` }));
  assert.equal((await computer.app('finder_rename', { items: names.slice(0, 10) })).renamed, 10);
  const many = await computer.app('finder_rename', { items: names.slice(10) });
  assert.equal(many.waitingForConfirmation, true);
  assert.equal(many.what, 'rename 11 items');
  // One of them goes away before the user says yes: the yes does not rename the rest blindly.
  fs.rmSync(names[15].path);
  const late = await computer.confirm(many.confirmId, true, 'window');
  assert.equal(late.error, 'not_found');
  assert.ok(fs.existsSync(names[10].path), 'nothing was renamed');
});

test('with computer use off the app tools still work, and a card is answered in the window', async () => {
  saveSettings({ computerUse: false });
  const { computer, at } = setup();
  assert.equal((await computer.app('reminders_list', {})).open, 2);
  const asked = await computer.app('finder_trash', { paths: ['~/Desktop/shot.png'] });
  assert.equal(asked.waitingForConfirmation, true);
  assert.match(asked.note, /the user answers on the card/);
  assert.doesNotMatch(asked.note, /confirm_action/);
  assert.equal((await computer.confirm(asked.confirmId, true, 'window')).done, true);
  assert.ok(!fs.existsSync(at('Desktop', 'shot.png')));
  saveSettings({ computerUse: true });
  assert.equal((await new ComputerUse({ logFile }).app('notes_find', {})).error, 'unsupported');
});

test('the logs and the timeline carry the tool, a count, how long and whether it worked: never a word of what was read or named', async () => {
  fs.rmSync(logFile, { force: true });
  const since = Date.now() - 1000;
  const { computer, state } = setup();
  const secret = 'Zanzibar-7731';
  state.notes.push({ id: 'x-coredata://A1/ICNote/p9', name: `${secret} plans`, text: `${secret} is the plan`, folder: secret, locked: false, files: 0 });
  state.mail.push({ id: 777, subject: `${secret} invoice`, from: `${secret} <pay@example.com>`, at: '2026-10-03T10:00:00', text: `pay ${secret}`, read: false });
  state.events.push({ title: `${secret} dinner`, start: '2026-10-03T20:00:00', end: '2026-10-03T21:00:00', allDay: false, location: secret, cal: 'Home' });
  state.reminders.push({ id: 'x-apple-reminder://S', name: `${secret} call`, due: '', list: 'Reminders', done: false });
  fs.writeFileSync(path.join(computer.apps.finder.home, 'Documents', `${secret}.txt`), 'x');
  const said = [
    await computer.app('notes_find', { text: secret }),
    await computer.app('notes_read', { note: `${secret} plans` }),
    await computer.app('notes_create', { title: `${secret} list`, text: secret }),
    await computer.app('notes_append', { note: `${secret} plans`, text: secret }),
    await computer.app('mail_unread', {}),
    await computer.app('mail_read', { id: 777 }),
    await computer.app('mail_draft', { subject: secret, text: secret }),
    await computer.app('calendar_today', {}),
    await computer.app('reminders_list', {}),
    await computer.app('reminders_add', { title: `${secret} again` }),
    await computer.app('reminders_complete', { reminder: `${secret} call` }),
    await computer.app('finder_list', { path: '~/Documents' }),
    await computer.app('finder_new_folder', { name: secret, in: '~/Documents' }),
    await computer.app('finder_rename', { items: [{ path: `~/Documents/${secret}.txt`, name: `${secret} 2.txt` }] }),
    await computer.app('notes_read', { note: `${secret} missing` }),
  ];
  const card = await computer.app('finder_trash', { paths: [`~/Documents/${secret} 2.txt`] });
  await computer.confirm(card.confirmId, true, 'window');
  assert.ok(said.slice(0, 14).every((r) => !r.error), 'every call worked');
  assert.ok(JSON.stringify(said).includes(secret), 'the assistant did get it');
  const lines = logged();
  assert.equal(JSON.stringify(lines).includes(secret), false, 'not in the computer log');
  assert.equal(JSON.stringify(lines).includes('Zanzibar'), false);
  const rows = lines.filter((l) => l.event === 'app');
  assert.equal(rows.length, 17, 'one line per call (the trash: one when asked, one when done)');
  for (const l of rows) assert.deepEqual(Object.keys(l).filter((k) => !['at', 'event', 'tool', 'count', 'ms', 'ok', 'why'].includes(k)), [], JSON.stringify(l));
  assert.deepEqual(rows.map((l) => [l.tool, l.count, l.ok]).slice(0, 5), [['notes_find', 1, true], ['notes_read', 1, true], ['notes_create', 1, true], ['notes_append', 1, true], ['mail_unread', 3, true]]);
  assert.deepEqual([rows[14].tool, rows[14].ok, rows[14].why], ['notes_read', false, 'not_found']);
  assert.deepEqual([rows[15].why, rows[16].ok, rows[16].count], ['ask', true, 1]);
  const timeline = readTimeline(dirs.data, since);
  assert.equal(JSON.stringify(timeline).includes('Zanzibar'), false, 'not in the timeline');
  assert.ok(timeline.some((r) => r.type === 'mac.app' && r.f.tool === 'mail_read' && r.f.count === 1 && r.f.ok === true));
  assert.deepEqual(safeFields('mac.app', { tool: 'mail_read', count: 1, ms: 12, ok: true, subject: 'x', text: 'y', path: '/z', target: 'q' }), { ok: true, ms: 12, tool: 'mail_read', count: 1 });
});

test('the tools are registered with the others, and the guidance says to prefer them over clicking', async () => {
  const mac = fakeMac();
  const q = new QuickActions({ exec: async (file, args, input) => mac.run(input, args.slice(args.indexOf('-') + 1), {}) });
  const d = new Dispatcher(new TaskManager({ queryFn: async function* () {} }), null, q);
  saveSettings({ computerUse: false });
  const tools = Object.fromEntries(d.toolList().map((t) => [t.name, /** @type {any} */ (t)]));
  for (const name of APP_TOOL_NAMES) assert.ok(tools[name], `${name} is offered, with computer use off too`);
  assert.equal(APP_TOOL_NAMES.length, 17);
  for (const name of APP_TOOL_NAMES) assert.ok(tools[name].description.length <= 130, `${name}: a short description`);
  // A tool call end to end, on the quick actions' own AppleScript runner.
  const r = await tools.mail_unread.handler({}, {});
  assert.equal(JSON.parse(r.content[0].text).unread, 2);
  assert.deepEqual(mac.calls.at(-1).args, ['unread', '15']);
  const bad = await tools.finder_list.handler({ path: '/etc' }, {});
  assert.equal(bad.isError, true);
  assert.equal(JSON.parse(bad.content[0].text).error, 'bad_path');
  assert.match(d.systemPrompt(), /In Finder, Notes, Reminders, Calendar and Mail, use the finder_, notes_, reminders_, calendar_ and mail_ tools .* instead of clicking or typing in those apps/);
});

test('what a personal tool was given is not kept in the turn record or shown as activity: only its name', async () => {
  const { toolNote } = await import('../lib/dispatcher.js');
  assert.equal(toolNote({ name: 'mcp__ops__notes_create', input: { title: 'Private plans', text: 'the whole note' } }), 'notes_create');
  assert.equal(toolNote({ name: 'mail_draft', input: { to: 'x', body: 'secret' } }), 'mail_draft');
  assert.equal(toolNote({ name: 'sheet_write', input: { ref: 'A1', value: 'salary' } }), 'sheet_write');
  assert.match(toolNote({ name: 'mcp__ops__open_app', input: { name: 'Notes' } }), /^open_app \{"name":"Notes"\}$/);
});
