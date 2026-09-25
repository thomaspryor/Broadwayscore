'use strict';
/**
 * red-first-dispatch.js — BRO-4054: the Mac-side pass that (1) dispatches
 * `test-yml:red:<job>:<sig>` cards the alert router filed for
 * dispatch-at-filing, and (2) follows up on their Linear cards once the
 * signature has resolved on main.
 *
 * WHY THIS EXISTS. test.yml's test-summary job files one Linear card per
 * distinct main-red breakage (route-main-streak-signatures.js → owner-alert-
 * router.js). Until BRO-4054 every one of those cards was PARKED (the
 * `PARKED:` sentinel headless-dispatchability.js refuses, BRO-3536) and sat
 * in the 70-deep digest-autofix queue behind unrelated work while main
 * stayed red on every push. CI cannot spawn a headless job itself (no
 * `claude` binary on the runner), so the filer marks the card with
 * linear-drain-parked.js's DISPATCH_AT_FILING_MARKER and this pass — wired
 * FIRST into scripts/bsc-reconcile.js's 5-minute launchd tick, before any
 * orphan/tab sweep ("red-first") — picks it up from LINEAR, not from a queue
 * file: a lost alert-ledger push must never strand a card (second-opinion
 * blocker on the design). The ledger's `dispatch.requestedAt` stamp is
 * telemetry plus the follow-up sweep's "was this ever requested" signal.
 *
 * DISPATCH PHASE (per tick)
 *   - candidates: open issues carrying DISPATCH_AT_FILING_MARKER, still in a
 *     backlog/unstarted state, with a safe-form VERIFY command (BRO-3907's
 *     derivation; `VERIFY: owner-judgment` cards are a human gate by design
 *     and must not spend a spawn or a cap slot — second-opinion NIT), oldest
 *     issue number first (filing order).
 *   - dedupe: skip while the shared dispatch-ledger has an open (non-terminal)
 *     job for `linear:<id>`, or this pass attempted the card within
 *     ATTEMPT_COOLDOWN_MS, or the issue already carries an unresolved
 *     "Dispatched ..." comment (linear-next's own cross-machine signal).
 *     linear-next.js's full guard stack still runs inside the child.
 *   - cap: DAILY_CAP dispatches per UTC day, counted from this pass's own
 *     journal (JOURNAL_PATH, Mac-local, never git-tracked). Refusals/skips do
 *     not count.
 *   - spawn: digest-autofix.js's dispatchDetached() — the same detached
 *     `linear-next.js --id X --headless --no-detach` every other Linear drain
 *     uses. No --allow-* waivers: these cards carry no PARKED sentinel.
 *
 * FOLLOW-UP PHASE (per tick)
 *   Reads the TRACKED ledger read-only from origin/main (bounded fetch, `git
 *   show origin/main:...` — never a checkout, never a write: bsc-reconcile's
 *   own rule is that a Mac-local writer must never touch the tracked alert
 *   ledger). For each red condition resolved within FOLLOW_UP_WINDOW_MS whose
 *   card is still open: decideCardFollowUp() — a LIVE job leaves the card
 *   alone; a dispatched-but-finished card gets one comment and is left to its
 *   job's outcome path; a never-dispatched card is canceled with the reason
 *   (a recurrence re-files automatically — findLinearDuplicate only matches
 *   OPEN issues). Idempotent across machines via the issue state plus a
 *   FOLLOW_UP_MARKER comment; the local journal keeps steady-state Linear
 *   reads near zero.
 *
 * Kill switches: RED_FIRST_DISABLED=1 (this pass only), LINEAR_NEXT_DISABLED=1
 * (every Linear dispatcher; honored here so a disabled tick logs one line
 * instead of spawning children that each refuse).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  DISPATCH_AT_FILING_MARKER, PARKED_STATE_TYPES, hasSafeVerifyCommand, issueNumber,
} = require('./linear-drain-parked.js');
const { findUnresolvedDispatchComment, newestDispatchComment } = require('./linear-dispatch.js');
const { isTerminalStateType } = require('./linear-state-types.js');
const { RED_SIGNATURE_PREFIX } = require('./main-red-streak.js');
const { classifyHeadlessDispatchability } = require('./headless-dispatchability.js');

const REPO = path.join(__dirname, '..', '..');
const DAILY_CAP = 6;
const ATTEMPT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const FOLLOW_UP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// Mutations per tick (each is one linear-brain subprocess, ~2s): sized to
// the daily dispatch cap so one tick can close out a whole day's cards while
// staying far inside bsc-reconcile's 90s bound.
const MAX_FOLLOW_UPS_PER_TICK = 6;
const MAX_FOLLOW_UP_FAILURES = 3;
const DISPATCH_STAGGER_SEC = 15;
const FOLLOW_UP_MARKER = '[red-first follow-up]';
const TRACKED_LEDGER_REL = 'data/audit/alert-ledger.json';
const JOURNAL_PATH = process.env.RED_FIRST_JOURNAL_PATH
  || path.join(os.homedir(), '.broadwayscore-state', 'red-first-dispatch.jsonl');
// Job names carry spaces ("E2E Tests"), so the key runs to the closing paren.
const CONDITION_KEY_RE = /condition:\s*(test-yml:red:[^)]+)\)/;

// ── pure helpers ────────────────────────────────────────────────────────────

function utcDay(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Journal rows {ts, event:'dispatch', ...} on the same UTC day as `now`. */
function countDispatchesToday(journal, now = Date.now()) {
  const today = utcDay(now);
  return (journal || []).filter((r) => r && r.event === 'dispatch' && utcDay(r.ts) === today).length;
}

