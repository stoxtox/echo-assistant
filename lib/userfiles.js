// Small text files Echo writes and reads for the user, in one direct step: "write me a first web
// page", "make a packing list", "make it look better". No editor is driven and no worker starts.
// (Oct 6, 2026: a two-line web page typed into VS Code by keystrokes took two minutes, eleven
// wasted actions and three save approvals; restyling it started a worker and three more.)
//
// Safety, all checked here and not left to the assistant:
// - Only the top of the user's Desktop, Documents and Downloads: a plain file name (no folders in
//   it, no leading dot), and neither the folder nor the file may be a link to somewhere else.
// - Only harmless kinds of text (TEXT_TYPES). Never anything the Mac would run.
// - A new file is just made (the user asked for it). A file that is already there is replaced
//   only after the user's yes, unless it still holds exactly what Echo itself wrote into it since
//   the server started. With extra safety on, replacing always asks.
// - What a replaced file held is kept in memory (not as a backup file in the user's folder) so
//   the last write can be undone until Echo restarts or writes another file.
// The log (quick-actions.log) gets the file's name, folder and size: never a word of what is in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, APP_DIR } from './config.js';
import { isInside } from './text.js';
import { QuickError, CONFIRM_TTL_MS } from './quick.js';

/** The only folders, by name, at the top of the home folder. */
export const USER_FOLDERS = ['Desktop', 'Documents', 'Downloads'];

/**
 * The kinds of file Echo writes and reads: notes and lists (.txt .md), tables (.csv .tsv), data
 * (.json), and a web page with its style, script and pictures (.html .htm .css .js .svg; a .js
 * here only ever runs inside a page in the browser, and opens in a text editor). Nothing the Mac
 * runs when it is opened or double-clicked: no .sh, .command, .py, .rb, .pl, .scpt, .applescript,
 * .workflow, .plist, .app, .terminal, .webloc and so on. Anything not listed is refused.
 */
export const TEXT_TYPES = ['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.css', '.js', '.svg'];

/** The most Echo writes or reads back in one go. */
export const MAX_BYTES = 200 * 1024;
/** A file bigger than this is never replaced: its old content could not sensibly be kept for undo. */
export const MAX_REPLACED_BYTES = 2 * 1024 * 1024;

