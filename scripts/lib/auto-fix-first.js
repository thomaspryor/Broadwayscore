'use strict';
/**
 * Auto-fix first (BRO-5477, owner decision 2026-10-16): an opening-night
 * pipeline failure files a START-NOW fix card for a cloud worker instead of
 * emailing the owner. The owner is emailed only when the fix fails:
 *   - still failing 3h after the card was filed, or
 *   - no worker started the card within 3h, or
 *   - failing again more than 1h after a worker closed the card, or
 *   - the card could not be filed at all (right away, as before).
 * Which alerts take this path: page-worthy-alerts.js AUTO_FIX_FIRST_*.
 *
 * State lives on the Linear card (no ledger fields): its line
 * `auto-fix-first-key: <key>` finds it, its state/dates say whether a fix ran,
 * and an `AUTO-FIX-FIRST ESCALATED` comment says the owner was told. A card
 * older than LOOKBACK_MS is a past incident and does not count.
 *
 * Escalation always needs evidence the pipeline is still red (a failing run
 * seen after the window), except "no worker started it". So a fix that cannot
 * be proven green yet (the poller has no cron) never pages on its own.
 *
 * decide() and the text builders are pure; gate()/sweep() take their IO as
 * deps so tests run without Linear or GitHub. defaultDeps() holds the real IO.
 */

const HOUR_MS = 3600000;
const WINDOW_MS = 3 * HOUR_MS;
const LOOKBACK_MS = 24 * HOUR_MS;
const GRACE_MS = HOUR_MS;
const KEY_LINE_PREFIX = 'auto-fix-first-key: ';
const ESCALATED_MARKER = 'AUTO-FIX-FIRST ESCALATED';
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

/** PURE. The key this card was filed for, from its exact key line. */
function cardKey(card) {
  const lines = String((card && card.description) || '').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith(KEY_LINE_PREFIX)) return t.slice(KEY_LINE_PREFIX.length).trim();
  }
  return null;
}

function ms(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : null;
}

