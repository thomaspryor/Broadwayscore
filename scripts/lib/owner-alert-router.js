/**
 * Owner Alert Router — single funnel for owner-facing automated alerts.
 *
 * audit-secret-scan-always-trace: required by 48+ scripts (well over
 * workflow-secret-scan.js's SHARED_MODULE_THRESHOLD), which normally means
 * "shared infra, don't trace its deps" — correct for an optional-provider
 * fallback chain, wrong here: dispatchCard()/sendAlert() below reach
 * linear-client.js's and discord-notify.js's hard, no-fallback secret reads
 * (LINEAR_API_KEY, RESEND_API_KEY, OWNER_EMAIL) for every one of those 48
 * callers. Without this marker on the gateway itself, the BFS in
 * collectTransitiveSource() never even reaches those files to check THEIR
 * own markers — this is how audit-imageless-scored-shows.yml shipped
 * without LINEAR_API_KEY for a week (2026-08-31 incident) even though the
 * audit correctly flagged that same step's other missing secrets.
 *
 * Problem this solves: 34 independent code paths email thomas.pryor@gmail.com
 * directly, most ending in a paste-into-Claude-Code prompt, and re-alert the
 * same known condition every run because nothing remembers what was already
 * reported. See ~/Documents/claude-outputs/email-consolidation-plan-2026-07-21.md.
 *
 * Every owner-facing alert should call routeAlert() instead of emailing (or
 * creating an ad-hoc GitHub issue / paste-prompt) directly. Each call declares
 * a stable `conditionKey` and a `disposition`:
 *   - 'auto':   files a Notion Action Queue card (Action property set) so
 *               notion-action-poll.js (the launchd action-dispatcher) picks it
 *               up and works it hands-free. Use for machine-fixable /
 *               machine-investigable conditions — no owner judgment required.
 *   - 'digest': queues a line for the next Daily Digest "Automation" section
 *               instead of sending its own email.
 *   - 'human':  sends an immediate email via the existing sendAlert() path —
 *               BUT only if conditionKey is on the page-worthy allowlist in
 *               ./page-worthy-alerts.js (owner mandate 2026-07-28, card
 *               #611: "NO sender emails me directly anymore" except a tiny
 *               explicit list). Any other conditionKey requesting 'human' is
 *               transparently downgraded to 'digest' — the caller still gets
 *               back the disposition it asked for having been honored in
 *               spirit (the owner IS told), just not by immediate email.
 *
 * Ledger keys on conditionKey: a condition
 * notifies ONCE per open incident. Re-fires while the incident is still open
 * are silent (only lastSeen/notifyCount move) until either `cooldownHours`
 * elapses (default 7 days — matches the plan's "known-accepted condition"
 * snooze) or resolveCondition(conditionKey) is called, which the caller
 * should do the moment its own check goes back to green. A resolved
 * condition that reoccurs is treated as a NEW incident and notifies again
 * immediately, regardless of cooldown.
 *
 * Where the ledger lives depends on WHO is running (card #693). In CI the
 * ledger is the git-tracked data/audit/alert-ledger.json, committed by the
 * same job (enforced by alert-ledger-commit-check.js). Locally — launchd
 * senders (opening-night-monitor-launch.js, autonomous-run.js), interactive
 * sessions, anything not on a runner — it is a machine-local file OUTSIDE
 * every git checkout (~/.broadwayscore-state/alert-ledger.json). A local
 * writer's uncommitted edit to a tracked file does not survive: any parallel
 * session's `git checkout` / `git reset --hard` / rebase in the shared
 * ~/Broadwayscore working tree wipes it, so the cooldown state a local sender
 * just wrote is gone by its next tick and every re-fire looks brand new. That
 * is exactly how the same "monitor pass FAILED for tao-of-glass" email went
 * out twice 21 minutes apart through a cooldownHours: 3 window on 2026-07-31,
 * with the ledger showing no record of either send. It also keeps launchd
 * senders from dirtying data/audit/ on every tick (task #732: a dirty
 * data/audit/ defeats the ff-only pull that keeps scheduled jobs on fresh
 * code). Override explicitly with ALERT_LEDGER_PATH when a caller needs its
 * own ledger (tests do).
 *
 * Known limitation (accepted for Sprint 1): the ledger is a plain JSON file,
 * not a distributed lock. Two CI runs that both call routeAlert()
 * for the SAME conditionKey from a fresh checkout at nearly the same moment
 * can both read "no open incident" and both dispatch — the loser's commit
 * then gets overwritten by push-with-retry.sh's last-writer-wins conflict
 * resolution on data/audit/*.json, so that condition looks "new" again next
 * run too. Outcome is a duplicate card/email, not a crash or lost alert —
 * acceptable for a single-owner project; harden with a real lock (e.g. the
 * pattern in scripts/lib/send-lock.js) if duplicates become a real problem.
 *
 * BRO-3030 (digest escalation, added after Sprint 1): a 'digest' condition
 * that re-notifies past ESCALATION_NOTIFY_THRESHOLD with no tracker attached
 * is promoted to 'auto' for that one call (see decideDigestEscalation()),
 * which means it inherits the exact same known-limitation race above — just
 * on a wider set of conditionKeys than only ever hit the 'auto' path before.
 * Same accepted tradeoff, wider surface; not a new risk class.
 */

const fs = require('fs');
const { rowAbsentCheckCmd, healthRowNameFromConditionKey, sanitizeRowText } = require('./health-row-check-cmd.js');
const os = require('os');
const path = require('path');
const { sendAlert } = require('./discord-notify');
const { isPageWorthy } = require('./page-worthy-alerts');
// BRO-375 (Phase 1): dispatchCard() below calls this in-process instead of
// shelling out to the linear-brain.js CLI — see linear-issue-create.js's
// header for why this is the natural repoint target.
const { createLinearIssue, isUsageLimitExceeded } = require('./linear-issue-create');
// BRO-4054: provenance marker for cards filed for dispatch-at-filing (no
// PARKED sentinel) — shared with the Mac-side red-first pass that selects them.
const { DISPATCH_AT_FILING_MARKER } = require('./linear-drain-parked');
// Cross-system dedupe (Phase 0 rail 2, plan 2026-08-12, task #1341) — see
// findLinearDuplicate() below. Every Linear GraphQL call stays inside
// linear-client.js (audit-linear-issuecreate-chokepoint.js convention).
const linearClient = require('./linear-client');

const REPO_ROOT = path.join(__dirname, '..', '..');
// Git-tracked ledger — CI only. Every job that routes an alert stages and
// commits this file in the SAME job (lint: alert-ledger-commit-check.js).
const TRACKED_LEDGER_PATH = path.join(REPO_ROOT, 'data', 'audit', 'alert-ledger.json');
// Machine-local ledger — everything not on a runner. Deliberately outside any
// git checkout (NOT data/… under the repo, and not a worktree-relative path):
// it must survive concurrent git operations in the shared working tree, and a
// launchd sender and an interactive session in a worktree must share ONE
// cooldown record rather than one per checkout. See the header comment.
const LOCAL_LEDGER_PATH = path.join(os.homedir(), '.broadwayscore-state', 'alert-ledger.json');

// Resolved once at require time (tests re-require with a fresh module cache
// after setting ALERT_LEDGER_PATH). GITHUB_ACTIONS/CI are set by every GitHub
// Actions runner and by nothing on this Mac.
function isCIExecution() {
  return !!(process.env.GITHUB_ACTIONS || process.env.CI);
}
const LEDGER_PATH = process.env.ALERT_LEDGER_PATH
  || (isCIExecution() ? TRACKED_LEDGER_PATH : LOCAL_LEDGER_PATH);
