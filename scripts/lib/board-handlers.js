'use strict';
/**
 * board-handlers.js (BRO-7139 Step 1) — which scheduled job acts on each board row.
 *
 * Every CATEGORIES entry in board-categories.js names its handlers (ids below).
 * A row is HANDLED when at least one of its handlers is in mode 'apply' and the
 * workflow really runs it with the exact invocation listed here (flags included,
 * so a report-only call cannot pass for an applying one). A row with no applying
 * handler is a GAP: it is listed in KNOWN_GAPS, and board-handlers.test.mjs fails
 * when the two disagree in either direction. A new category, a removed workflow
 * step or a dropped --apply therefore fails CI instead of leaving cards to rot,
 * and closing a gap forces the list to shrink.
 *
 * Limits: the test reads the workflow text, so it cannot see a job-level `if:`, a
 * shell conditional or a kill-switch variable; `does` says when coverage is partial.
 *
 * Modes: 'apply' writes to Linear on its own; 'report-only' only reports;
 * 'planned' is not built yet (no script, no workflow).
 */

const HANDLERS = {
  'owner-decision-emails': {
    script: 'scripts/send-owner-decision-emails.js', workflow: '.github/workflows/owner-decision-emails.yml',
    invocation: 'node scripts/send-owner-decision-emails.js $args', mode: 'apply',
    does: 'emails the owner each written DECISION NEEDED question and re-asks on a clock',
  },
  'linear-reclaim-abandoned': {
    script: 'scripts/linear-reclaim-abandoned.js', workflow: '.github/workflows/land-retry-cancelled.yml',
    invocation: 'run: node scripts/linear-reclaim-abandoned.js', mode: 'apply',
    does: 'moves In Progress cards whose claiming session died back to Todo',
  },
  'close-stuck-verified-cards': {
    script: 'scripts/close-stuck-verified-cards.js', workflow: '.github/workflows/data-health-check.yml',
    invocation: 'node scripts/close-stuck-verified-cards.js --apply', mode: 'apply',
    does: 'closes idle audited In Review/In Progress cards and proven Backlog/Todo cards on hard evidence (single-test checks), bounces failing In Review ones; partial coverage of the rows that name it',
  },
  'autonomous-acceptance-recheck': {
    script: 'scripts/autonomous-acceptance-recheck.js', workflow: '.github/workflows/data-health-check.yml',
    invocation: 'node scripts/autonomous-acceptance-recheck.js --time-budget-min 5', mode: 'apply',
    mustContain: ["RECHECK_AUTOCLOSE: 'true'"],
    does: 're-runs the check of RECHECK-AFTER stamped cards once the date passes and closes the passing ones',
  },
  'sweep-resolved-alert-cards': {
    script: 'scripts/sweep-resolved-alert-cards.js', workflow: '.github/workflows/data-health-check.yml',
    invocation: 'node scripts/sweep-resolved-alert-cards.js --apply', mode: 'apply',
    does: 'closes alert cards whose alert condition has recovered',
  },
  'owner-hold-sweep': {
    script: 'scripts/owner-hold-sweep.js', workflow: '.github/workflows/linear-unpark-drain.yml',
    invocation: 'node scripts/owner-hold-sweep.js --apply', mode: 'apply',
    does: 'releases owner-worded holds that are worker work, asks the owner on the rest',
  },
  'wake-board-worker': {
    script: 'scripts/wake-board-worker.js', workflow: '.github/workflows/board-worker-wake.yml',
    invocation: 'node scripts/wake-board-worker.js "$REASON"', mode: 'apply',
    does: 'the 2-hourly board worker routine (a scheduled cloud session) takes the next ready card; this workflow only starts it early',
  },
  'codex-runner': {
    script: 'scripts/codex/daily-runner.js', workflow: '.github/workflows/codex-runner.yml',
    invocation: 'node scripts/codex/daily-runner.js "${args[@]}"', mode: 'apply',
    does: 'runs the Codex lane, which retries bounced cards after their wait',
  },
  'enrich-card-acceptance': {
    script: 'scripts/enrich-card-acceptance.js', workflow: '.github/workflows/card-verifiability-audit.yml',
    invocation: 'node scripts/enrich-card-acceptance.js --source linear --limit 25', mode: 'apply',
    does: 'drafts a safe acceptance check onto cards that have none',
  },
  'board-hygiene-sweep': {
    script: 'scripts/board-hygiene-sweep.js', workflow: '.github/workflows/board-hygiene-report.yml',
    invocation: 'node scripts/board-hygiene-sweep.js |', mode: 'report-only',
    does: 'monthly report of prose date-waits and old Backlog cards; never writes',
  },
  'llm-triage': {
    script: 'scripts/llm-triage.js', workflow: null, invocation: null, mode: 'planned',
    does: 'BRO-7139 Step 3: reads parked-for-another-reason cards and nominates release/ask/close (report-only first)',
  },
};

