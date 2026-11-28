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
const { rootCauseIssueNumber, replayCase: replayRootCauseCase } = require('./lib/feedback-rootcause-cases.js');

const TRACKED_LEDGER = path.join(__dirname, '..', 'data', 'audit', 'alert-ledger.json');
// owner-alert-router.js DEFAULT_COOLDOWN_HOURS: a condition that has not fired
// once in a full cooldown window is not currently firing.
const QUIET_WINDOW_H = 168;
// The CI ledger is committed several times an hour; no write in two days means
// the router (or this checkout) is stale and "quiet" cannot be trusted.
const LEDGER_MAX_AGE_H = 48;

// BRO-8426: an opening-night check's kind:'alert' remediation routes
// `opening-night-<check>-<showId>` when the check fails, but nothing resolves
// that row when the check later passes: only the router's 168h absence sweep
// does. So a fix that landed a day after the alert read "still firing" for a
// week (BRO-7669: isRevival set on The Ugly One, check green, ledger open).
// For these keys the condition IS the check, so re-run the real check on
// today's data. Only checks whose context is shows / reviewsDoc / review texts
// (no drift state, no score history) and whose conditionKey is exactly
// `opening-night-<name>-<show.id>` are listed. A replay that cannot decide
// (show missing or closed, data unreadable or stale, the show's review texts
// absent) falls back to the ledger. Kill switch: ALERT_REPLAY_DISABLED=1.
// needsReviewTexts: an ok verdict means something only if the show's own
// review-texts dir was read, unless a `settledBy` flag short-circuits the check.
const REPLAYABLE_OPENING_NIGHT_CHECKS = [
  { name: 'revival-unverified', needsReviewTexts: true, settledBy: ['isRevival', 'revivalVerifiedNot'], load: () => require('./lib/opening-night-checks/revival-unverified.check.js') },
  { name: 'placeholder-synopsis', load: () => require('./lib/opening-night-checks/placeholder-synopsis.check.js') },
  { name: 'stale-upcoming-tag', load: () => require('./lib/opening-night-checks/stale-upcoming-tag.check.js') },
  { name: 'assigned-score-schema', load: () => require('./lib/opening-night-checks/assigned-score-schema.check.js') },
  { name: 'review-cards-complete', load: () => require('./lib/opening-night-checks/review-cards-complete.check.js') },
  { name: 'orphan-scoresource', load: () => require('./lib/opening-night-checks/orphan-scoresource.check.js') },
  { name: 'wrong-production-bww', load: () => require('./lib/opening-night-checks/wrong-production-bww.check.js') },
];

