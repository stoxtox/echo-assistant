// The everyday-app tools (lib/apps): Finder, Notes, Reminders, Calendar and Mail through their
// own scripting, so common errands never need clicking. Each goes through ComputerUse.app, which
// asks first where lib/policy.ts says to and logs only the tool, a count and how long it took.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { Apps } from '../apps/index.js';

const out = (value) => ({ content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(value) }], ...(value && value.error ? { isError: true } : {}) });

/** One sentence for the system guidance (lib/dispatcher.js). */
export const APPS_PROMPT = '- In Finder, Notes, Reminders, Calendar and Mail, use the finder_, notes_, reminders_, calendar_ and mail_ tools (and add_calendar_event) instead of clicking or typing in those apps: they are faster and checked. If one says the app isn\'t open, offer to open it; mail_draft only ever leaves a draft.';

const filePath = z.string().describe('Full path inside the home folder ("~/Documents/Taxes")');

/** @param {any} d the dispatcher (lib/dispatcher.js) */
export function appTools(d) {
  const computer = d.computer;
  // The real apps, on the AppleScript runner the quick actions use (tests give ComputerUse a fake).
  computer.apps ||= new Apps({
    run: (script, args, opts) => d.quick.osa(script, args, opts),
    reveal: (file) => d.quick.revealFile(file),
    resolve: (to) => d.quick.resolveRecipient(to),
  });
  const t = (name, description, shape) => tool(name, description, shape, async (args) => out(await computer.app(name, args)));
  return [
    t('finder_list', 'List a folder in the home folder: names, sizes, dates.', { path: filePath.optional().describe('The folder; left out: the home folder') }),
    t('finder_reveal', 'Show a file or folder in Finder, selected.', { path: filePath }),
    t('finder_new_folder', 'Make a new, empty folder.', { name: z.string(), in: filePath.optional().describe('The folder to make it in; left out: the home folder') }),
    t('finder_move', 'Move files or folders into a folder. Never replaces anything. More than 10 at once asks the user first.', { paths: z.array(filePath).min(1), to: filePath.describe('The folder they go into') }),
    t('finder_rename', 'Rename files or folders. Never replaces anything. More than 10 at once asks the user first.', { items: z.array(z.object({ path: filePath, name: z.string().describe('The new name, with its extension') })).min(1) }),
    t('finder_trash', 'Move files or folders to the Trash (the user can put them back). Always asks the user first.', { paths: z.array(filePath).min(1) }),
    t('notes_find', 'Find notes in the Notes app by words in the title or text; no words: the newest. Gives ids and titles.', { text: z.string().optional() }),
    t('notes_read', 'Read one note.', { note: z.string().describe('Its id from notes_find, or its exact title') }),
    t('notes_create', 'Make a new note.', { title: z.string(), text: z.string().optional(), folder: z.string().optional().describe('A folder in Notes, if the user named one') }),
    t('notes_append', 'Add text to the end of a note.', { note: z.string().describe('Its id from notes_find, or its exact title'), text: z.string() }),
    t('reminders_list', 'The reminders not yet done.', { list: z.string().optional().describe('One list by name; left out: all') }),
    t('reminders_add', 'Add a reminder.', { title: z.string(), due: z.string().optional().describe('Local date (2026-10-03) or date and time (2026-10-03T14:00)'), list: z.string().optional(), notes: z.string().optional() }),
    t('reminders_complete', 'Tick a reminder off.', { reminder: z.string().describe('Its id from reminders_list, or its exact title') }),
    t('calendar_today', "Read the Calendar: today's events, or the days from..to.", { from: z.string().optional().describe('Local date, e.g. 2026-10-03; left out: today'), to: z.string().optional().describe('The last day; left out: the same day') }),
    t('mail_unread', 'The unread mail in the inbox: senders and subjects only.', {}),
    t('mail_read', 'Read one message.', { id: z.number().describe('Its id from mail_unread') }),
    t('mail_draft', 'Write an email as a DRAFT and open it in Mail for the user to look over. It is never sent from here.', { to: z.array(z.string()).optional().describe('Contact ids from find_contact, or addresses the user gave'), subject: z.string().optional(), text: z.string() }),
  ];
}
