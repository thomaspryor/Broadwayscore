'use strict';

/**
 * land-stranded-refs.js — pure decisions for BRO-4802.
 *
 * The fast retry (land-retry-on-cancel.js + land-queue-backoff.js) re-runs an
 * evicted Land job only inside a window: Checks passed, run younger than
 * MAX_AGE_HOURS, attempt below MAX_ATTEMPTS. Everything outside that window
 * used to be abandoned: on 2026-10-06 nine land/** refs held finished work
 * that never reached main for 1-7 days. BRO-3619 spent all six attempts in six
 * minutes; BRO-1703 aged past 24h; BRO-934 and BRO-2358 were refused at land
 * time, and land.yml's only reaction was an owner-digest line nobody acts on.
 *
 * So every land/** ref still on origin gets one of:
 *   none     — landed, in flight, or the fast retry still owns it
 *   wait     — give it time (spacing between full re-runs, a fresh push)
 *   rerun    — evicted outside the fast window: re-run the WHOLE run, so
 *              Checks verify the current tip against today's main (land.yml
 *              lands only the tip its own Checks verified, --expect-tip)
 *   escalate — needs a worker: refused, red, budget spent, cancelled
 *              mid-landing, or no run ever fired for the tip. The caller
 *              routes it to the card the ref names.
 */

const { MAX_ATTEMPTS } = require('./land-retry-on-cancel');
const { MAX_AGE_HOURS } = require('./land-queue-backoff');

// One full re-run per ref per hour at most; the whole pass runs hourly.
const STRANDED_RETRY_MINUTES = 60;
// A full re-run repeats Checks (~30 min of runner time). Past this many
// attempts the ref needs a person or worker, not another lottery ticket.
const STRANDED_MAX_ATTEMPT = 20;
// A push whose Land run has not appeared after this long never will.
const NO_RUN_GRACE_MINUTES = 120;
const MARKER_PREFIX = 'LAND-STRANDED:';
// A ref idle this long is abandoned, not stranded: on 2026-10-06 origin held 80
// land/** refs, 50 last touched in September, many superseded by a later
// branch for the same card. Routing those would bounce long-finished cards
// back to Todo, so they are only counted (the caller reports them).
const ABANDONED_AFTER_DAYS = 14;
// Give the author time to react before a refusal or red run becomes someone
// else's work. Same thresholds as cloud-worker-pick.js's resume path
// (STRANDED_MS = 90 min since the run, IDLE_MS = 6 h since the card moved).
const REFUSAL_GRACE_MINUTES = 90;
const CARD_IDLE_HOURS = 6;
// An In Progress card belongs to its holder or to the resume path
// (cloud-worker-pick.js RESUME_WINDOW_MS = 7 d); only past that is it reopened.
const HELD_CARD_DAYS = 7;
// Transient whole-run failures: re-run like an eviction, no person needed.
const RERUNNABLE_CONCLUSIONS = new Set(['startup_failure', 'timed_out']);

const minutesSince = (iso, now) => (now - Date.parse(iso)) / 60000;

/** Completed, not landed, and idle past ABANDONED_AFTER_DAYS. Callers skip the jobs lookup for these. */
function isAbandonedRun(run, now = Date.now()) {
  return Boolean(run && run.status === 'completed' && run.conclusion !== 'success'
    && minutesSince(run.updated_at || run.created_at, now) > ABANDONED_AFTER_DAYS * 1440);
}

/**
 * @param {object} p
 * @param {string} p.tip - sha the land/** ref points at now
 * @param {?object} p.latestRun - newest land.yml run listed for the branch (push runs only;
 *   a workflow_dispatch run lists under main, so callers skip the pass while one is in flight)
 * @param {?Array} p.jobs - the latest attempt's jobs for latestRun (needed when it is not success)
 * @param {?string} p.tipCommittedAt - committer date of the tip (needed only when no run matches the tip)
 * @param {?string} p.cardLandedAt - newest successful Land run for the SAME card from another ref
 *   (a rebased or retry branch); a ref last run before that is a leftover, not lost work
 * @param {number} [p.now]
 * @returns {{action:'none'|'wait'|'rerun'|'escalate', reason:string}}
 */