/** Kinds quick.openFile opens itself (its own list of documents); the others are opened here. */
const DOCUMENTS = new Set(['.txt', '.md', '.csv', '.tsv']);
/** Kinds that show in the browser. */
const PAGES = new Set(['.html', '.htm', '.svg']);
const APP_NAME = /^[\p{L}\p{N} .&'+-]{1,60}$/u;
/** Apps that would run a file handed to them, rather than show it. */
const RUNS_FILES = /terminal|iterm|warp|kitty|alacritty|ghostty|script editor|automator|shortcuts|installer/i;

const sha = (/** @type {string | Buffer} */ v) => crypto.createHash('sha256').update(v).digest('hex');
const where = (folder) => (folder === 'Desktop' ? 'on your Desktop' : `in your ${folder} folder`);

export class UserFiles {
  /**
   * @param {{ quick: { exec: Function, openFile: Function, audit: (event: string, data: any) => void },
   *   home?: string, now?: () => number, strict?: () => boolean, turn?: () => number, confirmTtlMs?: number }} opts
   *   quick: the quick actions (lib/quick.js), for opening a file and for the log.
   *   strict: is extra safety on (Settings)? turn: how many times the user has spoken so far.
   */
  constructor({ quick, home = os.homedir(), now = Date.now, strict = () => false, turn = () => 0, confirmTtlMs = CONFIRM_TTL_MS }) {
    this.quick = quick;
    this.home = home;
    this.now = now;
    this.strict = strict;
    this.turn = turn;
    this.confirmTtlMs = confirmTtlMs;
    /** Files Echo wrote since the server started: full path -> a fingerprint of what it wrote. @type {Map<string, string>} */
    this.mine = new Map();
    /** Replacements waiting for the user's yes: full path -> what would be written. @type {Map<string, { content: string, turn: number, expiresAt: number }>} */
    this.waiting = new Map();
    /** The last write, for undo. `previous` is what the file held before (null: it was new). @type {{ file: string, name: string, folder: string, previous: Buffer | null, wrote: string } | null} */
    this.last = null;
  }

  /**
   * Where a file name in one of the three folders really is, or a refusal to relay. Nothing is
   * read or written here.
   * @param {unknown} name @param {unknown} [folder]
   * @returns {{ file: string, name: string, folder: string, ext: string }}
   */
  locate(name, folder) {
    const n = String(name ?? '').trim();
    const wanted = String(folder || 'Desktop').trim().toLowerCase();
    const f = USER_FOLDERS.find((x) => x.toLowerCase() === wanted);
    if (!f) throw new QuickError(`I only write and read files in ${USER_FOLDERS.join(', ')}, by the folder's name.`);
    // eslint-disable-next-line no-control-regex
    if (!n || n.length > 120 || /[/\\:\x00-\x1f\x7f]/.test(n) || n === '..') throw new QuickError('Give just a file name with its ending, like "index.html": no folders or slashes in it.');
    if (n.startsWith('.')) throw new QuickError("I don't write or read hidden files (names that start with a dot).");
    const ext = path.extname(n).toLowerCase();
    if (!TEXT_TYPES.includes(ext)) {
      throw new QuickError(`I only write and read small text files here (${TEXT_TYPES.join(' ')}), never anything that runs, so not ${ext ? `a ${ext} file` : 'a file with no ending'}. A script or a bigger job goes to a worker (start_task or start_project).`);
    }
    let home;
    let dir;
    try {
      home = fs.realpathSync(this.home);
      dir = fs.realpathSync(path.join(home, f));
    } catch {
      throw new QuickError(`There is no ${f} folder in your home folder.`, 'not_found');
    }
    // The folder itself must be the real one, not a link that leads somewhere else.
    if (dir !== path.join(home, f) || !fs.statSync(dir).isDirectory()) throw new QuickError(`Your ${f} folder points somewhere else, so I won't write there.`);
    const file = path.join(dir, n);
    if (path.dirname(file) !== dir || isInside(file, APP_DIR) || isInside(file, config.dataDir)) throw new QuickError("I can't write there.");
    return { file, name: n, folder: f, ext };
  }

  /** What is at this path now: nothing, or a plain file Echo may touch (anything else is refused). */
  existing(file, name) {
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      return null;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) throw new QuickError(`${name} is a link or not an ordinary file, so I won't touch it.`);
    return st;
  }

  /**
   * Make a new file, or replace one (after the user's yes, unless it still holds what Echo wrote).
   * @param {{ name: string, folder?: string, content?: string, confirmed?: boolean, open_with?: string }} req
   *   confirmed: true only after the user clearly said yes to the question a first call returned;
   *   false: they said no. The content of the first call is kept, so it need not be given again.
   * @returns {Promise<any>}
   */
  async write({ name, folder, content, confirmed, open_with }) {
    const at = this.locate(name, folder);
    for (const [k, w] of this.waiting) if (this.now() > w.expiresAt) this.waiting.delete(k);
    const asked = this.waiting.get(at.file);
    if (confirmed === false) {
      this.waiting.delete(at.file);
      return { written: false, cancelled: true, file: at.name, folder: at.folder };
    }
    const body = content === undefined || content === null ? asked?.content : String(content);
    if (body === undefined) throw new QuickError('There is nothing to write: give the content.');
    const bytes = Buffer.byteLength(body);
    if (bytes > MAX_BYTES) throw new QuickError(`That is too much for one quick file (over ${MAX_BYTES / 1024} KB). A job that size goes to a worker (start_task or start_project).`);
    const openWith = this.checkOpen(open_with);

    const st = this.existing(at.file, at.name);
    let previous = null;
    if (st) {
      if (st.size > MAX_REPLACED_BYTES) throw new QuickError(`${at.name} is too big for me to replace safely. Pick another name.`);
      previous = fs.readFileSync(at.file);
      // Echo's own file, untouched since: replacing it is what "make it look better" means.
      const own = this.mine.get(at.file) === sha(previous) && !this.strict();
      // A yes counts only for a question already asked about this file, and only once the user
      // has spoken since it was asked: the assistant can't answer its own question in one turn.
      const yes = confirmed === true && asked && this.turn() > asked.turn;
      if (!own && !yes) {
        this.waiting.set(at.file, { content: body, turn: asked && confirmed ? asked.turn : this.turn(), expiresAt: this.now() + this.confirmTtlMs });
        if (!asked || !confirmed) this.quick.audit('file_write_asked', { file: at.name, folder: at.folder, bytes });
        return {
          written: false,
          needsConfirm: true,
          file: at.name,
          folder: at.folder,
          question: `There is already a file called ${at.name} ${where(at.folder)}. Replace it?`,
          note: `Nothing was written. Ask the user exactly that and wait for their answer. Only after they clearly say yes, call write_file again with this name and folder and confirmed: true (leave content out: Echo kept it). If they say no, call it with confirmed: false, or offer another name.${asked && confirmed ? ' The user has not answered since the question was asked: do not call again until they do.' : ''}`,
        };
      }
      // Replace in place, never through a link put there in the meantime.
      const fd = fs.openSync(at.file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
      try {
        fs.writeFileSync(fd, body);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      // New: fails rather than follow or replace anything that appeared since the check. Never executable.
      fs.writeFileSync(at.file, body, { flag: 'wx', mode: 0o644 });
    }
    this.waiting.delete(at.file);
    this.mine.set(at.file, sha(body));
    this.last = { file: at.file, name: at.name, folder: at.folder, previous, wrote: sha(body) };
    this.quick.audit('file_written', { file: at.name, folder: at.folder, bytes, replaced: Boolean(st) });
    /** @type {any} */
    const out = { written: at.name, folder: at.folder, bytes, replaced: Boolean(st) };
    if (st) out.undo = 'The old version is kept until Echo restarts or writes another file: undo_write puts it back.';
    if (openWith !== null) {
      try {
        out.opened = (await this.open(at, openWith)).app;
      } catch (e) {
        out.openError = `The file is written, but it could not be opened: ${e.message}`;
      }
    }
    return out;
  }

  /**
   * Read one of those files back, so it can be changed and written again.
   * @param {{ name: string, folder?: string }} req
   */
  read({ name, folder }) {
    const at = this.locate(name, folder);
    const st = this.existing(at.file, at.name);
    if (!st) throw new QuickError(`There is no file called ${at.name} ${where(at.folder)}.`, 'not_found');
    const fd = fs.openSync(at.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, MAX_BYTES));
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
    if (buf.includes(0)) throw new QuickError(`${at.name} isn't a text file.`);
    const truncated = st.size > buf.length;
    this.quick.audit('file_read', { file: at.name, folder: at.folder, bytes: buf.length });
    return {
      file: at.name,
      folder: at.folder,
      bytes: st.size,
      content: buf.toString('utf8'),
      ...(truncated ? { truncated: true, note: `Only the first ${MAX_BYTES / 1024} KB. Do NOT write this back with write_file: the rest would be lost. A file this size goes to a worker.` } : {}),
    };
  }

  /** Put back what the last write replaced (one step back, this server run). */
  undo() {
    const l = this.last;
    if (!l) throw new QuickError('There is nothing to undo: Echo has not written a file since it started.');
    if (l.previous === null) throw new QuickError(`${l.name} was a new file, so there is no older version to put back. If the user wants it gone, move it to the Trash (finder_trash), which asks them first.`);
    const st = this.existing(l.file, l.name);
    // Changed since Echo wrote it (the user edited it): putting the old one back would lose that.
    if (!st || sha(fs.readFileSync(l.file)) !== l.wrote) throw new QuickError(`${l.name} has changed since Echo wrote it, so the old version was not put back.`);
    const fd = fs.openSync(l.file, fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW);
    try {
      fs.writeFileSync(fd, l.previous);
    } finally {
      fs.closeSync(fd);
    }
    this.last = null;
    // It holds the user's content again: replacing it asks.
    this.mine.delete(l.file);
    this.quick.audit('file_write_undone', { file: l.name, folder: l.folder, bytes: l.previous.length });
    return { restored: l.name, folder: l.folder, bytes: l.previous.length };
  }

  /** open_with as given: null (don't open), '' (the default app or the browser), or a checked app name. */
  checkOpen(openWith) {
    const w = String(openWith ?? '').trim();
    if (!w) return null;
    if (/^(default|browser)$/i.test(w)) return '';
    if (!APP_NAME.test(w)) throw new QuickError(`"${w.slice(0, 60)}" doesn't look like an app name.`);
    if (RUNS_FILES.test(w)) throw new QuickError(`I don't open files in ${w}: it runs things. Name an editor or a browser.`);
    return w;
  }

  /**
   * Show the file: documents through the quick actions' own open-file helper; a page in the
   * browser; a style sheet, script or data file in the text editor (-t), so nothing is ever run.
   * @param {{ file: string, name: string, ext: string }} at @param {string} app '' for the default
   */
  async open(at, app) {
    if (DOCUMENTS.has(at.ext)) return this.quick.openFile(at.file, app, { home: fs.realpathSync(this.home) });
    await this.quick.exec('open', app ? ['-a', app, at.file] : PAGES.has(at.ext) ? [at.file] : ['-t', at.file]);
    this.quick.audit('file_opened', { file: at.name, app: app || undefined });
    return { opened: at.name, app: app || (PAGES.has(at.ext) ? 'the browser' : 'the text editor') };
  }
}
