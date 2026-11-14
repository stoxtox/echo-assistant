// The small-file tools (lib/userfiles.js): write a text file for the user in one step, read it
// back to change it, and undo the last write. Errors come back as a sentence to say.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { text, fail, TOO_QUIET } from './result.js';
import { getSettings } from '../settings.js';
import { UserFiles, USER_FOLDERS, TEXT_TYPES, MAX_BYTES } from '../userfiles.js';

const folder = z.string().optional().describe(`${USER_FOLDERS.join(', ')} (default Desktop)`);
const TYPES = TEXT_TYPES.join(' ');

/** @param {any} d the dispatcher (lib/dispatcher.js) */
export function fileTools(d) {
  // One for the whole server run: it remembers which files Echo wrote, and the last one for undo.
  // (Tests give the dispatcher one with a throwaway home folder.)
  d.userFiles ||= new UserFiles({ quick: d.quick, strict: () => Boolean(getSettings().safeMode), turn: () => Number(d.computer?.turns) || 0 });
  /** @type {UserFiles} */
  const files = d.userFiles;
  const run = async (fn) => {
    try {
      return text(await fn());
    } catch (e) {
      return fail(e.message);
    }
  };
  return [
    tool(
      'write_file',
      `Write one small text file for the user (a web page, a note, a list, a table) straight into Desktop, Documents or Downloads, and optionally open it. Kinds: ${TYPES}; up to ${MAX_BYTES / 1024} KB. A new file is just made. If a file with that name is already there and Echo didn't write it, nothing is written and the result has needsConfirm with the question to ask.`,
      {
        name: z.string().describe('The file name with its ending, e.g. "index.html". No folders or slashes.'),
        folder,
        content: z.string().optional().describe('The whole finished text of the file. Left out only with confirmed.'),
        open_with: z.string().optional().describe('Open it afterwards: "browser" for a web page, "default", or an app name'),
        confirmed: z.boolean().optional().describe('Only after a needsConfirm result: true once the user clearly said yes to replacing the file, false if they said no'),
      },
      async (args) => {
        // (A soft or clipped yes is asked about once more before a file is replaced: dispatcher.clearYes.)
        if (args.confirmed === true && !d.clearYes(`write:${args.folder || 'Desktop'}/${args.name}`)) return fail(TOO_QUIET);
        return run(async () => {
          const r = await files.write(args);
          // Steps on the screen go to the app it was opened in, when one was named (as open_app does).
          if (r.opened && args.open_with && !/^(default|browser)$/i.test(args.open_with.trim())) d.computer?.noteApp?.(r.opened);
          return r;
        });
      }
    ),
    tool(
      'read_text_file',
      `Read one small text file from Desktop, Documents or Downloads (${TYPES}), e.g. to change a file you wrote and write it back with write_file. Read-only.`,
      { name: z.string().describe('The file name with its ending'), folder },
      (args) => run(() => files.read(args))
    ),
    tool('undo_write', "Put back what the last write_file replaced (one step back; only since Echo started). A file that was new has nothing to put back.", {}, () => run(() => files.undo())),
  ];
}
