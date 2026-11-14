// Decides which worker Bash commands need your approval.
//
//   'safe'         runs without asking
//   'network_read' a read-only web request (curl GET, public search APIs). Asks, unless
//                  you granted "auto-approve read-only web requests" for the task/session.
//   'network_site' any other request to a website. Asks, unless you granted that site.
//   'echo_read'    a read-only command on Echo's own folders (code, logs, data) from an ordinary
//                  task. Asks once; approving it lets that task (or, by choice, every task until
//                  Echo restarts) read Echo without asking again. Never covers writes or its port.
//   'risky'        always asks, no grant can skip it: git commit/push, deletes, deploys,
//                  purchases, logins, form submissions, touching Echo itself…
//                  (self-improvement tasks may run read-only commands against Echo)
//   'job_files'    a tool call that reaches outside the task's folder but only writes, reads or
//                  looks at named files (classifyOutside, below). It asks like a risky one; a yes
//                  covers those files for that one task, never a session, and nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, APP_DIR, DEFAULT_PORT } from './config.js';
import { appDirAliases } from './legacy.js';

/** @type {Array<[RegExp, string]>} */
const ALWAYS_GATED = [
  [/\bgit\s+push\b/, 'git push'],
  [/\bgit\s+commit\b/, 'git commit'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+\.|branch\s+-D|rebase|filter-branch|update-ref)/, 'rewrites git history or discards changes'],
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\b|-R\b)/, 'recursive delete'],
  [/\bsudo\b/, 'sudo'],
  [/\|\s*(ba|z)?sh\b|\b(ba|z)?sh\s+-c\s+"?\$\(\s*(curl|wget)/, 'runs code downloaded from the internet'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, 'publishes a package'],
  [/\bgh\s+(release\s+(create|upload|edit|delete)|repo\s+(create|delete|edit|rename|archive)|pr\s+(create|merge)|api\b.*(-X|--method)\s*(POST|PUT|PATCH|DELETE))\b/i, 'publishes to GitHub'],
  [/\b(npm|pnpm|yarn)\s+run\s+(release:publish|publish-repo)\b|\bpublish-(release|repo)\.js\b/, 'publishes Echo'],
  [/\b(firebase|vercel|netlify|fly|railway|heroku|eas|supabase|wrangler)\b.*\b(deploy|publish|submit|db\s+push|functions:delete|--prod)\b/, 'deploys'],
  [/\bgcloud\b.*\b(deploy|delete)\b/, 'cloud deploy or delete'],
  [/\baws\b.*\b(delete|rm|terminate)\b/, 'cloud delete'],
  [/\bxcrun\s+altool\b|\bfastlane\b/, 'App Store upload'],
  [/\bdrop\s+(table|database)\b/i, 'drops a database table'],
  [/\bchmod\s+-R\b|\bchown\s+-R\b/, 'recursive permission change'],
  [/\bkillall\b|\bpkill\b|\bkill\s+-9\b|(^|[;&|(]\s*|\bxargs\s+(-\S+\s+)*)kill\b/, 'kills processes'],
  [/\blaunchctl\b|\bcrontab\b|\bdefaults\s+write\b/, 'changes system configuration'],
  [/\bsecurity\s+(find|dump|delete)-/, 'reads the keychain'],
  [/\bosascript\b.*\b(keystroke|click|password)\b/i, 'automates the UI'],
];

// Safe mode (new users, turned on by setup for non-developers): these ask too. Deleting any file,
// installing software on the Mac, and controlling other apps (a script could send a message or
// an email without the confirmation card).
/** @type {Array<[RegExp, string]>} */
const STRICT_GATED = [
  [/(^|[;&|(\s])(rm|rmdir|unlink|srm|shred|trash)\s/, 'deletes files'],
  [/\bfind\b.*\s-delete\b/, 'deletes files'],
  [/\bbrew\s+(install|uninstall|reinstall|upgrade|remove|tap)\b/, 'installs software on the Mac'],
  [/\b(npm|pnpm|yarn)\s+(i|install|add)\b.*\s(-g|--global)\b|\byarn\s+global\b/, 'installs software on the Mac'],
  [/\bpip3?\s+install\b|\bpython3?\s+-m\s+pip\s+install\b|\bgem\s+install\b/, 'installs software on the Mac'],
  [/\bosascript\b|\bshortcuts\s+run\b|\bautomator\b/, 'controls another app'],
  [/(^|[;&|(]\s*)(sendmail|mail|mailx)\s/, 'sends an email'],
];

// Echo itself: its port and live folder are off-limits to ordinary workers. The default port
// stays blocked even when this copy runs on another one (tests, smoke tests).
const selfPortPattern = () => new RegExp(`\\b(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):(${[...new Set([config.port, DEFAULT_PORT])].join('|')})\\b`);
// The live folder under every name it answers to (an old VoiceOps link to it counts too).
const selfPatterns = () => [selfPortPattern(), ...appDirAliases(APP_DIR).map((d) => new RegExp(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))];
// The command as the shell would see its words: quotes dropped and backslash escapes resolved, so
// a folder with a space in its name ("Echo Copy", Echo\ Copy, 'Echo 'Copy) is still recognized.
const shellPlain = (cmd) => cmd.replace(/\\(.)/g, '$1').replace(/['"]/g, '');
/** Does the command name Echo's own port (the live one, or the default)? */
export const touchesSelfPort = (cmd) => selfPortPattern().test(String(cmd || ''));
const touchesSelf = (cmd) => {
  const plain = shellPlain(cmd);
  return selfPatterns().some((re) => re.test(cmd) || re.test(plain));
};

const HTTP_TOOL = /\b(curl|wget|http|https|xh)\b/;
const URL_RE = /https?:\/\/[^\s'"`)]+/g;
// Anything that logs in, pays, signs up, applies or otherwise submits stays gated.
const SENSITIVE_URL = /(log-?in|sign-?in|sign-?up|signup|register|oauth|auth\b|token|password|checkout|cart|purchase|payment|pay\b|billing|order|subscribe|apply\b|application|submit|account|unsubscribe|delete)/i;
const WRITE_FLAGS = /(\s-X\s*['"]?(PUT|DELETE|PATCH)\b|\s--request\s+['"]?(PUT|DELETE|PATCH)\b|\s-F\s|\s--form\b|\s-T\s|\s--upload-file\b|\s-u\s|\s--user\b|\s-b\s|\s--cookie\b|\s-c\s|\s--cookie-jar\b|\s-H\s*['"]?(authorization|cookie):|--post-file|--method=(PUT|DELETE|PATCH))/i;
const IS_POST = /(\s-X\s*['"]?POST\b|\s--request\s+['"]?POST\b|\s-d\s|\s--data(-raw|-binary|-urlencode)?\b|\s--json\b|--post-data|--method=POST)/i;
// POSTs that are really searches: job boards, search endpoints, GraphQL queries.
const SEARCH_POST = /(\/wday\/cxs\/.+\/jobs\b|\/search\b|\/jobs\/search|\/api\/.*(search|query|jobs)|graphql)/i;

const hostOf = (u) => {
  if (/^https?:\/\/[^/]*\$/.test(u)) return ''; // host built from a shell variable
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/* ---------- read-only commands (self-improvement tasks reading the live Echo) ---------- */

/**
 * Where each simple command of a shell line starts and ends (split on ; | || && & and newlines
 * outside quotes, $(…) and backticks). Unlike splitCommand it accepts anything, variables and
 * substitutions included: it only says where the pieces are, not that they're harmless.
 * @param {string} cmd
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
export function shellSegments(cmd) {
  const out = [];
  let start = 0;
  let depth = 0;
  let tick = false;
  const push = (end) => {
    const text = cmd.slice(start, end);
    if (text.trim()) out.push({ start, end, text });
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      i = close < 0 ? cmd.length : close;
    } else if (c === '"') {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== '"') j += cmd[j] === '\\' ? 2 : 1;
      i = j;
    } else if (c === '`') {
      tick = !tick;
    } else if (c === '$' && cmd[i + 1] === '(') {
      depth++;
      i++;
    } else if (c === '(' && depth > 0) {
      depth++;
    } else if (c === ')' && depth > 0) {
      depth--;
    } else if (depth === 0 && !tick && (c === ';' || c === '\n' || c === '|' || (c === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>'))) {
      push(i);
      if ((c === '|' || c === '&') && (cmd[i + 1] === c || (c === '|' && cmd[i + 1] === '&'))) i++;
      start = i + 1;
    }
  }
  push(cmd.length);
  return out;
}

// Shell variables the command may set for itself and use (L=/path/to/logs; tail $L/echo.log).
// Never one the environment already has (PATH, HOME, GIT_…: changing those changes programs).
const VAR_ASSIGN = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:'([^'\n]*)'|"([^"$`\\\n]*)"|([^\s;&|'"\\$`<>(){}*?[\]]*))\s*(?:;|&&|\n)/;
const SPECIAL_VARS = /^(PATH|IFS|HOME|ENV|BASH_ENV|CDPATH|PS4|PROMPT_COMMAND|SHELLOPTS|ZDOTDIR|PAGER|MANPAGER|EDITOR|VISUAL|TMPDIR|PWD|OLDPWD|(GIT|LD|DYLD|NODE|NPM|npm|LESS|GREP|JQ|LC|PYTHON|RUBY|PERL)\w*)$/;

/**
 * The command with its leading plain variables put in place: `L=/a/b; ls $L/logs` is checked as
 * `ls /a/b/logs`. Only literal values without spaces or glob characters, and only names the
 * environment doesn't already have; uses inside single quotes stay as they are (the shell leaves
 * them too). Anything else is left alone, so the usual checks still see the `$`.
 * @param {string} command
 */
export function expandLiterals(command) {
  let cmd = String(command || '');
  /** @type {Map<string, string>} */
  const vars = new Map();
  for (let m = cmd.match(VAR_ASSIGN); m; m = cmd.match(VAR_ASSIGN)) {
    const [whole, name, single, double, bare] = m;
    const value = single ?? double ?? bare ?? '';
    // Spaces are fine: the shell splits an unquoted $L on them just as the text put in its place is.
    if (SPECIAL_VARS.test(name) || Object.hasOwn(process.env, name) || !/^[\w./@:+,=~% -]*$/.test(value)) return String(command || '');
    vars.set(name, value);
    cmd = cmd.slice(whole.length);
  }
  if (!vars.size) return cmd;
  let out = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) return String(command || '');
      out += cmd.slice(i, close + 1);
      i = close;
      continue;
    }
    if (c === '\\') {
      out += cmd.slice(i, i + 2);
      i++;
      continue;
    }
    const m = c === '$' && cmd.slice(i).match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/);
    if (m && vars.has(m[1] ?? m[2])) {
      out += vars.get(m[1] ?? m[2]);
      i += m[0].length - 1;
    } else out += c;
  }
  return out;
}

/**
 * Split a shell command into its simple commands (on | || && ; & and newlines), outside quotes.
 * Returns null when the command does anything we can't vouch for as read-only: command or
 * process substitution, variables or escapes (other than an escaped space) outside single
 * quotes, subshells, or output redirection other than to /dev/null (2>&1 and friends are fine).
 * Inside double quotes a backslash is literal (grep "a\|b") or escapes \ " $ ` as the shell does.
 * @param {string} cmd
 * @returns {string[][] | null} each segment's words, quotes removed
 */
export function splitCommand(cmd) {
  return parseCommand(cmd)?.map((seg) => seg.map((w) => w.text)) ?? null;
}

/**
 * splitCommand, keeping for each word whether it holds an unquoted glob character (* ? [).
 * @param {string} cmd
 * @returns {Array<Array<{ text: string, glob: boolean }>> | null}
 */
function parseCommand(cmd) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  let glob = false;
  const endWord = () => {
    if (inWord) words.push({ text: word, glob });
    word = '';
    inWord = false;
    glob = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) return null;
      word += cmd.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        const d = cmd[j];
        if (d === '$' || d === '`') return null;
        if (d === '\\') {
          const next = cmd[j + 1];
          if (next === undefined) return null;
          if ('$`"\\'.includes(next)) (word += next), j++;
          else if (next === '\n') j++;
          else word += d;
        } else word += d;
      }
      if (j >= cmd.length) return null;
      inWord = true;
      i = j;
    } else if (c === '\\' && cmd[i + 1] === ' ') {
      // An escaped space in a path (/Users/me/Echo\ Copy): a literal space inside the word.
      word += ' ';
      inWord = true;
      i++;
    } else if (c === '$' || c === '`' || c === '\\' || c === '(' || c === ')' || c === '{' || c === '}') {
      return null;
    } else if (c === '>' || (c === '&' && cmd[i + 1] === '>')) {
      // Redirections: only to /dev/null, or duplicating a descriptor (2>&1, >&2).
      if (/^\d+$/.test(word) && inWord) (word = ''), (inWord = false);
      endWord();
      let j = c === '&' ? i + 2 : i + 1;
      if (cmd[j] === '>') j++;
      if (cmd[j] === '&') {
        const m = cmd.slice(j + 1).match(/^(\d+|-)/);
        if (!m) return null;
        i = j + m[0].length;
        continue;
      }
      const m = cmd.slice(j).match(/^\s*(\S+)/);
      if (!m || m[1].replace(/[;&|].*$/, '') !== '/dev/null') return null;
      i = j + m[0].indexOf('/dev/null') + '/dev/null'.length - 1;
    } else if (c === '<') {
      if (cmd[i + 1] === '(' || cmd[i + 1] === '<') return null; // process substitution, here-docs
      endWord();
      words.push({ text: '<', glob: false });
    } else if (c === '|' || c === ';' || c === '&' || c === '\n') {
      endSegment();
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      if (c === '*' || c === '?' || c === '[') glob = true;
      word += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

const flagsOf = (args) => args.filter((a) => a.startsWith('-'));
const operands = (args) => args.filter((a) => !a.startsWith('-') && a !== '<');
const LOOPBACK_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^\s]*)?$/;

// curl/wget: GET requests to this computer only. Every flag must be on the list.
const CURL_FLAGS = new Set(['-s', '-S', '-f', '-i', '-I', '-L', '-v', '-sS', '-Ss', '-fs', '-sf', '-fsS', '-sSf', '-fsSL', '-sL', '-sSL', '-si', '--silent', '--show-error', '--fail', '--include', '--head', '--location', '--verbose', '--compressed', '--no-progress-meter']);
const CURL_VALUE_FLAGS = new Set(['-m', '--max-time', '--connect-timeout', '-w', '--write-out']);
function readOnlyHttp(prog, args) {
  const urls = [];
  // wget saves to a file unless told to print or only check.
  if (prog === 'wget' && !args.some((a, i) => a === '-qO-' || a === '-O-' || a === '--spider' || ((a === '-O' || a === '--output-document') && ['-', '/dev/null'].includes(args[i + 1])))) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (prog === 'curl') {
        if (CURL_VALUE_FLAGS.has(a)) i++;
        else if ((a === '-o' || a === '--output') && args[i + 1] === '/dev/null') i++;
        else if ((a === '-X' || a === '--request') && /^(GET|HEAD)$/i.test(args[i + 1] || '')) i++;
        else if (!CURL_FLAGS.has(a)) return false;
      } else {
        if ((a === '-O' || a === '--output-document') && ['-', '/dev/null'].includes(args[i + 1])) i++;
        else if (!['-q', '--quiet', '-qO-', '-O-', '-S', '--server-response', '--spider'].includes(a) && !/^(-T\d+|--timeout=\d+)$/.test(a)) return false;
      }
    } else urls.push(a);
  }
  return urls.length > 0 && urls.every((u) => LOOPBACK_URL.test(u));
}

