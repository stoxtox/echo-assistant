// A node script that names the live Echo, run read-only instead of asking.
//
// A self-improvement worker often checks something against the real Echo with a quick script: a
// dry run of a migration over the live folder, a report over its data. Such a command names the
// live folder, so it used to ask ("touches Echo itself") even though it only reads. Now it runs
// under Node's permission model (`node --permission`), which the operating system's file calls go
// through:
//   - reads: the task's own folder, the live Echo's code, logs and data, temp folders. Never a
//     .env file or the self-improve PIN (data/self holds only the audit log to read).
//   - writes: only the task's own folder and temp folders. Never the live Echo.
//   - no child processes, worker threads, native add-ons or WASI.
// Only a plain `node <script>` or `node -e <code>` (after an optional `cd <folder> &&`), with
// read-only helpers after it (| head, 2>&1 | sed …) qualifies; anything else asks as before, and
// so does a command that names Echo's port. A script that needs more fails with ERR_ACCESS_DENIED.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR, config } from './config.js';
import { splitCommand, shellSegments, isReadOnlyCommand, isSecretPath } from './safety.js';

const NODE_START = /^(\s*cd\s+(?:'[^']+'|"[^"$`\\]+"|[^\s;&|'"\\$`<>(){}]+)\s*&&\s*)?node(?=\s)/;
// Options that change nothing about what the script may do.
const SAFE_OPTION = /^(--input-type=(module|commonjs)|--no-warnings|--trace-warnings|--enable-source-maps|--stack-trace-limit=\d+|--experimental-default-type=(module|commonjs))$/;
const CODE_OPTION = new Set(['-e', '--eval', '-p', '--print']);

/** The permission flag this Node understands, or null (too old: then the command asks). */
export function permissionFlag() {
  return process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : null;
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** Everything in a folder except secrets (and except the folders listed in `skip`). */
function entries(dir, skip = []) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => path.join(dir, n))
    .filter((p) => !/^\.env/.test(path.basename(p)) && !isSecretPath(p) && !isSecretPath(p, 'Grep') && !skip.some((s) => inside(s, p)));
}

/**
 * What a sandboxed script may read and write, or null if the task's own folder overlaps the live
 * Echo (then nothing is granted).
 * @param {{ own: string, live?: string, dataDir?: string, logDir?: string }} o
 */
export function sandboxPaths({ own, live = APP_DIR, dataDir = config.dataDir, logDir = config.logDir }) {
  const mine = path.resolve(own);
  const liveRoots = [live, dataDir, logDir].map((p) => path.resolve(p));
  if (liveRoots.some((r) => inside(mine, r) || inside(r, mine))) return null;
  // Temp folders, unless the live Echo is inside one (tests, a copy run from /tmp): never grant it that way.
  const temps = [...new Set([os.tmpdir(), real(os.tmpdir()), '/tmp', '/private/tmp'])].filter((t) => !liveRoots.some((r) => inside(r, t) || inside(real(r), t)));
  const audit = path.join(dataDir, 'self', 'audit.log');
  const reads = [
    ...entries(mine),
    ...entries(live, [dataDir, logDir]),
    ...entries(dataDir),
    ...(fs.existsSync(audit) ? [audit] : []),
    ...(fs.existsSync(logDir) ? [logDir] : []),
    ...temps,
  ];
  return { reads: [...new Set(reads)], writes: [mine, ...temps] };
}

const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The command with its node script sandboxed (read-only on the live Echo), or null if it isn't a
 * plain node run with read-only helpers around it.
 * @param {string} command
 * @param {{ own: string, live?: string, dataDir?: string, logDir?: string }} where own: the task's folder
 */
export function sandboxNode(command, where) {
  const cmd = String(command || '');
  const flag = permissionFlag();
  const m = cmd.match(NODE_START);
  if (!flag || !m) return null;
  const at = m[0].length - 'node'.length;
  const seg = shellSegments(cmd).find((s) => s.start <= at && at < s.end);
  if (!seg) return null;
  // The node part itself: no variables, substitutions, input or output redirection (the shell
  // would do those, outside the sandbox).
  const words = splitCommand(cmd.slice(at, seg.end));
  if (!words || words.length !== 1 || words[0].includes('<')) return null;
  const args = words[0].slice(1);
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (CODE_OPTION.has(args[i])) break;
    if (!SAFE_OPTION.test(args[i])) return null;
  }
  if (i >= args.length) return null; // no script: node would wait for input
  // Everything else on the line only reads.
  if (!isReadOnlyCommand(`${cmd.slice(0, at)}true${cmd.slice(seg.end)}`)) return null;
  const paths = sandboxPaths(where);
  if (!paths) return null;
  const flags = [flag, ...paths.reads.map((p) => `--allow-fs-read=${quote(p)}`), ...paths.writes.map((p) => `--allow-fs-write=${quote(p)}`)].join(' ');
  return `${cmd.slice(0, at)}node ${flags}${cmd.slice(at + 'node'.length)}`;
}
