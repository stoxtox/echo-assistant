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
import { redactText } from './screen.js';
import { installedAppNames } from './vocab.js';
import { closestApp } from './apps.ts';
import { readJson, writeJson } from './atomic.js';

export const CONTACTS_TTL_MS = 5 * 60 * 1000;
export const CONFIRM_TTL_MS = 3 * 60 * 1000;
const OSA_TIMEOUT_MS = 30 * 1000;

/**
 * Runs a program, feeding `input` on stdin. Returns stdout. Swapped out in tests.
 * `timeoutMs`: stop it after this long (spreadsheet calls, lib/sheets.js); 30 seconds otherwise.
 * @typedef {(file: string, args: string[], input?: string, opts?: { timeoutMs?: number }) => Promise<string>} Exec
 */
/** @type {Exec} */
export const defaultExec = (file, args, input, { timeoutMs = OSA_TIMEOUT_MS } = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
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

// A picture or file (Messages sends it as an attachment), on its own: the words go first with the
// script above. Messages can take a file without an error and still never attach it, and which
// way of naming the file it accepts has changed between macOS versions, so the form is an argument
// and deliver() tries each in turn until Messages shows a transfer for the file:
//   "alias": the file as an alias (what the maintained imsg tool sends; errors if the file is gone)
//   "posix": the file as a POSIX file (what worked from ~/Pictures on macOS 15)
const SEND_FILE_APPLESCRIPT = `
on run argv
  set theHandle to item 1 of argv
  set theService to item 2 of argv
  set thePath to item 3 of argv
  set theForm to item 4 of argv
  tell application "Messages"
    if theService is "SMS" then
      set theAccount to 1st account whose service type = SMS
    else
      set theAccount to 1st account whose service type = iMessage
    end if
    set theBuddy to participant theHandle of theAccount
    if theForm is "alias" then
      set theFile to POSIX file thePath as alias
    else
      set theFile to POSIX file thePath
    end if
    send theFile to theBuddy
  end tell
  return "sent"
end run`;

// What Messages says about a file it was asked to send, found by its (unique, staged) name:
// "<transfer status>|<service>", e.g. "finished|iMessage", "failed|SMS", or "none". This is all
// AppleScript can tell about a send: Messages has no scriptable list of messages, so whether the
// words were delivered can't be read from here (that needs the Messages history, which Echo does
// not have access to).
const FILE_STATUS_APPLESCRIPT = `
on run argv
  set theName to item 1 of argv
  set out to "none"
  tell application "Messages"
    repeat with t in (get file transfers whose name is theName)
      set theService to "?"
      try
        set theService to (service type of account of t) as text
      end try
      set out to ((transfer status of t) as text) & "|" & theService
    end repeat
  end tell
  return out
end run`;

// The folder open in Finder's front window (Finder search "in this folder").
const FINDER_FOLDER_APPLESCRIPT = `
tell application "Finder"
  if (count of Finder windows) is 0 then return ""
  return POSIX path of (target of front Finder window as alias)
end tell`;

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

/* ---------- did it arrive? ---------- */

export const DELIVERY_WAIT_MS = 6000;

/** What happened to a message, in the words the assistant says. Only "delivered" means they got it. */
export const DELIVERY_WORDS = {
  delivered: 'delivered',
  sent: 'sent, not delivered yet',
  sms: 'went as a text message (SMS), not iMessage',
  failed: 'NOT delivered: Messages shows an error',
  not_attached: 'did NOT attach: Messages never started sending it',
  unknown: "sent; delivery can't be checked from here",
};
/** Anything we don't recognise is "unknown": never a claim that it arrived. */
export const deliveryWords = (state) => DELIVERY_WORDS[state] || DELIVERY_WORDS.unknown;

const HOW_TO_CHECK = 'To be sure, look under the message in Messages or on the phone: it says Delivered when it arrives, and shows a red Not Delivered if it failed.';
const FILE_NEXT_STEP = "Don't resend on your own, and never say the file was sent. Offer one next step: AirDrop if they are nearby, or email it.";
const NEXT_STEP = "Don't resend on your own. Offer one next step: try their other number or email, or, for a green text message, check Text Message Forwarding on the iPhone (Settings, Apps, Messages).";

/**
 * A file's state from what Messages reports about its transfer ("finished|iMessage").
 * A finished transfer left this Mac; that is not the same as delivered. "none" is an answer too:
 * Messages has no transfer for the file, so it never attached. No answer at all is "unknown".
 * @param {string} raw @param {string} service the service it was sent on
 */
export function fileState(raw, service = 'iMessage') {
  const [status, via] = String(raw || '').trim().split('|');
  if (/^none$/i.test(status)) return 'not_attached';
  if (/^failed$/i.test(status)) return 'failed';
  if (/^sms$/i.test(via || '') && service !== 'SMS') return 'sms';
  if (/^finished$/i.test(status)) return service === 'SMS' ? 'sms' : 'unknown';
  if (/^(preparing|waiting|transferring|finalizing)$/i.test(status)) return 'sent';
  return 'unknown';
}

/**
 * The delivery part of a tool result: the words and the file separately when they differ.
 * With a file it also says, for the card in the window, whether the file attached (fileAttached)
 * and what the card should read when "Sent" would be untrue (label).
 * @param {{ text?: string | null, file?: string | null, name?: string }} o states (null: there was none)
 * @returns {{ state: string, delivery: string, attachmentState?: string, textState?: string, fileAttached?: boolean, label?: string, next?: string, check?: string }}
 */
export function describeDelivery({ text = null, file = null, name = '' }) {
  const states = [text, file].filter(Boolean);
  const order = ['failed', 'not_attached', 'sms', 'unknown', 'sent', 'delivered'];
  const state = order.find((s) => states.includes(s)) || 'unknown';
  const both = text && file;
  const missing = file === 'not_attached';
  const delivery = missing && text && text !== 'failed'
    ? `The words were sent${text === 'sms' ? ' (as a text message, SMS)' : ''}, but the file did NOT attach: Messages never started sending it.`
    : missing && !text ? 'The file did NOT attach: Messages never started sending it. Nothing was sent.'
    : both && text !== file
    ? `the words: ${deliveryWords(text)}. The file${name ? ` ${name}` : ''}: ${deliveryWords(file)}`
    : file && !text ? `the file${name ? ` ${name}` : ''}: ${deliveryWords(file)}` : deliveryWords(state);
  const textWent = text && text !== 'failed';
  const label = missing ? (textWent ? 'Text sent · file not attached' : 'File not attached')
    : file === 'failed' ? (textWent ? 'Text sent · file not delivered' : 'File not delivered')
    : file && text === 'failed' ? 'File sent · text not sent' : '';
  return {
    state,
    delivery,
    ...(file ? { attachmentState: file, fileAttached: !missing } : {}),
    ...(label ? { label } : {}),
    ...(both ? { textState: text } : {}),
    ...(missing ? { next: FILE_NEXT_STEP } : state === 'failed' || state === 'sms' ? { next: NEXT_STEP } : state === 'delivered' ? {} : { check: HOW_TO_CHECK }),
  };
}

/**
 * The ways to hand a file to Messages, in the order they are tried: each staged copy as an alias,
 * then the last copy (~/Pictures) as a plain POSIX file.
 * @param {string[] | string} staged @returns {Array<[string, 'alias' | 'posix']>}
 */
export function fileAttempts(staged) {
  const copies = [staged].flat().filter(Boolean);
  return [...copies.map((p) => /** @type {[string, 'alias' | 'posix']} */ ([p, 'alias'])), [copies[copies.length - 1], 'posix']];
}

export class QuickActions extends EventEmitter {
  /** @param {{ exec?: Exec, now?: () => number, contactsTtlMs?: number, confirmTtlMs?: number, deliveryWaitMs?: number }} [opts] */
  constructor({ exec = defaultExec, now = Date.now, contactsTtlMs = CONTACTS_TTL_MS, confirmTtlMs = CONFIRM_TTL_MS, deliveryWaitMs = DELIVERY_WAIT_MS } = {}) {
    super();
    this.exec = exec;
    this.now = now;
    this.contactsTtlMs = contactsTtlMs;
    this.confirmTtlMs = confirmTtlMs;
    this.deliveryWaitMs = deliveryWaitMs;
    this.aliasFile = path.join(config.dataDir, 'contact-aliases.json');
    this.logFile = path.join(config.dataDir, 'quick-actions.log');
    /** @type {{ at: number, list: Array<{ name: string, nickname: string, phones: Array<{value: string, label: string}>, emails: Array<{value: string, label: string}> }> } | null} */
    this.contacts = null;
    this.loading = null;
    /** id -> the real handle and whose it is. Kept across cache refreshes. */
    this.handles = new Map();
    /** Ids that a search matched unambiguously (one contact, one way to reach them). */
    this.unambiguous = new Set();
    /** @type {Map<string, { id: string, name: string, handle: string, masked: string, text: string, service: string, attachment?: string, expiresAt: number, timer: any }>} */
    this.pending = new Map();
  }

  osa(script, args = [], { jxa = false, timeoutMs = 0 } = {}) {
    const argv = [...(jxa ? ['-l', 'JavaScript'] : []), '-', ...args];
    return timeoutMs ? this.exec('osascript', argv, script, { timeoutMs }) : this.exec('osascript', argv, script);
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
    return readJson(this.aliasFile, {});
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
    writeJson(this.aliasFile, all);
    this.audit('alias_saved', { alias: alias.trim(), name: h.name, to: mask(h.handle) });
    return { alias: alias.trim(), name: h.name, masked: mask(h.handle) };
  }

  removeAlias(alias) {
    const all = this.aliases();
    const had = Boolean(all[aliasKey(alias)]);
    delete all[aliasKey(alias)];
    if (had) writeJson(this.aliasFile, all);
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
   * @param {{ to: string, text: string, sms?: boolean, direct?: boolean, attachment?: string }} req
   *   direct: the user said both who and the exact words in this same request.
   *   attachment: a picture or file to send with it (full path from find_file or save_from_url).
   * @param {{ home?: string }} [opts]
   * @returns {Promise<any>}
   */
  async sendMessage({ to, text, sms = false, direct = false, attachment = '' }, { home = os.homedir() } = {}) {
    const body = String(text || '').trim();
    const file = attachment ? this.checkAttachment(attachment, { home }) : '';
    if (!body && !file) throw new QuickError('The message is empty. Ask what it should say.');
    if (body.length > 2000) throw new QuickError('That message is too long for a quick send.');
    const r = this.resolveRecipient(to);
    const service = sms ? 'SMS' : 'iMessage';
    // A picture never goes straight out: it always waits on the card, with its name on it.
    if (direct && r.trusted && !file) {
      const delivery = await this.deliver({ name: r.name, handle: r.handle, text: body, service, via: `direct (${r.via})` });
      return { sent: true, to: r.name, masked: mask(r.handle), service, ...delivery };
    }
    const id = crypto.randomBytes(4).toString('hex');
    /** @type {any} */
    const p = { id, name: r.name, handle: r.handle, masked: mask(r.handle), text: body, service, attachment: file, expiresAt: this.now() + this.confirmTtlMs, timer: null };
    p.timer = setTimeout(() => this.resolvePending(id, false, 'expired').catch(() => {}), this.confirmTtlMs);
    p.timer.unref?.();
    this.pending.set(id, p);
    this.audit('message_card', { id, to: r.name, masked: p.masked, service, text: body, ...(file ? { attachment: path.basename(file) } : {}) });
    this.emit('confirm_request', this.publicPending(p));
    return {
      waitingForConfirmation: true,
      pendingId: id,
      to: r.name,
      masked: p.masked,
      service,
      ...(file ? { attachment: path.basename(file) } : {}),
      why: file ? 'a picture or file always waits for the user to confirm' : direct ? `the recipient wasn't a saved favorite or an unambiguous match` : 'the user has to confirm',
    };
  }

  /**
   * A file to send with a message: the user's own picture or document in their home folder (not
   * Library, hidden folders, Echo's own files or secrets), under 100 MB.
   * @param {string} file @param {{ home?: string }} [o]
   */
  checkAttachment(file, { home = os.homedir() } = {}) {
    const p = path.resolve(String(file || '').trim());
    const rel = path.relative(home, p);
    if (!path.isAbsolute(String(file).trim()) || rel.startsWith('..') || rel.split(path.sep).some((part) => part.startsWith('.')) || rel.startsWith('Library' + path.sep)) {
      throw new QuickError('I can only attach your own files from your home folder. Find it with find_file first.');
    }
    if (isInside(p, APP_DIR) || isInside(p, config.dataDir) || /\.env(\.|$)|pin\.json$/.test(p)) throw new QuickError("That's one of Echo's own files, so I won't send it.");
    if (!OPENABLE.test(path.extname(p))) throw new QuickError('I only attach pictures, documents and media.');
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      throw new QuickError(`There's no file at ${path.basename(p)}.`, 'not_found');
    }
    if (!st.isFile()) throw new QuickError(`${path.basename(p)} isn't a file.`);
    if (st.size > 100 * 1024 * 1024) throw new QuickError(`${path.basename(p)} is too big to send in a message.`);
    return p;
  }

  publicPending(p) {
    return { id: p.id, name: p.name, masked: p.masked, text: p.text, service: p.service, ...(p.attachment ? { attachment: path.basename(p.attachment) } : {}), expiresAt: new Date(p.expiresAt).toISOString() };
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
    let delivery = {};
    if (send) {
      try {
        delivery = await this.deliver({ name: p.name, handle: p.handle, text: p.text, service: p.service, via: by, attachment: p.attachment });
      } catch (e) {
        error = e;
      }
    } else {
      this.audit(by === 'expired' ? 'message_expired' : 'message_cancelled', { id, to: p.name, masked: p.masked, by });
    }
    const out = { id, sent: send && !error, cancelled: !send, by, to: p.name, masked: p.masked, error: error?.message || null, ...delivery };
    this.emit('confirm_resolved', out);
    if (error) throw error;
    return out;
  }

  /**
   * Hand the message to Messages, then find out what can be known about whether it arrived.
   * "Messages took it" is not "they got it": the result says which (describeDelivery).
   * With a file: the words go first, then the file, and the file only counts once Messages shows
   * a transfer for it. Messages can accept a file without an error and never attach it, so each
   * way of handing it over is tried in turn until a transfer appears; if none ever does, the
   * result says the file did not attach, never that it was sent.
   */
  async deliver({ name, handle, text, service, via, attachment = '' }) {
    const file = attachment ? path.basename(attachment) : undefined;
    const failed = (e) => {
      const err = e instanceof QuickError ? e : explainOsaError(e, 'Messages');
      this.audit('message_failed', { to: name, masked: mask(handle), service, via, text, file, error: err.message });
      return err;
    };
    let textErr = null;
    if (text || !attachment) {
      try {
        await this.osa(SEND_APPLESCRIPT, [handle, text, service]);
      } catch (e) {
        if (!attachment) throw failed(e);
        textErr = e;
      }
    }
    // The words: Messages has no way to ask, so only "it was sent as SMS because that was asked
    // for" is known. The file: Messages reports its transfer, watched for a few seconds.
    let textState = !text ? null : textErr ? 'failed' : service === 'SMS' ? 'sms' : 'unknown';
    let fState = null;
    let staged = '';
    let tries = 0;
    if (attachment) {
      let fileErr = null;
      for (const [where, form] of fileAttempts(this.stageAttachment(attachment))) {
        staged = where;
        tries++;
        try {
          await this.osa(SEND_FILE_APPLESCRIPT, [handle, service, where, form]);
          fileErr = null;
        } catch (e) {
          fileErr = e;
          continue;
        }
        fState = await this.watchFile(path.basename(where), service);
        // Anything but "no transfer" ends it: the file is on its way, or Messages can't be asked
        // (trying again then could send it twice).
        if (fState !== 'not_attached') break;
        // "No transfer" is only believed on a Mac where this look has seen a real transfer at
        // least once. Until then it may simply be blind, and a file that did go would be sent
        // again and reported as missing: so one try, and the honest "can't tell".
        if (!this.lookWorks()) { fState = 'unknown'; break; }
      }
      // Messages refused every form outright: with the words gone it is a file that did not
      // attach; with nothing gone it is a send that failed.
      if (fileErr && !fState) {
        if (!text || textErr) throw failed(textErr || fileErr);
        fState = 'not_attached';
      }
      if (fState === 'not_attached' && textErr) throw failed(textErr);
      if (fState === 'not_attached' && !text) throw failed(new QuickError(`Nothing was sent: the file did NOT attach. Messages never started sending it. ${FILE_NEXT_STEP}`, 'not_attached'));
    }
    // A file that left as SMS means the whole chat fell back to SMS.
    if (fState === 'sms' && textState === 'unknown') textState = 'sms';
    const delivery = describeDelivery({ text: textState, file: fState, name: file });
    this.audit('message_sent', { to: name, masked: mask(handle), service, via, text, file, state: delivery.state, ...(fState ? { textState, fileState: fState, staged: path.basename(staged), tries } : {}) });
    return delivery;
  }

  /** One look at a sent file's transfer in Messages. Never throws: no answer is "unknown". */
  async fileStateNow(stagedName, service) {
    try {
      const raw = String(await this.osa(FILE_STATUS_APPLESCRIPT, [stagedName], { timeoutMs: 2000 }) || '').trim();
      // Messages named a real transfer for this file: on this Mac the look can see them.
      if (raw && !/^none\b/i.test(raw)) this.lookSeen();
      return fileState(raw, service);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Watch a sent file until Messages says it left or failed, a few looks over deliveryWaitMs
   * (6 seconds) and never longer: then whatever is known. A file Messages still has no transfer
   * for after three looks (half the wait) did not attach.
   */
  /** Has the look at Messages' file transfers ever seen one on this Mac? (Kept in the data folder.) */
  lookWorks() {
    if (this.lookProven === undefined) {
      try { this.lookProven = Boolean(JSON.parse(fs.readFileSync(path.join(config.dataDir, 'messages-look.json'), 'utf8')).seen); } catch { this.lookProven = false; }
    }
    return this.lookProven;
  }
  lookSeen() {
    if (this.lookWorks()) return;
    this.lookProven = true;
    try { fs.writeFileSync(path.join(config.dataDir, 'messages-look.json'), JSON.stringify({ seen: true, at: new Date().toISOString() })); } catch {}
  }

  async watchFile(stagedName, service) {
    let state = 'unknown';
    let timer;
    const cap = new Promise((resolve) => { timer = setTimeout(resolve, this.deliveryWaitMs); });
    const looks = (async () => {
      for (const [i, part] of [1 / 12, 1 / 6, 1 / 4, 1 / 2].entries()) {
        await new Promise((r) => setTimeout(r, this.deliveryWaitMs * part));
        state = await this.fileStateNow(stagedName, service);
        if (state === 'not_attached' ? i >= 2 : state !== 'sent') return;
      }
    })();
    await Promise.race([looks, cap]);
    clearTimeout(timer);
    return state;
  }

  /**
   * "Did it go through?": the last few messages Echo sent to this person and what is known about
   * each, from Echo's own send log (never the screen). No message text, masked numbers only.
   * @param {{ to: string, count?: number }} o
   */
  async messageStatus({ to, count = 3 }) {
    const r = this.resolveRecipient(to);
    const masked = mask(r.handle);
    const n = Math.min(10, Math.max(1, Math.round(Number(count) || 3)));
    let lines = [];
    try {
      lines = fs.readFileSync(this.logFile, 'utf8').trim().split('\n').slice(-2000);
    } catch {}
    const mine = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if ((e.event === 'message_sent' || e.event === 'message_failed') && e.masked === masked && e.to === r.name) mine.push(e);
      } catch {}
    }
    const messages = await Promise.all(mine.slice(-n).reverse().map(async (e) => {
      if (e.event === 'message_failed') return { at: e.at, service: e.service, state: 'failed', delivery: 'NOT sent: Messages refused it', ...(e.file ? { attachment: e.file } : {}) };
      // A file can fail after the send returned (the chat falls back to SMS): look again now.
      let fState = e.fileState || null;
      if (e.staged && fState !== 'failed') {
        const now = await this.fileStateNow(e.staged, e.service);
        // No transfer now says nothing about then: Messages forgets them when it restarts.
        if (now !== 'unknown' && now !== 'not_attached') fState = now;
      }
      const textState = e.staged ? e.textState || null : e.state === 'sms' || e.service === 'SMS' ? 'sms' : 'unknown';
      const d = describeDelivery({ text: fState === 'sms' && textState === 'unknown' ? 'sms' : textState, file: fState, name: e.file });
      return { at: e.at, service: e.service, state: d.state, delivery: d.delivery, ...(e.file ? { attachment: e.file } : {}) };
    }));
    /** @type {Record<string, number>} */
    const states = {};
    for (const m of messages) states[m.state] = (states[m.state] || 0) + 1;
    this.audit('message_status', { to: r.name, masked, count: messages.length, states });
    const bad = messages.some((m) => m.state === 'failed' || m.state === 'sms');
    const missing = messages.some((m) => m.state === 'not_attached');
    return {
      to: r.name,
      masked,
      messages,
      note: `${messages.length ? 'Newest first; only messages Echo sent.' : 'Echo has not sent this person anything.'} Echo cannot read the Messages history, so it can't see Delivered for the words. ${HOW_TO_CHECK}`,
      ...(missing ? { next: FILE_NEXT_STEP } : bad ? { next: NEXT_STEP } : {}),
    };
  }

  /**
   * Copies of the file where Messages can read it, best first, all under one name made unique so
   * its transfer can be found again. Messages' own attachments folder is where the maintained
   * imsg tool stages files; this Mac only allows writing there with Full Disk Access, so it is
   * skipped quietly without it. ~/Pictures is the folder people found Messages will send from.
   * @param {string} file @param {{ home?: string }} [o]
   * @returns {string[]}
   */
  stageAttachment(file, { home = os.homedir() } = {}) {
    const name = `${Date.now().toString(36)}-${path.basename(file)}`;
    const out = [];
    for (const dir of [path.join(home, 'Library', 'Messages', 'Attachments', 'Echo'), path.join(home, 'Pictures', 'Echo Attachments')]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(file, path.join(dir, name));
        out.push(path.join(dir, name));
      } catch {}
    }
    return out.length ? out : [file];
  }

  /* ---------- the web and the clipboard ---------- */

  /**
   * Save a picture or file from a web link into Downloads ("save this image"). GET only, http(s),
   * at most 50 MB, never over an existing file; checked after saving (it's there, and not empty).
   * @param {{ url: string, name?: string }} o
   * @param {{ home?: string, fetchImpl?: typeof fetch }} [opts]
   */
  async saveFromUrl({ url, name = '' }, { home = os.homedir(), fetchImpl = fetch } = {}) {
    let u;
    try {
      u = new URL(String(url || '').trim());
    } catch {
      throw new QuickError(`"${url}" isn't a valid link.`);
    }
    if (!['http:', 'https:'].includes(u.protocol)) throw new QuickError('I only save from web links.');
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname)) throw new QuickError("I don't save from this Mac's own servers.");
    const MAX = 50 * 1024 * 1024;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res, buf;
    try {
      res = await fetchImpl(u.href, { signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) throw new QuickError(`The link answered ${res.status}, so nothing was saved.`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX) throw new QuickError('That file is over 50 MB, so I left it.');
      buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX) throw new QuickError('That file is over 50 MB, so I left it.');
    } catch (e) {
      if (e instanceof QuickError) throw e;
      throw new QuickError(`Couldn't download it: ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!buf.length) throw new QuickError('The link gave back an empty file, so nothing was saved.');
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_FOR_TYPE[type] || path.extname(u.pathname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
    if (!ext || !OPENABLE.test(ext)) throw new QuickError('That link is not a picture, document or media file, so I left it.');
    const base = (String(name || '').trim() || decodeURIComponent(path.basename(u.pathname, path.extname(u.pathname))) || 'download')
      .replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'download';
    const dir = path.join(home, 'Downloads');
    fs.mkdirSync(dir, { recursive: true });
    let dest = path.join(dir, base.toLowerCase().endsWith(ext) ? base : base + ext);
    for (let i = 2; fs.existsSync(dest) && i < 100; i++) dest = path.join(dir, `${base} ${i}${ext}`);
    fs.writeFileSync(dest, buf, { flag: 'wx' });
    // Checked, not assumed: it's there and it's the size that came down.
    const saved = fs.statSync(dest).size === buf.length;
    this.audit('file_saved', { host: u.hostname, file: path.basename(dest), bytes: buf.length });
    return { saved, path: dest, name: path.basename(dest), bytes: buf.length, type: type || undefined };
  }

  /** What's on the clipboard (text only), with passwords, keys and card numbers blacked out. */
  async readClipboard() {
    let out = '';
    try {
      out = String(await this.exec('pbpaste', []));
    } catch (e) {
      throw new QuickError(`Couldn't read the clipboard: ${(e?.message || '').slice(0, 80)}`);
    }
    const r = redactText(out.slice(0, 4000));
    return { text: r.text, truncated: out.length > 4000, redacted: r.count };
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

  /**
   * A link for an app (a FaceTime call, a System Settings pane), or a web link. Only these kinds.
   * @param {string} url
   */
  async openLink(url) {
    const u = String(url || '').trim();
    if (/^(https?|mailto):/i.test(u)) return this.openUrl(u);
    if (!/^(facetime|facetime-audio):\/\/[+\w@.%-]+$|^x-apple\.systempreferences:[\w.-]+(\?[\w=&-]*)?$/.test(u)) throw new QuickError("I only open web links, FaceTime calls and Settings panes.");
    try {
      await this.exec('open', [u]);
    } catch (e) {
      throw explainOsaError(e, /^face/.test(u) ? 'FaceTime' : 'System Settings');
    }
    // A call was placed: for a while Echo's own voice may come back through it (lib/pipeline/utterance.ts).
    if (/^face/.test(u)) this.callAt = Date.now();
    return { opened: u.split(':')[0] };
  }

  async openApp(name) {
    const n = String(name || '').trim();
    if (!/^[\p{L}\p{N} .&'+-]{1,60}$/u.test(n)) throw new QuickError(`"${name}" doesn't look like an app name.`);
    try {
      await this.exec('open', ['-a', n]);
    } catch (e) {
      if (!/Unable to find application|can't find application/i.test(`${e.stderr} ${e.message}`)) throw explainOsaError(e, n);
      // Said the short name ("Chrome", "Word"): open the one installed app it clearly means.
      const match = closestApp(n, installedAppNames());
      if (!match) throw new QuickError(`There's no app called ${n} on this Mac.`, 'not_found');
      try {
        await this.exec('open', ['-a', match]);
      } catch (e2) {
        throw explainOsaError(e2, match);
      }
      return { opened: match, asked: n };
    }
    return { opened: n };
  }

  /**
   * Open one of the user's own files (found with find_file), in a given app or its default one.
   * Only documents inside the home folder, never Library, hidden folders, Echo itself or secrets,
   * and never anything that runs.
   * @param {string} file full path
   * @param {string} [app]
   * @param {{ home?: string }} [opts]
   */
  async openFile(file, app, { home = os.homedir() } = {}) {
    const p = path.resolve(String(file || '').trim());
    const rel = path.relative(home, p);
    if (!String(file || '').trim() || !path.isAbsolute(String(file).trim()) || rel.startsWith('..') || rel.split(path.sep).some((part) => part.startsWith('.')) || rel.startsWith('Library' + path.sep)) {
      throw new QuickError('I can only open your own files in your home folder. Find it with find_file first.');
    }
    if (isInside(p, APP_DIR) || isInside(p, config.dataDir) || /\.env(\.|$)|pin\.json$/.test(p)) throw new QuickError("That's one of Echo's own files, so I won't open it.");
    if (!OPENABLE.test(path.extname(p))) throw new QuickError("I only open documents, pictures and media, not programs or scripts.");
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      throw new QuickError(`There's no file at ${path.basename(p)}.`, 'not_found');
    }
    if (!st.isFile()) throw new QuickError(`${path.basename(p)} isn't a file.`);
    const a = String(app || '').trim();
    if (a && !/^[\p{L}\p{N} .&'+-]{1,60}$/u.test(a)) throw new QuickError(`"${app}" doesn't look like an app name.`);
    try {
      await this.exec('open', [...(a ? ['-a', a] : []), p]);
    } catch (e) {
      if (/Unable to find application|can't find application/i.test(`${e.stderr} ${e.message}`)) throw new QuickError(`There's no app called ${a} on this Mac.`, 'not_found');
      throw explainOsaError(e, a || 'the file');
    }
    this.audit('file_opened', { file: path.basename(p), app: a || undefined });
    return { opened: path.basename(p), app: a || 'its default app' };
  }

  /**
   * Music without touching the screen: play, pause, skip, or find and play a song or artist.
   * Apple Music plays straight from the library; otherwise (and in Spotify) the search opens in
   * the app, and the assistant clicks the top result on screen.
   * @param {{ app: string, action: string, query?: string }} args
   */
  async mediaControl({ app, action, query }) {
    const name = /spotify/i.test(String(app)) ? 'Spotify' : /music|itunes|apple/i.test(String(app)) ? 'Music' : '';
    if (!name) throw new QuickError('I can control Apple Music or Spotify.');
    const verbs = { play: 'play', pause: 'pause', toggle: 'playpause', playpause: 'playpause', next: 'next track', previous: 'previous track' };
    if (Object.hasOwn(verbs, action)) {
      try {
        await this.osa(`tell application "${name}" to ${verbs[action]}`);
      } catch (e) {
        throw explainOsaError(e, name);
      }
      return { app: name, did: action, ...(action === 'play' || action === 'toggle' || action === 'playpause' ? await this.nowPlaying(name) : {}) };
    }
    if (action !== 'search_play') throw new QuickError(`I can play, pause, skip, or search and play, not "${action}".`);
    const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!q) throw new QuickError('Say which song or artist.');
    if (name === 'Music') {
      let out = '';
      try {
        out = String(await this.osa(MUSIC_SEARCH_PLAY, [q])).trim();
      } catch (e) {
        throw explainOsaError(e, name);
      }
      if (out.startsWith('playing:')) return { app: name, playing: out.slice(8).trim(), from: 'your library' };
    }
    const url = name === 'Spotify' ? `spotify:search:${encodeURIComponent(q)}` : `music://music.apple.com/search?term=${encodeURIComponent(q)}`;
    try {
      await this.exec('open', [url]);
    } catch (e) {
      throw explainOsaError(e, name);
    }
    return {
      app: name,
      searchOpened: q,
      playing: null,
      note: `The search for "${q}" is open in ${name}, but nothing is playing yet. If computer use is on, click the top result (or its play button) on screen; otherwise tell the user it's ready to pick.`,
    };
  }

  /** What's playing now, if the app says. */
  async nowPlaying(name) {
    try {
      const t = String(await this.osa(`tell application "${name}" to if player state is playing then return (name of current track) & " — " & (artist of current track)`)).trim();
      return t ? { playing: t } : {};
    } catch {
      return {};
    }
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
    const anchor = Object.hasOwn(PRIVACY_PANES, pane) ? PRIVACY_PANES[pane] : '';
    if (!anchor) throw new QuickError(`Unknown settings page "${pane}".`);
    await this.exec('open', [privacyPaneUrl(pane)]);
    return { opened: pane };
  }

  /* ---------- files ---------- */

  /**
   * Find the user's own files with Spotlight, one step instead of browsing Finder: by name, and
   * optionally by kind, how recently they changed, or words inside them. Scope: the home folder
   * (default), iCloud Drive, connected drives and memory cards, the folder open in Finder, or all
   * of these. Never Library (except iCloud Drive), hidden folders, Echo itself or secrets.
   * @param {string} name part of the file name ('' with kind/days/content to list by those)
   * @param {{ home?: string, limit?: number, scope?: 'home' | 'icloud' | 'volumes' | 'finder' | 'everywhere',
   *   kind?: string, days?: number, content?: string, volumesDir?: string }} [opts]
   */
  async findFiles(name, { home = os.homedir(), limit = 10, scope = 'home', kind = '', days = 0, content = '', volumesDir = '/Volumes' } = {}) {
    const q = String(name || '').trim();
    const c = String(content || '').trim();
    const k = String(kind || '').toLowerCase();
    if (!q && !c && !k && !days) throw new QuickError('Say what the file is called.');
    if (k && !KIND_TYPES[k]) throw new QuickError(`I can look for these kinds: ${Object.keys(KIND_TYPES).join(', ')}.`);
    const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    const volumes = () => {
      try {
        return fs.readdirSync(volumesDir).filter((v) => !v.startsWith('.')).map((v) => path.join(volumesDir, v)).filter((v) => {
          try {
            // The startup disk shows up in /Volumes as a link to /.
            return fs.realpathSync(v) !== '/';
          } catch {
            return false;
          }
        });
      } catch {
        return [];
      }
    };
    /** @type {string[]} */
    let roots = [];
    if (scope === 'finder') {
      let folder = '';
      try {
        folder = String(await this.osa(FINDER_FOLDER_APPLESCRIPT)).trim();
      } catch {}
      if (!folder) throw new QuickError('There is no Finder window open to search in. I can search your whole home folder instead.');
      roots = [folder];
    } else if (scope === 'icloud') roots = [icloud];
    else if (scope === 'volumes') {
      roots = volumes();
      if (!roots.length) throw new QuickError('No drive or memory card is connected.');
    } else if (scope === 'everywhere') roots = [home, ...volumes()];
    else roots = [home];

    const clean = (t) => t.replace(/["\\*]/g, ' ').trim();
    const simple = q && !c && !k && !days;
    const parts = [];
    if (q) parts.push(`(kMDItemDisplayName == "*${clean(q)}*"cd)`);
    if (c) parts.push(`(kMDItemTextContent == "*${clean(c)}*"cd)`);
    if (k) parts.push(`(${KIND_TYPES[k].map((t) => `kMDItemContentTypeTree == "${t}"`).join(' || ')})`);
    if (days > 0) parts.push(`(kMDItemFSContentChangeDate >= $time.today(-${Math.min(3650, Math.round(days))}))`);
    let out = '';
    for (const root of roots) {
      try {
        out += '\n' + String(await this.exec('mdfind', simple ? ['-onlyin', root, '-name', q] : ['-onlyin', root, parts.join(' && ')]));
      } catch (e) {
        throw new QuickError(`Spotlight search failed: ${(e?.message || '').slice(0, 120)}`);
      }
    }
    const allowed = (p) => {
      if (isInside(p, APP_DIR) || isInside(p, config.dataDir) || /\.env(\.|$)|pin\.json$/.test(p)) return false;
      const under = [...roots, ...(scope === 'everywhere' ? [icloud] : [])].find((r) => isInside(p, r) || p === r);
      if (!under) return false;
      const rel = path.relative(under, p);
      if (rel.split(path.sep).some((part) => part.startsWith('.'))) return false;
      // Library is private app data, except iCloud Drive (searched on purpose).
      if (under === home && (rel.startsWith('Library' + path.sep) && !isInside(p, icloud))) return false;
      return true;
    };
    const seen = new Set();
    const files = out
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p && path.isAbsolute(p) && !seen.has(p) && seen.add(p))
      .filter(allowed)
      .map((p) => {
        try {
          const st = fs.statSync(p);
          return st.isFile() || (k === 'folder' && st.isDirectory()) ? { path: p, name: path.basename(p), folder: path.basename(path.dirname(p)), modified: st.mtime.toISOString().slice(0, 10), bytes: st.size } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .slice(0, limit);
    return { query: q, scope, ...(k ? { kind: k } : {}), ...(days ? { days } : {}), ...(c ? { content: c } : {}), files, searched: roots.map((r) => (r === home ? '~' : r.replace(home, '~'))) };
  }

  /**
   * Show a file in Finder, selected (after find_file). Only the user's own files (home, iCloud
   * Drive, connected drives).
   * @param {string} file @param {{ home?: string }} [o]
   */
  async revealFile(file, { home = os.homedir() } = {}) {
    const p = path.resolve(String(file || '').trim());
    const rel = path.relative(home, p);
    const inHome = !rel.startsWith('..') && !path.isAbsolute(rel);
    const icloud = isInside(p, path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
    const onVolume = p.startsWith('/Volumes/');
    if (!path.isAbsolute(String(file).trim()) || (!inHome && !onVolume) || (inHome && !icloud && (rel.startsWith('Library' + path.sep) || rel.split(path.sep).some((x) => x.startsWith('.'))))) {
      throw new QuickError('I can only show your own files. Find it with find_file first.');
    }
    if (isInside(p, APP_DIR) || isInside(p, config.dataDir)) throw new QuickError("That's one of Echo's own files.");
    if (!fs.existsSync(p)) throw new QuickError(`There's no file at ${path.basename(p)}.`, 'not_found');
    try {
      await this.exec('open', ['-R', p]);
    } catch (e) {
      throw explainOsaError(e, 'Finder');
    }
    return { revealed: path.basename(p), folder: path.basename(path.dirname(p)) };
  }
}

/** Spotlight content types for "kind". */
const KIND_TYPES = {
  image: ['public.image'], photo: ['public.image'], picture: ['public.image'],
  pdf: ['com.adobe.pdf'],
  document: ['public.text', 'com.adobe.pdf', 'org.openxmlformats.wordprocessingml.document', 'com.microsoft.word.doc', 'com.apple.iwork.pages.sffpages', 'public.rtf'],
  spreadsheet: ['org.openxmlformats.spreadsheetml.sheet', 'com.microsoft.excel.xls', 'com.apple.iwork.numbers.sffnumbers', 'public.comma-separated-values-text'],
  presentation: ['org.openxmlformats.presentationml.presentation', 'com.microsoft.powerpoint.ppt', 'com.apple.iwork.keynote.sffkey'],
  video: ['public.movie'], audio: ['public.audio'], folder: ['public.folder'],
};

/** File extensions for what a download says it is. */
const EXT_FOR_TYPE = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic', 'image/tiff': '.tiff',
  'application/pdf': '.pdf', 'text/csv': '.csv', 'text/plain': '.txt', 'text/markdown': '.md', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/wav': '.wav', 'video/mp4': '.mp4', 'video/quicktime': '.mov',
};

/** Documents, pictures and media openFile may open (never apps, scripts or installers). */
const OPENABLE = /^\.(xlsx|xlsm|xls|csv|tsv|numbers|docx|doc|pages|rtf|txt|md|pdf|key|pptx|ppt|odt|ods|png|jpe?g|heic|gif|webp|tiff?|mp3|m4a|wav|aiff?|mp4|mov|m4v)$/i;

/** Apple Music: play the first library match for argv[1]. */
const MUSIC_SEARCH_PLAY = `on run argv
  set q to item 1 of argv
  tell application "Music"
    set hits to (search library playlist 1 for q)
    if (count of hits) > 0 then
      set t to item 1 of hits
      play t
      return "playing:" & (name of t) & " — " & (artist of t)
    end if
  end tell
  return "none"
end run`;

const PERMISSION_TESTS = {
  contacts: { app: 'Contacts', script: 'tell application "Contacts" to count people', ok: (n) => `Contacts works. I can see ${n || 'your'} contacts.` },
  messages: { app: 'Messages', script: 'tell application "Messages" to get name', ok: () => 'Messages works. I can send texts, and I always show you the message first.' },
  calendar: { app: 'Calendar', script: 'tell application "Calendar" to count calendars', ok: (n) => `Calendar works. I can see ${n || 'your'} calendars.` },
};

/** The x-apple.systempreferences URL that opens one Privacy & Security page (e.g. 'screen'), or ''. */
export function privacyPaneUrl(pane) {
  const anchor = Object.hasOwn(PRIVACY_PANES, pane) ? PRIVACY_PANES[pane] : '';
  return anchor ? `x-apple.systempreferences:com.apple.preference.security?${anchor}` : '';
}

/** Pages of System Settings, Privacy & Security, by the anchor its x-apple.systempreferences URL takes. */
export const PRIVACY_PANES = {
  screen: 'Privacy_ScreenCapture',
  accessibility: 'Privacy_Accessibility',
  input: 'Privacy_ListenEvent',
  microphone: 'Privacy_Microphone',
  contacts: 'Privacy_Contacts',
  calendars: 'Privacy_Calendars',
  automation: 'Privacy_Automation',
};
