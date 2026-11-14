// The premium voice's free characters (ElevenLabs, Cartesia). Echo speaks with the premium voice
// while this period's free characters last, then with Kokoro (local, free) until they come back,
// then the premium voice again. It never goes past the free (or plan) limit, so it never runs up
// a bill, even on an account that allows usage-based billing. A premium voice that fails (no
// network, a bad key, too slow) also falls back, one sentence at a time, and rests after a few
// failures in a row.
//
// What's known is kept in data/voice-budget.json: characters used this period, the limit, when it
// resets, and whether the voice is resting and why. ElevenLabs reports its own usage
// (/v1/user/subscription), checked at most every 10 minutes; Cartesia has no usage endpoint, so
// Echo counts what it sends against CARTESIA_MONTHLY_CHARS (default 20,000, the free plan) and a
// period that starts on the 1st (CARTESIA_RESET_DAY to match your billing day).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson } from './atomic.js';

export const PREMIUM = ['elevenlabs', 'cartesia'];
export const REFRESH_MS = 10 * 60 * 1000;
const FAILS_TO_REST = 3;
const REST_AFTER_FAILS_MS = 5 * 60 * 1000;
const REST_BAD_KEY_MS = 60 * 60 * 1000;
const PROBE_MS = 6 * 60 * 60 * 1000; // out of characters, reset time unknown: try again after this

/** Why a premium voice isn't speaking, in words for Settings and the assistant. */
export const WHY = {
  free_used_up: 'its free characters for this period are used up',
  quota: 'the provider said its characters are used up',
  bad_key: 'its API key was refused',
  failing: 'it failed several times in a row',
  no_key: 'there is no API key for it',
};

/**
 * The start of the next Cartesia period: the next `day` of a month after `now`, local time.
 * @param {Date} now @param {number} [day]
 */
export function nextMonthlyReset(now, day = 1) {
  const d = Math.min(Math.max(1, Math.floor(day) || 1), 28);
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), d);
  return thisMonth > now ? thisMonth : new Date(now.getFullYear(), now.getMonth() + 1, d);
}

/**
 * Is this error the provider saying the characters are used up (as opposed to a network blip)?
 * ElevenLabs: 401 with "quota_exceeded"; Cartesia: 402, or 429 mentioning credits.
 * @param {number} status @param {string} body
 */
export function isQuotaError(status, body = '') {
  const b = String(body).toLowerCase();
  if (/quota_exceeded|quota exceeded|insufficient (credits|balance)|out of credits|credit limit|character limit/.test(b)) return true;
  if (status === 402) return true;
  return status === 429 && /credit|quota/.test(b);
}

/**
 * @typedef {{ used: number, limit: number, resetAt: number, restingUntil: number, why: string,
 *   fails: number, checkedAt: number, overage?: boolean }} Budget
 */