// BRO-4151: which skip reasons mean "already being handled, stay quiet" vs
// "this card got NO job this tick and nothing is coming without a human
// looking at it". A live job, a very recent dispatch (still within
// ATTEMPT_COOLDOWN_MS of actually being requested), or an unresolved
// "Dispatched ..." comment from another machine are all already in flight.
// Everything else — no-safe-verify, cap-reached, human-gated, a card whose
// state moved out from under us, a refused/follow-up attempt now cooling
// down — got skipped with nobody told, which is exactly how BRO-4147 and
// BRO-4149 sat for 40+ minutes with no job and no alert.
function isSilentSkipReason(reason) {
  const r = String(reason || '');
  return r === 'live-job' || r === 'dispatched-comment' || r.startsWith('recent-attempt:dispatch');
}

function conditionKeyFromIssue(issue) {
  const m = CONDITION_KEY_RE.exec(String((issue && issue.description) || ''));
  return m ? m[1].trim() : null;
}

/** Filed for dispatch-at-filing AND still waiting (backlog/unstarted). */
function isRedFirstCandidateIssue(issue) {
  if (!issue || !issue.state || !PARKED_STATE_TYPES.has(issue.state.type)) return false;
  return typeof issue.description === 'string' && issue.description.includes(DISPATCH_AT_FILING_MARKER);
}

function latestJournalRow(journal, identifier, event) {
  let best = null;
  for (const r of journal || []) {
    if (!r || r.identifier !== identifier || (event && r.event !== event)) continue;
    if (!best || String(r.ts) > String(best.ts)) best = r;
  }
  return best;
}

/**
 * Pure selection for the dispatch phase.
 * @param {Array<object>} issues open Linear issues ({identifier, description, state:{type}})
 * @param {object} opts
 * @param {Array<object>} [opts.journal] this pass's journal rows
 * @param {Set<string>} [opts.openJobTaskIds] dispatch-ledger taskIds with a non-terminal job (`linear:BRO-N`)
 * @param {number} [opts.now]
 * @param {number} [opts.cap] per-UTC-day dispatch cap
 * @param {number} [opts.cooldownMs] per-card re-attempt cooldown
 * @returns {{candidates: object[], skipped: Array<{identifier:string, reason:string}>, remaining: number}}
 */
function selectRedFirstCandidates(issues, { journal = [], openJobTaskIds = new Set(), now = Date.now(), cap = DAILY_CAP, cooldownMs = ATTEMPT_COOLDOWN_MS } = {}) {
  const skipped = [];
  const eligible = [];
  for (const iss of Array.isArray(issues) ? issues : []) {
    if (!isRedFirstCandidateIssue(iss)) continue;
    const id = iss.identifier;
    if (openJobTaskIds.has(`linear:${id}`)) { skipped.push({ identifier: id, reason: 'live-job' }); continue; }
    const last = latestJournalRow(journal, id);
    if (last && now - Date.parse(last.ts) < cooldownMs) { skipped.push({ identifier: id, reason: `recent-attempt:${last.event}` }); continue; }
    if (!hasSafeVerifyCommand(iss)) { skipped.push({ identifier: id, reason: 'no-safe-verify' }); continue; }
    eligible.push(iss);
  }
  eligible.sort((a, b) => issueNumber(a.identifier) - issueNumber(b.identifier));
  const remaining = Math.max(0, cap - countDispatchesToday(journal, now));
  const candidates = eligible.slice(0, remaining);
  for (const iss of eligible.slice(remaining)) skipped.push({ identifier: iss.identifier, reason: 'cap-reached' });
  return { candidates, skipped, remaining };
}