const GIT_READ = new Set(['log', 'show', 'diff', 'status', 'rev-parse', 'ls-files', 'blame', 'grep', 'rev-list', 'merge-base', 'describe', 'shortlog', 'cat-file', 'show-ref']);
const GIT_BRANCH_LIST_FLAGS = new Set(['-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--verbose', '--show-current', '--merged', '--no-merged', '--contains', '--no-color', '--color']);
function readOnlyGit(args) {
  let i = 0;
  while (args[i] === '-C' || args[i] === '--no-pager' || /^--(git-dir|work-tree)=/.test(args[i] || '')) i += args[i] === '-C' ? 2 : 1;
  const [sub, ...rest] = args.slice(i);
  if (rest.some((a) => /^(--output|--ext-diff|-O|--open-files-in-pager)/.test(a))) return false;
  if (GIT_READ.has(sub)) return true;
  if (sub === 'branch') return rest.every((a) => GIT_BRANCH_LIST_FLAGS.has(a) || (rest.includes('--list') && !a.startsWith('-')));
  if (sub === 'worktree' || sub === 'stash') return rest[0] === 'list';
  if (sub === 'reflog') return !rest.length || rest[0] === 'show' || rest[0].startsWith('-');
  if (sub === 'remote') return rest.every((a) => a === '-v' || a === '--verbose') || rest[0] === 'get-url';
  return false;
}