function decideStrandedRef({ tip, latestRun, jobs, tipCommittedAt, cardLandedAt, now = Date.now() } = {}) {
  const out = (action, reason) => ({ action, reason });
  const landedMs = Date.parse(cardLandedAt || '');
  const lastMs = Date.parse((latestRun && (latestRun.updated_at || latestRun.created_at)) || tipCommittedAt || '');
  if (Number.isFinite(landedMs) && Number.isFinite(lastMs) && landedMs > lastMs
    && !(latestRun && latestRun.status !== 'completed')) return out('none', 'superseded');
  if (!latestRun || latestRun.head_sha !== tip) {
    if (latestRun && latestRun.status !== 'completed') return out('wait', 'older-tip-run-in-flight');
    const age = minutesSince(tipCommittedAt, now);
    if (!Number.isFinite(age)) return out('wait', 'tip-age-unknown');
    if (age > ABANDONED_AFTER_DAYS * 1440) return out('none', 'abandoned');
    return age < NO_RUN_GRACE_MINUTES ? out('wait', 'no-run-yet') : out('escalate', 'no-run-for-tip');
  }
  if (latestRun.status !== 'completed') return out('none', 'in-flight');
  if (latestRun.conclusion === 'success') return out('none', 'landed');
  if (isAbandonedRun(latestRun, now)) return out('none', 'abandoned');

  const byName = (n) => (jobs || []).find((j) => j.name === n);
  const checks = byName('Checks');
  const land = byName('Land');
  const attempt = latestRun.run_attempt || 1;

  if (latestRun.conclusion === 'cancelled' || RERUNNABLE_CONCLUSIONS.has(latestRun.conclusion)) {
    const landStarted = Boolean(land && (land.steps || []).some((s) => s.conclusion === 'success' || s.conclusion === 'failure'));
    if (landStarted) return out('escalate', 'land-cancelled-mid-flight');
    const fastOwned = checks && checks.conclusion === 'success'
      && attempt < MAX_ATTEMPTS
      && minutesSince(latestRun.created_at, now) < MAX_AGE_HOURS * 60;
    if (fastOwned) return out('none', 'fast-retry-owns');
    if (attempt >= STRANDED_MAX_ATTEMPT) return out('escalate', 'evicted-budget-exhausted');
    if (minutesSince(latestRun.updated_at || latestRun.created_at, now) < STRANDED_RETRY_MINUTES) return out('wait', 'spacing');
    return out('rerun', 'evicted-past-fast-retry');
  }

  if (minutesSince(latestRun.updated_at || latestRun.created_at, now) < REFUSAL_GRACE_MINUTES) return out('wait', 'fresh-failure');
  if (land && land.conclusion === 'failure') return out('escalate', 'land-refused');
  if (checks && checks.conclusion && checks.conclusion !== 'success') return out('escalate', 'checks-red');
  return out('escalate', `run-${latestRun.conclusion || 'unknown'}`);
}

/** Dedupe key written into the card comment: one escalation per run attempt (or per tip when no run fired). */
function strandedMarker({ branch, tip, latestRun, reason }) {
  const at = reason === 'no-run-for-tip' || !latestRun
    ? String(tip || '').slice(0, 12)
    : `${latestRun.id}#${latestRun.run_attempt || 1}`;
  return `${MARKER_PREFIX} ${branch}@${at} ${reason}`;
}

const REASON_TEXT = {
  'land-refused': 'the Land job refused it (most often the branch no longer rebases cleanly onto main, or a check that only runs at land time failed)',
  'checks-red': 'its Checks failed against main',
  'evicted-budget-exhausted': `it was evicted from the landing queue ${STRANDED_MAX_ATTEMPT}+ times`,
  'land-cancelled-mid-flight': 'its Land job was cancelled after it had started landing',
  'no-run-for-tip': 'no Land run ever started for the current tip of the branch',
  'rerun-refused': 'GitHub refused to re-run its last Land run (for example, older than the 30-day re-run limit)',
};