export class VoiceBudget {
  /**
   * @param {{ file?: string, now?: () => number, fetch?: typeof fetch, env?: NodeJS.ProcessEnv,
   *   onChange?: (provider: string, change: { why: string, prevWhy: string, until: number }) => void }} [o]
   */
  constructor({ file = path.join(config.dataDir, 'voice-budget.json'), now = Date.now, fetch: f = globalThis.fetch, env = process.env, onChange = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.fetch = f;
    this.env = env;
    this.onChange = onChange;
    /** @type {Record<string, Budget>} */
    this.state = {};
    this.state = readJson(file, {}) || {};
    this.refreshing = null;
  }

  hasKey(p) {
    return Boolean(p === 'elevenlabs' ? this.env.ELEVENLABS_API_KEY : p === 'cartesia' ? this.env.CARTESIA_API_KEY : false);
  }

  /** @returns {Budget} */
  get(p) {
    const b = (this.state[p] ??= { used: 0, limit: 0, resetAt: 0, restingUntil: 0, why: '', fails: 0, checkedAt: 0 });
    // Cartesia: Echo keeps the count, so it also starts each period.
    if (p === 'cartesia') {
      b.limit = Number(this.env.CARTESIA_MONTHLY_CHARS) || 20000;
      const day = Number(this.env.CARTESIA_RESET_DAY) || 1;
      if (!b.resetAt) b.resetAt = nextMonthlyReset(new Date(this.now()), day).getTime();
      while (b.resetAt <= this.now()) {
        b.used = 0;
        b.resetAt = nextMonthlyReset(new Date(b.resetAt), day).getTime();
      }
    } else if (b.resetAt && b.resetAt <= this.now()) {
      // ElevenLabs' period turned over: the old count is stale until it's asked again.
      b.used = 0;
      b.resetAt = 0;
      b.checkedAt = 0;
    }
    return b;
  }

  save() {
    try {
      writeJson(this.file, this.state, { indent: 1 });
    } catch {}
  }

  resting(p) {
    return this.get(p).restingUntil > this.now();
  }

  /**
   * May the premium voice say `chars` more characters now? Never past the free or plan limit.
   * @param {string} p @param {number} chars
   * @returns {{ ok: boolean, why: string }}
   */
  canUse(p, chars) {
    if (!this.hasKey(p)) return { ok: false, why: 'no_key' };
    const b = this.get(p);
    this.maybeRefresh(p);
    if (b.restingUntil > this.now()) return { ok: false, why: b.why };
    // A rest that ran out is a try, not a recovery: that's only when it speaks again (spent).
    if (b.limit && b.used + chars > b.limit) {
      this.setRest(p, b.resetAt > this.now() ? b.resetAt : this.now() + PROBE_MS, 'free_used_up');
      return { ok: false, why: 'free_used_up' };
    }
    return { ok: true, why: '' };
  }

  /** It spoke: count the characters (until the provider's own count replaces it). */
  spent(p, chars) {
    const b = this.get(p);
    b.used += chars;
    b.fails = 0;
    if (b.why) this.setRest(p, 0, '');
    else this.save();
  }

  /**
   * It failed: out of characters rests it until they're back; a refused key for an hour; three
   * failures in a row (network, too slow) for 5 minutes.
   * @param {string} p @param {{ status?: number, body?: string, timeout?: boolean }} e
   */
  failed(p, { status = 0, body = '', timeout = false } = {}) {
    const b = this.get(p);
    if (!timeout && isQuotaError(status, body)) {
      if (b.limit) b.used = Math.max(b.used, b.limit);
      return this.setRest(p, b.resetAt > this.now() ? b.resetAt : this.now() + PROBE_MS, 'quota');
    }
    if (status === 401 || status === 403) return this.setRest(p, this.now() + REST_BAD_KEY_MS, 'bad_key');
    if (++b.fails >= FAILS_TO_REST) {
      b.fails = 0;
      return this.setRest(p, this.now() + REST_AFTER_FAILS_MS, 'failing');
    }
    this.save();
  }

  /** Rest until `until` because of `why` ('' = back). Tells onChange when it starts or ends resting. */
  setRest(p, until, why) {
    const b = this.get(p);
    const prevWhy = b.why;
    b.restingUntil = until;
    b.why = why;
    this.save();
    if (Boolean(prevWhy) !== Boolean(why)) {
      try { this.onChange(p, { why, prevWhy, until }); } catch {}
    }
  }

  /** Ask ElevenLabs how much is used, at most every 10 minutes, without holding anything up. */
  maybeRefresh(p) {
    const b = this.get(p);
    if (p !== 'elevenlabs' || !this.hasKey(p) || this.now() - b.checkedAt < REFRESH_MS || this.refreshing) return;
    b.checkedAt = this.now();
    this.refreshing = this.refresh(p).finally(() => { this.refreshing = null; });
  }

  async refresh(p = 'elevenlabs') {
    if (p !== 'elevenlabs' || !this.hasKey(p)) return;
    try {
      const res = await this.fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': this.env.ELEVENLABS_API_KEY || '' } });
      if (!res.ok) return;
      const s = await res.json();
      const b = this.get(p);
      if (Number.isFinite(s.character_count)) b.used = s.character_count;
      if (Number.isFinite(s.character_limit)) b.limit = s.character_limit;
      if (Number.isFinite(s.next_character_count_reset_unix)) b.resetAt = s.next_character_count_reset_unix * 1000;
      b.overage = Boolean(s.can_extend_character_limit);
      b.checkedAt = this.now();
      // Out of characters: rest until the provider's own reset time (a new period clears it).
      if ((b.why === 'free_used_up' || b.why === 'quota') && b.used >= b.limit && b.resetAt > this.now()) b.restingUntil = b.resetAt;
      else if ((b.why === 'free_used_up' || b.why === 'quota') && b.used < b.limit) b.restingUntil = 0;
      this.save();
    } catch {}
  }

  /** For Settings: per premium voice, what's used, what's left, when it resets, and if it's resting. */
  status() {
    /** @type {Record<string, { hasKey: boolean, used: number, limit: number, left: number | null, resetAt: number, resting: boolean, why: string, restingUntil: number }>} */
    const out = {};
    for (const p of PREMIUM) {
      const b = this.get(p);
      const resting = b.restingUntil > this.now();
      out[p] = { hasKey: this.hasKey(p), used: b.used, limit: b.limit, left: b.limit ? Math.max(0, b.limit - b.used) : null, resetAt: b.resetAt, resting, why: resting ? b.why : '', restingUntil: resting ? b.restingUntil : 0 };
    }
    return out;
  }
}