/* grep (GNU, BSD, or ugrep, which macOS may run as grep): only options known to just read.
   ugrep has options that run other programs (--filter, --view, --pager) or write (--save-config). */
const GREP_SHORT = 'abcEFGHhiIlLnoqsvwxyUPZT0123456789';
const GREP_SHORT_VALUE = 'efABCm';
const GREP_LONG = new Set(['--recursive', '--line-number', '--ignore-case', '--no-ignore-case', '--count', '--files-with-matches', '--files-without-match', '--only-matching', '--no-filename', '--with-filename', '--word-regexp', '--line-regexp', '--invert-match', '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--no-messages', '--quiet', '--silent', '--null', '--text', '--byte-offset', '--initial-tab', '--line-buffered', '--color', '--colour']);
const GREP_LONG_VALUE = new Set(['--regexp', '--file', '--after-context', '--before-context', '--max-count', '--include', '--exclude', '--exclude-dir', '--include-dir', '--label', '--context', '--color', '--colour', '--binary-files']);
const GREP_LONG_SPACED = new Set(['--regexp', '--file', '--after-context', '--before-context', '--max-count', '--include', '--exclude', '--exclude-dir', '--include-dir', '--label']);

/**
 * The files and folders a grep reads, or null if it uses an option we don't know.
 * @returns {{ paths: string[], recursive: boolean } | null}
 */
function grepOperands(args) {
  const operands = [];
  let patternGiven = false;
  let recursive = false;
  let onlyOperands = false;
  let bareContext = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (onlyOperands || !a.startsWith('-') || a === '-') operands.push(a);
    else if (a === '--') onlyOperands = true;
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      if (eq < 0 ? !GREP_LONG.has(name) && !GREP_LONG_SPACED.has(name) : !GREP_LONG_VALUE.has(name)) return null;
      if (name === '--recursive') recursive = true;
      if (name === '--regexp' || name === '--file') patternGiven = true;
      if (eq < 0 && GREP_LONG_SPACED.has(name)) i++;
    } else {
      for (let k = 1; k < a.length; k++) {
        const f = a[k];
        if (GREP_SHORT_VALUE.includes(f)) {
          if (f === 'e' || f === 'f') patternGiven = true;
          // BSD grep's -C takes its number only attached; spaced, the next word would be a search path.
          if (f === 'C' && k === a.length - 1) bareContext = true;
          if (k === a.length - 1) i++; // the value is the next word
          break;
        }
        if (f === 'r') recursive = true;
        else if (!GREP_SHORT.includes(f)) return null;
      }
    }
  }
  if (recursive && bareContext) return null;
  return { paths: patternGiven ? operands : operands.slice(1), recursive };
}