// Overridable like ALERT_LEDGER_PATH above (tests / ad-hoc verification runs
// need to point this somewhere disposable too) — added after BRO-1699's
// verification run wrote two throwaway rows into the REAL tracked file
// because, unlike the ledger, this path had no override and no write-time
// guard. Same incident CLASS as the 2026-08-02 ledger one (saveLedger()'s
// NODE_TEST_CONTEXT guard below), just not yet caught for this file.
const DIGEST_QUEUE_PATH = process.env.ALERT_DIGEST_QUEUE_PATH
  || path.join(REPO_ROOT, 'data', 'audit', 'alert-digest-queue.json');
// Append-only attempt log for disposition='auto' dispatches — logs EVERY
// attempt (success or failure), unlike the ledger above which only ever
// records successes (a failed dispatch is deliberately not written there, so
// the next call retries). health-check.js's deadman check (#374) reads this
// to compare "attempts" vs "successes" over a trailing window — the ledger
// alone can't answer that question, because during the 2026-07-24 npm-ci
// incident every single dispatch failed, so the ledger would have shown ZERO
// activity all week even though the router was attempting (and silently
// failing) auto-dispatch on every run.
// Overridable + guarded like the ledger and digest queue above (BRO-1699
// what-else finding, systematic pass: this is the third tracked file this
// module writes and had the same gap as the digest queue did before this
// pass).
const ATTEMPTS_LOG_PATH = process.env.ALERT_ATTEMPTS_LOG_PATH
  || path.join(REPO_ROOT, 'data', 'audit', 'alert-router-attempts.jsonl');
const ATTEMPTS_LOG_RETENTION_DAYS = 30;

const DISPOSITIONS = ['auto', 'digest', 'human'];
const DEFAULT_COOLDOWN_HOURS = 168; // 7 days

// BRO-3030: a 'digest' condition that has re-notified more than this many
// times with no tracker ever attached gets escalated — see
// decideDigestEscalation() below. 208 conditions were audited fleet-wide,
// 179 open, only 36 carded; 8 had fired on most days for 25-43+ days because
// the 'digest' disposition previously had no escalation path at all (only
// 'auto' ever filed a tracker). Matches the acceptance bar the card was
// filed against: no open condition should sit past notifyCount 14 untracked.
const ESCALATION_NOTIFY_THRESHOLD = 14;

// BRO-3030 pre-mortem P0 — the condition families that may NEVER be quieted.
//
// The escalation above is "notify to threshold, file a tracker, then stop
// repeating and resurface only every resurfaceHours". For most families that
// is exactly right. For anything metering PAID usage it is not: a genuinely
// WORSENING cost metric would fire on day 1, get carded, and then say nothing
// for the next seven days while the money kept going out. The card's own
// plan-review named this before implementation — "Recurring cost alarms must
// keep firing until the metric returns to baseline, not until a card exists.
// Allowlist which condition families may ever be quieted."
//
// This was NOT a hypothetical corner. Measured on the live ledger the day this
// landed, 3 of the 10 open conditions past the notify threshold were cost
// families: provider-spend:overspend (notifyCount 20),
// bd-circuit-breaker-serp_api1 (19), sd-circuit-breaker (18). And they really
// do take this path — scripts/check-provider-spend.js passes
// disposition: 'digest'.
//
// A tracker still gets filed for these (the escalation half is what the card
// is for); they simply keep surfacing in the digest afterwards instead of
// going silent, so the owner sees a worsening number every day rather than
// once. The cost of being wrong here is asymmetric: an extra digest line
// versus an unnoticed overage, so this matches on the FAMILY prefix and errs
// toward keeping things visible.
const NEVER_QUIET_CONDITION_RE = /(^provider-spend:|circuit-breaker|(^|[:-])(spend|cost|billing|quota|credits?|overspend|budget)([:-]|$))/i;

/** Is `conditionKey` a paid-usage family that must never be silenced? */
function isNeverQuietCondition(conditionKey) {
  return NEVER_QUIET_CONDITION_RE.test(String(conditionKey || ''));
}

function readLedgerFile(p) {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.conditions) return parsed;
  } catch { /* missing/corrupt — treat as absent */ }
  return null;
}

function loadLedger() {
  const own = readLedgerFile(LEDGER_PATH);
  if (own) return own;
  // First run after the local ledger was introduced (or after someone deleted
  // it): seed from the committed CI ledger so conditions CI already notified
  // stay inside their cooldown instead of all re-firing at once. Read-only —
  // saveLedger() always writes LEDGER_PATH, never the tracked one.
  if (LEDGER_PATH !== TRACKED_LEDGER_PATH) {
    const tracked = readLedgerFile(TRACKED_LEDGER_PATH);
    if (tracked) return tracked;
  }
  return { conditions: {} };
}

// Shared guard for both tracked-state files this module owns (the ledger and
// the digest queue): tests, and ad-hoc verification runs under node:test,
// must NEVER write the REAL file unless the caller explicitly overrode its
// path. 2026-08-02: the tracked data/audit/alert-ledger.json was found
// carrying this module's own test conditions ('test:unwritable-ledger', a
// fake on-monitor-launch-failed-* with cardId 'fake-card-id'), swept into
// main by an unrelated wholesale data commit — and the same commit rolled
// back the REAL opening-night SLA state, causing a duplicate owner page.
// Extended to the digest queue (BRO-1699 what-else finding): the queue had
// no equivalent guard and no override, so a direct verification run of
// routeAlert()'s digest path wrote two throwaway rows straight into the
// real tracked file — same incident class, just not yet caught here.
// Guarded at write time (not require time) so read-only tests of the
// path-resolution logic still load.
function assertRealFileWriteIsSafeUnderTest(kind, overrideEnvVar) {
  if (process.env.NODE_TEST_CONTEXT && !process.env[overrideEnvVar]) {
    throw new Error(`owner-alert-router: refusing to write a REAL ${kind} under node:test — set ${overrideEnvVar} to a temp file (see loadRouterWithFakes)`);
  }
}

function saveLedger(ledger) {
  assertRealFileWriteIsSafeUnderTest('alert ledger', 'ALERT_LEDGER_PATH');
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  // Atomic write: a kill mid-write must not truncate the ledger and drop
  // every condition's open/silent state (same pattern as notion-action-poll.js).
  const tmp = `${LEDGER_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  fs.renameSync(tmp, LEDGER_PATH);
}

// The ledger is bookkeeping, not the alert itself: by the time it is written
// the card/email has already gone out. A write failure (unwritable HOME under
// a launchd agent, full disk, permissions) must therefore NOT propagate and
// take down the caller's whole check — it degrades to "this condition may
// re-notify next run", which is exactly the pre-fix behaviour. Loud on
// purpose: silent non-persistence is the bug this card exists for.
function persistLedger(ledger) {
  try {
    saveLedger(ledger);
    return true;
  } catch (err) {
    console.error(`[alert-router] FAILED to persist the ledger at ${LEDGER_PATH}: ${err.message} — cooldowns will NOT hold until this is fixed (card #693)`);
    return false;
  }
}

function hoursSince(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60);
}

