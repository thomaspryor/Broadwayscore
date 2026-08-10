'use strict';

/**
 * opening-night-remediation.js — turn opening-night check results into action.
 *
 * WHY (task #389, Notion "Structural #8: User is doing QA the system should do"):
 * on 2026-04-15 the owner manually caught six things — a wrong-production BWW
 * review, a BWW Review Roundup listing 19 reviews to our 13, a missing Critics
 * Take, an unparsed Guardian 3/5, an unparsed NY Post 2/4, and an unexplained
 * score jump. Every one already had (or promptly got) a detector under
 * scripts/lib/opening-night-checks/. The gap was never detection — it was that
 * a failing check printed `run: node scripts/generate-critic-consensus.js
 * --show=X` and then nothing ran it. The owner was the dispatcher.
 *
 * SHAPE — checks self-declare, this module collects. A check opts into
 * remediation by putting `details.remediation` on its result; nothing here
 * switches on check name. That mirrors the convention already in
 * opening-night-checklist.js's remediateMissingReviews(), which acts on any
 * check emitting `details.missingReviews` and likewise never names a check.
 * Adding a 7th remediating check therefore touches exactly one file: that
 * check. (A central name-switch was the first draft; it was rejected in
 * pre-implementation review precisely because it made every new check edit
 * this file too.)
 *
 * Two remediation kinds:
 *   kind:'workflow' — dispatch a workflow_dispatch that already owns the fix
 *                     (right secrets, right checkouts, right push path).
 *                     Deliberately NOT inline execution: the hourly checklist
 *                     job never checks out review-texts and never pushes core
 *                     data, so running the recovery scripts in-process would
 *                     write files that die with the runner.
 *   kind:'alert'    — tell the owner, mutate nothing. For verdicts a heuristic
 *                     should not write into the scored corpus.
 *
 * Cooldown reuses decideRequeueAction() from orphan-rescore-requeue.js — the
 * same dispatch/wait/escalate decision the #356 self-heal already uses — so
 * the hourly cron cannot re-dispatch the same job every hour, and a job that
 * keeps needing re-dispatch escalates to the owner instead of looping forever.
 */

const { decideRequeueAction } = require('./orphan-rescore-requeue');

