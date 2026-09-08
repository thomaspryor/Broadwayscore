#!/usr/bin/env node
// scripts/lib/cmux-socket-auth.js — credentials + error taxonomy for every
// call into the cmux control socket (BRO-2959).
//
// Why this exists: cmux 0.64.22 shipped a security migration that set
// `automation.socketControlMode = "cmuxOnly"` (plus
// socketControlPasswordMigrationVersion=1 in the app defaults) on
// 2026-09-07. In that mode the socket accepts ONLY processes whose ancestry
// is inside cmux, so every launchd-run automation started failing with
//   ERROR: Access denied - only processes started inside cmux can connect
// Three independent recovery layers died at the same instant and stayed dead
// for ~2h: bsc-reconcile's cmux tab-lane self-heal, bsc-prune (which
// hard-crashed on the uncaught exception), and dispatch-watchdog (which fell
// into its degraded report-only mode). Nothing paged, because the only
// signal was one more line in an already-noisy local report file.
//
// Two lessons are encoded here rather than left to each caller:
//
//   1. The credential belongs at the socket boundary, not in 25 LaunchAgent
//      plists. Injecting CMUX_SOCKET_PASSWORD per-plist under-fixes BY
//      CONSTRUCTION — at the time of writing five call sites spawn the cmux
//      binary directly (overnight-digest, cmux-launch, cmux-terminal-capacity,
//      message-dispatched-workspace, probe-cmux-launch) and a sixth plist
//      would have been missed. buildCmuxEnv() is the one place to fix.
//
//   2. "cmux said no" is not one condition. An auth rejection is a CONFIG
//      fault that will never clear on its own; a refused connection is a
//      daemon that is merely down and usually comes back. Collapsing them
//      into one opaque string is why this read as transient for hours.
//      classifyCmuxError() keeps them apart so callers can page immediately
//      on the permanent one and stay quiet on the transient one.
//
// Pure functions only (CLAUDE.md rule 15) apart from the memoized config
// read, which is isolated in readSocketPasswordFromDisk().

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// File-managed cmux settings. cmux also keeps a copy in app defaults, but
// only this file is readable without the `defaults` CLI, and a file-managed
// value takes precedence over the one saved in Settings.
const CMUX_CONFIG_PATH = path.join(os.homedir(), '.config', 'cmux', 'cmux.json');

/**
 * Pull `automation.socketPassword` out of cmux.json.
 *
 * cmux.json is JSONC — it ships with a large commented-out template — so
 * JSON.parse fails on the real file and we need a fallback. That fallback is
 * deliberately NOT a "strip everything after //" pass: the very first
 * property is
 *   "$schema": "https://raw.githubusercontent.com/.../cmux.schema.json"
 * and a naive //-stripper eats the rest of that line and corrupts the
 * document. Instead we match the one key we want with a string-aware
 * pattern that tolerates escapes, then let JSON.parse do the unescaping.
 *
 * @param {string} configText raw file contents.
 * @returns {string|null} the password, or null when absent/blank/malformed.
 *   null (never '') is the "no credential" answer on purpose — see
 *   buildCmuxEnv, which must omit the variable rather than send an empty one.
 */
function extractSocketPassword(configText) {
  if (typeof configText !== 'string' || configText === '') return null;

  // Fast path: a config with no comments parses outright.
  try {
    const parsed = JSON.parse(configText);
    const pw = parsed && parsed.automation && parsed.automation.socketPassword;
    return typeof pw === 'string' && pw !== '' ? pw : null;
  } catch { /* JSONC — fall through to the targeted match */ }

  // Drop COMMENTED-OUT lines before matching. cmux ships a large commented
  // template that contains its own `// "socketPassword" : "..."` line, and
  // taking the first textual match would happily inject a credential the
  // operator never enabled (ship-check finding). Only whole-line comments are
  // removed — a line whose first non-whitespace characters are `//` — which
  // deliberately leaves the "$schema": "https://..." value intact, since that
  // "//" is mid-line and stripping it would corrupt the document.
  const active = configText
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  const m = /"socketPassword"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(active);
  if (!m) return null;
  try {
    const pw = JSON.parse(`"${m[1]}"`);
    return typeof pw === 'string' && pw !== '' ? pw : null;
  } catch { return null; }
}

/**
 * Classify a failure from the cmux CLI.
 *
 * The distinction that matters operationally is auth-denied vs everything
 * else: an auth fault is a permanent config state (mode changed, password
 * rotated, password missing) that no amount of waiting repairs, so it should
 * page on the FIRST occurrence. 'unavailable' is the ordinary "cmux isn't
 * running right now" that legitimately self-heals and must stay quiet.
 *
 * @param {Error|string|null|undefined} err an Error from execFileSync (whose
 *   .message carries the captured stderr) or a bare message string.
 * @returns {'auth-denied'|'unavailable'|'not-found'|'timeout'|'unknown'|'empty'}
 *   'unknown' means a real message we could not classify (the "cmux reworded
 *   its error" signal, which escalates); 'empty' means no diagnostic text at
 *   all, which does not.
 */
