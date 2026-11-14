// Crash-safe state files. A state file (settings, the conversation's state, costs, vocabulary…)
// is never written in place: the new contents go to a temporary file next to it, are flushed,
// and then replace it in one rename, so a crash or a full disk can never leave half a file. The
// copy it replaced is kept as <file>.bak, and a file that won't parse is read from there instead
// of starting over from nothing.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Write `data` to `file` all at once (a reader sees the old contents or the new, never part).
 * @param {string} file
 * @param {string | Buffer} data
 * @param {{ mode?: number, backup?: boolean }} [o] mode: file permissions (0o600 for secrets);
 *   backup: keep the replaced copy as <file>.bak (on by default)
 */
export function writeFileAtomic(file, data, { mode, backup = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode ?? 0o644);
  try {
    if (typeof data === 'string') fs.writeSync(fd, data);
    else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } catch (e) {
    // A full disk: the half-written copy doesn't stay behind.
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  try {
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    if (backup && fs.existsSync(file)) {
      // The last good copy, only if it still parses (a bad file never replaces a good backup).
      if (!file.endsWith('.json') || parses(file)) fs.copyFileSync(file, `${file}.bak`);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Write a value as pretty JSON, crash-safe. @param {string} file @param {unknown} value @param {{ mode?: number, backup?: boolean, indent?: number }} [o] */
export function writeJson(file, value, { indent = 2, ...o } = {}) {
  writeFileAtomic(file, JSON.stringify(value, null, indent) + '\n', o);
}

/** @param {string} file */
function parses(file) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a JSON state file. Missing: `fallback`. Unreadable (cut off by a crash before files were
 * written this way, or edited by hand): the last good copy (<file>.bak), and failing that `fallback`.
 * @param {string} file
 * @param {any} fallback
 * @returns {any} (like JSON.parse)
 */
export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    try {
      const good = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
      console.error(`[state] ${path.basename(file)} couldn't be read; using its last good copy`);
      return good;
    } catch {
      console.error(`[state] ${path.basename(file)} couldn't be read and has no good copy; starting it fresh`);
      return fallback;
    }
  }
}
