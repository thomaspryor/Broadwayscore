#!/usr/bin/env node

/**
 * Email the owner what the feedback pipeline did with every submission in a run
 * — routed, parked, diagnosed, or failed.
 *
 * WHY THIS EXISTS (2026-08-05, GH #543, the SECOND time this bit):
 * Before this script, a user submission could be fetched, categorized, turned
 * into a GitHub issue and parked with NOBODY told. Three separate design
 * choices stacked into total silence:
 *
 *   1. process-feedback.yml DELETEs the owner's repo subscription every run,
 *      so bot-created issues never email them (deliberate — it was killing the
 *      owner's inbox with digest noise).
 *   2. The only Resend email in process-feedback.js goes to the SUBMITTER, and
 *      is skipped entirely when they leave the email field blank (#543 did).
 *   3. Nothing in the repo queries the `needs-review` / `feedback-digest`
 *      labels those issues carry.
 *
 * So "park it for review" resolved to "drop it". #505 sat untouched until the
 * owner resubmitted it as a live test; #543 sat untouched until the owner
 * noticed the Formspree notification and asked why nothing had happened.
 *
 * The rule this encodes: every run that saw a submission sends exactly one
 * owner email, whether the pipeline succeeded, partially succeeded, or failed.
 * Silence is now only ever "no new feedback" — never "something happened and
 * you weren't told".
 *
 * Input:  data/audit/feedback-run-report.json, written by process-feedback.js
 *         and enriched with issue numbers + dispatch results by the workflow's
 *         github-script step.
 * Env:    Optional: GITHUB_RUN_URL, PIPELINE_STATUS ('success' | 'failure' |
 *         'cancelled') so a crashed run still reports. RESEND_API_KEY /
 *         OWNER_EMAIL are only consulted if the router actually pages.
 *
 * DELIVERY (2026-08-05): this goes through routeAlert(), not a direct Resend
 * call. The owner's standing mandate (card #611) is that no sender emails them
 * directly unless its conditionKey is on the page-worthy allowlist in
 * scripts/lib/page-worthy-alerts.js; everything else lands in the daily digest.
 * "Feedback was processed" is not site-down / opening-night-dead / data-loss,
 * so it is digest-tier by default and the owner still hears about every
 * submission within a day. Promoting it to an immediate email is one line in
 * page-worthy-alerts.js if they ever want that.
 *
 * Exit code is ALWAYS 0 for a missing/empty report: "no new feedback this run"
 * is the overwhelmingly common case and must not paint the workflow red.
 * A genuine delivery failure exits 1 so the workflow's notify-failure step
 * fires — an alerting system that can fail silently is what this replaces.
 */

const fs = require('fs');
const path = require('path');
const { routeAlert } = require('./lib/owner-alert-router.js');

const REPORT_PATH = path.join(__dirname, '../data/audit/feedback-run-report.json');

/**
 * One line per submission saying, in plain terms, what happened to it.
 * Ordered worst-first so the thing needing the owner is never below the fold.
 */
function describeOutcome(item) {
  const dispatched = (item.dispatches || []).filter((d) => d.ok);
  const failed = (item.dispatches || []).filter((d) => d && d.ok === false);
  const parked = (item.plannedActions || []).filter((a) => a.kind === 'unroutable');

  if (failed.length > 0) {
    return {
      rank: 0,
      state: 'DISPATCH FAILED',
      color: '#b91c1c',
      detail: failed.map((d) => `${d.workflow}: ${d.error || 'unknown error'}`).join('; '),
      needsYou: true,
    };
  }
  if (parked.length > 0) {
    return {
      rank: 1,
      state: 'PARKED — needs you',
      color: '#b45309',
      detail: parked.map((a) => a.reason).join('; '),
      needsYou: true,
    };
  }
  if (dispatched.length > 0) {
    return {
      rank: 2,
      state: 'AUTO-DISPATCHED',
      color: '#15803d',
      detail: dispatched
        .map((d) => `${d.workflow}${d.inputs ? ` (${JSON.stringify(d.inputs)})` : ''}`)
        .join('; '),
      needsYou: false,
    };
  }
  if (item.diagnosed) {
    return {
      rank: 2,
      state: 'DIAGNOSED — auto-fix dispatched',
      color: '#15803d',
      detail: item.summary || '',
      needsYou: false,
    };
  }
  if (item.category === 'Bug' || item.category === 'Content Error') {
    // Reached the bug path but produced neither a diagnosis nor a dispatch.
    return {
      rank: 1,
      state: 'NO ACTION TAKEN — needs you',
      color: '#b45309',
      detail: 'Categorized as a bug/content error but nothing routed or diagnosed.',
      needsYou: true,
    };
  }
  return {
    rank: 3,
    state: 'ACKNOWLEDGED',
    color: '#525252',
    detail: item.email ? 'Thank-you email sent to submitter.' : 'No submitter email on file.',
    needsYou: false,
  };
}

