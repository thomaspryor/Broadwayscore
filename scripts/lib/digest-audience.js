/**
 * digest-audience.js — who does a health-check row actually affect?
 *
 * Owner feedback 2026-09-24 on the morning digest: "Clearly our site is not a
 * strong system, very brittle ... if I get updates like this every morning!"
 * The email led with 5 red "site errors", but every one except a catalogue gap
 * was the automation fleet monitoring ITSELF (CI red streak, push retries,
 * autofix throughput, worktree GC, dispatch ledgers, cmux). Visitors never see
 * those and the owner cannot act on them.
 *
 * This pure classifier splits health rows into:
 *   'visitors' — something a site visitor could notice: pages, deploys, show
 *                data, reviews/scores arriving, data freshness, SEO, email to
 *                subscribers.
 *   'internal' — the automation's own machinery (CI, dispatch, cards, logs).
 *
 * FAIL-SAFE: anything not explicitly listed as internal is 'visitors'. A new
 * or renamed check must never be silently demoted out of the owner's view;
 * the cost of a wrong 'visitors' is one noisy line, the cost of a wrong
 * 'internal' is a hidden outage.
 *
 * The row name's category is the text before the first ':' (the same split
 * renderHealthScoreboard uses), or the whole name when there is no colon.
 */
'use strict';

// Categories whose every check is about the automation fleet itself.
const INTERNAL_CATEGORIES = new Set([
  'Main',               // main-branch CI red streak / green rate (deploys are measured separately by "Deploy:")
  'Push-retry deadman', // git push retry failures across worker branches
  'Autofix',            // autofix throughput, canary, jobs-succeeding
  'Infra',              // worktree GC log, notion-schedule coupling
  'Infra-review',       // review-gate telemetry
  'Stuck work',         // paused / orphaned Linear+Notion cards
  'Dispatch',           // "Dispatch: board targeting" (folded in by send-morning-digest.js)
  'Dispatch outcomes',  // dispatch ledger abandoned jobs
  'Dispatch health',    // dead-launch rate
  'Headless dispatch',  // headless job success rate
  'cmux socket',        // terminal multiplexer reachability
  'Digest',             // this email's own content-invariant check
  'Alert Router',       // alert auto-dispatch deadman
  'Workflow coverage',  // workflows that never ran (CI hygiene)
]);

// Individual checks whose category is otherwise visitor-facing ("Data:",
// "Push:") but which are about the work queue, not the site.
const INTERNAL_CHECK_NAMES = new Set([
  'Data: undispatchable backlog cards',
  'Data: cards the drain cannot finish unattended',
  'Push: Git Data API fallback usage (24h)',
]);

// "Cron failed: X" / "Workflow repeat-failure: X" / "Cron: X" name a GitHub
// workflow. Only workflows that do CI, repo plumbing or agent bookkeeping are
// internal; every data/scrape/deploy/email workflow stays 'visitors' (and any
// workflow not listed here defaults to 'visitors').
const INTERNAL_WORKFLOWS = new Set([
  'Test Suite', 'Land', 'Autonomous Merge', 'Dependabot Auto-Merge',
  'Check Direct Push To Main', 'Check Push Ledger', 'Check Linear Drain Health',
  'Guard — No Orphan Commit', 'Diagnose Shallow Fetch', 'Diag — push-with-retry fetch timing',
  'Mirror to GitLab', 'Mirror Core Data to GitLab', 'Mirror Review Texts to GitLab', 'Rotate GitLab Mirror Token',
  'Critique Plan with LLMs', 'Get GPT-4 Plan Review', 'Review Sprint Plan with OpenAI',
  'Investigate Alert', 'Execute Approved Fix', 'Card Verifiability Audit', 'Check Arm Yield',
  'Drain Not-Attempted Backlog', 'Monitor Scheduled Email Count', 'Audit Time-Bomb Tests',
  'Secret Scan (gitleaks)', 'Stage Latency Log Rotation', 'Sentry Auto-Triage',
]);

const WORKFLOW_ROW_RE = /^(?:Cron failed|Workflow repeat-failure|Cron):\s*(.+)$/;

function categoryOf(name) {
  const s = String(name || '').trim();
  const i = s.indexOf(':');
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/**
 * @param {string|{name?: string}} row - a health row or its name
 * @returns {'visitors'|'internal'}
 */
function classifyHealthCheck(row) {
  const name = String((row && typeof row === 'object' ? row.name : row) || '').trim();
  if (!name) return 'visitors';
  const wf = WORKFLOW_ROW_RE.exec(name);
  if (wf) return INTERNAL_WORKFLOWS.has(wf[1].trim()) ? 'internal' : 'visitors';
  if (INTERNAL_CHECK_NAMES.has(name)) return 'internal';
  // Unmeasurable-here variants ("Dispatch health: dead-launch rate
  // (unmeasurable here)") share the category, so the category test covers them.
  return INTERNAL_CATEGORIES.has(categoryOf(name)) ? 'internal' : 'visitors';
}

/**
 * Split a health snapshot's errors/warns by audience. Bare-string rows are
 * tolerated (older snapshots) and normalised to {name}.
 */
function splitHealthByAudience(health) {
  const out = {
    visitors: { errors: [], warns: [] },
    internal: { errors: [], warns: [] },
  };
  if (!health) return out;
  for (const kind of ['errors', 'warns']) {
    for (const r of Array.isArray(health[kind]) ? health[kind] : []) {
      if (!r) continue;
      const row = typeof r === 'string' ? { name: r } : r;
      out[classifyHealthCheck(row)][kind].push(row);
    }
  }
  return out;
}

module.exports = {
  classifyHealthCheck,
  splitHealthByAudience,
  categoryOf,
  INTERNAL_CATEGORIES,
  INTERNAL_CHECK_NAMES,
  INTERNAL_WORKFLOWS,
};