// 6h: long enough that an in-flight recover-explicit-ratings run (weekly job,
// 100-min budget, single global concurrency group) finishes or is visibly
// stuck before we consider re-dispatching; short enough that a genuine
// opening-night gap is retried the same night.
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// 2 auto-attempts per rolling 24h, then hand it to the owner. Same budget as
// orphan-rescore-requeue.js — a third automated attempt has never fixed
// anything the first two didn't.
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Lifetime ceiling, deliberately NOT windowed (task #389, 2026-08-10).
//
// DEFAULT_MAX_ATTEMPTS is a ROLLING budget: once the two attempts age out of
// the 24h window the key is eligible again, so a remediation whose target can
// never succeed re-dispatches two workflow runs per day, forever, and re-writes
// an 'escalated' ledger line every hour in between. That is what happened to
// `critic-consensus:death-note-the-musical-west-end-2026` — the show had one
// scored review, generate-critic-consensus.js refuses to write a consensus
// below its own floor, and the loop ran 5 dispatches + 23 escalations before a
// human noticed.
//
// Why a ceiling rather than teaching each check its target's preconditions:
// that mirror is not always constructible. The checklist job checks out
// core-data only, so critics-take-present can see reviews.json but NOT the
// review-text files the generator actually counts; measured against the live
// corpus, every reviews.json-derived proxy either over-counts (14 shows could
// still loop) or under-counts (15 shows silently stop being checked). A check
// SHOULD mirror a precondition it can see — and critics-take-present now does
// — but the layer that dispatches has to be the one that guarantees no
// remediation runs forever, because it is the only layer that knows a fix has
// been attempted and did not take.
//
// 4 = two full budget cycles. After that the owner has been told (escalation
// happens at attempt 2) and two more automatic attempts have failed to change
// anything, so the honest state is "automation is done with this", recorded
// once and then silent.
const DEFAULT_LIFETIME_MAX_ATTEMPTS = 4;
// How long a retired key stays quiet before it gets one more full budget cycle.
//
// Retirement is a COOLING-OFF, never a life sentence. Both pre-ship reviewers
// independently landed on the same objection to a permanent one: the reason a
// remediation could not succeed is usually a property of the show at that
// moment, not forever. death-note has 1 scored review today; when the missing
// West End reviews land it will have 4, and the Critics' Take it never got
// becomes generatable. A terminal state with no way out would convert today's
// noisy loop into tomorrow's silent permanent gap — trading a visible failure
// for an invisible one, which is the worse trade.
//
// 14 days is chosen against the actual cost being controlled. The loop being
// killed ran ~2 dispatches/day plus an hourly ledger line, indefinitely. One
// budget cycle per fortnight is ~1/14th the dispatch rate and bounded ledger
// growth, while still re-testing the world often enough that a show which
// picks up reviews gets its Critics' Take within two weeks.
const DEFAULT_RETIREMENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const VALID_KINDS = new Set(['workflow', 'alert']);

/**
 * Collect self-declared remediations from a checklist run.
 *
 * @param {Array<{show: Object, results: Array<Object>}>} showResults
 * @param {{onInvalid?: (info: Object) => void}} [opts] called for every dropped
 *   malformed spec. Default logs a GitHub Actions warning — a spec with a
 *   typo'd kind or a missing key must NEVER be dropped in silence: that is
 *   precisely the "detected, nobody acted" failure this whole feature exists
 *   to close, and a silent drop would recreate it one layer down.
 * @returns {Array<Object>} remediation specs, each stamped with showId/checkName,
 *   deduped by `key` (first occurrence wins).
 */
function collectRemediations(showResults, opts = {}) {
  const onInvalid = opts.onInvalid || ((info) => {
    console.warn(`::warning::opening-night remediation spec dropped as malformed (check=${info.checkName}, show=${info.showId}, kind=${JSON.stringify(info.kind)}, key=${JSON.stringify(info.key)}) — the check fired but nothing will act on it`);
  });
  const out = [];
  const seen = new Set();

  for (const entry of showResults || []) {
    const showId = entry?.show?.id;
    if (!showId) continue;

    for (const result of entry.results || []) {
      // Only failing checks remediate. `ok` is the check contract's "no
      // actionable problem" flag — a check that returns ok:true with a
      // remediation attached is a bug in that check, not a job to run.
      if (result?.ok !== false) continue;

      const raw = result?.details?.remediation;
      if (!raw) continue;
      const specs = Array.isArray(raw) ? raw : [raw];

      for (const spec of specs) {
        if (!spec || !VALID_KINDS.has(spec.kind) || !spec.key) {
          onInvalid({
            showId,
            checkName: result.name || null,
            kind: spec ? spec.kind : null,
            key: spec ? spec.key : null,
          });
          continue;
        }
        if (seen.has(spec.key)) continue;
        seen.add(spec.key);
        out.push({ ...spec, showId, checkName: result.name || null });
      }
    }
  }

  return out;
}

/**
 * Index prior remediation attempts by key from the shared remediation ledger.
 *
 * Reads data/audit/remediation-log.jsonl — the SAME ledger the BWW RR stub
 * path already writes to, distinguished by the `kind` field. A second ledger
 * file was the other rejected draft: dispatch-ledger.js's own header states
 * the rule ("one ledger ... a second ledger recreates the problem in a new
 * shape") and this repo already carries three cooldown stores.
 *
 * @param {string[]} lines - raw JSONL lines (caller does the fs read)
 * @returns {Map<string, Array<{at: string, ok: boolean}>>}
 */
function readAttempts(lines) {
  const byKey = new Map();
  for (const line of lines || []) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || !entry.key || !entry.at) continue;
    // Only real attempts count against the budget. 'waited'/'escalated' are
    // decisions ABOUT the budget — counting them would let a single cooldown
    // wait consume the retry budget it was protecting.
    if (entry.action !== 'dispatched' && entry.action !== 'failed') continue;
    if (!byKey.has(entry.key)) byKey.set(entry.key, []);
    byKey.get(entry.key).push({ at: entry.at, ok: entry.action === 'dispatched' });
  }
  // decideRequeueAction reads the LAST element as the most recent attempt, and
  // a rebase/merge of a JSONL can disturb append order (same caveat
  // owner-alert-router.js:readDispatchAttempts documents) — sort explicitly.
  for (const attempts of byKey.values()) {
    attempts.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }
  return byKey;
}

