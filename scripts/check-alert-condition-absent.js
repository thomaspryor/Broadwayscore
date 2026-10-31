#!/usr/bin/env node
/**
 * check-alert-condition-absent.js — machine-checkable acceptance criteria for
 * owner-alert-router cards whose condition has no more specific command
 * (BRO-3889).
 *
 * owner-alert-router.js's buildCardNotes used to give every non-health-check
 * condition (gap:, cron-health-chronic:, backstop:, land:, ... ~63% of the
 * conditions it files) a prose-only acceptance line, which evaluateVerifiability
 * (scripts/lib/verify-gate.js) does not arm, so linear-next.js refused every
 * such card. The router's own alert ledger already records whether a condition
 * is still firing; this reads it.
 *
 * Verdict, per ledger entry (routeAlert updates lastSeen on EVERY fire,
 * including silent refires inside the cooldown; resolveCondition sets
 * status:'resolved' + resolvedAt):
 *   resolved, and not seen again since resolvedAt  -> not firing (exit 0)
 *   open, lastSeen within QUIET_WINDOW_H            -> firing     (exit 1)
 *   open, lastSeen older than QUIET_WINDOW_H        -> cannot tell (exit 3)
 *     (many families never call resolveCondition and one-shot detectors just stop
 *     looking, so quiet is not evidence of a fix)
 *   anything unparseable                            -> cannot tell (exit 3)
 *
 * Never a vacuous pass: a key that is in no ledger, an unreadable ledger, or a
 * ledger with no write in LEDGER_MAX_AGE_H (the router is not running, so
 * "quiet" means nothing) all exit 3.
 *
 * Deliberately READ-ONLY: it never calls into owner-alert-router.js (whose
 * loadLedger/persist paths write), it only JSON.parses the files.
 *
 * Ledger read: ALERT_LEDGER_PATH when set (the router's own override; tests point
 * it at a fixture), otherwise the git-tracked CI ledger data/audit/alert-ledger.json.
 *
 * The key travels as base64url (--key-b64) for the same reason as
 * check-health-row-absent.js: the check runner splits on whitespace with no
 * quote parsing and SAFE_CHECK_FORMS accepts a single [A-Za-z0-9_-] token. The
 * encoder (alertAbsentCheckCmd in scripts/lib/health-row-check-cmd.js) clamps
 * via rowMatchKey; this side applies rowMatchKey to every ledger key too.
 *
 * Exit codes: 0 not firing · 1 firing · 2 usage/decode error · 3 cannot tell
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { rowMatchKey } = require('./lib/health-row-check-cmd.js');

const TRACKED_LEDGER = path.join(__dirname, '..', 'data', 'audit', 'alert-ledger.json');
// owner-alert-router.js DEFAULT_COOLDOWN_HOURS: a condition that has not fired
// once in a full cooldown window is not currently firing.
const QUIET_WINDOW_H = 168;
// The CI ledger is committed several times an hour; no write in two days means
// the router (or this checkout) is stale and "quiet" cannot be trusted.
const LEDGER_MAX_AGE_H = 48;

function ts(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : NaN;
}

function activityOf(entry) {
  return Math.max(ts(entry && entry.lastSeen) || 0, ts(entry && entry.resolvedAt) || 0);
}

function ledgerPaths() {
  if (process.env.ALERT_LEDGER_PATH) return [process.env.ALERT_LEDGER_PATH];
  // Tracked CI ledger only: the verify runner replaces $HOME with a throwaway dir
  // (autonomous-checks.js checksEnv), so a machine-local ledger is never visible
  // there and reading it only in some runs would make the verdict depend on the caller.
  return [TRACKED_LEDGER];
}

/** Loads every ledger that exists. Throws only if NONE is readable. */
function loadLedgers(paths) {
  const out = [];
  const errors = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) { errors.push(`${p}: missing`); continue; }
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!parsed || typeof parsed.conditions !== 'object' || parsed.conditions === null) {
        errors.push(`${p}: no conditions object`);
        continue;
      }
      out.push({ path: p, conditions: parsed.conditions });
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  if (!out.length) throw new Error(errors.join('; ') || 'no ledger paths');
  return out;
}

/** 'firing' | 'absent' | 'unknown' for one ledger entry. */
function classifyEntry(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return { verdict: 'unknown', why: 'entry is not an object' };
  const lastSeen = ts(entry.lastSeen);
  if (entry.status === 'resolved') {
    const resolvedAt = ts(entry.resolvedAt);
    if (!Number.isFinite(resolvedAt)) return { verdict: 'unknown', why: 'resolved without a parseable resolvedAt' };
    if (Number.isFinite(lastSeen) && lastSeen > resolvedAt) return { verdict: 'unknown', why: 'seen after it was resolved' };
    return { verdict: 'absent', why: `resolved ${entry.resolvedAt}${entry.resolveReason ? ` (${entry.resolveReason})` : ''}` };
  }
  if (entry.status === 'open') {
    if (!Number.isFinite(lastSeen)) return { verdict: 'unknown', why: 'open without a parseable lastSeen' };
    const ageH = (nowMs - lastSeen) / 36e5;
    if (ageH <= QUIET_WINDOW_H) return { verdict: 'firing', why: `open, last fired ${entry.lastSeen} (${ageH.toFixed(1)}h ago, within ${QUIET_WINDOW_H}h)` };
    // Quiet is NOT proof of a fix: one-shot/windowed detectors simply stop looking
    // (review of BRO-3889), so only an explicit resolve counts as absent.
    return { verdict: 'unknown', why: `open but quiet: last fired ${entry.lastSeen} (${ageH.toFixed(1)}h ago, > ${QUIET_WINDOW_H}h); the condition was never resolved, so quiet proves nothing` };
  }
  return { verdict: 'unknown', why: `unrecognised status ${JSON.stringify(entry.status)}` };
}

