// Local-daemon hardening (security audit 2026-10-09).
//
// The bridge listens on 127.0.0.1, but loopback is reachable by every local
// program and, through DNS rebinding, by web pages. Three layers:
// 1. Host allow-list: requests must name the loopback interface (a rebinding
//    page sends its own hostname in Host).
// 2. Origin allow-list: browser requests carry Origin; only loopback origins
//    pass (opencode's server-side fetch sends none).
// 3. Per-install token: `~/.agy-bridge/token` (32 random bytes, hex), created
//    once and shared with the opencode plugin, sent as `x-agy-token` (or
//    `Authorization: Bearer`). Only GET /healthz answers without it, and only
//    with non-sensitive fields plus an HMAC proof the plugin uses to tell the
//    real daemon from any other process holding the port.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agyBridgeHome } from './sessionStore';

export const TOKEN_HEADER = 'x-agy-token';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function tokenFilePath(): string {
  return path.join(agyBridgeHome(), 'token');
}

function readTokenFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Per-install token, created on first use. Exclusive create (`wx`) so the
 * daemon and the plugin never end up with different tokens when they race;
 * mode 0600 on POSIX (on Windows the file inherits the user-only ACL of the
 * profile folder). A malformed file is replaced.
 */
export function loadOrCreateToken(file: string = tokenFilePath()): string {
  const existing = readTokenFile(file);
  if (existing !== null && TOKEN_PATTERN.test(existing)) {
    return existing;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = randomBytes(32).toString('hex');
  if (existing !== null) {
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  }
  try {
    fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const winner = readTokenFile(file);
      if (winner !== null && TOKEN_PATTERN.test(winner)) {
        return winner;
      }
    }
    throw err;
  }
}

/** Constant-time string comparison (false on any length mismatch). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Proof that the responder knows the install token, without revealing it.
 * The plugin sends a fresh nonce WITHOUT the token and checks this value.
 * Keep the `agy-bridge-health:` prefix identical in plugins/agy-bridge.ts.
 */
export function healthProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`agy-bridge-health:${nonce}`).digest('hex');
}

/** Token supplied by the caller: `x-agy-token` or `Authorization: Bearer`. */
export function suppliedToken(headers: Record<string, unknown>): string {
  const direct = headers[TOKEN_HEADER];
  if (typeof direct === 'string' && direct) {
    return direct.trim();
  }
  const auth = headers['authorization'];
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  return '';
}

/** Host header must name the loopback interface (blocks DNS rebinding). */
export function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== 'string' || !host.trim()) {
    return false;
  }
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end >= 0 ? hostname.slice(0, end + 1) : hostname;
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon >= 0) {
      hostname = hostname.slice(0, colon);
    }
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** No Origin (server-side clients) or a loopback Origin passes. */
export function isAllowedOrigin(origin: unknown): boolean {
  if (origin === undefined) {
    return true;
  }
  if (typeof origin !== 'string') {
    return false;
  }
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Debug routes (/v1/__debug/*) are registered only when explicitly enabled. */
export function debugRoutesEnabled(): boolean {
  const raw = process.env.AGY_BRIDGE_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
