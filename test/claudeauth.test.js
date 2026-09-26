// The setup wizard's "Sign in to Claude" step: status, browser sign-in and the test call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAuth, parseAuthStatus, friendlySignInError, findClaude } from '../lib/claudeauth.js';
import { signInSummary, CLAUDE_LINKS } from '../public/onboarding.js';

/** A stand-in `claude` that answers `auth status --json` and pretends to sign in. */
function fakeClaude(dir, { loggedIn = false } = {}) {
  const bin = path.join(dir, 'claude');
  const flag = path.join(dir, 'signed-in');
  if (loggedIn) fs.writeFileSync(flag, '');
  fs.writeFileSync(bin, `#!/bin/sh
if [ "$1 $2" = "auth status" ]; then
  if [ -f "${flag}" ]; then echo '{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "max", "email": "someone@example.com"}';
  else echo '{"loggedIn": false}'; fi
  exit 0
fi
if [ "$1 $2" = "auth login" ]; then
  echo "Opening browser to sign in… If it doesn't open, visit https://claude.ai/oauth/authorize?code=true&x=1"
  echo "$3" > "${dir}/login-flag"
  sleep 0.3
  touch "${flag}"
  exit 0
fi
exit 1
`, { mode: 0o755 });
  return bin;
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('parseAuthStatus reads the plan and method, never the email', () => {
  assert.deepEqual(parseAuthStatus({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', email: 'x@example.com' }), { signedIn: true, method: 'subscription', plan: 'Claude Pro' });
  assert.deepEqual(parseAuthStatus({ loggedIn: true, authMethod: 'console' }), { signedIn: true, method: 'api', plan: 'API key (pay as you go)' });
  assert.deepEqual(parseAuthStatus({ loggedIn: false }), { signedIn: false, method: null, plan: null });
  assert.deepEqual(parseAuthStatus(null), { signedIn: false, method: null, plan: null });
});

test('status, then a browser sign-in that finishes, as the wizard polls it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-claude-'));
  const bin = fakeClaude(dir);
  const auth = new ClaudeAuth({ env: { ECHO_CLAUDE_BIN: bin, PATH: '/usr/bin:/bin' } });
  const before = await auth.status();
  assert.equal(before.installed, true);
  assert.equal(before.signedIn, false);
  assert.equal(signInSummary(before).tone, 'idle');

  const started = auth.startLogin('subscription');
  assert.equal(started.running, true);
  assert.equal(auth.startLogin('subscription').running, true, 'a second click reuses the running sign-in');
  assert.ok(await waitFor(() => auth.login.url.startsWith('https://claude.ai/')), 'offers the sign-in link');
  assert.equal(signInSummary(await auth.status()).tone, 'busy');
  assert.ok(await waitFor(async () => (await auth.status()).signedIn));
  const after = await auth.status();
  assert.equal(after.plan, 'Claude Max');
  assert.equal(JSON.stringify(after).includes('example.com'), false, 'the email never reaches the page');
  assert.equal(fs.readFileSync(path.join(dir, 'login-flag'), 'utf8').trim(), '--claudeai');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an API-key sign-in uses the Console flow; a missing Claude Code is explained', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-claude-'));
  const bin = fakeClaude(dir);
  const auth = new ClaudeAuth({ env: { ECHO_CLAUDE_BIN: bin } });
  auth.startLogin('api');
  assert.ok(await waitFor(() => fs.existsSync(path.join(dir, 'login-flag'))));
  assert.equal(fs.readFileSync(path.join(dir, 'login-flag'), 'utf8').trim(), '--console');
  auth.cancelLogin();

  const none = new ClaudeAuth({ env: { ECHO_CLAUDE_BIN: path.join(dir, 'nope') } });
  const st = await none.status();
  assert.equal(st.installed, false);
  assert.match(signInSummary(st).title, /isn't installed/);
  assert.throws(() => none.startLogin(), /isn't installed/);
  assert.equal(findClaude({ ECHO_CLAUDE_BIN: path.join(dir, 'nope') }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the test call: success, a plain-words failure, and a retry', async () => {
  let fail = true;
  const auth = new ClaudeAuth({
    env: {},
    queryFn: async function* () {
      if (fail) yield { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' };
      else yield { type: 'result', subtype: 'success', result: 'ready' };
    },
  });
  const bad = await auth.test();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /aren't signed in/);
  assert.equal(signInSummary({ installed: true, signedIn: true, plan: 'Claude Pro' }, { error: bad.error }).tone, 'bad');
  fail = false;
  const good = await auth.test();
  assert.equal(good.ok, true);
  assert.equal(signInSummary({ installed: true, signedIn: true, plan: 'Claude Pro' }, { ok: true }).title, "You're signed in (Claude Pro)");
});

test('errors in plain words, and real links for the plan options', () => {
  assert.match(friendlySignInError('Credit balance is too low'), /out of credit/);
  assert.match(friendlySignInError('getaddrinfo ENOTFOUND api.anthropic.com'), /internet/);
  assert.match(friendlySignInError('rate_limit_error'), /usage limit/);
  for (const url of Object.values(CLAUDE_LINKS)) assert.match(url, /^https:\/\/(claude\.ai|console\.anthropic\.com|support\.anthropic\.com)\//);
});