// BRO-3030 — pure decision for a 'digest'-disposition routeAlert() call: does
// THIS call promote to 'auto' (so it flows through the file/dedupe/persist
// machinery 'auto' already owns, rather than a second hand-rolled copy of it
// living here), stay fully quiet (already tracked, reminder window hasn't
// elapsed), post a short "still open" reminder (already tracked, window
// elapsed — so a condition never vanishes from the digest forever just
// because its filed tracker went stale), or behave exactly as it always has
// (below threshold, not yet tracked)? No fs, no network — pure state in,
// decision out, mirroring guard-escalation.js's shouldEscalate()/
// shouldAutoRecover() shape and CLAUDE.md rule 15 (extract, don't inline,
// so the threshold logic is require()-tested instead of re-derived in a
// test file).
//
// Deliberately keyed on `existing.lastSurfacedAt`, NOT `existing.lastNotifiedAt`
// (ship-check catch): lastNotifiedAt is routeAlert()'s general "this incident
// was processed" clock and gets stamped to `now` on EVERY non-silent call,
// including a 'quiet' one — real digest callers pass short cooldownHours
// (1-24h, see dispatch-drift-watch.js/check-corpus-drift.js/etc.) and call
// routeAlert() roughly that often, so lastNotifiedAt never sits still long
// enough for an hours-since check against it to ever reach resurfaceHours.
// lastSurfacedAt only advances on a call that actually puts something in the
// digest (a promote/resurface notice, or a plain pre-threshold line) — see
// where routeAlert() sets result.lastSurfacedAt below.
function decideDigestEscalation({ conditionKey, existing, notifyCount, now, threshold = ESCALATION_NOTIFY_THRESHOLD, resurfaceHours = DEFAULT_COOLDOWN_HOURS }) {
  const alreadyTracked = !!(existing && existing.linearIdentifier);
  if (!alreadyTracked) {
    return { action: notifyCount > threshold ? 'promote' : 'normal' };
  }
  // BRO-3030 pre-mortem P0: paid-usage families are never silenced. They are
  // still promoted+tracked above (that is the escalation this card exists
  // for), but from then on they keep surfacing every call instead of waiting
  // out resurfaceHours — a worsening overage must not be invisible for a week
  // just because a tracker exists. See NEVER_QUIET_CONDITION_RE.
  if (isNeverQuietCondition(conditionKey)) {
    // NOTE (review catch): this exemption only ever RUNS if the caller's own
    // cooldownHours is short enough for routeAlert() to get this far — the
    // ledger cooldown gate short-circuits to 'silent' before the escalation
    // block. It works today because the cost callers pass short windows
    // (check-provider-spend.js cooldownHours: 20, the breaker checks: 6). If
    // someone raises one of those to the 168h default, this exemption becomes
    // a silent no-op. neverQuietRequiresShortCooldown() below is asserted by
    // the test suite against the real caller files so that change fails CI
    // instead of quietly restoring the 7-day blackout.
    return { action: 'resurface', neverQuiet: true };
  }
  const lastSurfacedAtMs = existing.lastSurfacedAt ? new Date(existing.lastSurfacedAt).getTime() : NaN;
  const hrsSinceSurfaced = Number.isFinite(lastSurfacedAtMs) ? (now - lastSurfacedAtMs) / (1000 * 60 * 60) : Infinity;
  return { action: hrsSinceSurfaced >= resurfaceHours ? 'resurface' : 'quiet' };
}

// A floor on how much context an auto-filed tracker carries. It originated as
// notion-brain.js's rule that a "Not started" card needs >=300 chars of Notes
// (feedback_notion_card_context.md); this router now files LINEAR issues, which
// impose no such rule, so the floor is kept on its own merits rather than
// inherited: an alert that files a two-line issue is an alert nobody can act on
// without re-deriving what tripped it. The template below clears the floor for
// realistic inputs, but a very short description plus a short conditionKey can
// land right on the edge — pad explicitly rather than relying on margin.
const MIN_NOTES_LENGTH = 320;

function buildCardNotes({ description, hint, fields, conditionKey, verify }) {
  const fieldLines = (fields || []).map(f => `- **${f.name}:** ${f.value}`).join('\n');
  const parts = [
    '## Problem',
    description || '(no description provided)',
  ];
  if (fieldLines) parts.push(fieldLines);
  parts.push(`\n## Suggested approach\n${hint || 'Investigate the condition and fix the root cause.'}`);
  // BRO-3881: prose alone here made EVERY card this router files
  // undispatchable. linear-next.js gates each dispatch on
  // evaluateVerifiability() (scripts/lib/verify-gate.js), which needs a
  // backticked safe-form command (or an explicit owner-judgment line) — so a
  // card whose only acceptance criteria was "condition X no longer fires" was
  // refused inside the detached child, AFTER the morning digest had already
  // spent one of its two daily dispatch slots on it. BRO-3349 was picked and
  // refused four days running that way.
  //
  // A health-check-sourced condition has a machine-checkable answer already:
  // the same check-health-row-absent.js command scripts/lib/digest-autofix.js
  // puts on the cards IT files for the very same rows. Emit it here too,
  // from the shared builder, so the two filers cannot drift again.
  const healthRowName = healthRowNameFromConditionKey(conditionKey);
  // BRO-3907: the OTHER family that hit the exact same bug —
  // `test-yml:red:<job>:<sig>` cards (route-main-streak-signatures.js) — has
  // no health-check row to key off, but DOES have a job+step the caller can
  // resolve to a real `run:` command (scripts/lib/red-signature-verify-cmd.js).
  // The caller passes the resolved `{ line, note }` through as `verify`; a
  // `verify.line` is either `VERIFY: <safe-form command>` or the literal
  // `VERIFY: owner-judgment` (both arm evaluateVerifiability() — see
  // OWNER_JUDGMENT_RE) — NEVER run through sanitizeRowText, which rewrites
  // "VERIFY:" to "VERIFY -" and would silently disarm the very line this
  // exists to add. `verify.note` (prose explaining a fallback/refusal) IS
  // sanitized, same as every other free-text field in this body.
  const acceptance = [
    '\n## Acceptance criteria',
    healthRowName
      // The COMMAND encodes the RAW name (the checker compares against raw
      // snapshot names); only the surrounding prose is sanitized — the same
      // split digest-autofix.js makes, for the same reason.
      ? `\`${rowAbsentCheckCmd(healthRowName)}\` passes — i.e. the daily health check no longer lists "${sanitizeRowText(healthRowName)}" among errors or warnings.`
      : (verify && verify.line ? verify.line : null),
    verify && verify.line && verify.note ? sanitizeRowText(verify.note) : null,
    // Sanitized in the PROSE copy only. The machine-readable
    // `[conditionKey:...]` anchor below stays raw — that is what
    // findLinearDuplicate and any future exact-match consumer read, and
    // Linear's own search (which findLinearDuplicate actually calls) matches
    // on the raw term. Prose is where a backtick or a literal VERIFY: would
    // do damage, because this line sits inside the acceptance section that
    // candidatesFrom/extractVerifyCmd scan for the command to run.
    `Condition "${sanitizeRowText(conditionKey)}" no longer fires on the next check. If it recurs, this card (or a fresh one) will re-open automatically — do not close this as "won't fix" without noting why.`,
  ].filter(Boolean).join('\n');
  parts.push(acceptance);
  // Rail 2 (Phase 0 parallel-run safety, plan 2026-08-12): an unambiguous,
  // greppable anchor for the cross-system dedupe (findLinearDuplicate below)
  // — the prose "Condition "<key>"..." line above already contains the raw
  // conditionKey too, so this is belt-and-suspenders for a future consumer
  // that wants an exact marker rather than a prose substring.
  parts.push(`\n[conditionKey:${conditionKey}]`);
  let notes = parts.join('\n');
  if (notes.length < MIN_NOTES_LENGTH) {
    notes += `\n\nFiled automatically by owner-alert-router.js (conditionKey: ${conditionKey}).`;
  }
  return notes;
}

