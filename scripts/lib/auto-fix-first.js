'use strict';
/**
 * Auto-fix first (BRO-5477, owner decision 2026-10-16): an opening-night
 * pipeline failure files a START-NOW fix card for a cloud worker instead of
 * emailing the owner. The owner is emailed only when the fix fails:
 *   - still failing 3h after the card was filed, or
 *   - no worker started the card within 3h, or
 *   - failing again more than 1h after a worker closed the card, or
 *   - the card could not be filed at all (right away, as before).
 * A fix that ran and did not hold (still red, stalled, canceled, red again
 * after Done) first files a second attempt (BRO-5541): the owner is emailed
 * only when that one fails too. After the email, nothing more is sent about
 * this key until its cards age out of LOOKBACK_MS; a failure after that
 * starts a fresh first attempt. Owner emails never ask him to open Claude.
 * Which alerts take this path: page-worthy-alerts.js AUTO_FIX_FIRST_*.
 *
 * State lives on the Linear card (no ledger fields): its line
 * `auto-fix-first-key: <key>` finds it, `auto-fix-first-attempt: N` says which
 * try it is (missing = 1), its state/dates say whether a fix ran, and an
 * `AUTO-FIX-FIRST ESCALATED` comment says the owner was told. A card older
 * than LOOKBACK_MS is a past incident and does not count.
 *
 * Escalation always needs evidence the pipeline is still red (a failing run
 * seen after the window), except "no worker started it". So a fix that cannot
 * be proven green yet (the poller has no cron) never pages on its own.
 *
 * decide() and the text builders are pure; gate()/sweep() take their IO as
 * deps so tests run without Linear or GitHub. defaultDeps() holds the real IO.
 */

const { parseSessionReportStatus } = require('./linear-session-reporting.js');
const { parseRecheckAfter } = require('./recheck-stamp.js');
const { fetchGitHubJSON } = require('./gh-api-client.js');

const HOUR_MS = 3600000;
const WINDOW_MS = 3 * HOUR_MS;
const LOOKBACK_MS = 24 * HOUR_MS;
const GRACE_MS = HOUR_MS;
const KEY_LINE_PREFIX = 'auto-fix-first-key: ';
const ATTEMPT_LINE_PREFIX = 'auto-fix-first-attempt: ';
const MAX_ATTEMPTS = 2;
// A fix that ran and did not hold gets a second try. Not 'not-started': no
// worker picked the card up in 3h, so a second card in the same pool would
// only add 3h before the owner hears (BRO-5541 review).
const RETRY_REASONS = new Set(['still-red', 'stalled', 'fix-canceled', 'red-after-fix']);
const ESCALATED_MARKER = 'AUTO-FIX-FIRST ESCALATED';
const SUPERSEDED_MARKER = 'AUTO-FIX-FIRST SUPERSEDED';
const WORKFLOW_KEY_PREFIX = 'workflow-red:';
// The two workflows whose manual dispatch sends email, creates Resend drafts
// or dispatches deploys (CLAUDE.md §17). A fix worker must never re-run them
// to prove a fix.
const NEVER_DISPATCH = ['opening-night-broadcast.yml', 'opening-night-poller.yml'];

function workflowKey(workflowFile) {
  const base = String(workflowFile || '').split('@')[0].split('/').pop();
  return `${WORKFLOW_KEY_PREFIX}${base}`;
}

function workflowFromKey(key) {
  return String(key || '').startsWith(WORKFLOW_KEY_PREFIX) ? String(key).slice(WORKFLOW_KEY_PREFIX.length) : null;
}

function cardLine(card, prefix) {
  const lines = String((card && card.description) || '').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(prefix)) return t.slice(prefix.length).trim();
  }
  return null;
}

/** PURE. The key this card was filed for, from its exact key line. */
function cardKey(card) {
  return cardLine(card, KEY_LINE_PREFIX);
}

