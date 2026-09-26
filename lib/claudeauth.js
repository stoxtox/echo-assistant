// "Sign in to Claude" for the setup wizard: is Claude Code installed and signed in, start the
// browser sign-in (`claude auth login`), and a tiny test call to prove Echo can reach Claude.
//
// Only asks Claude Code whether a sign-in exists; never reads, stores or shows the secret itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

const TEST_MODEL = process.env.VOICEOPS_SIGNIN_TEST_MODEL || 'claude-haiku-4-5';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** Where the `claude` command is: ECHO_CLAUDE_BIN, then PATH, then the usual install spots. */
export function findClaude(env = process.env, home = os.homedir()) {
  if (env.ECHO_CLAUDE_BIN) return fs.existsSync(env.ECHO_CLAUDE_BIN) ? env.ECHO_CLAUDE_BIN : null;
  const dirs = [...String(env.PATH || '').split(':'), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, 'claude');
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return f;
    } catch {}
  }
  return null;
}

/**
 * `claude auth status --json` in plain terms.
 * @param {any} raw
 * @returns {{ signedIn: boolean, method: 'subscription' | 'api' | null, plan: string | null }}
 */
export function parseAuthStatus(raw) {
  const signedIn = Boolean(raw?.loggedIn);
  if (!signedIn) return { signedIn, method: null, plan: null };
  const how = String(raw.authMethod || '').toLowerCase();
  const method = /claude\.ai|oauth|subscription/.test(how) ? 'subscription' : 'api';
  const sub = String(raw.subscriptionType || '').toLowerCase();
  const plan = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise' }[sub] || (method === 'api' ? 'API key (pay as you go)' : null);
  return { signedIn, method, plan };
}

/** Plain-words version of a failed test call. */
export function friendlySignInError(message) {
  const m = String(message || '');
  if (/credit balance|billing|payment/i.test(m)) return 'Your Anthropic account is out of credit. Add some at console.anthropic.com (Plans & Billing), then try again.';
  if (/rate.?limit|usage limit|429|overloaded|529/i.test(m)) return 'Claude is busy or you have hit a usage limit. Wait a minute and try again.';
  if (/not logged in|login|401|unauthori[sz]ed|invalid api key|authentication|oauth|expired/i.test(m)) return "Claude says you aren't signed in. Click Sign in and finish in the browser.";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed|timed out/i.test(m)) return "I couldn't reach Claude. Check your internet connection and try again.";
  if (/ENOENT|not found|failed to launch/i.test(m)) return "Claude Code isn't installed. Run Echo's installer again, then come back here.";
  return `The test didn't work: ${m.slice(0, 200) || 'no answer from Claude'}.`;
}

export class ClaudeAuth {
  /**
   * @param {{ env?: NodeJS.ProcessEnv, queryFn?: (p: { prompt: any, options: any }) => AsyncIterable<any>,
   *   run?: (bin: string, args: string[]) => Promise<string>, spawnFn?: typeof spawn }} [opts]
   */
  constructor({ env = process.env, queryFn = sdkQuery, run, spawnFn = spawn } = {}) {
    this.env = env;
    this.queryFn = queryFn;
    this.spawnFn = spawnFn;
    this.run =
      run ||
      ((bin, args) =>
        new Promise((resolve, reject) => {
          execFile(bin, args, { timeout: 15000, env: this.childEnv(), maxBuffer: 1024 * 1024 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout))));
        }));
    /** @type {{ running: boolean, method: string, url: string, error: string, startedAt: number }} */
    this.login = { running: false, method: '', url: '', error: '', startedAt: 0 };
    this.child = null;
    this.lastTest = null;
  }

  childEnv() {
    const home = os.homedir();
    return { ...this.env, PATH: `${this.env.PATH || ''}:${path.join(home, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin` };
  }

  /** @returns {Promise<{ installed: boolean, signedIn: boolean, method: string | null, plan: string | null, login: any, error?: string }>} */
  async status() {
    const login = { running: this.login.running, method: this.login.method, url: this.login.url, error: this.login.error };
    if (this.env.ANTHROPIC_API_KEY) return { installed: Boolean(findClaude(this.env)), signedIn: true, method: 'api', plan: 'API key (pay as you go)', login };
    const bin = findClaude(this.env);
    if (!bin) return { installed: false, signedIn: false, method: null, plan: null, login };
    try {
      const out = await this.run(bin, ['auth', 'status', '--json']);
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      return { installed: true, ...parseAuthStatus(JSON.parse(json)), login };
    } catch (e) {
      // Older Claude Code without `auth status`: a saved sign-in still counts.
      const signedIn = fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
      return { installed: true, signedIn, method: signedIn ? 'subscription' : null, plan: null, login, ...(signedIn ? {} : { error: "I couldn't check the sign-in. Click Sign in to try." }) };
    }
  }

  /**
   * Opens the Claude sign-in in the browser (Claude Code does that itself) and keeps it running
   * until it finishes, fails or 10 minutes pass. One at a time.
   * @param {'subscription' | 'api'} [method]
   */
  startLogin(method = 'subscription') {
    const bin = findClaude(this.env);
    if (!bin) throw new Error("Claude Code isn't installed. Run Echo's installer again, then come back here.");
    if (this.child && this.login.running) return { ...this.login };
    const flag = method === 'api' ? '--console' : '--claudeai';
    this.login = { running: true, method, url: '', error: '', startedAt: Date.now() };
    const child = this.spawnFn(bin, ['auth', 'login', flag], { env: this.childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let output = '';
    const onData = (d) => {
      output = (output + String(d)).slice(-4000);
      // If the browser didn't open by itself, the page can offer the link Claude Code printed.
      const url = output.match(/https:\/\/[^\s"'<>]+/g)?.find((u) => /claude\.(ai|com)|anthropic\.com/.test(u));
      if (url && !this.login.url) this.login.url = url;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      if (this.child === child) {
        this.login.error = 'The sign-in took too long, so I stopped waiting. Click Sign in to try again.';
        child.kill();
      }
    }, LOGIN_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', (e) => {
      this.login.error = `Couldn't start the sign-in: ${e.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (this.child !== child) return;
      this.child = null;
      this.login.running = false;
      if (code && !this.login.error) this.login.error = 'The sign-in was cancelled or did not finish. Click Sign in to try again.';
    });
    return { ...this.login };
  }

  cancelLogin() {
    const c = this.child;
    this.child = null;
    this.login.running = false;
    c?.kill();
  }

  /** A tiny real call through the same SDK Echo uses, so "signed in" means "works". */
  async test({ timeoutMs = 45000 } = {}) {
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let text = '';
    let error = '';
    try {
      for await (const msg of this.queryFn({
        prompt: 'Reply with exactly: ready',
        options: { model: TEST_MODEL, tools: [], maxTurns: 1, persistSession: false, settingSources: [], permissionMode: 'dontAsk', systemPrompt: 'You answer in one word.', thinking: { type: 'disabled' }, abortController: ac },
      })) {
        if (msg.type === 'result') {
          if (msg.subtype === 'success' && !msg.is_error) text = String(msg.result || '');
          else error = String(msg.result || msg.errors?.join?.(' ') || msg.subtype || 'error');
        }
      }
    } catch (e) {
      error = ac.signal.aborted ? 'timed out' : e.message;
    } finally {
      clearTimeout(timer);
    }
    const ok = Boolean(text.trim()) && !error;
    this.lastTest = { ok, at: Date.now() };
    return ok ? { ok, ms: Date.now() - started, reply: text.trim().slice(0, 40) } : { ok, error: friendlySignInError(error || 'no answer') };
  }
}
