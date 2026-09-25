// Quick native errands the assistant does itself, with no worker: look up a contact, send an
// iMessage, add a calendar event, open a link or an app. They run on the Mac through osascript
// (AppleScript or JXA), so they take a second instead of a minute.
//
// Privacy: the model only ever sees masked numbers and emails (last 4 digits). The full value
// stays here, under a short id, and is only used to send.
// Safety: a message goes out only after the user taps Send on the card in the window (or says
// yes to the read-back), or directly when the user gave both the recipient and the exact text
// and the recipient is a saved favorite or was matched unambiguously. Every send is logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { config, APP_DIR } from './config.js';
import { isInside } from './text.js';

export const CONTACTS_TTL_MS = 5 * 60 * 1000;
export const CONFIRM_TTL_MS = 3 * 60 * 1000;
const OSA_TIMEOUT_MS = 30 * 1000;

/**
 * Runs a program, feeding `input` on stdin. Returns stdout. Swapped out in tests.
 * @typedef {(file: string, args: string[], input?: string) => Promise<string>} Exec
 */
/** @type {Exec} */
export const defaultExec = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: OSA_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr || '') }));
      else resolve(String(stdout));
    });
    child.stdin?.end(input ?? '');
  });

/** A macOS automation error, with a message fit to be spoken. */
export class QuickError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.code = code;
  }
}

/** Turn an osascript failure into something the user can act on. */
export function explainOsaError(err, app) {
  const raw = `${err?.stderr || ''} ${err?.message || ''}`;
  if (/-1743|not authori[sz]ed|not allowed (to send|assistive)|-10004|privilege violation/i.test(raw)) {
    const privacy = app === 'Contacts' || app === 'Calendar' ? ` If it still fails, also turn on ${app === 'Calendar' ? 'Calendars' : 'Contacts'} under Privacy and Security for the same app.` : '';
    return new QuickError(
      `Echo isn't allowed to control ${app} yet. On the Mac, open System Settings, then Privacy and Security, then Automation, find the app Echo runs in (Echo, Terminal or node) and switch on ${app}.${privacy} Then try again.`,
      'permission'
    );
  }
  if (/-1712|timed? ?out|ETIMEDOUT|SIGTERM/i.test(raw)) return new QuickError(`${app} took too long to answer. It may be showing a permission prompt on the Mac; check the screen and try again.`, 'timeout');
  if (/ENOENT/.test(raw)) return new QuickError('osascript is not available, so quick actions only work on a Mac.', 'unavailable');
  const detail = (err?.stderr || err?.message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return new QuickError(`${app} gave an error: ${detail || 'unknown error'}`);
}

/* ---------- scripts (arguments go in as JSON on argv, never spliced into the source) ---------- */

const CONTACTS_JXA = `
function run() {
  const people = Application('Contacts').people;
  const names = people.name(), nicks = people.nickname();
  const phones = people.phones.value(), phoneLabels = people.phones.label();
  const emails = people.emails.value(), emailLabels = people.emails.label();
  return JSON.stringify(names.map((name, i) => ({
    name, nickname: nicks[i] || '',
    phones: (phones[i] || []).map((value, j) => ({ value, label: phoneLabels[i][j] || '' })),
    emails: (emails[i] || []).map((value, j) => ({ value, label: emailLabels[i][j] || '' })),
  })));
}`;

const SEND_APPLESCRIPT = `
on run argv
  set theHandle to item 1 of argv
  set theText to item 2 of argv
  set theService to item 3 of argv
  tell application "Messages"
    if theService is "SMS" then
      set theAccount to 1st account whose service type = SMS
    else
      set theAccount to 1st account whose service type = iMessage
    end if
    send theText to participant theHandle of theAccount
  end tell
  return "sent"
end run`;

const CALENDAR_JXA = `
function run(argv) {
  const o = JSON.parse(argv[0]);
  const Cal = Application('Calendar');
  const names = Cal.calendars.name(), writable = Cal.calendars.writable();
  const skip = /^(birthdays|holidays|us holidays|siri suggestions|scheduled reminders|found in (mail|apps))$/i;
  let i = o.calendar ? names.findIndex((n) => n.toLowerCase() === o.calendar.toLowerCase()) : names.findIndex((n, k) => writable[k] && !skip.test(n));
  if (i < 0 || !writable[i]) return JSON.stringify({ error: 'no_calendar', calendars: names.filter((n, k) => writable[k] && !skip.test(n)) });
  const cal = Cal.calendars[i];
  const props = { summary: o.title, startDate: new Date(o.start), endDate: new Date(o.end) };
  if (o.allDay) props.alldayEvent = true;
  if (o.location) props.location = o.location;
  if (o.notes) props.description = o.notes;
  const ev = Cal.Event(props);
  cal.events.push(ev);
  if (o.alert != null) ev.displayAlarms.push(Cal.DisplayAlarm({ triggerInterval: -o.alert }));
  return JSON.stringify({ calendar: names[i], uid: ev.uid() });
}`;

/* ---------- helpers ---------- */

const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9@.+ ]/g, ' ').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');
const cleanLabel = (l) => String(l || '').replace(/^_\$!<(.*)>!\$_$/, '$1').toLowerCase();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
const isPhone = (s) => /^\+?[\d\s().-]{7,}$/.test(String(s).trim()) && digits(s).length >= 7;