function isOpen(card) {
  const type = card && card.state && card.state.type;
  return type !== 'completed' && type !== 'canceled';
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
 * @returns {{action:'file'|'none'|'hold'|'escalate'|'pass', reason:string, card?:object}}
 */
function decide({ cards, redObservedAt, nowMs, canFile, windowMs = WINDOW_MS, lookbackMs = LOOKBACK_MS, graceMs = GRACE_MS }) {
  const recent = (cards || []).filter((c) => {
    const created = ms(c && c.createdAt);
    return created !== null && nowMs - created < lookbackMs;
  });
  const open = recent.filter(isOpen).sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const red = Number.isFinite(redObservedAt) ? redObservedAt : null;
  if (open.length) {
    const card = open[0];
    const created = ms(card.createdAt);
    if (isEscalated(card)) return { action: 'pass', reason: 'already-escalated', card };
    if (nowMs - created < windowMs) return { action: 'hold', reason: 'fix-window', card };
    if (!isStarted(card)) return { action: 'escalate', reason: 'not-started', card };
    if (red !== null && red >= created + windowMs) return { action: 'escalate', reason: 'still-red', card };
    // A crashed fix session leaves the card In Progress forever, and the
    // poller (no cron) may never show red again: give up waiting at 2x window.
    if (nowMs - created >= 2 * windowMs) return { action: 'escalate', reason: 'stalled', card };
    return { action: 'hold', reason: 'fix-in-progress', card };
  }
  const closed = recent.filter((c) => closedAtMs(c) !== null).sort((a, b) => closedAtMs(b) - closedAtMs(a));
  if (closed.length) {
    if (closed.some(isEscalated)) return { action: 'pass', reason: 'already-escalated', card: closed.find(isEscalated) };
    // A Done card passed its VERIFY (check-workflow-run-status --expect=success
    // or the alert-absent check), so it is evidence of a fix. Canceled cards
    // are not: if every recent card was canceled, nobody fixed it.
    const done = closed.filter((c) => c.state && c.state.type === 'completed');
    if (!done.length) return { action: 'escalate', reason: 'fix-canceled', card: closed[0] };
    const card = done[0];
    if (red !== null && red > closedAtMs(card) + graceMs) return { action: 'escalate', reason: 'red-after-fix', card };
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

/** PURE. Title + description of the START-NOW fix card. */
function buildCard({ key, alertTitle, alertDescription = '', runUrl = '', nowMs }) {
  const deadline = utc(nowMs + WINDOW_MS);
  const wf = workflowFromKey(key);
  const proof = wf
    ? `Prove it with unit tests, then let the next scheduled run of ${wf} go green. Do NOT dispatch ${NEVER_DISPATCH.join(' or ')} by hand: they send emails, create Resend drafts and dispatch deploys (CLAUDE.md section 17).`
    : `Prove it with unit tests; the check below goes green once the hourly check stops seeing the condition. Do NOT dispatch ${NEVER_DISPATCH.join(' or ')} by hand: they send emails, create Resend drafts and dispatch deploys (CLAUDE.md section 17).`;
  const description = [
    `START-NOW: opening-night pipeline failure, auto-fix first (BRO-5477). Any worker may take it. The owner is emailed if it is still failing at ${deadline} or nobody has started it by then.`,
    '',
    `${KEY_LINE_PREFIX}${key}`,
    '',
    `What failed: ${alertTitle}`,
    alertDescription ? String(alertDescription).slice(0, 2000) : null,
    runUrl ? `Failing run: ${runUrl}` : null,
    '',
    `What to do: find the root cause in the failing run's logs, fix it and land the fix. ${proof}`,
    '',
    `VERIFY: ${verifyCommandFor(key)}`,
  ].filter((l) => l !== null).join('\n');
  return { title: `Auto-fix: ${alertTitle}`.slice(0, 200), description };
}

/** PURE. The plain-English opening of the owner's escalation email. */
function escalationPreamble({ reason, card, error, nowMs }) {
  const ref = card ? (card.url || card.identifier || '') : '';
  const created = card && ms(card.createdAt);
  const hours = created ? Math.max(1, Math.round((nowMs - created) / HOUR_MS)) : null;
  let first;
  if (reason === 'not-started') {
    first = `An automatic fix was queued at ${utc(created)}, but no fix session picked it up in ${hours} hours, so you are being told now.`;
  } else if (reason === 'still-red') {
    first = `An automatic fix was started at ${utc(created)}. It is still failing ${hours} hours later, so you are being told now.`;
  } else if (reason === 'stalled') {
    first = `An automatic fix was started at ${utc(created)}, but it has not finished ${hours} hours later, so you are being told now.`;
  } else if (reason === 'fix-canceled') {
    first = `An automatic fix was queued at ${utc(created)}, but the fix session closed it without fixing it, so you are being told now.`;
  } else if (reason === 'red-after-fix') {
    first = `A fix session finished at ${utc(closedAtMs(card))}, but this failed again afterwards, so you are being told now.`;
  } else {
    first = `The automatic fix could not be started${error ? ` (${String(error).slice(0, 160)})` : ''}, so you are being told right away.`;
  }
  const act = 'To get it fixed, open a Claude session and ask it to fix this failure' + (ref ? ` (the fix card is ${ref}).` : '.');
  return `${first}\n${act}`;
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
  return `${ESCALATED_MARKER} ${utc(nowMs)}: emailed the owner (${reason}). From here this alert emails as it did before auto-fix first, until the card is 24h old.`;
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
  let d;
  try {
    d = deps || defaultDeps();
    const cards = await d.lookupCards(key, nowMs);
    const verdict = decide({ cards, redObservedAt: nowMs, nowMs, canFile: true });
    if (verdict.action === 'file') {
      const card = buildCard({ key, alertTitle, alertDescription, runUrl, nowMs });
      const unpickable = require('./cloud-worker-pick.js').startNowUnpickableReason({ title: card.title, description: card.description, priority: 2, mode: 'dispatch' });
      if (unpickable) throw new Error(`fix card would never be picked (${unpickable.reason})`);
      const filed = await d.fileCard(card);
      return { email: false, action: 'file', reason: 'no-card', card: filed, markEscalated: noop };
    }
    if (verdict.action === 'hold') return { email: false, ...verdict, markEscalated: noop };
    if (verdict.action === 'escalate') {
      return {
        email: true,
        ...verdict,
        preamble: escalationPreamble({ reason: verdict.reason, card: verdict.card, nowMs }),
        markEscalated: () => d.comment(verdict.card, escalationComment({ reason: verdict.reason, nowMs })).catch((e) => {
          console.error(`[auto-fix-first] could not mark ${verdict.card.identifier} escalated: ${e.message}`);
        }),
      };
    }
    return { email: true, ...verdict, markEscalated: noop };
  } catch (e) {
    console.error(`[auto-fix-first] ${key}: ${e.message} -- emailing the owner now`);
    return { email: true, action: 'file-failed', reason: 'file-failed', error: e.message, preamble: escalationPreamble({ reason: 'file-failed', error: e.message, nowMs }), markEscalated: noop };
  }
}

/**
 * Hourly sweep (opening-night-checklist.yml): escalates workflow incidents
 * whose fix window passed without a new paging failure (a once-a-night
 * orchestrator, or a storm the 2h notify cooldown keeps quiet). Never files.
 */
async function sweep({ nowMs = Date.now(), env = process.env, deps }) {
  const policy = require('./page-worthy-alerts.js');
  if (policy.autoFixFirstDisabled(env)) return [];
  const d = deps || defaultDeps();
  const out = [];
  for (const wf of policy.AUTO_FIX_FIRST_WORKFLOWS) {
    const key = workflowKey(wf);
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
      out.push({ key, ...verdict, card: verdict.card && verdict.card.identifier });
      if (verdict.action !== 'escalate') continue;
      const delivered = await d.sendEscalation({
        title: verdict.reason === 'not-started' || verdict.reason === 'fix-canceled'
          ? `${wf.replace(/\.yml$/, '')} failed and the automatic fix never ran`
          : `${wf.replace(/\.yml$/, '')} is still failing (automatic fix did not work)`,
        description: escalationPreamble({ reason: verdict.reason, card: verdict.card, nowMs }),
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

// cancelled counts: the opening-night workflows page on cancelled() too (a hang
// killed by timeout-minutes reports cancelled), so it is red evidence here.
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled']);

/**
 * PURE. Newest red completion among GitHub runs (newest first), or null if the
 * newest decided run passed. Skipped/neutral runs decide nothing.
 */
function latestRedFromRuns(runs) {
  for (const r of runs || []) {
    if (!r || r.status !== 'completed') continue;
    if (r.conclusion === 'success') return null;
    if (!RED_CONCLUSIONS.has(r.conclusion)) continue;
    return ms(r.updated_at) || ms(r.created_at);
  }
  return null;
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
    async fileCard({ title, description }) {
      const { createLinearIssue } = require('./linear-issue-create.js');
      const { issue } = await createLinearIssue({ title, description, priority: 2, dispatch: true });
      return issue;
    },
    async comment(card, body) {
      await linear.createComment(card.id, body);
    },
    async latestRedAt(workflowFile) {
      const repo = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/runs?per_page=20`, {
        signal: AbortSignal.timeout(20000),
        headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`GitHub runs for ${workflowFile}: HTTP ${res.status}`);
      const body = await res.json();
      return latestRedFromRuns(body.workflow_runs);
    },
    async sendEscalation({ title, description, url, conditionKey }) {
      const { routeAlert } = require('./owner-alert-router.js');
      const result = await routeAlert({ conditionKey, title, description, url, severity: 'error', disposition: 'human' });
      return !!(result && result.delivered);
    },
  };
}

module.exports = {
  WINDOW_MS, LOOKBACK_MS, GRACE_MS, KEY_LINE_PREFIX, ESCALATED_MARKER, NEVER_DISPATCH,
  workflowKey, workflowFromKey, cardKey, decide, verifyCommandFor, buildCard,
  escalationPreamble, escalationComment, escalationIdempotencyKey, escalationConditionKey, ESCALATION_KEY_PREFIX, latestRedFromRuns, gate, sweep, defaultDeps,
};