/**
 * Comment for the card a stranded ref names. States the facts and the resume
 * steps; the marker line makes a second post for the same run a no-op.
 */
function buildEscalationComment({ branch, tip, latestRun, reason }) {
  const why = REASON_TEXT[reason] || `its latest Land run ended ${reason}`;
  const runLine = latestRun && latestRun.html_url ? `Latest Land run: ${latestRun.html_url} (attempt ${latestRun.run_attempt || 1}).` : 'No Land run exists for this tip.';
  return [
    strandedMarker({ branch, tip, latestRun, reason }),
    '',
    `This card's work is NOT on main. It is stranded on \`${branch}\` (tip ${String(tip || '').slice(0, 12)}): ${why}.`,
    runLine,
    '',
    'To finish it: fetch that branch, rebase it onto origin/main (fix conflicts or the failing check), run its tests, and push the result to the SAME land branch (or a new land/** branch, then delete the old ref). Do not restart the work from scratch, and do not report done until the land ref is gone from origin.',
    '',
    'Posted by land-retry-cancelled.js --stranded (BRO-4802).',
  ].join('\n');
}

/**
 * What to do with the card the ref names:
 *   comment-and-reopen — In Review (someone believes it finished, but the work
 *                        is not on main), or In Progress held past
 *                        HELD_CARD_DAYS: back to Todo for a worker
 *   comment-only       — In Progress within HELD_CARD_DAYS (its holder or the
 *                        resume path owns it), Todo/Backlog (already waiting,
 *                        or paused on purpose), Done (often a superseded
 *                        attempt; the note keeps a wrong close findable)
 *   wait               — the card moved in the last CARD_IDLE_HOURS: someone
 *                        is on it; decide on a later pass
 *   log-only           — canceled/duplicate: abandoned on purpose
 *   skip-already-posted
 */
function escalationAction({ stateType, stateName, comments, marker, cardUpdatedAt, now = Date.now() }) {
  if ((comments || []).some((c) => String((c && c.body) || '').includes(marker))) return 'skip-already-posted';
  if (stateType === 'canceled' || stateType === 'duplicate') return 'log-only';
  const idleMin = minutesSince(cardUpdatedAt, now);
  if (Number.isFinite(idleMin) && idleMin < CARD_IDLE_HOURS * 60) return 'wait';
  if (stateType === 'started') {
    if (/review/i.test(stateName || '')) return 'comment-and-reopen';
    return Number.isFinite(idleMin) && idleMin > HELD_CARD_DAYS * 1440 ? 'comment-and-reopen' : 'comment-only';
  }
  return 'comment-only';
}

/**
 * One escalation per card: several refs often name the same card (a retry
 * branch after a refusal, v2/v3 attempts). Keep the most recently run one;
 * refs that name no card pass through for the caller to log.
 */
function newestPerCard(items, cardOf) {
  const best = new Map();
  const loose = [];
  for (const it of items || []) {
    const n = cardOf(it.branch);
    if (n == null) { loose.push(it); continue; }
    const at = (x) => Date.parse((x.latestRun && (x.latestRun.updated_at || x.latestRun.created_at)) || 0) || 0;
    if (!best.has(n) || at(it) > at(best.get(n))) best.set(n, it);
  }
  return [...best.values(), ...loose];
}

module.exports = {
  STRANDED_RETRY_MINUTES, STRANDED_MAX_ATTEMPT, NO_RUN_GRACE_MINUTES, MARKER_PREFIX, ABANDONED_AFTER_DAYS,
  REFUSAL_GRACE_MINUTES, CARD_IDLE_HOURS, HELD_CARD_DAYS,
  isAbandonedRun, decideStrandedRef, strandedMarker, buildEscalationComment, escalationAction, newestPerCard,
};