function replayTarget(key) {
  for (const c of REPLAYABLE_OPENING_NIGHT_CHECKS) {
    const prefix = `opening-night-${c.name}-`;
    if (key.startsWith(prefix) && key.length > prefix.length) return { ...c, showId: key.slice(prefix.length) };
  }
  return null;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// Same grouping opening-night-checklist.js loadReviewsDoc applies: the checks
// read context.reviewsDoc[show.id] (opening-night-checks/types.js), never the
// flat reviews.json document (ship-check P0: the raw doc read "No reviews yet").
function groupReviewsByShow(reviews) {
  const doc = {};
  for (const r of reviews) {
    if (!r || !r.showId) continue;
    (doc[r.showId] = doc[r.showId] || []).push(r);
  }
  return doc;
}

/**
 * Re-run the opening-night check that owns `key` against current data.
 * Paths come from ALERT_REPLAY_* env overrides (tests) or the repo defaults.
 * @returns {null | { code: 0|1, message: string }} null = cannot decide here
 */
function replayOpeningNightCheck(key, env = process.env) {
  if (env.ALERT_REPLAY_DISABLED === '1') return null;
  const target = replayTarget(key);
  if (!target) return null;
  const dataDir = path.join(__dirname, '..', 'data');
  const showsPath = env.ALERT_REPLAY_SHOWS_PATH || path.join(dataDir, 'shows.json');
  let shows;
  let reviewsDoc;
  try {
    // Old core data proves nothing about today (same bound as the ledger).
    if ((Date.now() - fs.statSync(showsPath).mtimeMs) / 36e5 > LEDGER_MAX_AGE_H) return null;
    const doc = readJson(showsPath);
    shows = Array.isArray(doc) ? doc : doc.shows;
    const reviews = readJson(env.ALERT_REPLAY_REVIEWS_PATH || path.join(dataDir, 'reviews.json'));
    const flat = Array.isArray(reviews) ? reviews : reviews && reviews.reviews;
    if (!Array.isArray(flat) || flat.length === 0) return null;
    reviewsDoc = groupReviewsByShow(flat);
  } catch {
    return null;
  }
  if (!Array.isArray(shows)) return null;
  const show = shows.find(s => s && s.id === target.showId);
  // A closed show is skipped by some checks: "ok" there is not "fixed".
  if (!show || show.status === 'closed') return null;
  let reviewTextsRoot = env.ALERT_REPLAY_REVIEW_TEXTS_DIR || null;
  if (!reviewTextsRoot) {
    try { reviewTextsRoot = require('./lib/review-texts-dir').resolveReviewTextsDir(); } catch { reviewTextsRoot = null; }
  }
  // A check that reads review texts passes vacuously when this show's texts
  // are absent (empty or partial corpus), unless a settling flag decides it.
  const settled = (target.settledBy || []).some(f => show[f] === true);
  if (target.needsReviewTexts && !settled) {
    let present = false;
    // existsSync, not statSync().isDirectory(): false (not a throw) on a dangling symlink.
    try { present = !!reviewTextsRoot && fs.existsSync(path.join(reviewTextsRoot, show.id)); } catch { present = false; }
    if (!present) return null;
  }
  let result;
  try {
    const mod = target.load();
    result = mod.run(show, { shows, reviewsDoc, reviewTextsRoot, now: new Date() });
  } catch {
    return null;
  }
  if (!result || typeof result.then === 'function' || typeof result.ok !== 'boolean') return null;
  const emitted = result.details && result.details.remediation && result.details.remediation.conditionKey;
  if (!result.ok && (!emitted || emitted === key)) {
    return { code: 1, message: `FAIL: "${key}" still firing — re-ran the ${target.name} check on ${show.id}: ${result.message}` };
  }
  return { code: 0, message: `PASS: "${key}" not firing — re-ran the ${target.name} check on ${show.id} against current data: ${result.message} (the alert-ledger row, if still open, closes on the router's quiet sweep)` };
}

// owner-alert-router.js decorates a condition's digest line title when it
// resurfaces or escalates, and send-morning-digest.js used to build the
// `digest-needs-you:<title>` dispatch key from that decorated title (BRO-7685).
// `stem` is the decoration's fixed lead-in, for keys clamped mid-decoration.
const DIGEST_TITLE_DECORATIONS = [
  { re: /\s*\(still open [—–-]+ [A-Z]+-\d+\)\s*$/, stem: ' (still open — ' },
  { re: /\s+[—–-]+\s+still happening after \d+ days?\s*$/, stem: ' — still happening after ' },
  { re: /\s+[—–-]+\s+escalated after \d+ notifications?\s*$/, stem: ' — escalated after ' },
];
const DIGEST_PREFIX = 'digest-needs-you:';

/** The router's own condition title, with any trailing digest decoration removed. */
function undecoratedDigestTitle(title) {
  let t = String(title == null ? '' : title);
  for (const { re } of DIGEST_TITLE_DECORATIONS) t = t.replace(re, '');
  return t.trim();
}

/**
 * Does a (possibly clamped by rowMatchKey) `digest-needs-you:` key name the
 * ledger row titled `title`? Matches the plain title, the title plus a whole
 * decoration, and, when the key was clamped, the title plus a cut-off one.
 */
function digestKeyMatchesTitle(key, title) {
  if (typeof title !== 'string' || !title.trim()) return false;
  const target = rowMatchKey(key);
  if (!target.startsWith(DIGEST_PREFIX)) return false;
  const base = rowMatchKey(DIGEST_PREFIX + title.trim());
  if (target === base) return true;
  if (rowMatchKey(DIGEST_PREFIX + undecoratedDigestTitle(target.slice(DIGEST_PREFIX.length))) === base) return true;
  // Clamped key (it cannot grow by more than the few spaces the clamp trimmed):
  // the cut may land inside a decoration.
  const clamped = rowMatchKey(target + 'x'.repeat(16)).length - target.length < 4;
  if (!clamped || !target.startsWith(base)) return false;
  const rest = target.slice(base.length);
  return DIGEST_TITLE_DECORATIONS.some(({ stem }) => stem.startsWith(rest) || rest.startsWith(stem));
}

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
    // BRO-6435: 17 ledger rows are 'resolved' with no resolvedAt (older writers). The row stopped
    // changing at lastSeen, so a resolved row never seen after that is absent; one with neither
    // timestamp still cannot be judged.
    const stamp = Number.isFinite(ts(entry.resolvedAt)) ? entry.resolvedAt : entry.lastSeen;
    const resolvedAt = ts(stamp);
    if (!Number.isFinite(resolvedAt)) return { verdict: 'unknown', why: 'resolved without a parseable resolvedAt or lastSeen' };
    if (Number.isFinite(lastSeen) && lastSeen > resolvedAt) return { verdict: 'unknown', why: 'seen after it was resolved' };
    return { verdict: 'absent', why: `resolved ${stamp}${entry.resolvedAt ? '' : ' (no resolvedAt; lastSeen used)'}${entry.resolveReason ? ` (${entry.resolveReason})` : ''}` };
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

function newestActivity(ledgers) {
  return Math.max(0, ...ledgers.flatMap(l => Object.values(l.conditions).map(activityOf)));
}

function ledgerIsStale(ledgers, nowMs) {
  const newest = newestActivity(ledgers);
  return !newest || (nowMs - newest) / 36e5 > LEDGER_MAX_AGE_H;
}

/**
 * Ledger rows `key` answers to: Map<ledgerKey, {entry, path}>, the most
 * recently active entry per ledger key across ledgers.
 * "Dispatch a fix" links from the morning digest carry a synthetic
 * `digest-needs-you:<title>` key that no router ever writes to the ledger, so
 * the check could never pass for them (BRO-6208). Such a key also matches
 * every ledger row whose title is that digest line's title, with or without
 * the router's resurface/escalation decoration (BRO-7685).
 */
function matchingRows(ledgers, key) {
  const target = rowMatchKey(key);
  const isDigestKey = key.startsWith(DIGEST_PREFIX);
  const byKey = new Map();
  for (const l of ledgers) {
    for (const [k, entry] of Object.entries(l.conditions)) {
      const titleHit = isDigestKey && entry && digestKeyMatchesTitle(key, entry.title);
      if (rowMatchKey(k) !== target && !titleHit) continue;
      const prev = byKey.get(k);
      if (!prev || activityOf(entry) > activityOf(prev.entry)) byKey.set(k, { entry, path: l.path });
    }
  }
  return byKey;
}

function defaultQuietHoursFor(key) {
  return require('./lib/owner-alert-router.js').absenceQuietHoursFor(key);
}

/**
 * BRO-8426: the earliest moment this check can pass for `key`, so a
 * RECHECK-AFTER stamp is not set before it (BRO-7437 and BRO-7669 were
 * stamped days before their checks could go green). A lower bound: an open
 * row also needs the router's absence sweep to run (and any linked tracker to
 * be Done) before it reads resolved.
 * @returns {null | { atMs: number|null, never?: true, why: string }}
 *   null = no future window known (passes on today's data, or cannot tell).
 */
function earliestPass(ledgers, key, nowMs = Date.now(), { replay = replayOpeningNightCheck, quietHoursFor = defaultQuietHoursFor } = {}) {
  if (rootCauseIssueNumber(key) != null) return null;
  // A replay that decides answers on today's data: no window to wait out.
  if (replay && replay(key)) return null;
  if (ledgerIsStale(ledgers, nowMs)) return null;
  let latest = null;
  for (const [k, { entry }] of matchingRows(ledgers, key)) {
    if (!entry || entry.status !== 'open') continue;
    const lastSeen = ts(entry.lastSeen);
    if (!Number.isFinite(lastSeen)) continue;
    const quietHours = quietHoursFor(k);
    if (quietHours == null) {
      return { atMs: null, never: true, why: `"${k}" is open and the router never resolves it on quiet alone: it needs an explicit resolve, so waiting cannot make this check pass` };
    }
    const atMs = lastSeen + quietHours * 36e5;
    if (!latest || atMs > latest.atMs) latest = { atMs, why: `"${k}" last fired ${entry.lastSeen}; the router resolves it no earlier than ${quietHours}h after that` };
  }
  return latest && latest.atMs > nowMs ? latest : null;
}

/** earliestPass for this script's own argv (scripts/lib/recheck-earliest-pass.js). */
function earliestPassForArgv(argv, nowMs = Date.now()) {
  const key = keyFromArgs(argv);
  if (!key) return null;
  let ledgers;
  try { ledgers = loadLedgers(ledgerPaths()); } catch { return null; }
  return earliestPass(ledgers, key, nowMs);
}

function keyFromArgs(args) {
  let key = null;
  const b64At = args.indexOf('--key-b64');
  const keyAt = args.indexOf('--key');
  if (b64At !== -1 && args[b64At + 1]) {
    const tok = args[b64At + 1];
    if (/^[A-Za-z0-9_-]+$/.test(tok)) key = Buffer.from(tok, 'base64url').toString('utf8');
  } else if (keyAt !== -1 && args[keyAt + 1]) {
    key = args[keyAt + 1];
  }
  if (!key || !key.trim() || key.includes('�')) return null;
  return key.trim();
}

/**
 * Pure decision over already-loaded ledgers. Exported for tests.
 * @returns {{ code: 0|1|3, message: string }}
 */
function decide(ledgers, key, nowMs = Date.now(), { replay = replayOpeningNightCheck } = {}) {
  // BRO-7919: the proposal email's root-cause button keys its card
  // `reader-feedback-rootcause-<issue>`, which no router writes to the ledger.
  // Its condition is "the intake router still leaves that ask open": replay the
  // ask's recorded case through the real router instead (no case: CANNOT TELL).
  const rootCauseIssue = rootCauseIssueNumber(key);
  if (rootCauseIssue != null) return replayRootCauseCase(rootCauseIssue);
  // BRO-8426: an opening-night check's own key is answered by the check itself.
  const replayed = replay ? replay(key) : null;
  if (replayed) return replayed;
  if (ledgerIsStale(ledgers, nowMs)) {
    const newest = newestActivity(ledgers);
    const newestAgeH = (nowMs - newest) / 36e5;
    return { code: 3, message: `CANNOT TELL: newest alert-ledger write is ${newest ? newestAgeH.toFixed(1) + 'h' : 'missing'} old (> ${LEDGER_MAX_AGE_H}h) — the ledger is stale, so a quiet condition proves nothing` };
  }
  const byKey = matchingRows(ledgers, key);
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
  const key = keyFromArgs(args);
  if (!key) {
    console.error('[check-alert-condition-absent] no valid conditionKey given (use --key or --key-b64)');
    return 2;
  }
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
module.exports = { main, decide, earliestPass, earliestPassForArgv, matchingRows, classifyEntry, replayOpeningNightCheck, replayTarget, REPLAYABLE_OPENING_NIGHT_CHECKS, undecoratedDigestTitle, digestKeyMatchesTitle, QUIET_WINDOW_H, LEDGER_MAX_AGE_H };