/** What the model sees instead of a number or email. */
export function mask(handle) {
  const h = String(handle).trim();
  if (isEmail(h)) {
    const [user, domain] = h.split('@');
    return `${user[0]}•••@${domain}`;
  }
  return `•••${digits(h).slice(-4)}`;
}

const handleId = (handle) => 'c_' + crypto.createHash('sha1').update(isEmail(handle) ? handle.trim().toLowerCase() : digits(handle)).digest('hex').slice(0, 8);
const aliasKey = (a) => norm(a);

export class QuickActions extends EventEmitter {
  /** @param {{ exec?: Exec, now?: () => number, contactsTtlMs?: number, confirmTtlMs?: number }} [opts] */
  constructor({ exec = defaultExec, now = Date.now, contactsTtlMs = CONTACTS_TTL_MS, confirmTtlMs = CONFIRM_TTL_MS } = {}) {
    super();
    this.exec = exec;
    this.now = now;
    this.contactsTtlMs = contactsTtlMs;
    this.confirmTtlMs = confirmTtlMs;
    this.aliasFile = path.join(config.dataDir, 'contact-aliases.json');
    this.logFile = path.join(config.dataDir, 'quick-actions.log');
    /** @type {{ at: number, list: Array<{ name: string, nickname: string, phones: Array<{value: string, label: string}>, emails: Array<{value: string, label: string}> }> } | null} */
    this.contacts = null;
    this.loading = null;
    /** id -> the real handle and whose it is. Kept across cache refreshes. */
    this.handles = new Map();
    /** Ids that a search matched unambiguously (one contact, one way to reach them). */
    this.unambiguous = new Set();
    /** @type {Map<string, { id: string, name: string, handle: string, masked: string, text: string, service: string, expiresAt: number, timer: any }>} */
    this.pending = new Map();
  }

  osa(script, args = [], { jxa = false } = {}) {
    return this.exec('osascript', [...(jxa ? ['-l', 'JavaScript'] : []), '-', ...args], script);
  }