/**
 * When each key was last retired by the lifetime ceiling.
 *
 * Returns the LATEST 'gave-up' timestamp per key, not merely the fact of one,
 * because retirement expires (DEFAULT_RETIREMENT_TTL_MS) and the attempts that
 * earned it stop counting once it does — otherwise the first retirement would
 * be permanent no matter what the TTL said.
 *
 * Read separately from readAttempts() rather than folded into its return shape
 * so the attempt budget and the terminal marker stay independently testable,
 * and so adding this could not change what readAttempts() means to its existing
 * callers.
 *
 * @param {string[]} lines - raw JSONL lines
 * @returns {Map<string, number>} key -> epoch ms of the most recent give-up
 */
function readGiveUps(lines) {
  const out = new Map();
  for (const line of lines || []) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || !entry.key || entry.action !== 'gave-up') continue;
    const at = new Date(entry.at).getTime();
    // A give-up line with an unparseable/absent `at` still means "retired" —
    // fall back to now-equivalent 0 so it is treated as long expired rather
    // than silently dropped (dropping it would resurrect the loop).
    const stamp = Number.isFinite(at) ? at : 0;
    if (!out.has(entry.key) || stamp > out.get(entry.key)) out.set(entry.key, stamp);
  }
  return out;
}

/**
 * Decide what to do with each collected remediation.
 *
 * @param {Array<Object>} remediations - from collectRemediations()
 * @param {Map<string, Array<{at: string, ok: boolean}>>} attemptsByKey - from readAttempts()
 * @param {Date} now
 * @param {{cooldownMs?: number, maxAttempts?: number, windowMs?: number}} [opts]
 * @returns {Array<{remediation: Object, action: 'dispatch'|'wait'|'escalate', waitMs?: number, attempts: number}>}
 */
function planRemediations(remediations, attemptsByKey, now, opts = {}) {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const lifetimeMaxAttempts = opts.lifetimeMaxAttempts ?? DEFAULT_LIFETIME_MAX_ATTEMPTS;
  const retirementTtlMs = opts.retirementTtlMs ?? DEFAULT_RETIREMENT_TTL_MS;
  // Map<key, epoch ms> from readGiveUps().
  const gaveUpKeys = opts.gaveUpKeys || new Map();
  const nowMs = (now || new Date()).getTime();

  return (remediations || []).map((remediation) => {
    // kind:'alert' has no cooldown here on purpose — routeAlert() owns its own
    // dedup (open-incident + cooldownHours keyed on conditionKey). Adding a
    // second cooldown in front of it would mean two ledgers disagreeing about
    // whether the owner has been told.
    if (remediation.kind === 'alert') {
      return { remediation, action: 'dispatch', attempts: 0 };
    }

    const attempts = attemptsByKey.get(remediation.key) || [];

    // Retired and still inside the cooling-off window: stay silent. Not even a
    // ledger line — an hourly cron writing "still given up" forever is the same
    // noise in a new costume.
    const retiredAt = gaveUpKeys.get(remediation.key);
    if (retiredAt != null && nowMs - retiredAt < retirementTtlMs) {
      return { remediation, action: 'retired', attempts: attempts.length };
    }

    // Lifetime ceiling, checked before the rolling budget so an aged-out window
    // cannot resurrect a remediation that has already had its full run.
    //
    // Counts only attempts that actually REACHED the target (`ok`, i.e. ledger
    // action 'dispatched'). A 'failed' line means the dispatch never happened —
    // the commonest cause being 'no-token', which this module's own
    // dispatchWorkflow() returns whenever the checklist job runs without a
    // token and which the warning at the bottom of executeRemediations calls
    // out as "the whole self-healing layer is inert". Counting those would let
    // one credential outage burn the lifetime budget of EVERY key in about a
    // day and retire all of them permanently, with no path back once the token
    // was restored — turning a recoverable outage into silent, total loss of
    // auto-remediation. Failed attempts still count against the ROLLING budget
    // (below), which is what throttles a dispatch storm; that budget resets, so
    // an outage there is self-healing.
    //
    // Attempts made BEFORE the last retirement are spent — they bought that
    // retirement. Counting them again would make the TTL cosmetic: the key
    // would come off cooling-off and be re-retired on the very next run,
    // forever, which is the permanent-terminal-state design both pre-ship
    // reviewers rejected. Each expiry therefore grants a fresh cycle.
    const reachedTarget = attempts.filter(
      a => a.ok && (retiredAt == null || new Date(a.at).getTime() > retiredAt)
    ).length;
    if (reachedTarget >= lifetimeMaxAttempts) {
      return { remediation, action: 'give-up', attempts: reachedTarget };
    }

    const decision = decideRequeueAction(attempts, now, { cooldownMs, maxAttempts, windowMs });
    return {
      remediation,
      // decideRequeueAction's 'alert' means "attempt budget spent, a human
      // needs this" — renamed to 'escalate' here so it never reads as the
      // kind:'alert' remediation type.
      action: decision.action === 'alert' ? 'escalate' : decision.action,
      ...(decision.waitMs != null ? { waitMs: decision.waitMs } : {}),
      attempts: decision.recentAttempts.length,
    };
  });
}

