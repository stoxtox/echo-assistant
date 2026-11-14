// May a self-improvement worker stop these processes without asking?
//
// Kills stay gated (lib/safety.js). The one exception: a self task stopping processes it started
// itself for testing (a smoke server on the test port, a test build of the Mac app in a temp or
// verify folder). Every process the command would hit is looked up first. Each one must:
//   - have started after the task did,
//   - belong to the task: run from, or name, its worktree or a temp folder, or listen on the test port,
//   - not be the live Echo: not this server, its supervisor or anything above it, and not whatever
//     listens on the live port.
// The rest of the command must be harmless: read-only helpers, or (when the caller vouches for it,
// lib/tasks.js) anything that would run without asking on its own, like starting the smoke server
// that the same line then stops. If anything can't be checked, the usual approval is asked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, DEFAULT_PORT } from './config.js';
import { splitCommand, isReadOnlyCommand, shellSegments } from './safety.js';

export const TEST_PORT = 4799;

const SIGNAL = /^-(\d{1,2}|[A-Z]{3,6}|SIG[A-Z]{3,6})$/;
const HARMLESS = new Set(['sleep', 'true', ':', 'wait']);

// `lsof -ti:4799 | xargs kill` and `kill $(lsof -ti:4799)`: stop whatever uses that port.
const LSOF_ARGS = String.raw`((?:\s+[-\w:=.]+)+)`;
const PORT_PIPE = new RegExp(String.raw`\blsof${LSOF_ARGS}\s*\|\s*xargs(?:\s+-\w+)*\s+kill(?:\s+-\w+)?(?=\s*(?:$|[;&|\n]))`, 'g');
const PORT_SUBST = new RegExp(String.raw`\bkill(?:\s+-\w+)?\s+\$\(\s*lsof${LSOF_ARGS}\s*\)`, 'g');

/** The port an `lsof -t -i:PORT` argument list names, or null if it isn't that simple form. */
function lsofPort(args) {
  const words = args.trim().split(/\s+/);
  if (!words.some((w) => /^-[a-zA-Z]*t/.test(w))) return null;
  const ports = words.map((w) => w.match(/^(?:-[a-zA-Z]*i)?(?:TCP|UDP)?@?(?:localhost|127\.0\.0\.1)?:(\d+)$/)).filter(Boolean);
  if (ports.length !== 1 || !words.every((w) => /^-[a-zA-Z]+$|^-s(TCP|UDP):\w+$|^-i$/.test(w) || /:\d+$/.test(w))) return null;
  return Number(ports[0][1]);
}

/** @typedef {{ pids: number[] } | { pattern: string, full: boolean, exact: boolean } | { port: number }} KillTarget */

/** One kill command's targets, or null if it isn't a form we can read. */
function parseKill(prog, args) {
  if (prog === '__killport') return { port: Number(args[0]) };
  if (prog === 'kill') {
    let i = 0;
    if (args[0] === '-s' || args[0] === '-n') i = 2;
    else if (args[0] && SIGNAL.test(args[0])) i = 1;
    const pids = args.slice(i);
    if (!pids.length || !pids.every((p) => /^\d+$/.test(p) && Number(p) > 1)) return null;
    return { pids: pids.map(Number) };
  }
  if (prog === 'pkill') {
    const flags = args.filter((a) => a.startsWith('-'));
    const rest = args.filter((a) => !a.startsWith('-'));
    if (rest.length !== 1 || !flags.every((f) => f === '-f' || f === '-x' || SIGNAL.test(f))) return null;
    // Too short a pattern matches half the system; ask about those.
    if (rest[0].length < 4) return null;
    return { pattern: rest[0], full: flags.includes('-f'), exact: flags.includes('-x') };
  }
  return null;
}

// A kill inside a loop, a condition or a subshell: `do kill 1`, `(kill 1)`, `then pkill -f x; fi`.
const LEAD_WORDS = /^(?:\s|\(|\{|(?:then|do|else|!)(?=\s))*/;
const KILL_START = /^(kill|pkill|killall|__killport)\b/;

/**
 * The kills in a command, and the command with each of them replaced by `true` (what's left to
 * judge). Null if a kill can't be read (`kill $PID`, `killall node`, a bad lsof form).
 * @param {string} command
 * @returns {{ targets: KillTarget[], rest: string } | null}
 */
export function splitKills(command) {
  let bad = false;
  const toPort = (_m, args) => {
    const port = lsofPort(args);
    if (port == null) bad = true;
    return ` __killport ${port} `;
  };
  const cmd = String(command || '').replace(PORT_SUBST, toPort).replace(PORT_PIPE, toPort);
  if (bad) return null;
  const targets = [];
  let rest = '';
  let at = 0;
  for (const seg of shellSegments(cmd)) {
    const lead = seg.text.match(LEAD_WORDS)?.[0] || '';
    const body = seg.text.slice(lead.length).replace(/[\s)}]+$/, '');
    if (!KILL_START.test(body)) continue;
    const words = splitCommand(body);
    if (!words || words.length !== 1) return null;
    const [prog, ...args] = words[0];
    const t = parseKill(prog, args);
    if (!t) return null;
    targets.push(t);
    const from = seg.start + lead.length;
    rest += `${cmd.slice(at, from)}true`;
    at = from + body.length;
  }
  return { targets, rest: rest + cmd.slice(at) };
}

