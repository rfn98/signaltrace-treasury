/**
 * Shared .env reader for the read-only verification scripts.
 *
 * This is the `envValue` helper that `scripts/reconcile-chain.ts` already used
 * successfully, extracted so `scripts/verify-db.ts` can load configuration the
 * same way instead of depending on the caller's shell.
 *
 * Precedence is unchanged from the established pattern:
 *   1. an already-exported process env var (always wins),
 *   2. `../contracts/.env` (the chain deployment env),
 *   3. `.env` (this app's env, e.g. web/.env).
 *
 * The value is returned, never logged: keys like DATABASE_URL and
 * ARBITRUM_SEPOLIA_RPC_URL are credentials, and printing them to CI output is
 * how they end up in build logs. This module reads and never prints.
 *
 * This is for *scripts*, not for the Next.js app: Next.js already loads `.env`
 * itself at boot. Nothing here is imported by the request path.
 */
import { readFileSync } from "node:fs";

/** Env files searched, in order, when the key is not already in process.env. */
const ENV_FILES = ["../contracts/.env", ".env"] as const;

/** Matches a single `KEY=value` line, tolerating CRLF and surrounding whitespace. */
const LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/;

/** Reads a single key from .env. Returns the value; never logs it. */
export function envValue(key: string): string | undefined {
  const fromProcess = process.env[key];
  if (fromProcess) return fromProcess;
  for (const file of ENV_FILES) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(LINE);
        if (m && m[1] === key) return m[2].trim();
      }
    } catch {
      /* file absent — try the next location */
    }
  }
  return undefined;
}