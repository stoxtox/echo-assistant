// The Mac app's own line to the server (Stage 3; macos/Sources/BodyLink.swift). The server writes
// a random token to data/self/body-token, readable by this user only; the app presents it when it
// connects to /ws/body, so no other program on the Mac can pose as Echo's hands.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { writeFileAtomic } from './atomic.js';

export const tokenFile = (dataDir: string = config.dataDir): string => path.join(dataDir, 'self', 'body-token');

/** The token, made on first use (and kept, so an app already running reconnects after a restart). */
export function bodyToken(dataDir: string = config.dataDir): string {
  const file = tokenFile(dataDir);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {}
  const t = randomBytes(32).toString('hex');
  writeFileAtomic(file, t + '\n', { mode: 0o600, backup: false });
  return t;
}

/** Is this the token? Compared in constant time. */
export function tokenOk(given: unknown, expected: string): boolean {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