// Appends one attempt record (success or failure) to ATTEMPTS_LOG_PATH and
// prunes entries older than ATTEMPTS_LOG_RETENTION_DAYS. Never throws —
// logging the attempt must not itself become a new silent-failure vector.
function logDispatchAttempt({ conditionKey, title, ok, error }) {
  // Outside the try, like saveLedger/queueDigestLine: under node:test without
  // ALERT_ATTEMPTS_LOG_PATH set, this must throw all the way out to fail the
  // test loudly, not be swallowed by the catch below and merely
  // console.error'd (the refusal itself IS the signal a real file write was
  // about to happen under test).
  assertRealFileWriteIsSafeUnderTest('alert-router attempts log', 'ALERT_ATTEMPTS_LOG_PATH');
  try {
    const cutoff = Date.now() - ATTEMPTS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let lines = [];
    try {
      lines = fs.readFileSync(ATTEMPTS_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    } catch { /* missing — first attempt */ }
    const kept = lines.filter(line => {
      try {
        return new Date(JSON.parse(line).ts).getTime() >= cutoff;
      } catch { return false; }
    });
    kept.push(JSON.stringify({
      ts: new Date().toISOString(),
      conditionKey,
      title,
      ok,
      error: error ? String(error).slice(0, 500) : null,
    }));
    fs.mkdirSync(path.dirname(ATTEMPTS_LOG_PATH), { recursive: true });
    fs.writeFileSync(ATTEMPTS_LOG_PATH, kept.join('\n') + '\n');
  } catch (err) {
    console.error(`[alert-router] failed to write attempt log (non-fatal): ${err.message}`);
  }
}

// Cross-system dedupe (Phase 0 rail 2, plan 2026-08-12, task #1341): before
// dispatchCard() files a NEW Notion card, check whether an OPEN Linear issue
// already tracks this conditionKey — linear-import.js already migrated most
// of the historical backlog (including prior auto-filed alert cards, which
// carry conditionKey verbatim in their body), so filing a second tracker for
// an already-tracked incident is a real cross-system double-file, not a
// theoretical one.
//
// FAILS OPEN, always: a Linear API error (missing LINEAR_API_KEY, network,
// rate limit, schema drift) must never suppress a real alert — any failure
// here is logged and treated as "no match found", so dispatchCard() runs
// exactly as it did before this rail existed. `searchIssuesFn` is an
// injectable seam (tests stub linear-client.js's export) — production always
// resolves to the real linearClient.searchIssues.
async function findLinearDuplicate(conditionKey, { searchIssuesFn = linearClient.searchIssues } = {}) {
  try {
    const match = await searchIssuesFn(conditionKey);
    return { matched: !!match, identifier: match ? match.identifier : null };
  } catch (err) {
    console.error(`[alert-router] Linear dedupe check failed for "${conditionKey}" (failing open — filing as before): ${err.message}`);
    return { matched: false, identifier: null, error: err.message };
  }
}

// Files a LINEAR issue via createLinearIssue() (scripts/lib/linear-issue-
// create.js) — the one creation chokepoint, CI-gated by
// audit-linear-issuecreate-chokepoint.js. BRO-375 (Phase 1) repointed this
// from an execFileSync shell-out to linear-brain.js (subprocess + regex-
// parsed stdout) to an in-process call, which itself creates the issue via
// the injectable client in scripts/lib/linear.js (BRO-374) — the seam that
// lets a routed alert's Linear creation be exercised with a stubbed client
// in owner-alert-router.test.mjs instead of a real network round trip.
// Returns { ok, cardId: null, linearIdentifier } — never throws; a dispatch
// failure degrades to a logged warning rather than crashing the caller's own
// check/pipeline. cardId is kept in the shape (always null on this path) so
// existing consumers reading .cardId see a stable field, and the ledger's
// linearIdentifier field (introduced by rail 2) now also carries the FILED
// tracker, not just deduped ones.
//
// Note on the removed 15s bound (ship-check, BRO-375): the old execFileSync
// call had an explicit `timeout: 15000` around the whole subprocess. This
// in-process call has no equivalent wrapper — getTeam() + createIssue() each
// get their own 429-retry-with-backoff (linear-client.js's graphql(), up to
// DEFAULT_MAX_ATTEMPTS), so a persistent rate limit can now take longer than
// 15s end to end. Accepted deliberately: every other createLinearIssue()
// caller in this repo (linear-brain.js, linear-session.js) already has no
// such cap, and re-adding one here would cut the retry fix short exactly
// when it matters (a real 429 burst). If this ever needs bounding, pass
// timeoutMs/maxAttempts through to linear-client.js's graphql() rather than
// wrapping the whole call in a race — see linear-client.js's graphql() opts.
async function dispatchCard({ title, description, hint, fields, severity, cardAction, priority, category, tags, conditionKey, verify, dispatchAtFiling }) {
  let notes = buildCardNotes({ description, hint, fields, conditionKey, verify });
  // Linear priority ints: 1=Urgent 2=High 3=Medium 4=Low. Alert-filed issues
  // map error-class severities to High, everything else Medium — Urgent is
  // reserved for humans. (`priority`, when a caller passes one, is the OLD
  // Notion string form — ignored deliberately rather than half-translated;
  // severity is the honest signal.)
  const linearPriority = (severity === 'critical' || severity === 'error') ? 2 : 3;
  // task #1310: no default disposition. An alert-filed issue isn't being
  // worked the instant it's created — the Phase-2 drain/auditor picks
  // parked issues up on its next pass — so this is a park, not a dispatch.
  const parkReason = `Auto-filed by owner-alert-router (condition: ${conditionKey}); parked for triage. The Linear-side drain (Phase 2 follow-up, in build) will dispatch machine-verifiable parked issues; until it ships these surface via the digest.`;
  // BRO-4054: a `dispatchAtFiling` caller (route-main-streak-signatures.js's
  // `test-yml:red:<job>:<sig>` cards) wants the card WORKED, not triaged —
  // main is red on every push until someone fixes it. Those cards are filed
  // in dispatch mode (Todo, no `PARKED:` line — the very sentinel
  // headless-dispatchability.js refuses, which is how every red card sat
  // undispatched, BRO-3536) with a provenance line the Mac-side red-first
  // pass (scripts/lib/red-first-dispatch.js, bsc-reconcile's 5-min tick)
  // selects on. The line deliberately does NOT contain linear-drain-parked's
  // AUTO_FILED_MARKER substring, so the 3x/day parked drain never
  // double-selects the same card.
  const dispatchMode = !!dispatchAtFiling;
  if (dispatchMode) {
    notes = `${DISPATCH_AT_FILING_MARKER} (BRO-4054; condition: ${conditionKey}). The Mac-side red-first pass dispatches it headless within ~5 minutes of filing; it needs no owner triage unless the VERIFY line below says owner-judgment.\n\n${notes}`;
  }
  try {
    const { issue } = await createLinearIssue({
      title,
      description: notes,
      priority: linearPriority,
      ...(dispatchMode ? { dispatch: true } : { park: parkReason }),
    });
    logDispatchAttempt({ conditionKey, title, ok: true });
    return { ok: true, cardId: null, linearIdentifier: issue.identifier, dispatchMode };
  } catch (err) {
    // Log the REAL error verbatim — this is the exact spot the npm-ci incident
    // (2026-07-24) got misdiagnosed as a NOTION_API_KEY problem.
    console.error(`[alert-router] issue dispatch failed for "${title}": ${err.message.slice(0, 300)}`);
    logDispatchAttempt({ conditionKey, title, ok: false, error: err.message });
    // A workflow that never wired LINEAR_API_KEY is a CONFIG gap, not a Linear
    // outage, and it is invisible in the run: the router fails open, the email
    // still sends, and only data/audit/alert-router-attempts.jsonl records that
    // no card was filed. That is how audit-imageless-scored-shows.yml dropped
    // every auto-dispatch on 2026-08-31 while its workflow stayed green.
    // Surface it as a run annotation so the gap is visible where it happens.
    // Deliberately an annotation, NOT a throw — fail-open is the router's
    // contract and an alert must never be lost because dispatch broke.
    if (process.env.GITHUB_ACTIONS && /LINEAR_API_KEY/.test(err.message || '')) {
      console.error(
        `::error title=Auto-dispatch disabled::LINEAR_API_KEY is not set in this workflow, so ` +
          `routeAlert(disposition:'auto') could not file a card for "${conditionKey}". The email was ` +
          `still sent, but nothing will be dispatched to fix it. Add ` +
          `LINEAR_API_KEY: \${{ secrets.LINEAR_API_KEY }} to this step's env.`
      );
    }
    // BRO-281: a USAGE_LIMIT_EXCEEDED failure is not an ordinary dispatch
    // failure that can just retry next call — it means the Linear intake
    // front door is jammed for EVERY conditionKey's 'auto' disposition until
    // the workspace is archived or upgraded (BRO-10), not just this one. The
    // Notion-era router degraded this to the same logged-warning path as any
    // other failure, which is exactly how the ceiling went unnoticed on
    // 2026-08-12.
    //
    // This must page (not silently log), but it must page ONCE per incident,
    // not once per failed dispatchCard() call: a failed dispatch is
    // deliberately never written to the ledger (see the "not recorded as
    // notified" comment below dispatchCard's caller), specifically so the
    // NEXT attempt retries instead of going silent — which means an unthrottled
    // page here would fire a fresh critical email for every single 'auto'
    // alert across every conditionKey, every call, for as long as the cap
    // stays hit (a same-day inbox storm, confirmed by both ship-check
    // reviewers on the first version of this fix, which called sendAlert()
    // directly with no cooldown of its own).
    //
    // Fix: route through routeAlert() itself, under ITS OWN fixed
    // conditionKey ('alert-router:usage-limit-exceeded', on the page-worthy
    // allowlist as a meta self-test — see page-worthy-alerts.js) and
    // disposition:'human'. That's a DIFFERENT conditionKey than the one that
    // failed to dispatch, so it gets its own ledger entry and cooldown —
    // one page per incident, silent re-fires for cooldownHours after, same
    // guarantee every other alert in this file gets. No recursion risk:
    // disposition:'human' never calls dispatchCard(), only 'auto' does.
    const usageLimitExceeded = isUsageLimitExceeded(err);
    if (usageLimitExceeded) {
      try {
        await routeAlert({
          conditionKey: 'alert-router:usage-limit-exceeded',
          title: 'Linear usage limit hit — automated alert filing is silently failing',
          description: `dispatchCard() could not file "${title}" (condition "${conditionKey}"): ${err.message}. Every 'auto' disposition alert will keep failing the same way until this is resolved — archive stale issues (scripts/linear-archive-done.js) or upgrade the plan (BRO-10).`,
          severity: 'critical',
          disposition: 'human',
          cooldownHours: 24,
        });
      } catch (escalationErr) {
        console.error(`[alert-router] USAGE_LIMIT_EXCEEDED escalation page itself failed: ${escalationErr.message}`);
      }
    }
    return { ok: false, error: err.message, usageLimitExceeded };
  }
}

// renderHealthDigestBlock (scripts/lib/autonomous-email-render.js) clips
// every queued row's description/decisionPrompt to 200 chars — whatever a
// caller puts after that is invisible to the owner, and nothing enforced
// that the surviving head reads as a complete thought (card #1078: two of
// three reports the owner screenshotted 2026-08-05 led with a bracketed
// state tag or an indented detail line, so the clipped head was a
// fragment). Rule mirrors the working assertion in
// tests/unit/feedback-owner-reports.test.mjs: the first 200 chars must not
// open on a bracket tag or an indented detail line, and must name the
// row's subject. `subject` is normally the row's title — pass it explicitly
// when the description's opening words diverge from the title (e.g. a show
// name the title doesn't repeat).
function headStandsAlone(description, subject) {
  if (typeof description !== 'string' || description.length === 0) {
    return { ok: true, reason: null };
  }
  const head = description.slice(0, 200);
  if (/^\s*\[/.test(head)) {
    return { ok: false, reason: 'clipped head opens on a bracket tag' };
  }
  if (/^\s{2}/.test(head)) {
    return { ok: false, reason: 'clipped head opens on an indented detail line' };
  }
  if (subject) {
    const escaped = String(subject).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escaped && !new RegExp(escaped, 'i').test(head)) {
      return { ok: false, reason: "clipped head does not name the row's subject" };
    }
  }
  return { ok: true, reason: null };
}

// `decision`/`decisionPrompt` (task #843, owner mandate 2026-08-02): a digest
// row is auto-dispatched by scripts/lib/digest-autofix.js by default — a
// caller opts a row OUT of that (keeps a bare Dispatch-a-fix button) only by
// setting decision:true, for the rare row that's a genuine judgment call
// (e.g. "raise the budget vs cut spend") rather than a technical fix.
// `model` lets a caller force the escalated model on the row's first
// auto-dispatch attempt (e.g. test.yml's streak escalation, which wants
// opus immediately since it's already the SECOND machine attempt at the
// underlying failure — the first, disposition:'auto', card already failed).
function queueDigestLine({ title, description, severity, conditionKey, url, decision, decisionPrompt, model, fields }) {
  // Non-throwing (card #1078): an alert must still reach the owner even if
  // its own head would clip badly — this is a loud warning, not a gate.
  // description renders as "<b>title</b> — description" (autonomous-email-
  // render.js) — the unclipped title always carries the subject, so only the
  // structural checks (bracket-tag/indent) apply here, not the subject rule.
  const headCheck = headStandsAlone(description);
  if (!headCheck.ok) {
    console.warn(`[alert-router] digest row "${conditionKey}" description may clip badly: ${headCheck.reason}`);
  }
  // decisionPrompt renders under a bare "Decision needed:" label with no
  // title prefix, so its own clipped head has to name the subject.
  const promptCheck = headStandsAlone(decisionPrompt, title);
  if (!promptCheck.ok) {
    console.warn(`[alert-router] digest row "${conditionKey}" decisionPrompt may clip badly: ${promptCheck.reason}`);
  }
  let queue = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(DIGEST_QUEUE_PATH, 'utf8'));
    if (Array.isArray(parsed)) queue = parsed;
  } catch { /* missing/corrupt — start fresh */ }
  // Replace any existing queued line for the same condition instead of
  // stacking duplicates if the digest hasn't been drained yet.
  queue = queue.filter(q => q.conditionKey !== conditionKey);
  queue.push({
    conditionKey, title, description, severity, url: url || null,
    decision: !!decision, decisionPrompt: decisionPrompt || null, model: model || null,
    // routeAlert's caller-supplied fields ([{name,value}]) — dispatchCard and
    // sendAlert both carry these through (e.g. the 'Shows' list on overdue/
    // checklist/drift alerts); the digest path was silently dropping them.
    fields: Array.isArray(fields) ? fields : [],
    queuedAt: new Date().toISOString(),
  });
  assertRealFileWriteIsSafeUnderTest('alert digest queue', 'ALERT_DIGEST_QUEUE_PATH');
  fs.mkdirSync(path.dirname(DIGEST_QUEUE_PATH), { recursive: true });
  fs.writeFileSync(DIGEST_QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n');
}

