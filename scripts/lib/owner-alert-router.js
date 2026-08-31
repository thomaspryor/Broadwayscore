/**
 * Owner Alert Router — single funnel for owner-facing automated alerts.
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
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { sendAlert } = require('./discord-notify');
const { isPageWorthy } = require('./page-worthy-alerts');
// BRO-375 (Phase 1): dispatchCard() below calls this in-process instead of
// shelling out to the linear-brain.js CLI — see linear-issue-create.js's
// header for why this is the natural repoint target.
const { createLinearIssue, isUsageLimitExceeded } = require('./linear-issue-create');
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

// A floor on how much context an auto-filed tracker carries. It originated as
// notion-brain.js's rule that a "Not started" card needs >=300 chars of Notes
// (feedback_notion_card_context.md); this router now files LINEAR issues, which
// impose no such rule, so the floor is kept on its own merits rather than
// inherited: an alert that files a two-line issue is an alert nobody can act on
// without re-deriving what tripped it. The template below clears the floor for
// realistic inputs, but a very short description plus a short conditionKey can
// land right on the edge — pad explicitly rather than relying on margin.
const MIN_NOTES_LENGTH = 320;

function buildCardNotes({ description, hint, fields, conditionKey }) {
  const fieldLines = (fields || []).map(f => `- **${f.name}:** ${f.value}`).join('\n');
  const parts = [
    '## Problem',
    description || '(no description provided)',
  ];
  if (fieldLines) parts.push(fieldLines);
  parts.push(`\n## Suggested approach\n${hint || 'Investigate the condition and fix the root cause.'}`);
  parts.push(`\n## Acceptance criteria\nCondition "${conditionKey}" no longer fires on the next check. If it recurs, this card (or a fresh one) will re-open automatically — do not close this as "won't fix" without noting why.`);
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
async function dispatchCard({ title, description, hint, fields, severity, cardAction, priority, category, tags, conditionKey }) {
  const notes = buildCardNotes({ description, hint, fields, conditionKey });
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
  try {
    const { issue } = await createLinearIssue({
      title,
      description: notes,
      priority: linearPriority,
      park: parkReason,
    });
    logDispatchAttempt({ conditionKey, title, ok: true });
    return { ok: true, cardId: null, linearIdentifier: issue.identifier };
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
 *           dispatch attempt).
 *
 * Returns { action: 'silent'|'auto'|'digest'|'human', conditionKey, cardId? }.
 */
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
  const effectiveDisposition = pageGated ? 'digest' : disposition;
  if (pageGated) {
    console.log(`[alert-router] disposition 'human' requested for "${conditionKey}" ("${title}") is not on the page-worthy allowlist — routed to the morning digest instead. Add it to scripts/lib/page-worthy-alerts.js if this should page immediately.`);
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
      ledger.conditions[conditionKey] = {
        status: 'open',
        disposition: effectiveDisposition,
        title,
        firstSeen: existing?.firstSeen || now,
        lastSeen: now,
        lastNotifiedAt: now,
        notifyCount: (existing?.notifyCount || 0) + 1,
        // A previously-filed open Notion card keeps its reference — the Linear
        // match means "don't file ANOTHER tracker", not "the old card vanished".
        cardId: existing?.cardId || null,
        linearIdentifier: linearDup.identifier,
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
    const dispatch = await dispatchCard({ title, description, hint, fields, severity, cardAction, priority, category, tags, conditionKey });
    result.cardId = dispatch.cardId || null;
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
  } else if (effectiveDisposition === 'digest') {
    queueDigestLine({ title, description, severity, conditionKey, url, decision, decisionPrompt, model, fields });
  } else if (effectiveDisposition === 'human') {
    const delivered = await sendAlert({ title, description, severity, fields, url, email: true });
    result.delivered = delivered;
    notifyOk = delivered;
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
    notifyCount: (existing?.notifyCount || 0) + 1,
    cardId: result.cardId !== undefined ? result.cardId : (existing?.cardId || null),
    // Filed-tracker identity survives in the ledger so the cooldown
    // short-circuit (top of function) keeps reporting it on silent refires.
    linearIdentifier: result.linearIdentifier !== undefined ? result.linearIdentifier : (existing?.linearIdentifier || null),
  };
  persistLedger(ledger);
  return result;
}

// Call the moment the underlying check goes back to green — lets the next
// occurrence notify immediately instead of waiting out the cooldown.
// Returns true if an open incident was actually resolved (false = no-op).
function resolveCondition(conditionKey) {
  const ledger = loadLedger();
  const existing = ledger.conditions[conditionKey];
  if (!existing || existing.status !== 'open') return false;
  existing.status = 'resolved';
  existing.resolvedAt = new Date().toISOString();
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
  findLinearDuplicate,
  isPageWorthy, // re-exported for callers/tests that want to check gating without calling routeAlert
  resolveCondition,
  deleteCondition,
  loadLedger,
  headStandsAlone,
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