/**
 * What a command would kill, or null if it does anything else (or anything we can't read).
 * @param {string} command
 * @returns {null | KillTarget[]}
 */
export function killTargets(command) {
  const s = splitKills(command);
  if (!s?.targets.length) return null;
  const segments = splitCommand(s.rest);
  if (!segments?.length) return null;
  for (const [prog, ...args] of segments) {
    if (HARMLESS.has(prog)) continue;
    if (!isReadOnlyCommand([prog, ...args].join(' '))) return null;
  }
  return s.targets;
}

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return String(e.stdout || ''); // pgrep and lsof exit 1 when nothing matches
  }
};
const pidList = (out) => out.split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);

/** "[[dd-]hh:]mm:ss" from ps, in seconds. */
export function etimeSeconds(etime) {
  const m = String(etime).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return NaN;
  const [, d = 0, h = 0, mi, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * 60 + Number(s);
}

/** How we look at processes. Tests swap this out. */
export const systemProcs = {
  /** @returns {Map<number, { pid: number, ppid: number, age: number, command: string }>} */
  table() {
    const map = new Map();
    for (const line of sh('ps', ['-axo', 'pid=,ppid=,etime=,command=']).split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (m) map.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), age: etimeSeconds(m[3]), command: m[4] });
    }
    return map;
  },
  /** @param {number} port */
  listeners: (port) => pidList(sh('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'])),
  /** @param {number} port */
  users: (port) => pidList(sh('lsof', ['-t', `-i:${port}`])),
  /** @param {string} pattern @param {{ full: boolean, exact: boolean }} o */
  match: (pattern, { full, exact }) => pidList(sh('pgrep', [...(full ? ['-f'] : []), ...(exact ? ['-x'] : []), pattern])),
  /** @param {number} pid */
  cwd(pid) {
    const line = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n'));
    return line ? line.slice(1) : '';
  },
};

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const tempRoots = () => [...new Set([os.tmpdir(), real(os.tmpdir()), '/tmp', '/private/tmp'])].map((p) => p.replace(/\/+$/, '') + '/');

/**
 * Should this kill command run without asking? Only when every process it names is the task's own.
 * @param {string} command
 * @param {{ worktree: string, since: number, now?: number, procs?: typeof systemProcs, livePids?: number[], restOk?: (rest: string) => boolean }} ctx
 *   since: when the task started (ms); livePids: this Echo's own process and its parents;
 *   restOk: whether the rest of the command (the kills taken out) would run without asking
 * @returns {{ ok: boolean, why: string }}
 */
export function ownKill(command, { worktree, since, now = Date.now(), procs = systemProcs, livePids = [process.pid, process.ppid], restOk }) {
  const split = splitKills(command);
  const targets = killTargets(command) || (split?.targets.length && restOk?.(split.rest) ? split.targets : null);
  if (!targets) return { ok: false, why: 'not a plain kill command' };
  const livePorts = [...new Set([config.port, DEFAULT_PORT])];
  if (targets.some((t) => 'port' in t && livePorts.includes(t.port))) return { ok: false, why: "targets the live Echo's port" };
  const table = procs.table();
  // This Echo, everything above it (supervisor, launcher), and whatever serves the live port.
  const protectedPids = new Set(livePorts.flatMap((p) => procs.listeners(p)));
  for (let pid of livePids) {
    for (let hops = 0; pid > 1 && hops < 50 && !protectedPids.has(pid); hops++) {
      protectedPids.add(pid);
      pid = table.get(pid)?.ppid ?? 0;
    }
  }
  const pids = new Set();
  for (const t of targets) {
    const found = 'pids' in t ? t.pids : 'port' in t ? procs.users(t.port) : procs.match(t.pattern, t);
    for (const pid of found) pids.add(pid);
  }
  const testPortPids = new Set(procs.listeners(TEST_PORT));
  const roots = [path.resolve(worktree) + '/', ...tempRoots()];
  const mine = (s) => Boolean(s) && roots.some((r) => (s + '/').startsWith(r) || s.includes(' ' + r) || s.includes('=' + r) || s.startsWith(r));
  for (const pid of pids) {
    const p = table.get(pid);
    if (!p) continue; // already gone: killing it does nothing
    if (protectedPids.has(pid)) return { ok: false, why: `process ${pid} is the live Echo` };
    if (!(now - p.age * 1000 >= since - 5000)) return { ok: false, why: `process ${pid} was running before this task started` };
    if (!(testPortPids.has(pid) || mine(p.command) || mine(procs.cwd(pid)))) return { ok: false, why: `process ${pid} isn't from this task's folder, a temp folder or the test port` };
  }
  return { ok: true, why: pids.size ? `stops ${pids.size} process${pids.size > 1 ? 'es' : ''} this task started` : 'nothing to stop' };
}
