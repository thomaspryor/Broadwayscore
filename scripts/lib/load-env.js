/**
 * Load .env into process.env for scripts that run OUTSIDE a login shell.
 *
 * launchd agents (and cron) do not inherit an interactive shell environment —
 * they get only what their plist's EnvironmentVariables block declares. A
 * script that reads process.env.RESEND_API_KEY therefore works when you run it
 * by hand and silently no-ops under launchd.
 *
 * That is not hypothetical: opening-night-monitor-launch.js ran 344 times under
 * launchd and every escalation email it tried to send was dropped with
 * "RESEND_API_KEY or OWNER_EMAIL not set, skipping email alert" — so three
 * exhausted launch attempts on a live opening night notified nobody (2026-07-30
 * audit; task #457).
 *
 * Manual parse on purpose: `dotenv` is NOT in package.json (neither
 * dependencies nor devDependencies), so `require('dotenv')` would throw
 * MODULE_NOT_FOUND and take the whole job down — strictly worse than the
 * missing-credential bug it is meant to fix.
 *
 * A non-empty existing process.env value always wins, so CI (which injects real
 * secrets via `env:`) is unaffected and a stale local .env can never shadow it.
 * An EMPTY existing value is treated as absent and gets filled from .env.
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {string} [repoRoot] - Directory containing .env. Defaults to the repo
 *   root inferred from this file's location.
 * @returns {{ loaded: boolean, path: string, keys: string[] }}
 *   `loaded` false when no .env exists (normal in CI). `keys` lists only the
 *   variables this call actually set — never their values, so it is safe to log.
 */
function loadEnv(repoRoot) {
  const root = repoRoot || path.join(__dirname, '..', '..');
  const envPath = path.join(root, '.env');

  // NEVER throw. This function exists to keep a launchd job alive; if it dies
  // here it takes down the very job it is meant to fix. existsSync + readFileSync
  // is a TOCTOU race, and readFileSync also throws on a directory, a permissions
  // problem, or a mid-read unlink — all of which must degrade to "no .env".
  let raw;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch (err) {
    return { loaded: false, path: envPath, keys: [], error: err.code || String(err) };
  }

  // Strip a UTF-8 BOM, else the first key parses as "﻿RESEND_API_KEY".
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const keys = [];
  for (const line of raw.split('\n')) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // `export FOO=bar` is valid in a shell-sourced .env (opening-night-monitor.sh
    // does `source .env`), and without this the key parses as "export FOO".
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let val = trimmed.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes: KEY="value" → value
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    // Fill in anything the environment did not usefully provide. An empty-string
    // env var counts as absent on purpose: launchd/CI can export FOO= with no
    // value, and treating that as "already set" would leave the credential
    // blank — the exact silent-no-credential failure this file exists to stop.
    // A real CI secret is non-empty, so it still wins.
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = val;
      keys.push(key);
    }
  }
  return { loaded: true, path: envPath, keys };
}

module.exports = { loadEnv };
