// The native errand tools (lib/quick.js): messages, calendar, apps, files, media. Errors come
// back as a sentence to say. Moved out of the dispatcher unchanged.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { text, fail, TOO_QUIET } from './result.js';
import { getSettings } from '../settings.js';


/** @param {any} d the dispatcher (lib/dispatcher.js) */
export function quickTools(d) {
  const quick = d.quick;
  const run = async (fn) => {
    try {
      return text(await fn());
    } catch (e) {
      return fail(e.code === 'permission' ? `Permission needed. Tell the user: ${e.message}` : e.message);
    }
  };
  return [
    tool(
      'find_contact',
      'Search the Mac Contacts app by name, nickname, saved alias or last digits. Returns people with ids and masked numbers/emails (last 4 digits). Fast (cached).',
      { name: z.string().describe('Name as the user said it') },
      ({ name }) => run(() => quick.findContact(name))
    ),
    tool(
      'send_imessage',
      'Send an iMessage through Messages. Shows a Send/Cancel card in the Echo window unless direct is allowed. Every send is logged. Once sent, the result\'s delivery line says what is known about whether it arrived: say that, not more.',
      {
        to: z.string().describe('A contact id from find_contact, or a saved favorite alias, or a phone number/email the user dictated'),
        text: z.string().describe('The exact message'),
        direct: z.boolean().optional().describe('True only if the user gave both the recipient and the exact text in this same request'),
        sms: z.boolean().optional().describe('Send as SMS instead of iMessage; only when the user explicitly asks'),
        attachment: z.string().optional().describe('A picture or file to send with it: a full path from find_file or save_from_url. It always waits on the card. The result says whether the file attached (fileAttached); when it did not, the words still went and the file did not.'),
      },
      // Safe mode: every message waits on its Send / Cancel card.
      ({ to, text: body, direct, sms, attachment }) => run(() => quick.sendMessage({ to, text: body ?? '', direct: direct && !getSettings().safeMode, sms, attachment }))
    ),
    tool(
      'confirm_message',
      'Send or cancel a message waiting on its confirmation card, after the user clearly says yes or no out loud. Once sent, the result\'s delivery line says what is known about whether it arrived: say that, not more. With a file, fileAttached: false means the file did NOT go (only the words did): say so, never that the file was sent.',
      { pending_id: z.string(), send: z.boolean() },
      // (A soft or clipped yes is asked about once more before anything is sent: dispatcher.clearYes.)
      async ({ pending_id, send }) => (send && !d.clearYes(`message:${pending_id}`) ? fail(TOO_QUIET) : run(() => quick.resolvePending(pending_id, send, 'voice')))
    ),
    tool(
      'message_status',
      'Did it go through? What is known about the last few messages Echo sent to one person (delivered, sent, went as SMS, NOT delivered, or can\'t be checked), from Echo\'s own record and Messages, never the screen. Read-only; no message text.',
      { to: z.string().describe('A contact id from find_contact, or a saved favorite alias'), count: z.number().optional().describe('How many of the latest messages (default 3)') },
      ({ to, count }) => run(() => quick.messageStatus({ to, count }))
    ),
    tool(
      'set_contact_alias',
      'Save a favorite: a name the user uses for a contact (e.g. "Sam", "mom") pointing at one exact number or email, after they confirmed which one.',
      { alias: z.string(), contact_id: z.string().describe('Id from find_contact') },
      ({ alias, contact_id }) => run(() => quick.setAlias(alias, contact_id))
    ),
    tool(
      'add_calendar_event',
      'Add an event to the Mac Calendar app (the default calendar, or a named one). Times are local ISO, e.g. 2026-09-26T19:00.',
      {
        title: z.string(),
        start: z.string().describe('Local ISO date-time; a date alone (2026-09-26) with all_day'),
        end: z.string().optional().describe('Local ISO date-time; default one hour after start'),
        location: z.string().optional(),
        notes: z.string().optional(),
        alert_minutes: z.number().optional().describe('Alert this many minutes before'),
        calendar: z.string().optional().describe('Calendar name, if the user named one'),
        all_day: z.boolean().optional(),
      },
      (ev) => run(() => quick.addCalendarEvent(ev))
    ),
    tool('open_url', 'Open a web (or mailto) link in the default browser on the Mac.', { url: z.string() }, ({ url }) => run(() => quick.openUrl(url))),
    tool(
      'open_app',
      'Open (or bring forward) a Mac app by name, e.g. "Spotify". With file (a full path from find_file), opens that file in it. Computer-use steps then go to this app.',
      { name: z.string(), file: z.string().optional().describe('A full path from find_file, to open in this app') },
      ({ name, file }) => run(async () => {
        const r = file ? await quick.openFile(file, name) : await quick.openApp(name);
        // The driving session works in this app from now on (lib/computer.js), by its real name
        // ("Chrome" opens "Google Chrome").
        d.computer.noteApp(r?.opened || name);
        return r;
      })
    ),
    tool(
      'media_control',
      'Apple Music or Spotify without touching the screen: play, pause, toggle, next, previous, or search_play a song, album or artist (Music plays it from the library; otherwise the search opens in the app for you to click the top result).',
      {
        app: z.enum(['Music', 'Spotify']),
        action: z.enum(['play', 'pause', 'toggle', 'next', 'previous', 'search_play']),
        query: z.string().optional().describe('For search_play: the song, album or artist'),
      },
      ({ app, action, query }) => run(async () => {
        const r = await quick.mediaControl({ app, action, query });
        d.computer.noteApp(r.app);
        return r;
      })
    ),
    tool(
      'find_file',
      "Find the user's own files with Spotlight in one step (never by browsing Finder), newest first: by name, and optionally by kind, how recently they changed, or words inside. Use before start_project when they mention a file they have, and for \"find the photos from the memory card\" (scope volumes, kind image).",
      {
        name: z.string().describe('Part of the file name, e.g. "budget" or "budget.xlsx"; "" to find by kind/days/content only'),
        scope: z.enum(['home', 'icloud', 'volumes', 'finder', 'everywhere']).optional().describe('home (default), icloud (iCloud Drive), volumes (connected drives, memory cards), finder (the folder open in Finder), everywhere'),
        kind: z.enum(['image', 'photo', 'pdf', 'document', 'spreadsheet', 'presentation', 'video', 'audio', 'folder']).optional(),
        days: z.number().optional().describe('Only files changed in the last N days'),
        content: z.string().optional().describe('Words inside the file'),
      },
      ({ name, scope, kind, days, content }) => run(() => quick.findFiles(name, { scope, kind, days, content }))
    ),
    tool(
      'reveal_file',
      'Show a file in Finder, selected (a full path from find_file). Opens its folder with it highlighted.',
      { path: z.string() },
      ({ path: file }) => run(() => quick.revealFile(file))
    ),
    tool(
      'save_from_url',
      'Save a picture or file from a web link into Downloads ("save this image", "download that PDF"), checked after saving. Returns its full path (to send it with send_imessage attachment, or open it).',
      { url: z.string(), name: z.string().optional().describe('A file name to save it as, without the extension') },
      ({ url, name }) => run(() => quick.saveFromUrl({ url, name }))
    ),
    tool(
      'read_clipboard',
      'Read the text on the clipboard ("what did I copy?", "paste what I copied into…"). Passwords, keys and card numbers come back blacked out.',
      {},
      () => run(() => quick.readClipboard())
    ),
  ];
}
