// Files and folders without clicking through Finder: list a folder, make one, move, rename, and
// move to the Trash.
//
// Everything but the Trash is done here, by the file system itself: it needs no app, it can't be
// misheard by a script, and each step is checked as it happens. Only the Trash goes through
// Finder (its `delete` puts things in the system Trash, where the user can put them back): there
// is no other way to reach the Trash, and Echo never deletes a file outright.
//
// What may be touched: the user's own things inside their home folder. Never a hidden file,
// ~/Library, Echo's own files, or anything a link leads to outside home; and the home folder and
// its standard folders (Desktop, Documents, …) can be listed and filled but never moved, renamed
// or trashed themselves. Nothing is ever replaced: a name that is taken is an error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, APP_DIR } from '../config.js';
import { isInside } from '../text.js';
import { COMMON, callScript, fail } from './osa.js';

/** How many entries of a folder one listing gives. */
export const LIST_MAX = 100;
/** How many things one move, rename or trash may name. */
export const BATCH_MAX = 200;

/** Folders macOS itself puts in a home: theirs to stay where they are. */
const STANDARD = new Set(['Applications', 'Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public', 'Sites']);

// argv: the full paths to move to the Trash. Each is turned into an alias before Finder is asked
// (so one that isn't there stops everything before anything moves), then all go in one `delete`,
// which in Finder means "move to the Trash".
export const FINDER_SCRIPT = String.raw`${COMMON}
on run argv
	set |TB| to character id 9
	set |theItems| to {}
	repeat with |onePath| in argv
		try
			set end of |theItems| to ((POSIX file (contents of |onePath|)) as alias)
		on error
			return "ERR" & |TB| & "not_found"
		end try
	end repeat
	try
		with timeout of 5 seconds
			tell application "Finder" to delete |theItems|
		end timeout
	on error |errText| number |errNum|
		return "ERR" & |TB| & "script" & |TB| & |errNum| & |TB| & my escText(|errText|)
	end try
	return "OK"
end run
`;

const bad = (message) => fail('bad_path', message);
const OWN_FILES = 'Echo only works with your own files and folders inside your home folder: not hidden ones, the Library, system folders, other disks, or anything a link leads to outside it.';

/**
 * A path the assistant gave, checked: `{ path }` (absolute, no "..", inside home, and there) or `{ error }`.
 * @param {unknown} given a full path, or one starting with "~/"
 * @param {{ home?: string, change?: boolean }} [o] change: it is about to be moved, renamed or
 *   trashed (so not home itself or one of its standard folders)
 * @returns {any} { path } or { error, message }
 */
export function checkPath(given, { home = os.homedir(), change = false } = {}) {
  let s = String(given ?? '').trim();
  if (s === '~' || s.startsWith('~/')) s = path.join(home, s.slice(1));
  if (!s || s.includes('\0') || !path.isAbsolute(s)) return bad(`Give the full path (it starts with "/" or "~/"). ${OWN_FILES}`);
  const p = path.resolve(s);
  const off = (root, at) => {
    const rel = path.relative(root, at);
    const parts = rel.split(path.sep);
    return !isInside(at, root) || parts.some((x) => x.startsWith('.')) || parts[0] === 'Library';
  };
  if (off(home, p) || isInside(p, APP_DIR) || isInside(p, config.dataDir)) return bad(OWN_FILES);
  if (change && (p === path.resolve(home) || (path.dirname(p) === path.resolve(home) && STANDARD.has(path.basename(p))))) return bad(`${path.basename(p)} is one of the Mac's own folders: Echo works with what is inside it, never the folder itself.`);
  // Where it really is, links followed: still inside home, by the same rules.
  let real = '';
  try {
    real = fs.realpathSync(p);
  } catch (e) {
    return denied(e, p);
  }
  let realHome = home;
  try {
    realHome = fs.realpathSync(home);
  } catch {}
  if (off(realHome, real)) return bad(`That is a link to somewhere outside your own files. ${OWN_FILES}`);
  return { path: p };
}