/**
 * A recursive reader (rg, diff -r) only over folders that hold no secret: each named path
 * absolute or relative to a known folder, and with no path, the folder it runs in.
 * @param {string[]} paths @param {string | null} [cwd]
 */
function searchesNoSecret(paths, cwd) {
  if (!paths.length) return Boolean(cwd) && !holdsSecret(/** @type {string} */ (cwd));
  return paths.every((p) => !p.startsWith('~') && (path.isAbsolute(p) || cwd) && !/[*?[]/.test(path.dirname(p)) && !holdsSecret(path.resolve(cwd || '/', /[*?[]/.test(path.basename(p)) ? path.dirname(p) : p)));
}

const WALK_LIMIT = 5000;
/** True if a folder (or file) holds a secret a recursive search would read, or is too big to check. */
function holdsSecret(abs) {
  if (isSecretPath(abs, 'Grep')) return true;
  let st;
  try {
    st = fs.statSync(abs); // follows a symlink named on the command line, as grep -r does
  } catch {
    return false; // nothing there to read
  }
  if (!st.isDirectory()) return isSecretPath(abs);
  const stack = [fs.realpathSync(abs)];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    if (isSecretPath(dir, 'Grep')) return true;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable to grep too
    }
    for (const e of entries) {
      if (++seen > WALK_LIMIT) return true;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (!e.isSymbolicLink() && isSecretPath(full)) return true;
    }
  }
  return false;
}

/**
 * grep, plain or recursive. A recursive grep must name its folders (absolute, or relative to a
 * leading `cd` into an existing folder), globbed only in the last part, and none may hold a secret.
 * @param {string[]} args
 * @param {{ cwd?: string | null }} [ctx]
 */
function readOnlyGrep(args, { cwd } = {}) {
  const parsed = grepOperands(args);
  if (!parsed) return false;
  if (!parsed.recursive) return true;
  if (!parsed.paths.length) return false;
  return parsed.paths.every((p) => {
    if (p === '-' || p.startsWith('~') || (!path.isAbsolute(p) && !cwd)) return false;
    // A glob in the last part (lib/*.js) only matches inside its folder, so check that folder.
    const dir = path.dirname(p);
    if (/[*?[]/.test(path.basename(p))) return !/[*?[]/.test(dir) && !holdsSecret(path.resolve(cwd || '/', dir));
    return !/[*?[]/.test(p) && !holdsSecret(path.resolve(cwd || '/', p));
  });
}

/**
 * An awk program with its string and regex literals blanked out, so a | or > inside /a|b/ or
 * "x>y" isn't mistaken for a pipe or a redirect. Null if a literal never closes.
 * A / only starts a regex where a value can't precede it (division needs one).
 * @param {string} src
 */
function awkCode(src) {
  let out = '';
  let prev = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const regexStart = c === '/' && (prev === '' || '(,!~{};&|=?:\n'.includes(prev));
    if (c === '"' || regexStart) {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) return null;
      out += c + c;
      prev = c;
      i = j;
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}

function readOnlyAwk(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-F') i++; // the field separator is a pattern, not code
    else if (a.startsWith('-F')) continue;
    else if (/^-[a-zA-Z]*[if]|^--(include|load|file|in-?place|exec)/.test(a)) return false;
    else {
      // Pipes, redirects, system(), getline, gawk's indirect calls (@f) and the environment are out.
      const code = a.startsWith('-') ? a : awkCode(a);
      if (code == null || /system|getline|ENVIRON|PROCINFO|[|>@]/.test(code.replace(/\|\|/g, ''))) return false;
    }
  }
  return true;
}

// Programs that only look at names and sizes, never contents: they may list secrets and take
// file lists from xargs.
const NAME_ONLY = new Set(['ls', 'du', 'stat', 'wc']);
const XARGS_FLAGS = new Set(['-0', '-r', '-t', '-x', '--null', '--no-run-if-empty', '--verbose']);
function readOnlyXargs(args) {
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (/^-[nLPs]$/.test(args[i])) i++;
    else if (!XARGS_FLAGS.has(args[i]) && !/^-[nLPs]\d+$/.test(args[i])) return false;
  }
  const [prog, ...rest] = args.slice(i);
  return NAME_ONLY.has(prog) && READ_ONLY[prog](rest);
}

/** @type {Record<string, (args: string[], ctx?: { cwd?: string | null }) => boolean>} */
const READ_ONLY = {
  cat: () => true, head: () => true, tail: () => true,
  ls: () => true, wc: () => true, stat: () => true, du: () => true, df: () => true,
  file: (args) => !args.includes('-C'),
  // diff -r reads whole folders, like a recursive search.
  diff: (args, { cwd } = {}) => !flagsOf(args).some((f) => /^-[a-zA-Z]*r|^--recursive/.test(f)) || searchesNoSecret(operands(args), cwd),
  cmp: () => true, comm: () => true, cut: () => true, tr: () => true, nl: () => true,
  // jq's env and $ENV would print the environment, API keys included.
  column: () => true, jq: (args) => !/\benv\b|\$ENV\b/.test(args.join(' ')), pwd: () => true, echo: () => true, printf: () => true,
  basename: () => true, dirname: () => true, realpath: () => true, readlink: () => true, date: () => true,
  which: () => true, test: () => true, '[': () => true, true: () => true, cd: () => true,
  tree: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*o/.test(f)),
  shasum: () => true, md5: () => true, od: () => true, ps: () => true, pgrep: () => true,
  xxd: (args) => operands(args).length <= 1,
  lsof: () => true, netstat: () => true,
  strings: () => true, sw_vers: () => true, uname: () => true, sleep: () => true, sysctl: (args) => !args.some((a) => a.includes('=') || a === '-w'),
  // macOS: show logs, plist values, code signatures and preferences, never change them.
  log: (args) => args[0] === 'show',
  plutil: (args) => ['-p', '-lint'].includes(args[0]) || (args[0] === '-extract' && args.filter((a) => a === '-o').length === 1 && args[args.indexOf('-o') + 1] === '-'),
  codesign: (args) => args.length > 0 && args.every((a) => /^(-d|-v|-dv+|-vv+|-r-|--display|--verify|--deep|--strict|--verbose(=\d)?)$/.test(a) || !a.startsWith('-')) && args.some((a) => /^(-d|-v|--display|--verify|-dv+|-vv+)$/.test(a)),
  defaults: (args) => ['read', 'read-type', 'domains'].includes(args[0]),
  'xcode-select': (args) => args.length === 1 && ['-p', '--print-path'].includes(args[0]),
  // Recursive grep only over folders that hold no secrets (.env, the PIN hash).
  grep: readOnlyGrep,
  egrep: readOnlyGrep,
  xargs: readOnlyXargs,
  rg: (args, { cwd } = {}) => !flagsOf(args).some((f) => /^-[a-zA-Z]*u|^--(no-ignore|pre\b|pre=|search-zip)|^-z$/.test(f)) && searchesNoSecret(operands(args).slice(args.some((a) => a === '-e' || a.startsWith('--regexp')) ? 0 : 1), cwd),
  find: (args) => !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)),
  sort: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*o|^--output/.test(f)),
  uniq: (args) => operands(args).length <= 1,
  tee: (args) => operands(args).every((a) => a === '/dev/null'),
  // awk and sed scripts can write files or run commands, so those forms are out.
  awk: readOnlyAwk,
  sed: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*[iIf]|^--(in-place|file)/.test(f)) && !/(^|[\s;{}/\d$!])[wWe](\s|$)/.test(' ' + args.join(' ')),
  git: (args) => readOnlyGit(args),
  curl: (args) => readOnlyHttp('curl', args),
  wget: (args) => readOnlyHttp('wget', args),
};