  audit(event, data) {
    try {
      fs.appendFileSync(this.logFile, JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...data }) + '\n');
    } catch {}
  }

  /* ---------- contacts ---------- */

  async loadContacts({ fresh = false } = {}) {
    if (!fresh && this.contacts && this.now() - this.contacts.at < this.contactsTtlMs) return this.contacts.list;
    this.loading ??= (async () => {
      try {
        const out = await this.osa(CONTACTS_JXA, [], { jxa: true });
        const list = JSON.parse(out || '[]');
        this.contacts = { at: this.now(), list };
        return list;
      } catch (e) {
        throw e instanceof SyntaxError ? new QuickError('Contacts returned something I could not read.') : explainOsaError(e, 'Contacts');
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  remember(name, handle, kind, label) {
    const id = handleId(handle);
    this.handles.set(id, { name, handle: handle.trim(), kind, label });
    return id;
  }

  describeHandles(c) {
    return [
      ...c.phones.map((p) => ({ id: this.remember(c.name, p.value, 'phone', cleanLabel(p.label)), kind: 'phone', label: cleanLabel(p.label), masked: mask(p.value) })),
      ...c.emails.map((e) => ({ id: this.remember(c.name, e.value, 'email', cleanLabel(e.label)), kind: 'email', label: cleanLabel(e.label), masked: mask(e.value) })),
    ];
  }

  /**
   * Contacts matching a spoken name (or a saved alias, or the last digits of a number).
   * Exact name matches come first; `unambiguous` means exactly one contact with one handle.
   */
  async findContact(query) {
    const q = norm(query);
    if (!q) throw new QuickError('Say whose contact to look up.');
    const favorite = this.aliases()[aliasKey(query)];
    const list = await this.loadContacts();
    const qDigits = digits(query);
    const scored = [];
    for (const c of list) {
      const name = norm(c.name), nick = norm(c.nickname);
      const tokens = `${name} ${nick}`.split(' ').filter(Boolean);
      const qTokens = q.split(' ');
      let score = 0;
      if (name === q || (nick && nick === q)) score = 3;
      else if (qTokens.every((t) => tokens.includes(t))) score = 2;
      else if (qTokens.every((t) => tokens.some((w) => w.startsWith(t)))) score = 1;
      else if (qDigits.length >= 4 && c.phones.some((p) => digits(p.value).endsWith(qDigits))) score = 1;
      if (score && (c.phones.length || c.emails.length)) scored.push({ c, score });
    }
    scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
    const shown = scored.slice(0, 8).map(({ c, score }) => ({ name: c.name, exactName: score === 3, handles: this.describeHandles(c) }));
    const unambiguous = scored.length === 1 && shown[0].handles.length === 1;
    if (unambiguous) this.unambiguous.add(shown[0].handles[0].id);
    return {
      query,
      ...(favorite ? { savedFavorite: { alias: query, name: favorite.name, id: favorite.id, masked: mask(favorite.handle) } } : {}),
      matches: shown,
      more: Math.max(0, scored.length - shown.length),
      unambiguous,
    };
  }

  /* ---------- favorites / aliases ---------- */

  /** @returns {Record<string, { alias: string, id: string, name: string, handle: string, label: string }>} */
  aliases() {
    try {
      return JSON.parse(fs.readFileSync(this.aliasFile, 'utf8'));
    } catch {
      return {};
    }
  }

  /** Masked list for the model and the prompt. */
  favorites() {
    return Object.values(this.aliases()).map((a) => ({ alias: a.alias, name: a.name, id: a.id, masked: mask(a.handle), label: a.label }));
  }

  setAlias(alias, contactId) {
    const key = aliasKey(alias);
    if (!key) throw new QuickError('Say what to call them.');
    const h = this.handles.get(contactId);
    if (!h) throw new QuickError(`Unknown contact id ${contactId}. Look them up with find_contact first.`);
    const all = this.aliases();
    all[key] = { alias: alias.trim(), id: contactId, name: h.name, handle: h.handle, label: h.label };
    fs.mkdirSync(path.dirname(this.aliasFile), { recursive: true });
    fs.writeFileSync(this.aliasFile, JSON.stringify(all, null, 2));
    this.audit('alias_saved', { alias: alias.trim(), name: h.name, to: mask(h.handle) });
    return { alias: alias.trim(), name: h.name, masked: mask(h.handle) };
  }

  removeAlias(alias) {
    const all = this.aliases();
    const had = Boolean(all[aliasKey(alias)]);
    delete all[aliasKey(alias)];
    if (had) fs.writeFileSync(this.aliasFile, JSON.stringify(all, null, 2));
    return had;
  }

  /**
   * Who a message goes to: a contact id from find_contact, a saved alias, or a number/email.
   * @returns {{ name: string, handle: string, trusted: boolean, via: string }}
   */
  resolveRecipient(to) {
    const s = String(to || '').trim();
    if (!s) throw new QuickError('Say who the message is for.');
    if (this.handles.has(s)) {
      const h = this.handles.get(s);
      const favorite = Object.values(this.aliases()).some((a) => a.id === s);
      return { name: h.name, handle: h.handle, trusted: favorite || this.unambiguous.has(s), via: favorite ? 'favorite' : 'contact' };
    }
    const a = this.aliases()[aliasKey(s)] || Object.values(this.aliases()).find((x) => x.id === s);
    if (a) {
      this.handles.set(a.id, { name: a.name, handle: a.handle, kind: isEmail(a.handle) ? 'email' : 'phone', label: a.label });
      return { name: a.name, handle: a.handle, trusted: true, via: 'favorite' };
    }
    if (isPhone(s) || isEmail(s)) return { name: s, handle: s, trusted: false, via: 'handle' };
    throw new QuickError(`"${s}" isn't a saved favorite or a contact id. Call find_contact first and use the id it returns.`);
  }

  /* ---------- messages ---------- */

  /**
   * Send now (only when allowed) or put up a confirmation card.
   * @param {{ to: string, text: string, sms?: boolean, direct?: boolean }} req
   *   direct: the user said both who and the exact words in this same request.
   */
  async sendMessage({ to, text, sms = false, direct = false }) {
    const body = String(text || '').trim();
    if (!body) throw new QuickError('The message is empty. Ask what it should say.');
    if (body.length > 2000) throw new QuickError('That message is too long for a quick send.');
    const r = this.resolveRecipient(to);
    const service = sms ? 'SMS' : 'iMessage';
    if (direct && r.trusted) {
      await this.deliver({ name: r.name, handle: r.handle, text: body, service, via: `direct (${r.via})` });
      return { sent: true, to: r.name, masked: mask(r.handle), service };
    }
    const id = crypto.randomBytes(4).toString('hex');
    const p = { id, name: r.name, handle: r.handle, masked: mask(r.handle), text: body, service, expiresAt: this.now() + this.confirmTtlMs, timer: null };
    p.timer = setTimeout(() => this.resolvePending(id, false, 'expired').catch(() => {}), this.confirmTtlMs);
    p.timer.unref?.();
    this.pending.set(id, p);
    this.audit('message_card', { id, to: r.name, masked: p.masked, service, text: body });
    this.emit('confirm_request', this.publicPending(p));
    return {
      waitingForConfirmation: true,
      pendingId: id,
      to: r.name,
      masked: p.masked,
      service,
      why: direct ? `the recipient wasn't a saved favorite or an unambiguous match` : 'the user has to confirm',
    };
  }

  publicPending(p) {
    return { id: p.id, name: p.name, masked: p.masked, text: p.text, service: p.service, expiresAt: new Date(p.expiresAt).toISOString() };
  }

  pendingList() {
    return [...this.pending.values()].map((p) => this.publicPending(p));
  }

  /**
   * The user answered the card (in the window or by voice), or it expired.
   * @param {string} id
   * @param {boolean} send
   * @param {'window' | 'voice' | 'expired'} by
   */
  async resolvePending(id, send, by) {
    const p = this.pending.get(id);
    if (!p) throw new QuickError('That message was already sent, cancelled or expired.', 'stale');
    this.pending.delete(id);
    clearTimeout(p.timer);
    let error = null;
    if (send) {
      try {
        await this.deliver({ name: p.name, handle: p.handle, text: p.text, service: p.service, via: by });
      } catch (e) {
        error = e;
      }
    } else {
      this.audit(by === 'expired' ? 'message_expired' : 'message_cancelled', { id, to: p.name, masked: p.masked, by });
    }
    const out = { id, sent: send && !error, cancelled: !send, by, to: p.name, masked: p.masked, error: error?.message || null };
    this.emit('confirm_resolved', out);
    if (error) throw error;
    return out;
  }

  async deliver({ name, handle, text, service, via }) {
    try {
      await this.osa(SEND_APPLESCRIPT, [handle, text, service]);
    } catch (e) {
      const err = explainOsaError(e, 'Messages');
      this.audit('message_failed', { to: name, masked: mask(handle), service, via, text, error: err.message });
      throw err;
    }
    this.audit('message_sent', { to: name, masked: mask(handle), service, via, text });
  }

  /* ---------- calendar ---------- */

  /**
   * @param {{ title: string, start: string, end?: string, location?: string, notes?: string, alert_minutes?: number, calendar?: string, all_day?: boolean }} ev
   */
  async addCalendarEvent({ title, start, end, location, notes, alert_minutes, calendar, all_day }) {
    if (!String(title || '').trim()) throw new QuickError('The event needs a title.');
    // A bare date is UTC midnight to Date.parse; people mean local midnight.
    const local = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) ? `${String(v).trim()}T00:00` : v);
    const s = Date.parse(local(start));
    if (Number.isNaN(s)) throw new QuickError(`Couldn't read the start time "${start}". Use a local date and time like 2026-09-26T19:00.`);
    const e = end ? Date.parse(local(end)) : s + (all_day ? 24 : 1) * 3600 * 1000;
    if (Number.isNaN(e)) throw new QuickError(`Couldn't read the end time "${end}".`);
    if (e <= s) throw new QuickError('The event ends before it starts.');
    const alert = alert_minutes == null ? null : Math.max(0, Math.round(alert_minutes)) * 60;
    const args = { title: title.trim(), start: s, end: e, location: location || '', notes: notes || '', alert, calendar: calendar || '', allDay: Boolean(all_day) };
    let out;
    try {
      out = JSON.parse(await this.osa(CALENDAR_JXA, [JSON.stringify(args)], { jxa: true }));
    } catch (err) {
      throw err instanceof SyntaxError ? new QuickError('Calendar returned something I could not read.') : explainOsaError(err, 'Calendar');
    }
    if (out.error === 'no_calendar') {
      throw new QuickError(`${calendar ? `There's no writable calendar called "${calendar}".` : 'No writable calendar found.'} Calendars: ${(out.calendars || []).join(', ') || 'none'}.`, 'no_calendar');
    }
    this.audit('event_added', { title: args.title, start: new Date(s).toISOString(), end: new Date(e).toISOString(), calendar: out.calendar });
    return { added: true, title: args.title, calendar: out.calendar, start: new Date(s).toString(), end: new Date(e).toString(), alertMinutes: alert_minutes ?? null };
  }

  /* ---------- open ---------- */

  async openUrl(url) {
    let u;
    try {
      u = new URL(String(url).trim());
    } catch {
      throw new QuickError(`"${url}" isn't a valid link.`);
    }
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new QuickError('I only open web and email links.');
    try {
      await this.exec('open', [u.href]);
    } catch (e) {
      throw explainOsaError(e, 'the browser');
    }
    return { opened: u.href };
  }

  async openApp(name) {
    const n = String(name || '').trim();
    if (!/^[\p{L}\p{N} .&'+-]{1,60}$/u.test(n)) throw new QuickError(`"${name}" doesn't look like an app name.`);
    try {
      await this.exec('open', ['-a', n]);
    } catch (e) {
      if (/Unable to find application|can't find application/i.test(`${e.stderr} ${e.message}`)) throw new QuickError(`There's no app called ${n} on this Mac.`, 'not_found');
      throw explainOsaError(e, n);
    }
    return { opened: n };
  }

  /* ---------- setup: permissions ---------- */

  /**
   * A harmless call to one app, so macOS asks for permission now (during setup) rather than in
   * the middle of an errand. Resolves to { ok, message } either way.
   * @param {'contacts' | 'messages' | 'calendar'} kind
   */
  async testPermission(kind) {
    const test = PERMISSION_TESTS[kind];
    if (!test) throw new QuickError(`Unknown permission "${kind}".`);
    try {
      const out = String(await this.osa(test.script)).trim();
      return { ok: true, kind, message: test.ok(out) };
    } catch (e) {
      const err = explainOsaError(e, test.app);
      return { ok: false, kind, code: err.code, message: err.message };
    }
  }

  /** Open the matching page of System Settings, Privacy and Security. */
  async openPrivacySettings(pane) {
    const anchor = PRIVACY_PANES[pane];
    if (!anchor) throw new QuickError(`Unknown settings page "${pane}".`);
    await this.exec('open', [`x-apple.systempreferences:com.apple.preference.security?${anchor}`]);
    return { opened: pane };
  }

  /* ---------- files ---------- */

  /**
   * Find the user's own files by name with Spotlight (e.g. "the budget Excel file in Downloads").
   * Only inside the home folder, never Library, hidden folders, Echo itself or secrets.
   * @param {string} name part of the file name
   * @param {{ home?: string, limit?: number }} [opts]
   */
  async findFiles(name, { home = os.homedir(), limit = 10 } = {}) {
    const q = String(name || '').trim();
    if (!q) throw new QuickError('Say what the file is called.');
    let out = '';
    try {
      out = String(await this.exec('mdfind', ['-onlyin', home, '-name', q]));
    } catch (e) {
      throw new QuickError(`Spotlight search failed: ${(e?.message || '').slice(0, 120)}`);
    }
    const files = out
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p && path.isAbsolute(p))
      .filter((p) => {
        const rel = path.relative(home, p);
        if (rel.startsWith('..') || rel.split(path.sep).some((part) => part.startsWith('.')) || rel.startsWith('Library' + path.sep)) return false;
        if (isInside(p, APP_DIR) || isInside(p, config.dataDir) || /\.env(\.|$)|pin\.json$/.test(p)) return false;
        return true;
      })
      .map((p) => {
        try {
          const st = fs.statSync(p);
          return st.isFile() ? { path: p, name: path.basename(p), folder: path.basename(path.dirname(p)), modified: st.mtime.toISOString().slice(0, 10), bytes: st.size } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, limit);
    return { query: q, files };
  }
}

const PERMISSION_TESTS = {
  contacts: { app: 'Contacts', script: 'tell application "Contacts" to count people', ok: (n) => `Contacts works. I can see ${n || 'your'} contacts.` },
  messages: { app: 'Messages', script: 'tell application "Messages" to get name', ok: () => 'Messages works. I can send texts, and I always show you the message first.' },
  calendar: { app: 'Calendar', script: 'tell application "Calendar" to count calendars', ok: (n) => `Calendar works. I can see ${n || 'your'} calendars.` },
};

const PRIVACY_PANES = {
  microphone: 'Privacy_Microphone',
  contacts: 'Privacy_Contacts',
  calendars: 'Privacy_Calendars',
  automation: 'Privacy_Automation',
};