/** A file-system error in words: macOS keeping Echo out of a folder, or anything else. */
function denied(e, p) {
  const code = /** @type {any} */ (e)?.code;
  if (code === 'EPERM' || code === 'EACCES') return fail('not_allowed', `macOS hasn't allowed Echo into ${path.basename(path.dirname(p)) || 'that folder'}. Tell the user: open System Settings, Privacy & Security, Files and Folders, and switch that folder on under Echo. Then try again.`);
  if (code === 'ENOENT') return fail('not_found', `There is nothing at ${p}.`);
  if (code === 'EXDEV') return fail('failed', 'That would move it to another disk, which Echo leaves to the user.');
  return fail('failed', `That didn't work (${String(code || 'error')}).`);
}

/** A name for a new folder or a renamed file: one name, not a path, not hidden. */
function checkName(name) {
  const n = String(name ?? '').trim();
  if (!n || n.length > 255 || /[/:\0]/.test(n) || n.startsWith('.') || n === '..') return fail('bad_name', `"${n.slice(0, 40)}" can't be a name: give one name with no "/" or ":" in it, not starting with a dot.`);
  return { name: n };
}

const there = (p) => fs.lstatSync(p, { throwIfNoEntry: false });
const many = (list) => (Array.isArray(list) ? list : list === undefined || list === null ? [] : [list]);

export class Finder {
  /**
   * @param {{ run: (script: string, args: string[], opts?: { timeoutMs?: number }) => Promise<string>,
   *   reveal?: ((file: string) => Promise<any>) | null, home?: string, timeoutMs?: number }} opts
   *   run: the AppleScript runner; reveal: shows a file in Finder (QuickActions.revealFile)
   */
  constructor({ run, reveal = null, home = os.homedir(), timeoutMs }) {
    this.run = run;
    this.revealFile = reveal;
    this.home = home;
    this.timeoutMs = timeoutMs;
  }

  /**
   * What a move, a rename or a trash would touch, checked, before anything is done: how many
   * things, and a name for the card ("“Notes.txt”", "12 items").
   * @param {'move' | 'rename' | 'trash'} op @param {any} args
   * @returns {any} { error, message } or { op, count, label, items, to }
   */
  plan(op, args = {}) {
    const given = op === 'rename' ? many(args.items) : many(args.paths);
    if (!given.length) return fail('bad_path', op === 'rename' ? 'Give items: each a path and its new name.' : 'Give paths: the full path of each thing.');
    if (given.length > BATCH_MAX) return fail('too_many', `That is ${given.length} things; Echo does at most ${BATCH_MAX} at once.`);
    let to = '';
    if (op === 'move') {
      const dest = checkPath(args.to, { home: this.home });
      if (dest.error) return dest;
      if (!fs.statSync(dest.path).isDirectory()) return fail('not_found', `${dest.path} isn't a folder.`);
      to = dest.path;
    }
    const items = [];
    const taken = new Set();
    for (const g of given) {
      const c = checkPath(op === 'rename' ? g?.path : g, { home: this.home, change: true });
      if (c.error) return c;
      const st = /** @type {fs.Stats} */ (there(c.path));
      // Finder follows a link to what it points at, so the Trash would take the wrong thing.
      if (op === 'trash' && st.isSymbolicLink()) return bad(`${path.basename(c.path)} is a link to something else. Echo leaves links to the user.`);
      let dest = '';
      if (op === 'rename') {
        const n = checkName(g?.name);
        if (n.error) return n;
        dest = path.join(path.dirname(c.path), /** @type {string} */ (n.name));
      } else if (op === 'move') {
        if (isInside(to, c.path)) return bad(`${path.basename(c.path)} can't go inside itself.`);
        dest = path.join(to, path.basename(c.path));
      }
      if (dest) {
        if (dest === c.path) return fail('exists', `${path.basename(c.path)} is already there by that name.`);
        // Nothing is ever replaced. (A change of capitals only is the same file, and fine.)
        const same = dest.toLowerCase() === c.path.toLowerCase();
        if (taken.has(dest.toLowerCase()) || (there(dest) && !same)) return fail('exists', `There is already a “${path.basename(dest)}” in ${path.basename(path.dirname(dest))}. Nothing was changed: pick another name.`);
        taken.add(dest.toLowerCase());
      }
      items.push({ from: c.path, to: dest });
    }
    const label = items.length === 1 ? `“${path.basename(/** @type {any} */ (items[0]).from)}”` : `${items.length} items`;
    return { op, count: items.length, label, items, to };
  }