// Secrets stay off-limits even to read: .env files and the self-improve PIN hash
// (including globs or variables that could expand to them).
// Quoted globs don't expand, so only unquoted ones count (a jq filter like '.[] | .tasks[]?' is fine).
const SECRETS = /(^|[/\s'"=])\.env\b|pin\.json/;
// Checked again on each word once quotes are gone, so ".en"v or 'pin'.json can't slip past.
const SECRET_WORD = /(^|[/=])\.env\b|pin\.json/;
const SECRET_NAMES = ['.env', '.env.local', '.env.example', 'pin.json'];

/**
 * Could this unquoted glob expand to a secret? Globbed folders could lead anywhere, so they count.
 * When its folder is known (an absolute path, or relative to a leading cd), what it really matches
 * there is checked: data/*.json in Echo's data folder is fine, data/self/* isn't.
 * @param {string} word @param {string | null} [cwd]
 */
function globMayHitSecret(word, cwd = null) {
  const parts = word.split('/');
  const last = parts.pop() || '';
  if (parts.some((p) => /[*?[]/.test(p))) return true;
  const dir = parts.join('/') || (word.startsWith('/') ? '/' : '.');
  const abs = path.isAbsolute(dir) ? dir : cwd && !dir.startsWith('~') ? path.resolve(cwd, dir) : null;
  if (abs) {
    let names = null;
    try {
      names = fs.readdirSync(abs);
    } catch {
      names = null; // can't look: judge by the name alone
    }
    if (names) {
      const re = globRegex(last);
      // A matching folder isn't read by the plain readers here (cat, grep without -r: "Is a
      // directory"); the ones that do go into folders (grep -r, rg, diff -r) check them themselves.
      return names.some((n) => re.test(n) && (!n.startsWith('.') || last.startsWith('.')) && (SECRET_NAMES.includes(n) || /^\.env/.test(n) || isSecretPath(path.join(abs, n))));
    }
  }
  const re = globRegex(last);
  // Without dotglob, a glob only matches a dot-file if it starts with a dot itself.
  return SECRET_NAMES.some((n) => re.test(n) && (!n.startsWith('.') || last.startsWith('.')));
}

/** A glob's last part as a regex. Any bracket class counts as "any one character": broader than the shell, never narrower. */
function globRegex(last) {
  let src = '';
  for (let i = 0; i < last.length; i++) {
    const c = last[i];
    const close = c === '[' ? last.indexOf(']', i + 2) : -1;
    if (close > 0) (src += '.'), (i = close);
    else if (c === '*') src += '.*';
    else if (c === '?' || c === '[') src += '.';
    else src += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${src}$`);
}

// `cd <folder> && …` (or `;`) at the start: relative paths in the rest are inside that folder.
// `cd <folder> && …` (or `;`) at the start: relative paths in the rest are inside that folder.
// The folder may be quoted in parts ("/Users/me/Echo Copy"/data).
function leadingCd(cmd) {
  const first = shellSegments(cmd)[0];
  if (!first || !(cmd.startsWith('&&', first.end) || ';\n'.includes(cmd[first.end] || '|'))) return null;
  const words = parseCommand(first.text);
  if (words?.length !== 1 || words[0].length !== 2 || words[0][0].text !== 'cd' || words[0][1].glob) return null;
  const dir = words[0][1].text;
  if (!path.isAbsolute(dir)) return null;
  try {
    return fs.statSync(dir).isDirectory() ? path.resolve(dir) : null; // a failed cd would leave us elsewhere
  } catch {
    return null;
  }
}

/**
 * True if every command in a pipeline or list only reads: an allow-listed program with no
 * writing flags, no output redirection except to /dev/null, no command substitution, and no
 * secret (.env, the PIN hash) named or reachable by a glob. ls, du, stat and wc may name them:
 * they never print contents.
 * @param {string} command
 */
export function isReadOnlyCommand(command) {
  const cmd = expandLiterals(command);
  if (SECRETS.test(cmd)) return false;
  const segments = parseCommand(cmd);
  if (!segments?.length) return false;
  let cwd = leadingCd(cmd);
  return segments.every((words, idx) => {
    const [named, ...args] = words.map((w) => w.text);
    // /bin/cat and /usr/bin/grep are cat and grep.
    const prog = /^\/(usr\/)?bin\/[\w-]+$/.test(named) ? path.basename(named) : named;
    if (prog === 'cd' && idx > 0) cwd = null; // a later cd may run in a subshell; stop guessing
    if (!NAME_ONLY.has(prog) && words.some((w) => SECRET_WORD.test(w.text) || (w.glob && globMayHitSecret(w.text, cwd)))) return false;
    const check = Object.hasOwn(READ_ONLY, prog) ? READ_ONLY[prog] : null;
    return Boolean(check) && check(args, { cwd });
  });
}

/**
 * Classify a Bash command. Returns { level, reason, hosts }.
 * Self-improvement tasks may run read-only commands against the live Echo (its folder,
 * logs, data, and GET requests to its port). For ordinary tasks a read-only command on Echo's
 * folder (not its port) is 'echo_read', which a grant can cover; everything else stays risky.
 * strict (safe mode) also gates deletes, software installs and app control.
 * @param {string} command
 * @param {{ selfTask?: boolean, strict?: boolean }} [opts]
 */
export function classifyCommand(command, { selfTask = false, strict = false } = {}) {
  const cmd = String(command || '');
  for (const [re, what] of ALWAYS_GATED) if (re.test(cmd)) return { level: 'risky', reason: what, hosts: [] };
  if (strict) for (const [re, what] of STRICT_GATED) if (re.test(cmd)) return { level: 'risky', reason: what, hosts: [] };
  if (touchesSelf(cmd)) {
    if (selfTask && isReadOnlyCommand(cmd)) return { level: 'safe', reason: '', hosts: [] };
    if (!selfPortPattern().test(cmd) && isReadOnlyCommand(cmd)) return { level: 'echo_read', reason: "reads Echo's own code (read-only)", hosts: [] };
    return { level: 'risky', reason: 'touches Echo itself', hosts: [] };
  }
  if (!HTTP_TOOL.test(cmd)) return { level: 'safe', reason: '', hosts: [] };

  // Flags count on the web request itself (and on variables the command sets, which could hold
  // them), not elsewhere in the line: `head -c 300` after a curl isn't a cookie jar.
  const pieces = shellSegments(cmd).map((s) => s.text);
  const requests = pieces.filter((t) => HTTP_TOOL.test(t));
  const flagged = ` ${pieces.filter((t) => HTTP_TOOL.test(t) || /(^|\s)[A-Za-z_]\w*=/.test(t)).join(' \n ')} `;
  const urls = cmd.match(URL_RE) || [];
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
  if (!urls.length) {
    // curl with a URL built in a variable: we can't see where it goes, so ask.
    return IS_POST.test(flagged) || requests.some((t) => /\$\{?\w|\$\(|`/.test(t))
      ? { level: 'network_site', reason: 'web request to an address built at runtime', hosts }
      : { level: 'safe', reason: '', hosts };
  }
  const pathOf = (u) => u.replace(/^https?:\/\/[^/]+/, '');
  if (urls.some((u) => SENSITIVE_URL.test(pathOf(u)))) {
    return { level: 'risky', reason: 'web request to a login, payment, account or submission page', hosts };
  }
  if (WRITE_FLAGS.test(flagged)) return { level: 'risky', reason: 'web request that uploads, authenticates or changes data', hosts };
  // An argument that is a variable ($OPTS, "$F") could be any flag at all: ask.
  if (requests.some((t) => /(^|\s)["']?\$/.test(t))) return { level: 'network_site', reason: 'web request with options built at runtime', hosts };
  if (IS_POST.test(flagged)) {
    return urls.every((u) => SEARCH_POST.test(u))
      ? { level: 'network_read', reason: 'read-only search request', hosts }
      : { level: 'network_site', reason: 'sends data to a website', hosts };
  }
  return { level: 'safe', reason: '', hosts }; // plain GET downloads/reads
}

/** Grants the user gave by voice: per task or for the whole session. */
export class Grants {
  /** @param {{ strict?: () => boolean }} [opts] strict: safe mode, where grants only ever cover one task */
  constructor({ strict = () => false } = {}) {
    this.strict = strict;
    this.session = { networkRead: false, echoRead: false, sites: new Set() };
    this.tasks = new Map(); // taskId -> { networkRead, echoRead, sites, paths }
  }

  forTask(id) {
    if (!this.tasks.has(id)) this.tasks.set(id, { networkRead: false, echoRead: false, sites: new Set(), paths: new Map() });
    return this.tasks.get(id);
  }

  /**
   * The user said yes to this task changing these files (or the files in these folders): the same
   * task may change and look at them again without asking. Only ever for one task, never a session.
   * @param {number} taskId @param {Array<{ path: string, dir?: boolean }>} entries
   */
  grantPaths(taskId, entries) {
    const t = this.forTask(taskId);
    for (const e of entries) t.paths.set(e.path, e.dir ? 'dir' : 'file');
  }

  /** Is this path one the user approved for this task (the file itself, or inside an approved folder)? */
  pathOk(taskId, abs) {
    const paths = this.tasks.get(taskId)?.paths;
    if (!paths?.size) return false;
    return paths.has(abs) || [...paths].some(([p, kind]) => kind === 'dir' && insideDir(abs, p));
  }

  /** The task is over: what the user approved for its files ends with it. */
  endJob(taskId) {
    this.tasks.get(taskId)?.paths.clear();
  }

  /** @param {{ taskId?: number, scope?: 'task' | 'session', kind: 'network_read' | 'echo_read' | 'site', site?: string }} g */
  grant({ taskId, scope = 'task', kind, site }) {
    if (scope === 'session' && this.strict()) {
      if (taskId == null) throw new Error('In safe mode, "stop asking" only covers one task at a time. Say which task.');
      scope = 'task';
    }
    const target = scope === 'session' ? this.session : this.forTask(taskId);
    if (kind === 'network_read') target.networkRead = true;
    else if (kind === 'echo_read') target.echoRead = true;
    else if (kind === 'site' && site) target.sites.add(site.toLowerCase().replace(/^www\./, ''));
    else throw new Error('Unknown grant');
    return this.describe(taskId);
  }

  revoke({ taskId, scope = 'task' }) {
    if (scope === 'session') this.session = { networkRead: false, echoRead: false, sites: new Set() };
    else this.tasks.delete(taskId);
  }

  describe(taskId) {
    const t = this.tasks.get(taskId);
    return {
      session: { networkRead: this.session.networkRead, echoRead: this.session.echoRead, sites: [...this.session.sites] },
      task: t ? { networkRead: t.networkRead, echoRead: t.echoRead, sites: [...t.sites] } : null,
    };
  }

  /** May this task read Echo's own folders (read-only) without asking? */
  echoRead(taskId) {
    return Boolean(this.session.echoRead || this.tasks.get(taskId)?.echoRead);
  }

  /**
   * Does an existing grant cover this classified command? Risky commands are never covered.
   * @param {number} taskId @param {{ level: string, hosts?: string[], paths?: string[] }} verdict
   */
  covers(taskId, verdict) {
    if (verdict.level === 'safe') return true;
    if (verdict.level === 'risky') return false;
    if (verdict.level === 'echo_read') return this.echoRead(taskId);
    // Files outside the task's folder: every one must be a file the user approved for this task.
    if (verdict.level === 'job_files') return Boolean(verdict.paths?.length) && (verdict.paths || []).every((p) => this.pathOk(taskId, p));
    const t = this.tasks.get(taskId);
    const scopes = [this.session, t].filter(Boolean);
    const siteOk = (h) => scopes.some((s) => [...s.sites].some((site) => h === site || h.endsWith('.' + site)));
    if (verdict.level === 'network_read' && scopes.some((s) => s.networkRead)) return true;
    const hosts = verdict.hosts || [];
    return hosts.length > 0 && hosts.every(siteOk);
  }
}

/**
 * Short human reason for an approval prompt, or null if no approval is needed.
 * @param {string} toolName
 * @param {{ command?: string }} input
 * @param {{ grants?: Grants, taskId?: number, selfTask?: boolean, strict?: boolean }} [opts]
 */
export function riskReason(toolName, input, { grants, taskId, selfTask = false, strict = false } = {}) {
  if (toolName !== 'Bash') return null;
  const verdict = classifyCommand(input.command, { selfTask, strict });
  if (verdict.level === 'safe') return null;
  if (grants?.covers(taskId, verdict)) return null;
  return `${verdict.reason}: ${String(input.command).slice(0, 300)}`;
}

/* ---------- self-improvement tasks: reading the live Echo ---------- */

const insideDir = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Secrets no task may read: .env files and the self-improve PIN hash (and its folder, for searches). */
export function isSecretPath(abs, toolName = 'Read') {
  const p = path.resolve(abs);
  if (/(^|\/)\.env(\.[^/]*)?$/.test(p)) return true;
  const selfData = path.join(config.dataDir, 'self');
  if (p === path.join(selfData, 'pin.json') || /\/data\/self\/pin\.json$/.test(p)) return true;
  // A search over the folder holding the PIN hash could read it too.
  return /^(Grep|Glob)$/.test(toolName) && (insideDir(p, selfData) || /\/data\/self$/.test(p));
}

/** Folders a self-improvement task may read without asking: the live app, its data and logs, and the worktrees (old folder too). */
export const selfReadableRoots = () => [APP_DIR, config.dataDir, config.logDir, config.worktreeDir, config.legacyWorktreeDir];

/**
 * May a self-improvement task use this read-only tool (Read, Glob, Grep…) on this path without asking?
 * @param {string} toolName
 * @param {string} abs absolute path
 */
export function selfMayRead(toolName, abs) {
  if (!/^(Read|Glob|Grep|LS|NotebookRead)$/.test(toolName)) return false;
  if (isSecretPath(abs, toolName)) return false;
  return selfReadableRoots().some((root) => insideDir(path.resolve(abs), root));
}

/* ---------- the job's own files: one yes covers them for the task ---------- */

// "The job's own files" are, narrowly:
//   1. the task's own folder (always free: the SDK doesn't ask about it);
//   2. a file outside it that the user said yes to this task writing, once;
//   3. when that file is inside a folder the task's instruction names by full path (the folder
//      the job was given as its target), the files in that folder: the question says so
//      (lib/tasks.js jobCovers).
// Reading or opening one of them to check the result is covered with it. A different file, even
// one the instruction names, asks its own question the first time.
// And never, whatever was approved (these ask every time, as before): anything outside the user's
// home folder; hidden files and folders (.ssh, .zshrc, .git…); ~/Library and ~/Applications;
// Echo's own code, data and logs; secrets; and, as a folder, the home folder or one directly in it
// (the Desktop, Documents: a file there can be covered, the whole folder can't).

/**
 * A path with its links followed as far as it exists, so a link inside an approved folder can't
 * lead out of it. Null for a link that points nowhere (writing to it would create its target).
 * @param {string} abs
 */
export function realPath(abs) {
  let p = path.resolve(abs);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(p), ...rest.reverse());
    } catch {}
    if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) return null;
    const up = path.dirname(p);
    if (up === p) return path.resolve(abs);
    rest.push(path.basename(p));
    p = up;
  }
}

/**
 * Could one yes ever cover this path for a task (see the list above)? `abs` has its links followed.
 * @param {string | null} abs @param {{ home?: string, dir?: boolean }} [o] dir: as a whole folder
 */
export function mayBeJobFile(abs, { home = os.homedir(), dir = false } = {}) {
  if (!abs) return false;
  const rel = path.relative(realPath(home) || home, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  if (parts.some((s) => s.startsWith('.')) || ['Library', 'Applications'].includes(parts[0])) return false;
  if (dir && parts.length < 2) return false;
  if (isSecretPath(abs) || touchesSelf(abs)) return false;
  return !selfReadableRoots().some((root) => insideDir(abs, root) || insideDir(abs, realPath(root) || root));
}

/** Files a browser or Preview only shows: opening one runs nothing on the Mac. */
const VIEWABLE = /\.(html?|png|jpe?g|gif|webp|svg|pdf|txt|md|css)$/i;
export const isViewable = (p) => VIEWABLE.test(String(p || ''));
const VIEWERS = new Set(['Safari', 'Google Chrome', 'Firefox', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Preview']);
const HEADLESS_BROWSER = /\/(Google Chrome|Chromium|Microsoft Edge|Brave Browser)$/;
const HEADLESS_FLAG = /^--(headless(=new|=old)?|disable-gpu|hide-scrollbars|no-first-run|force-device-scale-factor=[\d.]+|window-size=\d+,\d+|virtual-time-budget=\d+|default-background-color=\w+)$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const echoPorts = () => new Set([Number(config.port), DEFAULT_PORT]);

/**
 * What a page address given to a browser points at: a file (returned as a path), or a page on
 * this Mac that isn't Echo's (''), or null for anything else (the web, a file that isn't a page).
 */
function localPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === 'file:') {
    let p = '';
    try {
      p = decodeURIComponent(u.pathname);
    } catch {}
    return u.host === '' && isViewable(p) ? p : null;
  }
  if (!/^https?:$/.test(u.protocol) || !LOCAL_HOSTS.has(u.hostname) || u.username || u.password) return null;
  return echoPorts().has(Number(u.port || (u.protocol === 'https:' ? 443 : 80))) ? null : '';
}

/**
 * The files a Bash line touches outside the task's folder, when every part of it is one of:
 *   - `cp` of plain files (no folders);
 *   - `open` of a page or picture, in the default app or a browser;
 *   - a browser run headless to take a picture of a page;
 *   - a local preview: `python3 -m http.server` bound to this Mac only (127.0.0.1 / localhost,
 *     given on the line: Python's default is every network), not on Echo's port. The folder it
 *     serves is reported like any other path, so one outside the task's own must be approved;
 *   - a read-only command (isReadOnlyCommand), or a leading `cd`.
 * Null for anything else (a delete, a move, a redirect, a variable, a glob, a program not listed):
 * that asks as before.
 * @param {string} command @param {{ cwd: string, home: string }} o
 * @returns {{ paths: string[], writes: string[] } | null}
 */
function outsideBash(command, { cwd, home }) {
  const cmd = String(command || '');
  if (touchesSelfPort(cmd)) return null;
  const segments = splitCommand(cmd);
  const texts = shellSegments(cmd);
  if (!segments?.length || texts.length !== segments.length) return null;
  const root = realPath(cwd);
  if (!root) return null;
  let dir = root;
  let bad = false;
  const paths = new Set();
  const writes = new Set();
  /** A word as a path. Marks the line as not understood when it can't be one for sure. */
  const at = (w) => {
    if (w === '~' || /^~[^/]/.test(w) || /[*?[]/.test(w)) return (bad = true), null;
    const p = realPath(path.resolve(dir, w.startsWith('~/') ? path.join(home, w.slice(2)) : w));
    if (!p) bad = true;
    return p;
  };
  const touch = (p, write = false) => {
    if (!p || insideDir(p, root)) return;
    paths.add(p);
    if (write) writes.add(p);
  };
  const page = (word) => {
    const p = /^[a-z][a-z0-9+.-]*:\/\//i.test(word) ? localPage(word) : isViewable(word) ? at(word) : null;
    if (p === null) return (bad = true), undefined;
    if (p) touch(realPath(p) || ((bad = true), null));
  };
  segments.forEach((words, idx) => {
    const [prog, ...args] = words;
    const flags = args.filter((a) => a.startsWith('-'));
    const rest = args.filter((a) => !a.startsWith('-'));
    if (prog === 'cd') {
      // Only first, and only to a full path: later words are then read from that folder.
      if (idx > 0 || args.length !== 1 || !/^(\/|~\/)/.test(args[0])) return (bad = true);
      const to = at(args[0]);
      if (!to) return;
      touch(to);
      dir = to;
    } else if (prog === 'cp') {
      if (flags.some((f) => !/^-[fpvnX]+$/.test(f)) || rest.length < 2) return (bad = true);
      const dest = at(rest[rest.length - 1]);
      const isDir = Boolean(dest && fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory());
      if (rest.length > 2 && !isDir) return (bad = true);
      for (const src of rest.slice(0, -1)) {
        const from = at(src);
        if (!from || !fs.statSync(from, { throwIfNoEntry: false })?.isFile()) return (bad = true);
        touch(from);
        // Into a folder: the file it lands on is what gets written (and may be a link itself).
        touch(isDir ? realPath(path.join(/** @type {string} */ (dest), path.basename(from))) || ((bad = true), null) : dest, true);
      }
    } else if (prog === 'open') {
      const pages = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-a' && VIEWERS.has(args[i + 1])) i++;
        else if (args[i].startsWith('-') && args[i] !== '-g') return (bad = true);
        else pages.push(args[i]);
      }
      if (!pages.length) return (bad = true);
      pages.forEach(page);
    } else if (HEADLESS_BROWSER.test(prog)) {
      const shot = flags.filter((f) => /^--screenshot(=|$)/.test(f));
      const others = flags.filter((f) => !/^--screenshot(=|$)/.test(f));
      if (rest.length !== 1 || shot.length !== 1 || !others.some((f) => /^--headless/.test(f)) || others.some((f) => !HEADLESS_FLAG.test(f))) return (bad = true);
      touch(at(shot[0].includes('=') ? shot[0].slice(shot[0].indexOf('=') + 1) : 'screenshot.png'), true);
      page(rest[0]);
    } else if (/^python3?(\.\d+)?$/.test(prog) && args[0] === '-m' && args[1] === 'http.server') {
      let bind = '';
      let serve = dir;
      let port = 8000;
      for (let i = 2; i < args.length; i++) {
        const [name, inline] = args[i].startsWith('--') && args[i].includes('=') ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)] : [args[i], undefined];
        const value = () => inline ?? args[++i] ?? '';
        if (name === '--bind' || name === '-b') bind = value();
        else if (name === '--directory' || name === '-d') serve = at(value()) || '';
        else if (/^\d+$/.test(name) && inline === undefined) port = Number(name);
        else return (bad = true);
      }
      if (!LOCAL_HOSTS.has(bind) || !serve || echoPorts().has(port)) return (bad = true);
      touch(serve);
    } else {
      if (!isReadOnlyCommand(texts[idx].text)) return (bad = true);
      // Every word that could be a path counts as one, flags' values included (--file=/x, -f/x).
      for (const a of args) {
        if (!a.startsWith('-')) touch(at(a));
        else if (/[/~]/.test(a)) touch(at(a.slice(a.search(/[/~]/))));
      }
    }
  });
  return bad ? null : { paths: [...paths], writes: [...writes] };
}

