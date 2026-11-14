// The everyday apps without clicking: Finder, Notes, Reminders, Calendar and Mail, each through
// one small adapter in this folder (the pattern is lib/sheets.js; the shared rules are ./osa.js).
// This is the one door the assistant's tools come through (lib/tools/apps.js, by way of
// ComputerUse.app, which asks first where lib/policy.ts says to and logs the tool, a count, how
// long it took and whether it worked: never a name, a subject or a word of what was read).
import { Finder } from './finder.js';
import { Notes } from './notes.js';
import { Reminders } from './reminders.js';
import { Calendar } from './calendar.js';
import { Mail } from './mail.js';
import { fail } from './osa.js';

/** The tools that change something (the rest only read). */
const CHANGES = new Set(['finder_new_folder', 'finder_move', 'finder_rename', 'finder_trash', 'notes_create', 'notes_append', 'reminders_add', 'reminders_complete', 'mail_draft']);
/** The tools lib/policy.ts has a say in, and what each does to files. */
const FILE_OPS = /** @type {const} */ ({ finder_move: 'move', finder_rename: 'rename', finder_trash: 'trash' });

export const APP_TOOL_NAMES = ['finder_list', 'finder_reveal', 'finder_new_folder', 'finder_move', 'finder_rename', 'finder_trash', 'notes_find', 'notes_read', 'notes_create', 'notes_append', 'reminders_list', 'reminders_add', 'reminders_complete', 'calendar_today', 'mail_unread', 'mail_read', 'mail_draft'];

export class Apps {
  /**
   * @param {{ run: (script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>,
   *   reveal?: ((file: string) => Promise<any>) | null, resolve?: ((to: string) => { name: string, handle: string }) | null,
   *   home?: string, timeoutMs?: number, now?: () => number }} opts
   *   run: the AppleScript runner (QuickActions.osa); reveal: QuickActions.revealFile; resolve:
   *   QuickActions.resolveRecipient; home, timeoutMs, now: for tests
   */
  constructor({ run, reveal = null, resolve = null, home, timeoutMs, now }) {
    this.finder = new Finder({ run, reveal, timeoutMs, ...(home ? { home } : {}) });
    this.notes = new Notes({ run, timeoutMs });
    this.reminders = new Reminders({ run, timeoutMs });
    this.calendar = new Calendar({ run, timeoutMs, ...(now ? { now } : {}) });
    this.mail = new Mail({ run, timeoutMs, resolve });
  }

  /** Does this tool change something on the Mac? */
  changes(tool) {
    return CHANGES.has(tool);
  }

  /**
   * For a tool that moves, renames or trashes files: what it would touch, checked, before
   * anything is done (`{ op, count, label, … }` or `{ error, message }`); null for any other tool.
   */
  plan(tool, args) {
    const op = FILE_OPS[tool];
    return op ? this.finder.plan(op, args) : null;
  }

  /**
   * Run one tool. Answers what the assistant is told, with `count` (how many things it read or
   * touched) for the log.
   * @param {string} tool @param {any} args @param {any} [planned] what plan() answered, when it was asked
   * @returns {Promise<any>}
   */
  async call(tool, args = {}, planned = null) {
    const p = planned || this.plan(tool, args);
    if (p?.error) return p;
    switch (tool) {
      case 'finder_list': return this.finder.list(args);
      case 'finder_reveal': return this.finder.reveal(args);
      case 'finder_new_folder': return this.finder.newFolder(args);
      case 'finder_move': case 'finder_rename': return this.finder.relocate(p);
      case 'finder_trash': return this.finder.trash(p);
      case 'notes_find': return this.notes.find(args);
      case 'notes_read': return this.notes.read(args);
      case 'notes_create': return this.notes.create(args);
      case 'notes_append': return this.notes.append(args);
      case 'reminders_list': return this.reminders.list(args);
      case 'reminders_add': return this.reminders.add(args);
      case 'reminders_complete': return this.reminders.complete(args);
      case 'calendar_today': return this.calendar.events(args);
      case 'mail_unread': return this.mail.unread();
      case 'mail_read': return this.mail.read(args);
      case 'mail_draft': return this.mail.draft(args);
      default: return fail('bad_action', `Unknown app tool ${String(tool).slice(0, 40)}.`);
    }
  }
}