// Reads the digest queue WITHOUT clearing it. Prefer peek + clearDigestQueue()
// over drainDigestQueue() when the consumer does substantial work between
// reading and durably persisting the lines: a read-and-clear leaves a window
// where a throw loses the lines permanently. Permanently, not transiently —
// the ledger already recorded those conditions as notified, so routeAlert()
// will not re-queue them (cooldownHours, default 7 days), and a one-shot
// event like a regional show going live never fires again at all.
function peekDigestQueue() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DIGEST_QUEUE_PATH, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch { /* missing/corrupt — nothing queued */ }
  return [];
}

// Clears the queue. Call only AFTER the peeked lines are durably persisted.
function clearDigestQueue() {
  assertRealFileWriteIsSafeUnderTest('alert digest queue', 'ALERT_DIGEST_QUEUE_PATH');
  fs.mkdirSync(path.dirname(DIGEST_QUEUE_PATH), { recursive: true });
  fs.writeFileSync(DIGEST_QUEUE_PATH, JSON.stringify([], null, 2) + '\n');
}

// Removes specific queued lines without touching the rest of the queue.
// For callers that queue optimistically and then discover the underlying action
// was rolled back — without this, the owner is told something shipped that
// didn't. Pair it with resolveCondition()/deleteCondition() so the ledger stops
// claiming the condition was already notified, otherwise the cooldown silences
// the NEXT (real) occurrence. Returns the number of lines removed.
function removeDigestLines(conditionKeys) {
  const keys = new Set(Array.isArray(conditionKeys) ? conditionKeys : [conditionKeys]);
  const queue = peekDigestQueue();
  const kept = queue.filter(q => !q || !keys.has(q.conditionKey));
  if (kept.length !== queue.length) {
    assertRealFileWriteIsSafeUnderTest('alert digest queue', 'ALERT_DIGEST_QUEUE_PATH');
    fs.mkdirSync(path.dirname(DIGEST_QUEUE_PATH), { recursive: true });
    fs.writeFileSync(DIGEST_QUEUE_PATH, JSON.stringify(kept, null, 2) + '\n');
  }
  return queue.length - kept.length;
}