/**
 * Carry out a plan. All I/O is injected so this is testable without a network,
 * a GitHub token, or a writable audit dir.
 *
 * @param {Array<Object>} planned - from planRemediations()
 * @param {Object} deps
 * @param {Date}   deps.now
 * @param {(workflow: string, inputs: Object) => Promise<{ok: boolean, error?: string}>} deps.dispatchWorkflow
 * @param {(opts: Object) => Promise<{action: string}>} deps.routeAlert
 * @param {(entry: Object) => void} deps.appendLedger
 * @param {boolean} [deps.disabled] - kill switch (OPENING_NIGHT_REMEDIATION_DISABLED)
 * @returns {Promise<{considered: number, dispatched: number, waited: number, escalated: number, alerted: number, failed: number, killed: number}>}
 */
async function executeRemediations(planned, deps) {
  const { now, dispatchWorkflow, routeAlert, appendLedger, disabled = false } = deps || {};
  // `suppressed` is tracked separately from `alerted` on purpose: routeAlert
  // owns a 7-day per-conditionKey cooldown and returns {action:'silent'} when
  // it suppresses. Counting those as `alerted` would make the stat read as
  // "the owner was told N times" when the owner was told once — the same
  // class of self-flattering metric as a gate that reports clean because it
  // scanned nothing.
  const stats = { considered: 0, dispatched: 0, waited: 0, escalated: 0, alerted: 0, suppressed: 0, failed: 0, killed: 0, gaveUp: 0, retired: 0 };
  const at = (now || new Date()).toISOString();

  for (const { remediation, action, waitMs, attempts } of planned || []) {
    stats.considered++;
    const base = {
      at,
      kind: remediation.kind,
      key: remediation.key,
      showId: remediation.showId,
      checkName: remediation.checkName,
      reason: remediation.reason || null,
    };

    if (disabled) {
      stats.killed++;
      appendLedger({ ...base, action: 'killed', why: 'OPENING_NIGHT_REMEDIATION_DISABLED' });
      continue;
    }

    // Retired on an earlier run. Write nothing at all — the whole point of the
    // terminal state is that the ledger stops growing.
    if (action === 'retired') {
      stats.retired++;
      continue;
    }

    // Crossing the lifetime ceiling: record it exactly once, dispatch nothing,
    // alert nothing. The owner already got the escalation at attempt 2; this
    // line is the automation saying it has stopped, which is what makes
    // "no ledger activity" readable as "resolved or retired" rather than
    // ambiguous silence.
    if (action === 'give-up') {
      stats.gaveUp++;
      appendLedger({
        ...base,
        action: 'gave-up',
        attempts,
        workflow: remediation.workflow || null,
        why: `lifetime attempt ceiling reached (${attempts}) — cooling off for ${Math.round(DEFAULT_RETIREMENT_TTL_MS / 86400000)}d before any further automatic attempt`,
      });
      console.warn(`::warning::opening-night remediation retired ${remediation.key} after ${attempts} attempts — ${remediation.workflow || remediation.kind} never resolved the check; retrying in ${Math.round(DEFAULT_RETIREMENT_TTL_MS / 86400000)}d`);
      continue;
    }

    if (action === 'wait') {
      stats.waited++;
      appendLedger({ ...base, action: 'waited', waitMs, attempts });
      continue;
    }

    if (action === 'escalate') {
      // Budget spent. Tell the owner ONCE (routeAlert dedups on conditionKey)
      // that auto-remediation gave up, rather than silently retrying forever
      // or silently stopping — the "write-only" failure mode of #689/#690.
      let routed = null;
      try {
        routed = await routeAlert({
          conditionKey: `opening-night-remediation-exhausted-${remediation.key}`,
          title: `Auto-remediation gave up on ${remediation.showId}`,
          description: `${remediation.checkName || 'check'} keeps failing after ${attempts} automatic attempt(s) in 24h. Remaining fix: ${remediation.workflow || remediation.kind} ${JSON.stringify(remediation.inputs || {})}`,
          severity: 'warning',
          disposition: 'digest',
        });
      } catch (err) {
        appendLedger({ ...base, action: 'failed', why: `escalation alert threw: ${err?.message || String(err)}` });
        stats.failed++;
        continue;
      }
      // Same distinction the kind:'alert' branch below makes, for the same
      // reason: routeAlert returns {action:'silent'} when its own conditionKey
      // cooldown suppressed the notification, and an hourly cron will hit that
      // branch every hour for a single incident. Counting those as 'escalated'
      // made the stat read "the owner was told 23 times" when the owner was
      // told once (task #389, observed on
      // critic-consensus:death-note-the-musical-west-end-2026).
      if (routed?.action === 'silent') {
        stats.suppressed++;
        appendLedger({ ...base, action: 'suppressed', why: 'escalation alert-router cooldown', attempts });
      } else {
        stats.escalated++;
        appendLedger({ ...base, action: 'escalated', attempts, routed: routed?.action || null });
      }
      continue;
    }

    // action === 'dispatch'
    if (remediation.kind === 'alert') {
      let routed = null;
      try {
        routed = await routeAlert({
          conditionKey: remediation.conditionKey,
          title: remediation.title,
          description: remediation.description || '',
          severity: remediation.severity || 'warning',
          // 'digest', never 'human': the morning digest is the owner-visible
          // channel that does not page at 2am, and 'human' additionally has to
          // clear the page-worthy allowlist + the human-caller digest baseline
          // gate (scripts/audit-alert-senders.js).
          disposition: 'digest',
        });
      } catch (err) {
        stats.failed++;
        appendLedger({ ...base, action: 'failed', why: `alert threw: ${err?.message || String(err)}` });
        continue;
      }
      // routeAlert returns {action:'silent'} when its own conditionKey cooldown
      // suppressed the notification. That is NOT an alert the owner received,
      // and the ledger must not call it 'dispatched' — the hourly cron would
      // otherwise write one "dispatched" line per hour for a single incident.
      if (routed?.action === 'silent') {
        stats.suppressed++;
        appendLedger({ ...base, action: 'suppressed', why: 'alert-router cooldown', conditionKey: remediation.conditionKey });
      } else {
        stats.alerted++;
        appendLedger({ ...base, action: 'dispatched', routed: routed?.action || null, conditionKey: remediation.conditionKey });
      }
      continue;
    }

    // kind === 'workflow'
    let result;
    try {
      result = await dispatchWorkflow(remediation.workflow, remediation.inputs || {});
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) };
    }
    if (result && result.ok) {
      stats.dispatched++;
      appendLedger({ ...base, action: 'dispatched', workflow: remediation.workflow, inputs: remediation.inputs || {} });
    } else {
      stats.failed++;
      const why = result?.error || 'unknown dispatch failure';
      appendLedger({ ...base, action: 'failed', workflow: remediation.workflow, inputs: remediation.inputs || {}, why });
      // Surface in the Actions log. 'no-token' especially: it means the whole
      // self-healing layer is inert while detection keeps reporting normally —
      // the vacuous-gate shape (looks like it ran, did nothing). Annotation
      // only; the checklist's 0/1/3 exit contract is deliberately unchanged.
      console.warn(`::warning::opening-night remediation failed to dispatch ${remediation.workflow} for ${remediation.showId}: ${why}`);
    }
  }

  return stats;
}

const REPO_OWNER = process.env.GITHUB_REPOSITORY?.split('/')?.[0] || 'thomaspryor';
const REPO_NAME = process.env.GITHUB_REPOSITORY?.split('/')?.[1] || 'Broadwayscore';

/**
 * Real workflow_dispatch. Same shape and same never-throws contract as
 * scripts/lib/dispatch-rescore.js:dispatchRescore.
 *
 * @param {string} workflow - workflow FILE name, e.g. 'update-critic-consensus.yml'
 * @param {Object} inputs
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function dispatchWorkflow(workflow, inputs) {
  const token = process.env.GITHUB_TOKEN || process.env.REVIEW_TEXTS_TOKEN;
  if (!token) return { ok: false, error: 'no-token' };

  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${workflow}/dispatches`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-opening-night-remediation',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: inputs || {} }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `${res.status} ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  collectRemediations,
  readAttempts,
  readGiveUps,
  planRemediations,
  executeRemediations,
  dispatchWorkflow,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MS,
  DEFAULT_LIFETIME_MAX_ATTEMPTS,
  DEFAULT_RETIREMENT_TTL_MS,
};