/**
 * What to do with a red card whose ledger condition has resolved.
 * @returns {'none'|'leave'|'comment'|'cancel'}
 *   none    condition still open, or the issue is already terminal
 *   leave   a job is LIVE on the card, or it is 'started' with no dispatch signal
 *           (attended work) — never touch it (not-resolved-while-live)
 *   comment dispatched before, job finished — one note, outcome path owns the close
 *   cancel  never dispatched — close it with the reason
 */
function decideCardFollowUp({ conditionStatus, issueStateType, dispatched, live }) {
  if (conditionStatus !== 'resolved') return 'none';
  if (!issueStateType || isTerminalStateType(issueStateType)) return 'none';
  if (live) return 'leave';
  // A 'started' card (In Progress / In Review) with no dispatch signal is
  // someone's attended work (a cmux tab, a hand-dispatch) — never cancel it.
  if (issueStateType === 'started') return dispatched ? 'comment' : 'leave';
  if (dispatched) return 'comment';
  return 'cancel';
}

function followUpCommentBody({ action, conditionKey, resolvedAt, resolveReason }) {
  const tail = action === 'cancel'
    ? 'This card was never dispatched, so it is canceled; a recurrence of the signature re-files automatically.'
    : 'This card was dispatched; leaving its outcome to that job.';
  return `${FOLLOW_UP_MARKER} Condition \`${conditionKey}\` resolved on main at ${resolvedAt} (${resolveReason || 'job-green'}): the failing signature no longer appears. ${tail}`;
}

// ── I/O helpers (all injectable through runRedFirstPass deps) ───────────────