// Reads and clears in one step — retained for callers whose read and use are
// adjacent. See peekDigestQueue() for why a wide read-to-persist gap should
// use the two-step form instead.
function drainDigestQueue() {
  const queue = peekDigestQueue();
  if (queue.length > 0) clearDigestQueue();
  return queue;
}

/**
 * routeAlert(opts) — the single entry point every owner-facing alert should call.
 *
 * Required: conditionKey (stable per-incident-type id, e.g. 'health-check:Cookies: expiration'),
 *           title, disposition ('auto'|'digest'|'human').
 * Optional: description, hint (suggested fix — becomes the card's "Suggested
 *           approach" or is folded into the email body), severity (default
 *           'error'), fields ([{name,value}]), url, cardAction (Notion Action
 *           value for disposition='auto', default 'Investigate'), priority,
 *           category, tags, cooldownHours (default 7 days), decision +
 *           decisionPrompt (disposition='digest'/page-gated-'human' only —
 *           marks the row a genuine judgment call so digest-autofix.js
 *           never auto-dispatches it, see queueDigestLine's header note),
 *           model (forces the model on the row's first digest-autofix
 *           dispatch attempt), verify ({ line, note } — a pre-built
 *           `VERIFY: <cmd>`/`VERIFY: owner-judgment` acceptance line for
 *           disposition='auto' cards that have no health-check row to key
 *           off; see scripts/lib/red-signature-verify-cmd.js).
 *
 * Returns { action: 'silent'|'auto'|'digest'|'human', conditionKey, cardId? }.
 */
// BRO-4141: one Resend Idempotency-Key per condition per cooldown window, so
// parallel runners that all read a stale ledger still send one email. Windows
// are fixed buckets from the epoch, capped at Resend's 24h key lifetime, so a
// send near a bucket edge can repeat once. The ledger cooldown still does the
// long-window work.
// `incident` (the prior resolvedAt when a resolved condition re-fires) makes a
// red -> green -> red recurrence inside one bucket a new email, not a dupe.
function alertIdempotencyKey(conditionKey, cooldownHours, nowMs, incident = '') {
  const h = Number(cooldownHours);
  const windowMs = Math.max(1, Math.min(Number.isFinite(h) ? h : 24, 24)) * 3600e3;
  // Hashed so a long conditionKey can't push the bucket past Resend's 256 chars.
  const id = require('crypto').createHash('sha1').update(`${conditionKey}|${incident}`).digest('hex').slice(0, 20);
  return `owner-alert:${id}:${Math.floor(nowMs / windowMs)}`;
}