/**
 * Pure decision over already-loaded ledgers. Exported for tests.
 * @returns {{ code: 0|1|3, message: string }}
 */
function decide(ledgers, key, nowMs = Date.now()) {
  const newest = Math.max(0, ...ledgers.flatMap(l => Object.values(l.conditions).map(activityOf)));
  const newestAgeH = (nowMs - newest) / 36e5;
  if (!newest || newestAgeH > LEDGER_MAX_AGE_H) {
    return { code: 3, message: `CANNOT TELL: newest alert-ledger write is ${newest ? newestAgeH.toFixed(1) + 'h' : 'missing'} old (> ${LEDGER_MAX_AGE_H}h) — the ledger is stale, so a quiet condition proves nothing` };
  }
  const target = rowMatchKey(key);
  // Per ledger key, the most recently active entry across ledgers wins.
  // "Dispatch a fix" links from the morning digest carry a synthetic
  // `digest-needs-you:<title>` key that no router ever writes to the ledger, so
  // the check could never pass for them (BRO-6208). Such a key also matches
  // every ledger row whose title is that digest line's title.
  const DIGEST_PREFIX = 'digest-needs-you:';
  const digestTitle = key.startsWith(DIGEST_PREFIX) ? rowMatchKey(key.slice(DIGEST_PREFIX.length)) : null;
  const byKey = new Map();
  for (const l of ledgers) {
    for (const [k, entry] of Object.entries(l.conditions)) {
      const titleHit = digestTitle && entry && typeof entry.title === 'string' && rowMatchKey(entry.title) === digestTitle;
      if (rowMatchKey(k) !== target && !titleHit) continue;
      const prev = byKey.get(k);
      if (!prev || activityOf(entry) > activityOf(prev.entry)) byKey.set(k, { entry, path: l.path });
    }
  }
  if (!byKey.size) {
    return { code: 3, message: `CANNOT TELL: "${key}" is in no alert ledger (${ledgers.map(l => l.path).join(', ')}) — never a vacuous pass` };
  }
  const results = [...byKey.entries()].map(([k, { entry }]) => ({ k, ...classifyEntry(entry, nowMs) }));
  const firing = results.find(r => r.verdict === 'firing');
  if (firing) return { code: 1, message: `FAIL: "${firing.k}" still firing — ${firing.why}` };
  const unknown = results.find(r => r.verdict === 'unknown');
  if (unknown) return { code: 3, message: `CANNOT TELL: "${unknown.k}" — ${unknown.why}` };
  return { code: 0, message: `PASS: ${results.map(r => `"${r.k}" ${r.why}`).join('; ')}` };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/check-alert-condition-absent.js (--key "<conditionKey>" | --key-b64 <base64url>)');
    console.log('Exit 0 not firing, 1 firing, 2 usage, 3 cannot tell (read-only; reads the alert ledger).');
    return 2;
  }
  let key = null;
  const b64At = args.indexOf('--key-b64');
  const keyAt = args.indexOf('--key');
  if (b64At !== -1 && args[b64At + 1]) {
    const tok = args[b64At + 1];
    if (/^[A-Za-z0-9_-]+$/.test(tok)) key = Buffer.from(tok, 'base64url').toString('utf8');
  } else if (keyAt !== -1 && args[keyAt + 1]) {
    key = args[keyAt + 1];
  }
  if (!key || !key.trim() || key.includes('�')) {
    console.error('[check-alert-condition-absent] no valid conditionKey given (use --key or --key-b64)');
    return 2;
  }
  key = key.trim();
  let ledgers;
  try {
    ledgers = loadLedgers(ledgerPaths());
  } catch (err) {
    console.error(`[check-alert-condition-absent] CANNOT TELL: alert ledger unreadable — ${err.message}`);
    return 3;
  }
  const { code, message } = decide(ledgers, key);
  (code === 0 ? console.log : console.error)(`[check-alert-condition-absent] ${message}`);
  return code;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (err) {
    console.error(`[check-alert-condition-absent] crashed: ${err.stack || err.message}`);
    process.exit(3);
  }
}
module.exports = { main, decide, classifyEntry, QUIET_WINDOW_H, LEDGER_MAX_AGE_H };