/**
 * Classify a tool call the SDK stopped because it reaches outside the task's folder (a Write,
 * Edit or Read of a file there, or a Bash line that names one). When it only writes, reads or
 * looks at files that could be the job's own, the verdict is 'job_files' with those paths: a
 * grant covers it when every one is approved for the task (Grants.covers), and otherwise the
 * question, once answered yes, approves the files it writes. Everything else is 'risky'.
 * @param {string} toolName @param {any} input @param {string} blockedPath
 * @param {{ cwd: string, home?: string }} o
 * @returns {{ level: 'risky' | 'job_files', reason: string, hosts: string[], paths: string[], writes: string[], edit?: boolean }}
 */
export function classifyOutside(toolName, input, blockedPath, { cwd, home = os.homedir() }) {
  const reason = `${toolName} outside the task folder: ${blockedPath}`;
  const risky = { level: /** @type {const} */ ('risky'), reason, hosts: [], paths: [], writes: [] };
  const tilde = (p) => (String(p).startsWith('~/') ? path.join(home, String(p).slice(2)) : String(p));
  const blocked = realPath(path.resolve(cwd, tilde(blockedPath)));
  if (!blocked) return risky;
  let found = null;
  if (/^(Write|Edit|MultiEdit|NotebookEdit|Read)$/.test(toolName)) {
    const named = input?.file_path || input?.notebook_path;
    const p = named ? realPath(path.resolve(cwd, tilde(named))) : null;
    if (p) found = { paths: [p], writes: toolName === 'Read' ? [] : [p] };
  } else if (toolName === 'Bash') {
    found = outsideBash(input?.command, { cwd, home });
  }
  // The path the SDK stopped on must be one this reading of the call found (or its folder).
  if (found && !found.paths.some((p) => insideDir(p, blocked))) found = null;
  if (!found?.paths.length || !found.paths.every((p) => mayBeJobFile(p, { home }))) return risky;
  return { level: 'job_files', reason, hosts: [], ...found, edit: /Edit/.test(toolName) };
}