async function routeAlert(opts) {
  const {
    conditionKey,
    title,
    description = '',
    hint = '',
    severity = 'error',
    disposition,
    fields = [],
    url,
    cardAction,
    priority,
    category,
    tags,
    cooldownHours = DEFAULT_COOLDOWN_HOURS,
    decision,
    decisionPrompt,
    model,
    verify,
    dispatchAtFiling,
  } = opts || {};

  if (!conditionKey) throw new Error('routeAlert requires a stable conditionKey');
  if (!title) throw new Error('routeAlert requires a title');
  if (!DISPOSITIONS.includes(disposition)) {
    throw new Error(`routeAlert: invalid disposition "${disposition}" (must be one of ${DISPOSITIONS.join('|')})`);
  }

  const ledger = loadLedger();
  const existing = ledger.conditions[conditionKey];
  const now = new Date().toISOString();

  if (existing && existing.status === 'open' && hoursSince(existing.lastNotifiedAt) < cooldownHours) {
    existing.lastSeen = now;
    existing.silentRefires = (existing.silentRefires || 0) + 1;
    persistLedger(ledger);
    // linearIdentifier survives the cooldown path so consumers (health-check's
    // digest line) keep telling the truth about WHERE the tracker lives on
    // every silent refire, not just the first rail-2 short-circuit.
    return { action: 'silent', conditionKey, cardId: existing.cardId || null, linearIdentifier: existing.linearIdentifier || null };
  }

  // Page-worthy gate (card #611): 'human' only actually pages if conditionKey
  // is on the allowlist. Everything else requesting 'human' is transparently
  // downgraded to 'digest' — the caller's requested disposition is honored in
  // spirit (the owner is still told, just not by immediate email).
  const pageGated = disposition === 'human' && !isPageWorthy(conditionKey);
  let effectiveDisposition = pageGated ? 'digest' : disposition;
  if (pageGated) {
    console.log(`[alert-router] disposition 'human' requested for "${conditionKey}" ("${title}") is not on the page-worthy allowlist — routed to the morning digest instead. Add it to scripts/lib/page-worthy-alerts.js if this should page immediately.`);
  }

  // BRO-3030: decide digest escalation BEFORE the rail-2 dedupe check below,
  // so a promotion to 'auto' flows through that same dedupe+dispatch+persist
  // path unmodified — see decideDigestEscalation()'s header for why this
  // reuses 'auto' rather than duplicating its machinery here.
  let promotedFromDigest = false;
  let digestDecision = null;
  let digestNotifyCount = null;
  if (effectiveDisposition === 'digest') {
    digestNotifyCount = (existing?.notifyCount || 0) + 1;
    digestDecision = decideDigestEscalation({ conditionKey, existing, notifyCount: digestNotifyCount, now: Date.now() });
    if (digestDecision.action === 'promote') {
      effectiveDisposition = 'auto';
      promotedFromDigest = true;
    }
  }

  // Rail 2 cross-system dedupe (Phase 0, plan 2026-08-12, task #1341): 'auto'
  // is the only disposition that actually creates a NEW tracker (dispatchCard
  // files a LINEAR issue — it has since BRO-375 repointed it; this comment said
  // "Notion card" long after that stopped being true, and on 2026-08-19 it led
  // an owner session to report to the owner that alerts still filed Notion
  // cards) — checked here, after the disposition is resolved,
  // so a 'human' request downgraded to 'digest' never triggers a Linear round
  // trip it doesn't need. Short-circuits with the SAME { action: 'silent',
  // conditionKey, cardId } shape the ledger-cooldown check above returns, plus
  // linearIdentifier (additive — existing callers reading .action/.cardId/
  // .conditionKey see no change). The ledger write here means a SUBSEQUENT
  // call within cooldownHours hits the ledger-cooldown short-circuit above
  // instead of re-querying Linear every time.
  if (effectiveDisposition === 'auto') {
    const linearDup = await findLinearDuplicate(conditionKey);
    if (linearDup.matched) {
      console.log(`[alert-router] conditionKey ${conditionKey} already tracked as ${linearDup.identifier} — not double-filing`);
      // BRO-3030 ship-check catch (Bug 2): a promoted-from-digest call that
      // hits this dedupe match used to return silent with NO digest line at
      // all — the owner-used-to-seeing-this-daily condition would just
      // vanish, no different from the bug this card exists to fix. One-time
      // notice, same as the direct-file path below.
      if (promotedFromDigest) {
        queueDigestLine({
          title: `${title} — already tracked at ${linearDup.identifier}`,
          description: `This condition already has an open tracker (${linearDup.identifier}); not filing a duplicate. It will go quiet in the digest from here.\n\n${description}`,
          severity, conditionKey, url, decision: true, fields,
        });
      }
      ledger.conditions[conditionKey] = {
        status: 'open',
        disposition: effectiveDisposition,
        title,
        firstSeen: existing?.firstSeen || now,
        lastSeen: now,
        lastNotifiedAt: now,
        // See decideDigestEscalation()'s header: only advance this when we
        // actually surfaced something (the notice above), not on every silent
        // dedupe-match refire.
        lastSurfacedAt: promotedFromDigest ? now : (existing?.lastSurfacedAt || null),
        notifyCount: (existing?.notifyCount || 0) + 1,
        // A previously-filed open Notion card keeps its reference — the Linear
        // match means "don't file ANOTHER tracker", not "the old card vanished".
        cardId: existing?.cardId || null,
        linearIdentifier: linearDup.identifier,
        ...carriedRedFirstFields(existing),
      };
      persistLedger(ledger);
      return { action: 'silent', conditionKey, cardId: existing?.cardId || null, linearIdentifier: linearDup.identifier };
    }
  }

  // New incident: first time, or reoccurred after resolveCondition() /
  // cooldown expiry. Dispatch per effective disposition.
  const result = { action: effectiveDisposition, conditionKey };
  if (pageGated) result.requestedDisposition = disposition;
  let notifyOk = true;
  if (effectiveDisposition === 'auto') {
    const dispatch = await dispatchCard({ title, description, hint, fields, severity, cardAction, priority, category, tags, conditionKey, verify, dispatchAtFiling });
    result.cardId = dispatch.cardId || null;
    // BRO-4054: the durable "dispatch requested" stamp. The Mac-side pass
    // selects candidates from Linear itself (a lost ledger push must not
    // strand the card — second-opinion blocker), so this is telemetry +
    // the follow-up sweep's "was this ever requested" signal, not the queue.
    if (dispatch.ok && dispatch.dispatchMode) {
      result.dispatch = {
        requestedAt: now,
        mode: 'dispatch-at-filing',
        ...(dispatchAtFiling && typeof dispatchAtFiling === 'object' ? { runId: dispatchAtFiling.runId || null, runUrl: dispatchAtFiling.runUrl || null } : {}),
      };
    }
    // BRO-286: the filed tracker is a Linear issue — surface WHERE it lives
    // so consumers (health-check's digest line) tell the truth.
    result.linearIdentifier = dispatch.linearIdentifier || null;
    result.dispatchOk = dispatch.ok;
    // Propagate the real dispatch error (not just the ok/fail boolean) so
    // callers — the E2E canary, health-check.js's dispatchedCards mapping —
    // can surface the true underlying failure instead of re-guessing one.
    if (!dispatch.ok) result.dispatchError = dispatch.error;
    if (dispatch.usageLimitExceeded) result.usageLimitExceeded = true;
    notifyOk = dispatch.ok;
    if (promotedFromDigest) {
      if (dispatch.ok) {
        // One-time notice that this previously-noisy digest condition now
        // has a tracker — after this it goes quiet in the digest (occasional
        // reminder only, see decideDigestEscalation()'s 'resurface' branch
        // below) instead of repeating in full every day.
        queueDigestLine({
          title: `${title} — escalated after ${digestNotifyCount} notifications`,
          description: `Filed ${dispatch.linearIdentifier} for owner triage after ${digestNotifyCount} repeats with no tracker.\n\n${description}`,
          severity, conditionKey, url, decision: true, fields,
        });
        result.lastSurfacedAt = now;
      } else {
        // Dispatch failed: don't leave the owner blind on this call — fall
        // back to the plain line so visibility isn't worse than before this
        // fix. The ledger write below is skipped on notifyOk===false either
        // way, so the NEXT call retries escalation from the same state.
        queueDigestLine({ title, description, severity, conditionKey, url, decision, decisionPrompt, model, fields });
      }
    }
  } else if (effectiveDisposition === 'digest') {
    if (digestDecision.action === 'normal') {
      queueDigestLine({ title, description, severity, conditionKey, url, decision, decisionPrompt, model, fields });
      result.lastSurfacedAt = now;
    } else if (digestDecision.action === 'resurface') {
      // Carry the caller's OWN description through (BRO-3030 P0 follow-up).
      // The first version of this branch emitted only "Still firing after N
      // notifications", discarding description/decisionPrompt — which defeats
      // the whole point for the never-quiet cost families: provider-spend
      // deliberately keeps its TITLE stable and puts every breach number in
      // the description, so a spend going $40/day -> $400/day produced a line
      // identical to yesterday's except the counter. A resurfaced cost alert
      // has to carry today's number or it is not telling the owner anything.
      queueDigestLine({
        title: `${title} (still open — ${existing.linearIdentifier})`,
        description: [
          `Still firing after ${digestNotifyCount} notifications since it was filed. Tracked at ${existing.linearIdentifier}.`,
          description,
        ].filter(Boolean).join('\n\n'),
        severity, conditionKey, url, decision: true, decisionPrompt, model, fields,
      });
      result.lastSurfacedAt = now;
    }
    // digestDecision.action === 'quiet': already tracked, resurface window
    // hasn't elapsed yet — no line queued this call, and result.lastSurfacedAt
    // is deliberately left unset so the ledger write below carries the OLD
    // lastSurfacedAt forward unchanged (see decideDigestEscalation's header —
    // this is the field the resurface decision actually depends on).
    // notifyCount/lastSeen/lastNotifiedAt still advance normally below.
  } else if (effectiveDisposition === 'human') {
    const delivered = await sendAlert({
      title, description, severity, fields, url, email: true,
      idempotencyKey: alertIdempotencyKey(conditionKey, cooldownHours, Date.now(),
        existing && existing.status === 'resolved' ? existing.resolvedAt || '' : ''),
    });
    result.delivered = delivered;
    notifyOk = delivered;
    if (delivered) result.lastSurfacedAt = now;
  }

  if (!notifyOk) {
    // Dispatch/delivery failed (Notion down, Resend down, etc). Do NOT record
    // this as a notified incident — if we did, the silent-refire branch above
    // would suppress the NEXT attempt too, for up to cooldownHours, even
    // though nobody was ever actually told. Leaving the ledger untouched
    // means the next call retries as if this one never happened.
    console.error(`[alert-router] notify failed for "${title}" (${conditionKey}) — not recording as notified, will retry next call`);
    return result;
  }

  ledger.conditions[conditionKey] = {
    status: 'open',
    disposition: effectiveDisposition,
    ...(pageGated ? { requestedDisposition: disposition } : {}),
    title,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    lastNotifiedAt: now,
    // See decideDigestEscalation()'s header: this is a SEPARATE clock from
    // lastNotifiedAt above — it only advances when a call actually surfaced
    // something in the digest, not on every processed call.
    lastSurfacedAt: result.lastSurfacedAt !== undefined ? result.lastSurfacedAt : (existing?.lastSurfacedAt || null),
    notifyCount: (existing?.notifyCount || 0) + 1,
    cardId: result.cardId !== undefined ? result.cardId : (existing?.cardId || null),
    // Filed-tracker identity survives in the ledger so the cooldown
    // short-circuit (top of function) keeps reporting it on silent refires.
    linearIdentifier: result.linearIdentifier !== undefined ? result.linearIdentifier : (existing?.linearIdentifier || null),
    ...carriedRedFirstFields(existing),
    ...(result.dispatch ? { dispatch: result.dispatch } : {}),
  };
  persistLedger(ledger);
  return result;
}

