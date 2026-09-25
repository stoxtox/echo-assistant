// Decides which worker Bash commands need your approval.
//
//   'safe'         runs without asking
//   'network_read' a read-only web request (curl GET, public search APIs). Asks, unless
//                  you granted "auto-approve read-only web requests" for the task/session.
//   'network_site' any other request to a website. Asks, unless you granted that site.
//   'risky'        always asks, no grant can skip it: git commit/push, deletes, deploys,
//                  purchases, logins, form submissions, touching Echo itself…
//                  (self-improvement tasks may run read-only commands against Echo)
import path from 'node:path';
import { config, APP_DIR, DEFAULT_PORT } from './config.js';

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
const selfPatterns = () => [
  new RegExp(`\\b(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):(${[...new Set([config.port, DEFAULT_PORT])].join('|')})\\b`),
  new RegExp(APP_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
];

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
 * Split a shell command into its simple commands (on | || && ; & and newlines), outside quotes.
 * Returns null when the command does anything we can't vouch for as read-only: command or
 * process substitution, variables or escapes outside single quotes, subshells, or output
 * redirection other than to /dev/null (2>&1 and friends are fine).
 * @param {string} cmd
 * @returns {string[][] | null} each segment's words, quotes removed
 */
export function splitCommand(cmd) {
  const segments = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
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
      const close = cmd.indexOf('"', i + 1);
      if (close < 0) return null;
      const inner = cmd.slice(i + 1, close);
      if (/[$`\\]/.test(inner)) return null;
      word += inner;
      inWord = true;
      i = close;
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
      words.push('<');
    } else if (c === '|' || c === ';' || c === '&' || c === '\n') {
      endSegment();
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
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
  return false;
}

/** @type {Record<string, (args: string[]) => boolean>} */
const READ_ONLY = {
  cat: () => true, head: () => true, tail: () => true,
  ls: () => true, wc: () => true, stat: () => true, du: () => true, df: () => true,
  file: (args) => !args.includes('-C'),
  diff: () => true, cmp: () => true, comm: () => true, cut: () => true, tr: () => true, nl: () => true,
  column: () => true, jq: () => true, pwd: () => true, echo: () => true, printf: () => true,
  basename: () => true, dirname: () => true, realpath: () => true, readlink: () => true, date: () => true,
  which: () => true, test: () => true, '[': () => true, true: () => true, cd: () => true,
  tree: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*o/.test(f)),
  shasum: () => true, md5: () => true, od: () => true, ps: () => true, pgrep: () => true,
  xxd: (args) => operands(args).length <= 1,
  lsof: () => true, netstat: () => true,
  // Recursive grep would read secrets like .env; the Grep tool and rg skip ignored files.
  grep: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*[rR]|^--(recursive|dereference-recursive|directories)/.test(f)),
  egrep: (args) => READ_ONLY.grep(args),
  rg: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*u|^--(no-ignore|pre\b|pre=|search-zip)|^-z$/.test(f)),
  find: (args) => !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a)),
  sort: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*o|^--output/.test(f)),
  uniq: (args) => operands(args).length <= 1,
  tee: (args) => operands(args).every((a) => a === '/dev/null'),
  // awk and sed scripts can write files or run commands, so those forms are out.
  awk: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*[if]|^--(include|load|file|in-?place)/.test(f)) && !/system|getline|\||>/.test(args.join(' ')),
  sed: (args) => !flagsOf(args).some((f) => /^-[a-zA-Z]*[iIf]|^--(in-place|file)/.test(f)) && !/(^|[\s;{}/\d$!])[wWe](\s|$)/.test(' ' + args.join(' ')),
  git: (args) => readOnlyGit(args),
  curl: (args) => readOnlyHttp('curl', args),
  wget: (args) => readOnlyHttp('wget', args),
};

// Secrets stay off-limits even to read: .env files and the self-improve PIN hash
// (including globs or variables that could expand to them).
// Quoted globs don't expand, so only unquoted ones count (a jq filter like '.[0]' is fine).
const SECRETS = /(^|[/\s'"=])\.env\b|pin\.json|(^|[/\s=])\.[^\s/'"]*[*?[]|(^|[/\s=])self\/[^\s'"]*[*?[]/;

/**
 * True if every command in a pipeline or list only reads: an allow-listed program with no
 * writing flags, no output redirection except to /dev/null, and no command substitution.
 * @param {string} command
 */
export function isReadOnlyCommand(command) {
  const cmd = String(command || '');
  if (SECRETS.test(cmd)) return false;
  const segments = splitCommand(cmd);
  if (!segments?.length) return false;
  return segments.every(([prog, ...args]) => {
    const check = Object.hasOwn(READ_ONLY, prog) ? READ_ONLY[prog] : null;
    return Boolean(check) && check(args);
  });
}

/**
 * Classify a Bash command. Returns { level, reason, hosts }.
 * Self-improvement tasks may run read-only commands against the live Echo (its folder,
 * logs, data, and GET requests to its port); everything else touching Echo stays risky.
 * strict (safe mode) also gates deletes, software installs and app control.
 * @param {string} command
 * @param {{ selfTask?: boolean, strict?: boolean }} [opts]
 */
export function classifyCommand(command, { selfTask = false, strict = false } = {}) {
  const cmd = String(command || '');
  for (const [re, what] of ALWAYS_GATED) if (re.test(cmd)) return { level: 'risky', reason: what, hosts: [] };
  if (strict) for (const [re, what] of STRICT_GATED) if (re.test(cmd)) return { level: 'risky', reason: what, hosts: [] };
  if (selfPatterns().some((re) => re.test(cmd))) {
    if (selfTask && isReadOnlyCommand(cmd)) return { level: 'safe', reason: '', hosts: [] };
    return { level: 'risky', reason: 'touches Echo itself', hosts: [] };
  }
  if (!HTTP_TOOL.test(cmd)) return { level: 'safe', reason: '', hosts: [] };

  const urls = cmd.match(URL_RE) || [];
  const hosts = [...new Set(urls.map(hostOf).filter(Boolean))];
  if (!urls.length) {
    // curl with a URL built in a variable: we can't see where it goes, so ask.
    return IS_POST.test(cmd) || /\$\{?\w|\$\(/.test(cmd)
      ? { level: 'network_site', reason: 'web request to an address built at runtime', hosts }
      : { level: 'safe', reason: '', hosts };
  }
  const pathOf = (u) => u.replace(/^https?:\/\/[^/]+/, '');
  if (urls.some((u) => SENSITIVE_URL.test(pathOf(u)))) {
    return { level: 'risky', reason: 'web request to a login, payment, account or submission page', hosts };
  }
  if (WRITE_FLAGS.test(cmd)) return { level: 'risky', reason: 'web request that uploads, authenticates or changes data', hosts };
  if (IS_POST.test(cmd)) {
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
    this.session = { networkRead: false, sites: new Set() };
    this.tasks = new Map(); // taskId -> { networkRead, sites }
  }

  forTask(id) {
    if (!this.tasks.has(id)) this.tasks.set(id, { networkRead: false, sites: new Set() });
    return this.tasks.get(id);
  }

  /** @param {{ taskId?: number, scope?: 'task' | 'session', kind: 'network_read' | 'site', site?: string }} g */
  grant({ taskId, scope = 'task', kind, site }) {
    if (scope === 'session' && this.strict()) {
      if (taskId == null) throw new Error('In safe mode, "stop asking" only covers one task at a time. Say which task.');
      scope = 'task';
    }
    const target = scope === 'session' ? this.session : this.forTask(taskId);
    if (kind === 'network_read') target.networkRead = true;
    else if (kind === 'site' && site) target.sites.add(site.toLowerCase().replace(/^www\./, ''));
    else throw new Error('Unknown grant');
    return this.describe(taskId);
  }

  revoke({ taskId, scope = 'task' }) {
    if (scope === 'session') this.session = { networkRead: false, sites: new Set() };
    else this.tasks.delete(taskId);
  }

  describe(taskId) {
    const t = this.tasks.get(taskId);
    return {
      session: { networkRead: this.session.networkRead, sites: [...this.session.sites] },
      task: t ? { networkRead: t.networkRead, sites: [...t.sites] } : null,
    };
  }

  /** Does an existing grant cover this classified command? Risky commands are never covered. */
  covers(taskId, verdict) {
    if (verdict.level === 'safe') return true;
    if (verdict.level === 'risky') return false;
    const t = this.tasks.get(taskId);
    const scopes = [this.session, t].filter(Boolean);
    const siteOk = (h) => scopes.some((s) => [...s.sites].some((site) => h === site || h.endsWith('.' + site)));
    if (verdict.level === 'network_read' && scopes.some((s) => s.networkRead)) return true;
    return verdict.hosts.length > 0 && verdict.hosts.every(siteOk);
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

/** Folders a self-improvement task may read without asking: the live app, its data and logs, and the worktrees. */
export const selfReadableRoots = () => [APP_DIR, config.dataDir, config.logDir, config.worktreeDir];

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