function readJournal(p = JOURNAL_PATH) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function appendJournal(row, p = JOURNAL_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

// Read-only view of the TRACKED ledger as origin/main has it. Bounded (5s
// each, fail-open) and never a checkout. Returns null when unreadable (the
// follow-up phase then skips this tick).
const FETCH_TIMEOUT_MS = 5000;
function readTrackedLedgerFromOrigin() {
  try {
    try {
      // unbounded-fetch-ok: single-ref fetch from the Mac's FULL clone on the
      // launchd tick (bsc-reconcile) / by-hand CLI only — this function is
      // never invoked from a workflow, let alone a fetch-depth:1 checkout.
      execFileSync('git', ['-C', REPO, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '-q'], {
        timeout: FETCH_TIMEOUT_MS, stdio: 'ignore',
      });
    } catch { /* stale origin/main ref is still a usable read — fail-open */ }
    const raw = execFileSync('git', ['-C', REPO, 'show', `origin/main:${TRACKED_LEDGER_REL}`], {
      encoding: 'utf8', timeout: FETCH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw);
    return parsed && parsed.conditions ? parsed : null;
  } catch {
    return null;
  }
}

function openJobTaskIdsFromLedger() {
  const ledger = require('./dispatch-ledger.js');
  return new Set(ledger.openJobs(ledger.readEntries()).map((j) => String(j.taskId)));
}

// The one Linear mutation chokepoint with the cancel gate is linear-brain's
// CLI (its --cancel-reason gate lives only there) — subprocess on purpose.
function updateIssueViaBrain(identifier, args) {
  return execFileSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'update', identifier, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function defaultDeps() {
  const linearClient = require('./linear-client.js');
  const { dispatchDetached } = require('./digest-autofix.js');
  const { routeAlert } = require('./owner-alert-router.js');
  return {
    listOpenIssues: () => linearClient.listOpenIssuesWithDescriptions(),
    getIssue: (id) => linearClient.getIssue(id),
    openJobTaskIds: openJobTaskIdsFromLedger,
    readJournal: () => readJournal(),
    appendJournal: (row) => appendJournal(row),
    readTrackedLedger: readTrackedLedgerFromOrigin,
    dispatch: (identifier, log, staggerSec) => dispatchDetached(`linear:${identifier}`, log, staggerSec, null, {}),
    updateIssue: updateIssueViaBrain,
    routeSkipAlert: (opts) => routeAlert(opts),
  };
}

// BRO-4151: one 'digest' routeAlert per non-silently-skipped card this tick —
// routeAlert's own per-conditionKey cooldown (7 days by default) means a
// still-stuck card is only actually queued into the morning digest once, not
// re-queued every 5-minute tick until someone fixes it.
async function surfaceSkip(d, { identifier, reason }, issueByIdentifier, log) {
  const iss = issueByIdentifier.get(identifier);
  const title = (iss && iss.title) || identifier;
  try {
    await d.routeSkipAlert({
      conditionKey: `red-first-skip:${identifier}`,
      title: `Red-first dispatch skipped ${identifier} — no job spawned (${reason})`,
      description: `The BRO-4054 red-first pass skipped "${title}" (${identifier}) this tick with reason "${reason}" — no dispatch was attempted and no job was spawned. Unless this reason clears on its own (e.g. the daily cap resetting), the card will keep sitting here with nobody looking at it.`,
      severity: 'warning',
      disposition: 'digest',
      fields: [
        { name: 'Card', value: identifier },
        { name: 'Skip reason', value: reason },
      ],
    });
  } catch (err) {
    log(`[red-first] skip-alert failed for ${identifier} (${reason}): ${err.message}`);
  }
}

// ── the pass ────────────────────────────────────────────────────────────────

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] select and decide, spawn/journal/mutate nothing
 * @param {(msg:string)=>void} [opts.log]
 * @param {number} [opts.now]
 * @param {object} [opts.deps] see defaultDeps() — tests inject every I/O seam
 * @returns {Promise<{disabled?:string, dispatched:string[], skipped:Array, followUps:Array}>}
 */
async function runRedFirstPass({ dryRun = false, log = console.log, now = Date.now(), deps = {} } = {}) {
  const d = { ...defaultDeps(), ...deps };
  const summary = { dispatched: [], skipped: [], followUps: [] };
  if (process.env.RED_FIRST_DISABLED === '1') { summary.disabled = 'RED_FIRST_DISABLED'; log('[red-first] RED_FIRST_DISABLED=1 — skipping'); return summary; }
  if (process.env.LINEAR_NEXT_DISABLED === '1') { summary.disabled = 'LINEAR_NEXT_DISABLED'; log('[red-first] LINEAR_NEXT_DISABLED=1 — skipping'); return summary; }

  const issues = await d.listOpenIssues();
  const journal = d.readJournal();
  const openJobTaskIds = d.openJobTaskIds();

  // ── dispatch phase ──
  const sel = selectRedFirstCandidates(issues, { journal, openJobTaskIds, now });
  summary.skipped.push(...sel.skipped);
  let stagger = 0;
  for (const iss of sel.candidates) {
    const id = iss.identifier;
    // Cross-machine dedupe: a "Dispatched ..." comment this host never
    // journaled (dispatched by hand, or from another machine).
    const fresh = await d.getIssue(id);
    if (!fresh || !fresh.state || !PARKED_STATE_TYPES.has(fresh.state.type)) { summary.skipped.push({ identifier: id, reason: 'state-moved' }); continue; }
    if (findUnresolvedDispatchComment(fresh)) { summary.skipped.push({ identifier: id, reason: 'dispatched-comment' }); continue; }
    const gate = classifyHeadlessDispatchability({ subject: fresh.title, notes: fresh.description || '' });
    if (!gate.dispatchable) {
      summary.skipped.push({ identifier: id, reason: `human-gated:${(gate.blockers || []).join('+')}` });
      if (!dryRun) d.appendJournal({ event: 'refused', identifier: id, conditionKey: conditionKeyFromIssue(fresh), reason: (gate.blockers || []).join('+') });
      continue;
    }
    if (dryRun) { log(`[red-first] DRY-RUN would dispatch ${id} (${fresh.title})`); summary.dispatched.push(id); continue; }
    d.dispatch(id, log, stagger);
    stagger += DISPATCH_STAGGER_SEC;
    d.appendJournal({ event: 'dispatch', identifier: id, conditionKey: conditionKeyFromIssue(fresh) });
    summary.dispatched.push(id);
    log(`[red-first] dispatched ${id} (${fresh.title})`);
  }

  // BRO-4151: surface every skip this tick that isn't already-being-handled
  // (a live job, a very recent dispatch, an unresolved dispatched-comment) —
  // dry-run mutates nothing, so it never routes an alert either.
  if (!dryRun) {
    const issueByIdentifier = new Map((issues || []).map((i) => [i.identifier, i]));
    for (const skip of summary.skipped) {
      if (isSilentSkipReason(skip.reason)) continue;
      await surfaceSkip(d, skip, issueByIdentifier, log);
    }
  }

  // ── follow-up phase ──
  const tracked = d.readTrackedLedger();
  if (!tracked) { log('[red-first] tracked ledger unreadable from origin/main — follow-up sweep skipped this tick'); return summary; }
  const journalNow = dryRun ? journal : d.readJournal();
  const openById = new Map((issues || []).map((i) => [i.identifier, i]));
  let applied = 0;
  for (const [key, cond] of Object.entries(tracked.conditions || {})) {
    if (applied >= MAX_FOLLOW_UPS_PER_TICK) break;
    if (!key.startsWith(RED_SIGNATURE_PREFIX) || !cond || cond.status !== 'resolved' || !cond.linearIdentifier) continue;
    const resolvedMs = Date.parse(cond.resolvedAt || '');
    if (!Number.isFinite(resolvedMs) || now - resolvedMs > FOLLOW_UP_WINDOW_MS) continue;
    const id = cond.linearIdentifier;
    if (latestJournalRow(journalNow, id, 'follow-up')) continue;
    const failures = journalNow.filter((r) => r && r.identifier === id && r.event === 'follow-up-failed').length;
    if (failures >= MAX_FOLLOW_UP_FAILURES) continue;
    const listed = openById.get(id);
    if (!listed) {
      // Already closed (or not this team's) — nothing to do, remember that.
      if (!dryRun) d.appendJournal({ event: 'follow-up', identifier: id, conditionKey: key, action: 'none', reason: 'not-open' });
      continue;
    }
    const live = openJobTaskIds.has(`linear:${id}`);
    let dispatched = live || !!cond.dispatch || !!latestJournalRow(journalNow, id, 'dispatch');
    let fresh = null;
    if (!live) {
      fresh = await d.getIssue(id);
      if (fresh && fresh.comments && fresh.comments.nodes) {
        if (fresh.comments.nodes.some((c) => String(c.body || '').includes(FOLLOW_UP_MARKER))) {
          if (!dryRun) d.appendJournal({ event: 'follow-up', identifier: id, conditionKey: key, action: 'none', reason: 'already-commented' });
          continue;
        }
        if (newestDispatchComment(fresh.comments.nodes)) dispatched = true;
      }
    }
    const stateType = (fresh && fresh.state && fresh.state.type) || (listed.state && listed.state.type);
    const action = decideCardFollowUp({ conditionStatus: cond.status, issueStateType: stateType, dispatched, live });
    summary.followUps.push({ identifier: id, conditionKey: key, action, live, dispatched });
    // 'leave' is a true no-op: not even a comment while the job is live, and
    // no journal row, so the card is re-evaluated (→ 'comment') once the job
    // has finished.
    if (action === 'none' || action === 'leave') continue;
    if (dryRun) { log(`[red-first] DRY-RUN follow-up ${id}: ${action} (${key})`); continue; }
    const body = followUpCommentBody({ action, conditionKey: key, resolvedAt: cond.resolvedAt, resolveReason: cond.resolveReason });
    const args = ['--comment', body];
    if (action === 'cancel') {
      args.push('--state', 'Canceled', '--cancel-reason',
        `BRO-4054 red-signature follow-up: condition ${key} resolved on main (${cond.resolveReason || 'job-green'}) and this card was never dispatched.`);
    }
    try {
      d.updateIssue(id, args);
      d.appendJournal({ event: 'follow-up', identifier: id, conditionKey: key, action });
      applied++;
      log(`[red-first] follow-up ${id}: ${action} (${key})`);
    } catch (err) {
      const msg = String((err && (err.stderr || err.message)) || err).trim().slice(0, 300);
      d.appendJournal({ event: 'follow-up-failed', identifier: id, conditionKey: key, action, error: msg });
      log(`[red-first] follow-up ${id} (${action}) FAILED: ${msg}`);
    }
  }
  return summary;
}

module.exports = {
  DAILY_CAP, ATTEMPT_COOLDOWN_MS, FOLLOW_UP_WINDOW_MS, MAX_FOLLOW_UPS_PER_TICK, FOLLOW_UP_MARKER, JOURNAL_PATH,
  utcDay, countDispatchesToday, conditionKeyFromIssue, isRedFirstCandidateIssue, isSilentSkipReason,
  selectRedFirstCandidates, decideCardFollowUp, followUpCommentBody,
  readJournal, appendJournal, readTrackedLedgerFromOrigin, runRedFirstPass,
};