// Rows nothing applies to today. Shrink this list when a handler lands; never grow it
// without a card that builds the missing handler.
const KNOWN_GAPS = [
  'dated-past-failed', // recheck failures are only reported, nothing reopens or reworks them
  'parked-real-block', // waits on a password, money or a device; no job checks whether the block cleared
  'parked-no-reason', // Backlog with no PARKED line; only the monthly report-only age sweep sees it
  'parked-prose-wait', // only the monthly report-only sweep stamps these
  'parked-other', // BRO-7139 Step 3 llm-triage
  'paused', // Paused with no RECHECK-AFTER stamp: the recheck refuses unstamped cards
  'app-repo', // iPhone-app cards: cloud workers cannot open that repo
  'other', // BRO-7139 Step 3 llm-triage
];

/** PURE. Category keys none of whose handlers apply. */
function gapsOf(categories, handlers = HANDLERS) {
  return categories
    .filter((c) => !(c.handlers || []).some((id) => handlers[id] && handlers[id].mode === 'apply'))
    .map((c) => c.key);
}

const SAMPLE = 5;

/**
 * PURE (BRO-7139 Step 2). Group a categorizeBoard() report's cards by the handler that owns them.
 * A card goes to every handler its category names; a card whose category has no applying handler
 * is also listed under gaps. Returns { open, handlers: {id: {mode, categories, count, sample}},
 * gaps: [{category, count, sample}] } with handler ids and gap keys in a stable order.
 */
function planDispatch(report, handlers = HANDLERS) {
  const cats = new Map((report.categories || []).map((c) => [c.key, c]));
  const out = {};
  const gapCards = new Map();
  const gapKeys = new Set(gapsOf([...cats.values()], handlers));
  for (const card of report.cards || []) {
    const cat = cats.get(card.category);
    for (const id of (cat && cat.handlers) || []) {
      const h = handlers[id];
      if (!h) continue;
      const row = out[id] || (out[id] = { mode: h.mode, categories: [], count: 0, sample: [] });
      if (!row.categories.includes(card.category)) row.categories.push(card.category);
      row.count += 1;
      if (row.sample.length < SAMPLE) row.sample.push(card.identifier);
    }
    if (!cat || gapKeys.has(card.category)) {
      const g = gapCards.get(card.category) || { category: card.category, count: 0, sample: [] };
      g.count += 1;
      if (g.sample.length < SAMPLE) g.sample.push(card.identifier);
      gapCards.set(card.category, g);
    }
  }
  const sorted = {};
  for (const id of Object.keys(out).sort()) sorted[id] = { ...out[id], categories: out[id].categories.sort() };
  return {
    open: (report.cards || []).length,
    handlers: sorted,
    gaps: [...gapCards.values()].sort((a, b) => b.count - a.count || String(a.category).localeCompare(String(b.category))),
  };
}

module.exports = { HANDLERS, KNOWN_GAPS, gapsOf, planDispatch };