function classifyCmuxError(err) {
  if (!err) return 'empty';
  // Deliberately does NOT read err.stdout. stdout carries COMMAND OUTPUT —
  // workspace titles, `top` process tables — any of which could contain the
  // literal words "Access denied" and be mistaken for a rejection (ship-check
  // finding). Since the only mutating retry in the tree keys off this verdict,
  // a content-driven false positive there would re-send a command that had
  // already been applied. Diagnosis comes from the failure channels only.
  // stderr is the ONLY trustworthy channel, and it is preferred whenever it
  // has content. execFileSync builds err.message as
  //   "Command failed: <the full argv>\n<stderr>"
  // so the ARGUMENTS are inside the message — and run() carries mutating
  // commands like `send --text '<arbitrary text>'`. A message that merely
  // mentions "Access denied" would classify as auth-denied, which is the one
  // class that RETRIES, and the send would be replayed into a live pane
  // (ship-check finding — reproduced: stderr said "Socket closed" while the
  // argv made it read as auth-denied).
  //
  // Only when stderr is empty do we fall back to the message, and even then
  // the "Command failed: <argv>" first line is dropped so arguments can never
  // reach the matcher.
  const text = typeof err === 'string'
    ? err
    : String(err.stderr || '').trim()
      ? String(err.stderr)
      : String(err.message || '').split('\n').filter((l) => !/^Command failed:/.test(l)).join('\n');
  // A failure carrying NO diagnostic text is its own category, distinct from
  // one whose text we simply do not recognise. That distinction is
  // load-bearing: 'unknown' escalates (it is the "cmux reworded its error"
  // signal), and an empty error is absence of evidence, not evidence of a
  // rewording — paging on it would page on any odd exec failure that happened
  // to produce no stderr (ship-check finding).
  if (!text.trim()) return 'empty';

  // Both rejection shapes cmux emits: no credential offered, and a wrong one.
  if (/Access denied|Invalid password|only processes started inside cmux/i.test(text)) {
    return 'auth-denied';
  }
  // Socket conditions are checked BEFORE the missing-binary check on purpose:
  // cmux says "Socket not found at <path>" when the DAEMON is down, which the
  // generic /not found/ pattern below would otherwise misread as "cmux is not
  // installed". Both stay quiet, but they mean different things to a reader.
  if (/Failed to connect|Connection refused|Socket not found|Socket closed/i.test(text)) {
    return 'unavailable';
  }
  if (/timed out|ETIMEDOUT|SIGTERM/i.test(text)) return 'timeout';
  if (/ENOENT|no such file|command not found/i.test(text)) return 'not-found';
  return 'unknown';
}

/**
 * Build the environment for a cmux subprocess.
 *
 * Two failure directions to avoid, both learned the hard way:
 *
 *   - NEVER overwrite a CMUX_SOCKET_PASSWORD the caller already has. A
 *     LaunchAgent that sets it explicitly is the operator's stated intent
 *     and outranks whatever is on disk.
 *   - NEVER set the variable to '' when no password is known. A wrong or
 *     empty password is REJECTED where absence would have succeeded: a
 *     process running inside cmux is admitted by ancestry alone, and
 *     supplying a bad credential turns that working call into an outage.
 *     Absent means "fall back to ancestry", which is the safe default.
 *
 * @param {Record<string,string|undefined>} baseEnv usually process.env.
 * @param {string|null} password from extractSocketPassword.
 * @returns {Record<string,string|undefined>} a new env object (never mutates).
 */
function buildCmuxEnv(baseEnv, password, { force = false } = {}) {
  const base = baseEnv && typeof baseEnv === 'object' ? baseEnv : {};
  // `force` exists for the retry path and ONLY for it. Without it the
  // deference rule above silently defeats the refresh: a LaunchAgent holding
  // a STALE CMUX_SOCKET_PASSWORD is the exact case the retry was written for,
  // and re-reading disk only to discard the fresh value made attempt 2
  // byte-identical to attempt 1 (ship-check finding). Deferring to the
  // operator is right until their value has been PROVEN wrong by a rejection.
  if (base.CMUX_SOCKET_PASSWORD && !force) return { ...base };
  if (typeof password !== 'string' || password === '') {
    // Under `force` the caller's credential has already been REJECTED, so
    // re-sending it is guaranteed to fail again. With nothing better on disk
    // the only move that can still succeed is to drop it and fall back to
    // cmux-ancestry. Returning `base` here would repeat the rejected
    // credential verbatim — the retry defeated a second way.
    return force ? withoutCmuxPassword(base) : { ...base };
  }
  return { ...base, CMUX_SOCKET_PASSWORD: password };
}

/**
 * Return an env object with no CMUX_SOCKET_PASSWORD at all.
 *
 * Used for the single auth-denied retry: if the password we injected is
 * stale, retrying WITHOUT it lets an in-cmux caller back in via ancestry
 * instead of failing on a credential it never needed.
 */