// BRO-4054 (second-opinion blocker): both ledger writes in routeAlert build
// a FRESH record from an explicit field list, so any field another writer
// stamped on the open condition — the dispatch-at-filing request stamp, the
// stale-signature absence counter — silently vanished on the next refire
// (cooldown expiry → dedupe-match rewrite). Carry them across explicitly.
function carriedRedFirstFields(existing) {
  const out = {};
  if (existing && existing.dispatch) out.dispatch = existing.dispatch;
  if (existing && Array.isArray(existing.absentRunIds)) out.absentRunIds = existing.absentRunIds;
  return out;
}

// Merge `patch` into an OPEN condition's record without touching the
// routeAlert-owned fields (status/lastSeen/notifyCount...). Used by
// route-main-streak-signatures.js to stamp `absentRunIds` (BRO-4054 stale
// tracking). No-op (returns false) when the condition is missing or closed.
function patchCondition(conditionKey, patch) {
  const ledger = loadLedger();
  const existing = ledger.conditions[conditionKey];
  if (!existing || existing.status !== 'open') return false;
  Object.assign(existing, patch || {});
  persistLedger(ledger);
  return true;
}

// Call the moment the underlying check goes back to green — lets the next
// occurrence notify immediately instead of waiting out the cooldown.
// Returns true if an open incident was actually resolved (false = no-op).
// `reason` (BRO-4054, optional) is recorded as `resolveReason` so a reader of
// the ledger — the Mac-side card follow-up sweep, a human — can tell a
// same-job-went-green resolution from a stale-signature one.
function resolveCondition(conditionKey, { reason } = {}) {
  const ledger = loadLedger();
  const existing = ledger.conditions[conditionKey];
  if (!existing || existing.status !== 'open') return false;
  existing.status = 'resolved';
  existing.resolvedAt = new Date().toISOString();
  if (reason) existing.resolveReason = String(reason);
  persistLedger(ledger);
  return true;
}

// Hard-removes a condition from the ledger — for synthetic/test conditions
// only (e.g. the E2E canary's fixed conditionKeys). Real conditions should
// use resolveCondition() so history (firstSeen/notifyCount) is preserved;
// this exists so a canary run leaves zero residue and always re-dispatches
// fresh on its next run instead of going silent under the normal cooldown.
function deleteCondition(conditionKey) {
  const ledger = loadLedger();
  if (!(conditionKey in ledger.conditions)) return false;
  delete ledger.conditions[conditionKey];
  persistLedger(ledger);
  return true;
}

// Reads the trailing-N-day dispatch attempt log for disposition='auto'
// dispatches — used by health-check.js's deadman check to compare attempts
// vs successes independent of the ledger (see ATTEMPTS_LOG_PATH comment).
// Sorted oldest→newest by `ts` (ship-check finding): logDispatchAttempt()
// rewrites the file after filtering, and a rebase conflict resolution or
// manual edit could disturb append order, so callers that need "the most
// recent attempt" must not assume array order == chronological order.
function readDispatchAttempts({ days = 7 } = {}) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let lines = [];
  try {
    lines = fs.readFileSync(ATTEMPTS_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  } catch { /* missing — no attempts logged yet */ }
  return lines
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(entry => new Date(entry.ts).getTime() >= cutoff)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

module.exports = {
  routeAlert,
  alertIdempotencyKey,
  // BRO-3881: exported so the test asserts the REAL card body every filed
  // issue gets, rather than a copy of the template (CLAUDE.md rule 15). The
  // bug it guards — prose-only acceptance criteria that no dispatch will
  // accept — is invisible from routeAlert's return value.
  buildCardNotes,
  findLinearDuplicate,
  isPageWorthy, // re-exported for callers/tests that want to check gating without calling routeAlert
  resolveCondition,
  patchCondition,
  deleteCondition,
  loadLedger,
  headStandsAlone,
  decideDigestEscalation,
  isNeverQuietCondition,
  NEVER_QUIET_CONDITION_RE,
  ESCALATION_NOTIFY_THRESHOLD,
  drainDigestQueue,
  peekDigestQueue,
  clearDigestQueue,
  removeDigestLines,
  readDispatchAttempts,
  DEFAULT_COOLDOWN_HOURS,
  DISPOSITIONS,
  // Where THIS process's cooldown state lives (tracked ledger in CI,
  // machine-local file otherwise). Exported so callers/diagnostics can print
  // the resolved path instead of assuming data/audit/alert-ledger.json.
  ledgerPath: () => LEDGER_PATH,
  isLocalLedger: () => LEDGER_PATH !== TRACKED_LEDGER_PATH,
  // exported for tests only
  _LEDGER_PATH: LEDGER_PATH,
  _TRACKED_LEDGER_PATH: TRACKED_LEDGER_PATH,
  _LOCAL_LEDGER_PATH: LOCAL_LEDGER_PATH,
  _DIGEST_QUEUE_PATH: DIGEST_QUEUE_PATH,
  _ATTEMPTS_LOG_PATH: ATTEMPTS_LOG_PATH,
};