/**
 * A submission's identity for dedup purposes. submissionId() is what
 * feedback-run-report.js keys items on; the issue number and the show/message
 * pair are fallbacks so an item that never got an id still contributes
 * something stable rather than collapsing every run onto one key.
 */
function itemKey(item) {
  return String(
    (item && (item.submissionId || item.issueNumber)) ||
      `${(item && item.show) || ''}|${(item && item.message) || ''}`
  );
}

/**
 * Build the routeAlert() payload for one pipeline run.
 *
 * conditionKey is the SET of submissions this run saw, not the run itself: two
 * runs over the same submissions are the same incident (the router silences the
 * second), while a genuinely new submission produces a new key and notifies
 * immediately. Keying on the run id instead would defeat the ledger entirely;
 * keying on a constant would silence every submission after the first.
 */
function buildAlert(report, pipelineStatus, runUrl) {
  const items = Array.isArray(report.items) ? report.items : [];
  const rows = items
    .map((item) => ({ item, outcome: describeOutcome(item) }))
    .sort((a, b) => a.outcome.rank - b.outcome.rank);

  const needsYou = rows.filter((r) => r.outcome.needsYou).length;
  const failedRun = Boolean(pipelineStatus && pipelineStatus !== 'success');

  const title = failedRun
    ? `Feedback pipeline ${pipelineStatus} — ${items.length} submission(s) may be unprocessed`
    : needsYou > 0
    ? `Feedback: ${needsYou} of ${items.length} need${needsYou === 1 ? 's' : ''} you`
    : `Feedback: ${items.length} submission(s), all handled automatically`;

  const lines = rows.map(({ item, outcome }) => {
    const who = `${item.name || 'Anonymous'}${item.email ? ` (${item.email})` : ' (no email)'}`;
    const issue = item.issueNumber
      ? ` — https://github.com/thomaspryor/Broadwayscore/issues/${item.issueNumber}`
      : '';
    return [
      `[${outcome.state}] ${item.show || 'No show given'}`,
      `  "${item.message || '(no message)'}"`,
      `  What happened: ${outcome.detail || '—'}`,
      `  ${item.category || 'Uncategorized'}${item.priority ? ` · ${item.priority} priority` : ''} · from ${who}${issue}`,
    ].join('\n');
  });

  const header = [
    `${items.length} submission(s) processed${report.spamFlaggedCount ? `, ${report.spamFlaggedCount} spam-flagged` : ''}.`,
    needsYou > 0
      ? `${needsYou} need${needsYou === 1 ? 's' : ''} your attention.`
      : 'Nothing needs you.',
    failedRun
      ? `The pipeline run itself ended in "${pipelineStatus}" — outcomes below may be incomplete.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    conditionKey: `feedback-outcomes:${items.map(itemKey).sort().join(',')}`,
    title,
    description: [header, ...lines].join('\n\n'),
    // Anything needing the owner, or a run that did not finish, is an error —
    // that is what decides the digest's severity ordering. A fully-automated
    // run is informational.
    severity: failedRun || needsYou > 0 ? 'error' : 'info',
    url: runUrl || undefined,
    fields: [
      { name: 'Submissions', value: String(items.length) },
      { name: 'Need you', value: String(needsYou) },
      { name: 'Pipeline status', value: pipelineStatus || 'success' },
    ],
  };
}

async function main() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  } catch {
    console.log('No feedback run report — nothing to notify.');
    return;
  }

  const items = Array.isArray(report.items) ? report.items : [];
  if (items.length === 0) {
    console.log('Run report has no items — nothing to notify.');
    return;
  }

  const alert = buildAlert(
    report,
    process.env.PIPELINE_STATUS || 'success',
    process.env.GITHUB_RUN_URL || ''
  );

  let result;
  try {
    // 'human' is the honest request — the owner asked to be told about every
    // submission. The router's page-worthy gate (card #611) decides whether
    // that means an immediate email or a line in the next daily digest; either
    // way the owner IS told, which is the guarantee this script exists for.
    result = await routeAlert({ ...alert, disposition: 'human' });
  } catch (err) {
    console.error(`::error::Failed to route feedback outcomes to the owner: ${err.message}`);
    process.exit(1);
  }

  // routeAlert returns without recording when delivery actually failed (Resend
  // down, etc). Treat that as the send failure it is, so the workflow's
  // notify-failure step fires instead of the run looking clean.
  if (result.action === 'human' && result.delivered === false) {
    console.error(`::error::Owner alert delivery FAILED for "${alert.title}" — nobody was notified.`);
    process.exit(1);
  }

  console.log(
    result.action === 'silent'
      ? `Already reported, not repeating: "${alert.title}"`
      : `Owner notified (${result.action}): "${alert.title}"`
  );
}

module.exports = { buildAlert, describeOutcome, itemKey };

if (require.main === module) {
  main().catch((err) => {
    console.error(`::error::notify-feedback-outcomes crashed: ${err.message}`);
    process.exit(1);
  });
}