/** PURE. Which automatic attempt this card is (1 when the line is missing). */
function cardAttempt(card) {
  const n = parseInt(cardLine(card, ATTEMPT_LINE_PREFIX), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
}

// Duplicate is terminal too: a racing second card closed as Duplicate must not
// stay "open" and page as not-started while the real card is being worked.
function isOpen(card) {
  const type = card && card.state && card.state.type;
  return !require('./linear-state-types.js').isTerminalStateType(type);
}

// Being worked on right now. A worker that gives up moves the card back to
// Todo/Backlog (startedAt stays set), which counts as not started again.
function isStarted(card) {
  const type = card && card.state && card.state.type;
  return type === 'started';
}

function closedAtMs(card) {
  return ms(card && (card.completedAt || card.canceledAt));
}

/**
 * PURE. When a worker parked this card with its fix already landed, as ms; else
 * null. A stamp alone is trusted as "fix landed"; a later red run still
 * escalates (decideAttempt), so a wrong trust costs a late email, never a silent one.
 * linear-session.js writes `**Session report (paused)**` plus a
 * `RECHECK-AFTER` stamp (colon optional, shared parser) when a fix only shows on a later scheduled run (the
 * poller has no cron). The card goes back to Backlog, which reads as "not
 * started", but a fix exists: it must wait for proof, not page the owner
 * (BRO-5835: BRO-5716 was claimed 20:53Z, fixed 21:06Z, parked 21:33Z, and
 * emailed as "nobody picked it up" at 00:10Z while the poller was green).
 */
function fixParkedAt(card) {
  const created = ms(card && card.createdAt);
  let newest = null;
  for (const c of (card && card.comments) || []) {
    const body = String((c && c.body) || '');
    if (parseSessionReportStatus(body) !== 'paused' || parseRecheckAfter(body) === null) continue;
    const at = ms(c.createdAt);
    if (at !== null && (created === null || at >= created) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

function isEscalated(card) {
  const comments = (card && card.comments) || [];
  return comments.some((c) => String((c && c.body) || '').includes(ESCALATED_MARKER));
}

/**
 * PURE. What to do about a page-worthy failure of an auto-fix-first alert.
 * @param {object} p
 * @param {Array} p.cards cards whose key line matches this key (any age)
 * @param {number|null} p.redObservedAt ms of the newest red evidence, or null
 * @param {number} p.nowMs
 * @param {boolean} p.canFile true on a fresh failure (gate), false in the sweep
 * 'retry' = file attempt N+1 (verdict.attempt) instead of emailing.
 * @returns {{action:'file'|'none'|'hold'|'escalate'|'retry', reason:string, card?:object, attempt?:number}}
 */
function decide({ cards, redObservedAt, nowMs, canFile, windowMs = WINDOW_MS, lookbackMs = LOOKBACK_MS, graceMs = GRACE_MS }) {
  const recent = (cards || []).filter((c) => {
    const created = ms(c && c.createdAt);
    return created !== null && nowMs - created < lookbackMs;
  });
  // The owner was told already: say nothing more until the cards age out.
  const escalated = recent.find(isEscalated);
  if (escalated) return { action: 'hold', reason: 'already-escalated', card: escalated };
  const latest = recent.reduce((n, c) => Math.max(n, cardAttempt(c)), 0);
  const verdict = decideAttempt(recent.filter((c) => cardAttempt(c) === latest), { redObservedAt, nowMs, canFile, windowMs, graceMs });
  if (verdict.action === 'escalate' && RETRY_REASONS.has(verdict.reason) && latest < MAX_ATTEMPTS) {
    return { ...verdict, action: 'retry', attempt: latest + 1 };
  }
  return verdict;
}

// decide() for the cards of one attempt.
function decideAttempt(recent, { redObservedAt, nowMs, canFile, windowMs, graceMs }) {
  const open = recent.filter(isOpen).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const red = Number.isFinite(redObservedAt) ? redObservedAt : null;
  if (open.length) {
    const card = open[0];
    const created = ms(card.createdAt);
    if (nowMs - created < windowMs) return { action: 'hold', reason: 'fix-window', card };
    if (!isStarted(card)) {
      const parked = fixParkedAt(card);
      if (parked === null) return { action: 'escalate', reason: 'not-started', card };
      // Same rule as a Done card: red only counts after the fix landed, and the
      // grace hour covers a run already in flight when the worker parked it.
      if (red !== null && red > parked && nowMs >= parked + graceMs) return { action: 'escalate', reason: 'still-red', card };
      return { action: 'hold', reason: 'fix-parked-awaiting-proof', card };
    }
    if (red !== null && red >= created + windowMs) return { action: 'escalate', reason: 'still-red', card };
    // A crashed fix session leaves the card In Progress forever, and the
    // poller (no cron) may never show red again: give up waiting at 2x window.
    // No red at all means the newest run passed, so there is nothing to page.
    if (red !== null && nowMs - created >= 2 * windowMs) return { action: 'escalate', reason: 'stalled', card };
    return { action: 'hold', reason: 'fix-in-progress', card };
  }
  const closed = recent.filter((c) => closedAtMs(c) !== null).sort((a, b) => closedAtMs(b) - closedAtMs(a));
  if (closed.length) {
    // A Done card passed its VERIFY (check-workflow-run-status --expect=success
    // or the alert-absent check), so it is evidence of a fix. Canceled cards
    // are not: if every recent card was canceled, nobody fixed it.
    const done = closed.filter((c) => c.state && c.state.type === 'completed');
    // A canceled fix only matters if the pipeline failed again after it.
    if (!done.length) {
      return red !== null && red > closedAtMs(closed[0])
        ? { action: 'escalate', reason: 'fix-canceled', card: closed[0] }
        : { action: 'hold', reason: 'fix-canceled-green', card: closed[0] };
    }
    const card = done[0];
    // Red after Done is a failed fix. The grace hour only delays the page (a
    // run already in flight at close); it never excuses the red for good, or a
    // failure inside that hour would hold here forever (the gate holds it and
    // every sweep re-reads the same run until the card ages out).
    if (red !== null && red > closedAtMs(card) && nowMs >= closedAtMs(card) + graceMs) return { action: 'escalate', reason: 'red-after-fix', card };
    return { action: 'hold', reason: 'fix-just-closed', card };
  }
  return canFile ? { action: 'file', reason: 'no-card' } : { action: 'none', reason: 'no-card' };
}

/** PURE. The card's VERIFY command, a SAFE_CHECK_FORMS form. */
function verifyCommandFor(key) {
  const wf = workflowFromKey(key);
  if (wf) return `node scripts/check-workflow-run-status.js --workflow=${wf} --expect=success`;
  return require('./health-row-check-cmd.js').alertAbsentCheckCmd(key);
}

function utc(msValue) {
  return new Date(msValue).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * PURE. Title + description of the START-NOW fix card. attempt 2 (BRO-5541)
 * names the first card, so the second worker starts from its outcome.
 */
function buildCard({ key, alertTitle, alertDescription = '', runUrl = '', nowMs, attempt = 1, previous = null }) {
  const deadline = utc(nowMs + WINDOW_MS);
  const wf = workflowFromKey(key);
  const proof = wf
    ? `Prove it with unit tests, then let the next scheduled run of ${wf} go green. Do NOT dispatch ${NEVER_DISPATCH.join(' or ')} by hand: they send emails, create Resend drafts and dispatch deploys (CLAUDE.md section 17).`
    : `Prove it with unit tests; the check below goes green once the hourly check stops seeing the condition. Do NOT dispatch ${NEVER_DISPATCH.join(' or ')} by hand: they send emails, create Resend drafts and dispatch deploys (CLAUDE.md section 17).`;
  const retry = attempt > 1;
  const prevRef = previous ? (previous.url || previous.identifier || 'the first fix card') : 'the first fix card';
  const description = [
    retry
      ? `START-NOW: opening-night pipeline failure, automatic fix attempt ${attempt} (BRO-5541). The first attempt (${prevRef}) did not hold. Any worker may take it. The owner is emailed if it is still failing at ${deadline} or nobody has started it by then.`
      : `START-NOW: opening-night pipeline failure, auto-fix first (BRO-5477). Any worker may take it. The owner is emailed if it is still failing at ${deadline} or nobody has started it by then.`,
    '',
    `${KEY_LINE_PREFIX}${key}`,
    '',
    retry ? `${ATTEMPT_LINE_PREFIX}${attempt}` : null,
    retry ? '' : null,
    retry ? `Read ${prevRef} first (description, comments, linked commits): its fix did not hold, so find what it missed rather than repeating it.` : null,
    retry ? '' : null,
    `What failed: ${alertTitle}`,
    alertDescription ? String(alertDescription).slice(0, 2000) : null,
    runUrl ? `Failing run: ${runUrl}` : null,
    '',
    `What to do: find the root cause in the failing run's logs, fix it and land the fix. ${proof}`,
    '',
    `VERIFY: ${verifyCommandFor(key)}`,
  ].filter((l) => l !== null).join('\n');
  return { title: `${retry ? 'Auto-fix (second try)' : 'Auto-fix'}: ${alertTitle}`.slice(0, 200), description };
}

/** PURE. The alert title a fix card was filed for (for a retry's title). */
function alertTitleOf(card) {
  return String((card && card.title) || 'opening-night pipeline failure').replace(/^Auto-fix(?: \(second try\))?: /, '');
}

// What broke, in the owner's words, for the three workflows; any other key
// falls back to the alert title.
const PLAIN_NAMES = {
  'opening-night-poller.yml': 'The opening-night review poller',
  'opening-night-orchestrator.yml': 'The nightly opening-night review collection',
  'opening-night-broadcast.yml': 'The opening-night subscriber email',
};

/** PURE. "The opening-night review poller", or the alert title. */
function plainName(key, alertTitle) {
  return PLAIN_NAMES[workflowFromKey(key)] || alertTitle || 'An opening-night pipeline step';
}

/**
 * PURE. The plain-English opening of the owner's escalation email: what is
 * broken, what was tried, what the automation does next. Owner rule
 * (2026-10-16): never ask him to open Claude or do what a computer can do.
 */
function escalationPreamble({ reason, card, error, nowMs, what = 'An opening-night pipeline step' }) {
  const created = card && ms(card.createdAt);
  const hours = created ? Math.max(1, Math.round((nowMs - created) / HOUR_MS)) : null;
  const tries = card && cardAttempt(card) >= 2 ? 'Two automatic fixes were tried.' : 'An automatic fix was tried.';
  const last = card && cardAttempt(card) >= 2 ? 'The second' : 'It';
  const queued = card && cardAttempt(card) >= 2 ? 'A second automatic fix' : 'An automatic fix';
  let first;
  if (reason === 'not-started') {
    // startedAt survives a worker handing the card back (see isStarted).
    const picked = card && card.startedAt
      ? 'a fix session started on it but stopped without a fix'
      : `no fix session picked it up in ${hours} hours`;
    first = `${what} is failing. ${queued} was queued at ${utc(created)}, but ${picked}. The fix card stays open, so the next free fix session takes it.`;
  } else if (reason === 'still-red') {
    first = `${what} is still failing. ${tries} ${last} was queued at ${utc(created)} and it is still failing ${hours} hours later.`;
  } else if (reason === 'stalled') {
    first = `${what} is still failing. ${tries} ${last} was queued at ${utc(created)} and has not finished ${hours} hours later.`;
  } else if (reason === 'fix-canceled') {
    first = `${what} is still failing. ${tries} ${last} was closed without a fix.`;
  } else if (reason === 'red-after-fix') {
    first = `${what} is still failing. ${tries} ${last} finished at ${utc(closedAtMs(card))}, but it failed again afterwards.`;
  } else {
    const why = error ? ` (${String(error).slice(0, 160)})` : '';
    return `${what} is failing, and the automatic fix could not be started${why}, so you are being told right away.\n${card
      ? `The automation will not email you about this again before ${utc(ms(card.createdAt) + LOOKBACK_MS)}. If it is still failing after that, it tries to start a fix again by itself.`
      : 'The automation tries to start a fix again the next time this fails.'}`;
  }
  const quiet = created
    ? `will not email you about this again before ${utc(created + LOOKBACK_MS)}. If it is still failing after that, it starts a new automatic fix by itself.`
    : 'will not email you about this again today.';
  const next = reason === 'not-started' ? `The automation ${quiet}` : `The automation has stopped retrying for now and ${quiet}`;
  return `${first}\n${next}`;
}

/** PURE. The owner email's subject, for the gate's and the sweep's sends. */
function escalationTitle({ reason, what }) {
  if (reason === 'file-failed') return `${what} is failing and the automatic fix could not be started`;
  if (reason === 'not-started') return `${what} is failing and no automatic fix has started`;
  return `${what} is still failing after the automatic fixes`;
}

// The sweep's escalation goes through routeAlert() under this page-worthy key
// (prefix in page-worthy-alerts.js), one condition per fix card.
const ESCALATION_KEY_PREFIX = 'auto-fix-first:escalation:';
function escalationConditionKey(card) {
  return `${ESCALATION_KEY_PREFIX}${(card && (card.identifier || card.id)) || 'unknown'}`;
}

/**
 * The Resend Idempotency-Key for a card's escalation: the same key routeAlert()
 * derives for escalationConditionKey(card), so the gate's direct send and the
 * sweep's routed send dedupe against each other when the marker comment fails
 * to save or two runs race. Resend keeps a key 24h, so a repeat across a 24h
 * bucket edge is possible; the marker comment and the router ledger cover that.
 */
function escalationIdempotencyKey(card, nowMs = Date.now()) {
  const router = require('./owner-alert-router.js');
  return router.alertIdempotencyKey(escalationConditionKey(card), router.DEFAULT_COOLDOWN_HOURS, nowMs);
}

function escalationComment({ reason, nowMs }) {
  return `${ESCALATED_MARKER} ${utc(nowMs)}: emailed the owner (${reason}). This alert sends nothing more until this card is 24h old; a failure after that starts a new first attempt.`;
}

function supersededComment({ next, attempt, reason, nowMs }) {
  return `${SUPERSEDED_MARKER} ${utc(nowMs)}: this fix did not hold (${reason}); automatic attempt ${attempt} is ${(next && (next.url || next.identifier)) || 'filed'}.`;
}

// Check, then file: a card no worker would pick fails loud instead.
async function fileFixCard(d, card, model) {
  const unpickable = require('./cloud-worker-pick.js').startNowUnpickableReason({ title: card.title, description: card.description, priority: 2, mode: 'dispatch' });
  if (unpickable) throw new Error(`fix card would never be picked (${unpickable.reason})`);
  return d.fileCard(model ? { ...card, model } : card);
}

/**
 * File the next automatic attempt for a fix that did not hold, then retire the
 * old card (comment, and cancel it if still open so two workers never share
 * one fix). Throws only if filing fails; retiring is best effort.
 */
async function fileRetry(d, verdict, { key, alertTitle, alertDescription, runUrl, nowMs }) {
  const card = buildCard({ key, alertTitle: alertTitle || alertTitleOf(verdict.card), alertDescription, runUrl, nowMs, attempt: verdict.attempt, previous: verdict.card });
  const filed = await fileFixCard(d, card, 'opus');
  await d.supersede(verdict.card, supersededComment({ next: filed, attempt: verdict.attempt, reason: verdict.reason, nowMs })).catch((e) => {
    console.error(`[auto-fix-first] could not retire ${verdict.card.identifier}: ${e.message}`);
  });
  return filed;
}

/**
 * Gate one page-worthy failure. Never throws: any error emails (fail loud).
 * After a delivered escalation the caller calls result.markEscalated().
 * @returns {Promise<{email:boolean, action:string, reason:string, card?:object, preamble?:string, markEscalated:Function}>}
 */
async function gate({ key, alertTitle, alertDescription, runUrl, nowMs = Date.now(), env = process.env, deps }) {
  const noop = async () => {};
  if (require('./page-worthy-alerts.js').autoFixFirstDisabled(env)) {
    return { email: true, action: 'disabled', reason: 'kill-switch', markEscalated: noop };
  }
  const what = plainName(key, alertTitle);
  let d;
  try {
    d = deps || defaultDeps();
    const cards = await d.lookupCards(key, nowMs);
    const verdict = decide({ cards, redObservedAt: nowMs, nowMs, canFile: true });
    if (verdict.action === 'file') {
      const filed = await fileFixCard(d, buildCard({ key, alertTitle, alertDescription, runUrl, nowMs }));
      return { email: false, action: 'file', reason: 'no-card', card: filed, markEscalated: noop };
    }
    if (verdict.action === 'retry') {
      const filed = await fileRetry(d, verdict, { key, alertTitle, alertDescription, runUrl, nowMs });
      return { email: false, action: 'retry', reason: verdict.reason, card: filed, markEscalated: noop };
    }
    if (verdict.action === 'hold') return { email: false, ...verdict, markEscalated: noop };
    if (verdict.action === 'escalate') {
      return {
        email: true,
        ...verdict,
        preamble: escalationPreamble({ reason: verdict.reason, card: verdict.card, nowMs, what }),
        markEscalated: () => d.comment(verdict.card, escalationComment({ reason: verdict.reason, nowMs })).catch((e) => {
          console.error(`[auto-fix-first] could not mark ${verdict.card.identifier} escalated: ${e.message}`);
        }),
      };
    }
    return { email: true, ...verdict, markEscalated: noop };
  } catch (e) {
    console.error(`[auto-fix-first] ${key}: ${e.message} -- emailing the owner now`);
    return { email: true, action: 'file-failed', reason: 'file-failed', error: e.message, preamble: escalationPreamble({ reason: 'file-failed', error: e.message, nowMs, what }), markEscalated: noop };
  }
}

/**
 * Hourly sweep (opening-night-checklist.yml): acts on workflow incidents whose
 * fix window passed without a new paging failure (a once-a-night
 * orchestrator, or a storm the 2h notify cooldown keeps quiet). Files only a
 * second attempt, never a first card.
 */
async function sweep({ nowMs = Date.now(), env = process.env, deps }) {
  const policy = require('./page-worthy-alerts.js');
  if (policy.autoFixFirstDisabled(env)) return [];
  const d = deps || defaultDeps();
  const out = [];
  for (const wf of policy.AUTO_FIX_FIRST_WORKFLOWS) {
    const key = workflowKey(wf);
    const what = plainName(key);
    // One workflow's Linear/GitHub error must not stop the others' sweep.
    try {
      const cards = await d.lookupCards(key, nowMs);
      if (!cards.length) continue;
      // Can't read the runs: assume still red, so a GitHub outage cannot
      // silence a failed fix (fail loud, same as gate()).
      const redObservedAt = await d.latestRedAt(wf).catch((e) => {
        console.error(`[auto-fix-first] ${wf}: ${e.message} -- treating as still red`);
        return nowMs;
      });
      const verdict = decide({ cards, redObservedAt, nowMs, canFile: false });
      if (verdict.action === 'retry') {
        try {
          const filed = await fileRetry(d, verdict, { key, nowMs });
          out.push({ key, ...verdict, card: filed && filed.identifier });
          continue;
        } catch (e) {
          // Keep: a fix card that cannot be filed emails at once.
          console.error(`[auto-fix-first] ${wf}: second attempt not filed (${e.message}) -- emailing the owner now`);
          const delivered = await d.sendEscalation({
            title: escalationTitle({ reason: 'file-failed', what }),
            description: escalationPreamble({ reason: 'file-failed', card: verdict.card, error: e.message, nowMs, what }),
            url: verdict.card.url,
            conditionKey: escalationConditionKey(verdict.card),
          });
          if (delivered) await d.comment(verdict.card, escalationComment({ reason: 'file-failed', nowMs }));
          out.push({ key, action: 'escalate', reason: 'file-failed', card: verdict.card.identifier });
          continue;
        }
      }
      out.push({ key, ...verdict, card: verdict.card && verdict.card.identifier });
      if (verdict.action !== 'escalate') continue;
      const delivered = await d.sendEscalation({
        title: escalationTitle({ reason: verdict.reason, what }),
        description: escalationPreamble({ reason: verdict.reason, card: verdict.card, nowMs, what }),
        url: verdict.card.url,
        conditionKey: escalationConditionKey(verdict.card),
      });
      if (delivered) await d.comment(verdict.card, escalationComment({ reason: verdict.reason, nowMs }));
    } catch (e) {
      out.push({ key, action: 'error', reason: e.message });
    }
  }
  return out;
}

// One definition of a failing run for the pager and the sweep (BRO-5541).
// Every auto-fix-first workflow pages from a step with this exact name
// (tests/unit/page-worthy-workflows.test.mjs pins it). Its `if:` decides
// whether a cancelled run is a failure: a timeout-minutes hang is, an Express
// takeover (check_preemption) is not, and a pending run replaced in the
// concurrency queue never ran it at all. The sweep reads that step's outcome
// instead of re-deriving the rule, so the two cannot disagree. Inherited
// blind spot: a real hang while ORCHESTRATOR_PAUSED is set is skipped by both.
const NOTIFY_STEP_NAME = 'Notify on failure';
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * PURE. Is this completed run a failure? jobs = GET /runs/{id}/jobs .jobs, only
 * needed for a cancelled run: red when its Notify step ran (or was cut off),
 * not red when that step was skipped or the run never started a step.
 * Unknown jobs (undefined) count as red (fail loud).
 */
function runIsRed(run, jobs) {
  if (!run || run.status !== 'completed') return false;
  if (RED_CONCLUSIONS.has(run.conclusion)) return true;
  if (run.conclusion !== 'cancelled') return false;
  if (!Array.isArray(jobs)) return true;
  const steps = jobs.flatMap((j) => (j && j.steps) || []);
  if (!steps.length) return false;
  const notify = steps.filter((s) => s && s.name === NOTIFY_STEP_NAME);
  if (!notify.length) return true;
  return notify.some((s) => s.conclusion !== 'skipped');
}

// Decides the "newest decided run": success clears, red counts, anything else
// (skipped, neutral, a cancel that is not a failure) is passed over.
function decidesRun(run, jobs) {
  return run && run.status === 'completed' && (run.conclusion === 'success' || runIsRed(run, jobs));
}

/**
 * PURE. Newest red completion among GitHub runs (newest first), or null if the
 * newest decided run passed. jobsByRunId: run id -> jobs, for cancelled runs.
 */
function latestRedFromRuns(runs, jobsByRunId = {}) {
  for (const r of runs || []) {
    const jobs = r && jobsByRunId[r.id];
    if (!decidesRun(r, jobs)) continue;
    if (r.conclusion === 'success') return null;
    return ms(r.updated_at) || ms(r.created_at);
  }
  return null;
}

/**
 * latestRedFromRuns, fetching jobs only for the cancelled runs it meets before
 * the first deciding run. fetchJobs(id) -> jobs; a fetch error counts as red.
 */
async function latestRedAtFromRuns(runs, fetchJobs) {
  const jobsByRunId = {};
  for (const r of runs || []) {
    if (!r || r.status !== 'completed') continue;
    if (r.conclusion === 'cancelled') {
      jobsByRunId[r.id] = await Promise.resolve().then(() => fetchJobs(r.id)).catch((e) => {
        console.error(`[auto-fix-first] jobs for run ${r.id}: ${e.message} -- treating as red`);
        return undefined;
      });
    }
    if (decidesRun(r, jobsByRunId[r.id])) break;
  }
  return latestRedFromRuns(runs, jobsByRunId);
}

async function githubGet(urlPath) {
  const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
  return fetchGitHubJSON(`https://api.github.com/repos/${repo}${urlPath}`, { caller: 'auto-fix-first.js', timeoutMs: 20000, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
}

function defaultDeps() {
  const linear = require('./linear-client.js');
  return {
    async lookupCards(key, nowMs) {
      const since = new Date(nowMs - LOOKBACK_MS).toISOString();
      const issues = await linear.listIssuesByProvenance({ since, descriptionMarkers: [`${KEY_LINE_PREFIX}${key}`] });
      const mine = issues.filter((i) => cardKey(i) === key);
      if (!mine.length) return [];
      const comments = await linear.listIssueComments(mine.map((i) => i.identifier));
      return mine.map((i) => ({ ...i, comments: comments.get(i.identifier) || [] }));
    },
    async fileCard({ title, description, model }) {
      const { createLinearIssue } = require('./linear-issue-create.js');
      const { issue } = await createLinearIssue({ title, description, priority: 2, dispatch: true, model, dedupeOptOut: 'auto-fix-first' }); // see card-dedupe.js DEDUPE_OPT_OUTS
      return issue;
    },
    async comment(card, body) {
      await linear.createComment(card.id, body);
    },
    async supersede(card, body) {
      await linear.createComment(card.id, body);
      if (!isOpen(card)) return;
      const team = await linear.getTeam();
      const canceled = ((team.states && team.states.nodes) || []).find((st) => st.type === 'canceled');
      if (!canceled) throw new Error('no canceled state on the team');
      await linear.updateIssue(card.id, { stateId: canceled.id });
    },
    async latestRedAt(workflowFile) {
      const body = await githubGet(`/actions/workflows/${workflowFile}/runs?per_page=20`);
      return latestRedAtFromRuns(body.workflow_runs, async (id) => {
        const page = await githubGet(`/actions/runs/${id}/jobs?per_page=100`);
        // A truncated job list could hide the Notify step; undefined reads as red.
        return (page.jobs || []).length < (page.total_count || 0) ? undefined : page.jobs;
      });
    },
    async sendEscalation({ title, description, url, conditionKey }) {
      const { routeAlert } = require('./owner-alert-router.js');
      const result = await routeAlert({ conditionKey, title, description, url, severity: 'error', disposition: 'human' });
      return !!(result && result.delivered);
    },
  };
}

module.exports = {
  WINDOW_MS, LOOKBACK_MS, GRACE_MS, KEY_LINE_PREFIX, ATTEMPT_LINE_PREFIX, MAX_ATTEMPTS, RETRY_REASONS, ESCALATED_MARKER, SUPERSEDED_MARKER, NEVER_DISPATCH,
  NOTIFY_STEP_NAME, RED_CONCLUSIONS,
  workflowKey, workflowFromKey, cardKey, cardAttempt, decide, verifyCommandFor, buildCard, alertTitleOf, plainName,
  escalationPreamble, escalationTitle, escalationComment, escalationIdempotencyKey, escalationConditionKey, ESCALATION_KEY_PREFIX,
  runIsRed, latestRedFromRuns, latestRedAtFromRuns, gate, sweep, defaultDeps,
};
