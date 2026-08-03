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

// Worktrees never have their own .env (gitignored, not copied on
// EnterWorktree), so the __dirname-relative default below resolves to a
// worktree root with no .env and readEnvFile silently finds nothing. Fall
// back to the canonical repo path — same idiom dispatch-ledger.js uses for
// its own REPO/LEDGER_PATH constants (task #983, generalizing the
// notion-brain.js fix in commit 3fd452ba1fc). Only applies when the caller
// did not pass an explicit repoRoot, so callers that need a specific
// directory (e.g. tests) are unaffected.
const CANONICAL_REPO = '/Users/tompryor/Broadwayscore';

/**
 * Pure parser: .env text → { KEY: value }. No I/O, no process.env access, so it
 * is directly unit-testable (CLAUDE.md rule 15) and — critically — usable by
 * callers that must NOT mutate the global environment (see readEnvKeys).
 *
 * @param {string} raw - full .env file contents
 * @returns {Record<string,string>} last occurrence of a duplicated key wins,
 *   matching shell `source` semantics.
 */
function parseEnvFile(raw) {
  const out = {};
  if (typeof raw !== 'string' || !raw) return out;
  // Strip a UTF-8 BOM, else the first key parses as "﻿RESEND_API_KEY".
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

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
    out[key] = val;
  }
  return out;
}

// Shared reader. NEVER throws: these functions exist to keep a launchd job
// alive, so dying here would take down the very job they are meant to fix.
// existsSync + readFileSync is a TOCTOU race, and readFileSync also throws on a
// directory, a permissions problem, or a mid-read unlink — all of which must
// degrade to "no .env".
function readEnvFile(repoRoot) {
  const root = repoRoot || path.join(__dirname, '..', '..');
  let envPath = path.join(root, '.env');
  if (!repoRoot && !fs.existsSync(envPath) && fs.existsSync(path.join(CANONICAL_REPO, '.env'))) {
    envPath = path.join(CANONICAL_REPO, '.env');
  }
  try {
    return { ok: true, path: envPath, values: parseEnvFile(fs.readFileSync(envPath, 'utf8')) };
  } catch (err) {
    return { ok: false, path: envPath, values: {}, error: err.code || String(err) };
  }
}

/**
 * Read SPECIFIC keys out of .env WITHOUT touching process.env.
 *
 * loadEnv() below deliberately publishes every .env key to the global
 * environment — correct for a top-level script that wants its own credentials,
 * catastrophic for a caller that builds a deliberately-stripped child env.
 * scripts/lib/claude-cli.js spawns untrusted headless implementers with a
 * 7-variable allow-list precisely so Resend/Notion/scraper secrets never reach
 * them; calling loadEnv() there would publish all 75 .env keys to process.env
 * and every later non-stripped spawn in the same process would inherit them,
 * defeating the containment (Codex P0 on commit fc4999cfc71, 2026-08-01).
 *
 * A non-empty process.env value always wins, so CI (which injects real secrets
 * via `env:`) is unaffected and a stale local .env can never shadow it. An
 * EMPTY existing value is treated as absent — launchd/CI can export FOO= with
 * no value, and treating that as "already set" leaves the credential blank.
 *
 * @param {string[]} keys - variable names to look up
 * @param {string} [repoRoot] - directory containing .env
 * @returns {Record<string,string>} ONLY the requested keys that .env supplies
 *   AND process.env did not usefully provide. Never includes any other key.
 */
function readEnvKeys(keys, repoRoot) {
  const out = {};
  if (!Array.isArray(keys) || keys.length === 0) return out;
  // Skip the read entirely when the environment already covers everything.
  if (keys.every((k) => process.env[k])) return out;
  const { values } = readEnvFile(repoRoot);
  for (const k of keys) {
    if (process.env[k]) continue; // non-empty env value wins
    if (typeof values[k] === 'string' && values[k] !== '') out[k] = values[k];
  }
  return out;
}

/**
 * @param {string} [repoRoot] - Directory containing .env. Defaults to the repo
 *   root inferred from this file's location.
 * @returns {{ loaded: boolean, path: string, keys: string[] }}
 *   `loaded` false when no .env exists (normal in CI). `keys` lists only the
 *   variables this call actually set — never their values, so it is safe to log.
 */
function loadEnv(repoRoot) {
  const { ok, path: envPath, values, error } = readEnvFile(repoRoot);
  if (!ok) return { loaded: false, path: envPath, keys: [], error };

  const keys = [];
  for (const [key, val] of Object.entries(values)) {
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

module.exports = { loadEnv, readEnvKeys, parseEnvFile };