function withoutCmuxPassword(baseEnv) {
  const copy = { ...(baseEnv && typeof baseEnv === 'object' ? baseEnv : {}) };
  delete copy.CMUX_SOCKET_PASSWORD;
  return copy;
}

// ── memoized disk read (the only I/O in this module) ───────────────────────
// run() is called per-workspace inside loops (checkLiveness issues two calls
// per workspace, ~44 per tick at 22 workspaces), so the config must not be
// re-read per call. Invalidated only by an explicit refresh, which the
// auth-denied retry path uses to pick up a rotated password.
// Keyed BY PATH: a single shared slot let a read with a custom path (a test,
// or any future multi-config caller) poison the answer for the default path
// process-wide.
const passwordCache = new Map();
// Paths already reported as unreadable, so the warning is emitted once.
const readErrorLogged = new Set();

function readSocketPasswordFromDisk({
  refresh = false, configPath = CMUX_CONFIG_PATH, logFn = console.error,
} = {}) {
  if (!refresh && passwordCache.has(configPath)) return passwordCache.get(configPath);
  let text = '';
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    // A missing config is ordinary — cmux may not be installed. A config that
    // exists but cannot be READ (EACCES/EPERM) is a different animal and must
    // not be reported as "no password configured": that is indistinguishable
    // from the outage's own cause class, which is how this stayed invisible.
    // Once per path, not once per read. Every auth rejection re-reads with
    // refresh:true (bypassing the cache), and a tick makes dozens of cmux
    // calls — without this guard a persistently unreadable config would emit
    // dozens of identical lines every five minutes.
    if (e && e.code !== 'ENOENT' && !readErrorLogged.has(configPath)) {
      readErrorLogged.add(configPath);
      logFn(`[cmux] could not read ${configPath} (${e.code || e.message}) — proceeding with no socket credential.`);
    }
    text = '';
  }
  const pw = extractSocketPassword(text);
  passwordCache.set(configPath, pw);
  return pw;
}

// Test-only: drop the memo so a fixture-driven test isn't order-dependent.
function _resetPasswordCache() { passwordCache.clear(); readErrorLogged.clear(); }

/** Convenience: the env a cmux subprocess should inherit. */
function cmuxSpawnEnv(baseEnv = process.env, opts = {}) {
  const { force = false, ...readOpts } = opts;
  return buildCmuxEnv(baseEnv, readSocketPasswordFromDisk(readOpts), { force });
}

/**
 * Decide whether a tick's worth of cmux failures deserves to page the owner.
 *
 * Deliberately NOT a consecutive-failure streak. A streak counter is the
 * natural instinct here, but it is wrong for two reasons:
 *
 *   - The report file it would read only ever records FAILURES (there is no
 *     per-tick success row), so a trailing-failure count is monotonic — it
 *     never resets and stops meaning anything.
 *   - More importantly, an auth rejection is not a flaky condition that
 *     earns credibility by repeating. The config is wrong right now and will
 *     stay wrong until someone changes it, so waiting N ticks only buys
 *     silence during the outage. BRO-2959 burned ~2h precisely because the
 *     failure looked transient.
 *
 * So: auth-denied escalates on the FIRST occurrence; everything else stays
 * quiet and is left to the existing degraded-mode paths, which handle a
 * merely-absent cmux correctly.
 *
 * @param {Array<Error|string>} failures the tick's cmux failures.
 * @returns {{escalate: boolean, authDenied: number, counts: Record<string,number>}}
 */
function summarizeCmuxFailures(failures) {
  const counts = {};
  for (const f of Array.isArray(failures) ? failures : []) {
    const kind = classifyCmuxError(f);
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const authDenied = counts['auth-denied'] || 0;
  // 'unknown' escalates too, and that is the whole point of including it:
  // classifyCmuxError recognises auth rejections by their English PROSE, so
  // the day cmux rewords "Access denied" to something else, every rejection
  // silently becomes 'unknown' — it would not retry and would not page, and
  // the fleet would lose its self-heal exactly as it did on 2026-09-07 with
  // nobody told (ship-check finding). Treating an unclassifiable cmux failure
  // as page-worthy makes the taxonomy fail LOUD instead of silent.
  //
  // Safe against noise by measurement, not hope: over all 2600 cmux sweep
  // failures recorded in reconcile-report.jsonl, exactly ONE classified as
  // 'unknown' (0.04%) — the rest are unavailable/timeout, which stay quiet.
  const unknown = counts.unknown || 0;
  return { escalate: authDenied > 0 || unknown > 0, authDenied, unknown, counts };
}

module.exports = {
  CMUX_CONFIG_PATH,
  summarizeCmuxFailures,
  extractSocketPassword,
  classifyCmuxError,
  buildCmuxEnv,
  withoutCmuxPassword,
  readSocketPasswordFromDisk,
  cmuxSpawnEnv,
  _resetPasswordCache,
};