  /** What is in a folder: names, which are folders, sizes and when each last changed. */
  list(args = {}) {
    const c = checkPath(args.path || '~', { home: this.home });
    if (c.error) return c;
    let names;
    try {
      names = fs.readdirSync(c.path, { withFileTypes: true });
    } catch (e) {
      return /** @type {any} */ (e)?.code === 'ENOTDIR' ? fail('not_found', `${path.basename(c.path)} is a file, not a folder.`) : denied(e, path.join(c.path, 'x'));
    }
    // What Echo may not go into isn't shown either: hidden things, and the Library at the top of home.
    const top = c.path === path.resolve(this.home);
    const shown = names.filter((d) => !d.name.startsWith('.') && !(top && d.name === 'Library')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const items = shown.slice(0, LIST_MAX).map((d) => {
      const st = fs.statSync(path.join(c.path, d.name), { throwIfNoEntry: false });
      const folder = st ? st.isDirectory() : d.isDirectory();
      return { name: d.name, ...(folder ? { folder: true } : { size: st?.size ?? 0 }), ...(st ? { changed: st.mtime.toISOString().slice(0, 10) } : {}) };
    });
    return { folder: c.path, count: shown.length, items, ...(shown.length > items.length ? { note: `Only the first ${items.length} of ${shown.length} are here. Use find_file to look for one by name.` } : {}) };
  }

  /** A new, empty folder. */
  newFolder(args = {}) {
    const parent = checkPath(args.in || '~', { home: this.home });
    if (parent.error) return parent;
    const n = checkName(args.name);
    if (n.error) return n;
    const p = path.join(parent.path, /** @type {string} */ (n.name));
    if (there(p)) return fail('exists', `There is already a “${n.name}” in ${path.basename(parent.path)}.`);
    try {
      fs.mkdirSync(p);
    } catch (e) {
      return denied(e, p);
    }
    return { done: true, created: p, count: 1 };
  }

  /** Move things into a folder, or give them new names. `planned`: what plan() answered. */
  relocate(planned) {
    let n = 0;
    for (const it of planned.items) {
      try {
        // Looked at again right before: something made since the check is never replaced.
        if (there(it.to) && it.to.toLowerCase() !== it.from.toLowerCase()) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        fs.renameSync(it.from, it.to);
        n++;
      } catch (e) {
        const why = /** @type {any} */ (e)?.code === 'EEXIST' ? fail('exists', `There is already a “${path.basename(it.to)}” there.`) : denied(e, it.from);
        return { ...why, message: `${why.message} ${n} of ${planned.items.length} were done before it stopped.`, count: n };
      }
    }
    return { done: true, [planned.op === 'rename' ? 'renamed' : 'moved']: n, ...(planned.to ? { to: planned.to } : {}), paths: planned.items.slice(0, 20).map((it) => it.to), count: n };
  }

  /** To the system Trash, through Finder, and checked: each thing is gone from where it was. */
  async trash(planned) {
    const paths = planned.items.map((it) => it.from);
    const a = await callScript(this.run, 'Finder', FINDER_SCRIPT, paths, { ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}) });
    const left = paths.filter((p) => there(p));
    const gone = paths.length - left.length;
    if (a.error) return { ...a, count: gone };
    if (left.length) return { error: 'failed', message: `Finder answered, but ${left.length} of ${paths.length} are still where they were. Don't tell the user they are in the Trash.`, count: gone };
    return { done: true, trashed: gone, note: 'In the Trash, not deleted: the user can put it back from there.', count: gone };
  }

  /** Show it in Finder, selected. */
  async reveal(args = {}) {
    const c = checkPath(args.path, { home: this.home });
    if (c.error) return c;
    if (!this.revealFile) return fail('unsupported', 'Showing a file in Finder is not available here.');
    try {
      return { ...(await this.revealFile(c.path)), count: 1 };
    } catch (e) {
      return fail(/** @type {any} */ (e)?.code === 'not_found' ? 'not_found' : 'failed', String(/** @type {any} */ (e)?.message || 'Finder would not show it.'));
    }
  }
}
