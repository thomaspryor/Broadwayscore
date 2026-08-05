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
 * Env:    RESEND_API_KEY, OWNER_EMAIL. Optional: GITHUB_RUN_URL, PIPELINE_STATUS
 *         ('success' | 'failure' | 'cancelled') so a crashed run still reports.
 *
 * Exit code is ALWAYS 0 for a missing/empty report: "no new feedback this run"
 * is the overwhelmingly common case and must not paint the workflow red.
 * A genuine send failure exits 1 so the workflow's notify-failure step fires —
 * an alerting system that can fail silently is the thing this replaces.
 */

const fs = require('fs');
const path = require('path');
const { postJSON } = require('./lib/email-templates.js');

const REPORT_PATH = path.join(__dirname, '../data/audit/feedback-run-report.json');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function buildEmail(report, pipelineStatus, runUrl) {
  const items = Array.isArray(report.items) ? report.items : [];
  const rows = items
    .map((item) => ({ item, outcome: describeOutcome(item) }))
    .sort((a, b) => a.outcome.rank - b.outcome.rank);

  const needsYou = rows.filter((r) => r.outcome.needsYou).length;
  const failedRun = pipelineStatus && pipelineStatus !== 'success';

  const subject = failedRun
    ? `Feedback pipeline ${pipelineStatus} — ${items.length} submission(s) may be unprocessed`
    : needsYou > 0
    ? `Feedback: ${needsYou} of ${items.length} need${needsYou === 1 ? 's' : ''} you`
    : `Feedback: ${items.length} submission(s), all handled automatically`;

  const cards = rows
    .map(({ item, outcome }) => `
      <div style="border:1px solid #e5e5e5;border-left:4px solid ${outcome.color};border-radius:6px;padding:14px 16px;margin:0 0 12px;">
        <div style="font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;color:${outcome.color};letter-spacing:.04em;">${escapeHtml(outcome.state)}</div>
        <div style="font:600 16px/1.4 -apple-system,Segoe UI,sans-serif;color:#171717;margin:6px 0 2px;">${escapeHtml(item.show || 'No show given')}</div>
        <div style="font:400 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#404040;margin:0 0 8px;">&ldquo;${escapeHtml(item.message || '(no message)')}&rdquo;</div>
        <div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#525252;">
          <strong>What happened:</strong> ${escapeHtml(outcome.detail || '—')}
        </div>
        <div style="font:400 12px/1.5 -apple-system,Segoe UI,sans-serif;color:#737373;margin-top:8px;">
          ${escapeHtml(item.category || 'Uncategorized')}${item.priority ? ` &middot; ${escapeHtml(item.priority)} priority` : ''}
          &middot; from ${escapeHtml(item.name || 'Anonymous')}${item.email ? ` (${escapeHtml(item.email)})` : ' (no email)'}
          ${item.issueNumber ? `&middot; <a href="https://github.com/thomaspryor/Broadwayscore/issues/${item.issueNumber}" style="color:#0a7ea4;">issue #${escapeHtml(item.issueNumber)}</a>` : ''}
        </div>
      </div>`)
    .join('');

  const html = `
    <div style="max-width:640px;margin:0 auto;padding:24px 16px;background:#ffffff;">
      <h1 style="font:700 20px/1.3 -apple-system,Segoe UI,sans-serif;color:#171717;margin:0 0 4px;">Feedback pipeline run</h1>
      <p style="font:400 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#525252;margin:0 0 20px;">
        ${escapeHtml(items.length)} submission(s) processed${report.spamFlaggedCount ? `, ${escapeHtml(report.spamFlaggedCount)} spam-flagged` : ''}.
        ${needsYou > 0 ? `<strong style="color:#b45309;">${escapeHtml(needsYou)} need${needsYou === 1 ? 's' : ''} your attention.</strong>` : 'Nothing needs you.'}
      </p>
      ${failedRun ? `<p style="font:600 14px/1.5 -apple-system,Segoe UI,sans-serif;color:#b91c1c;background:#fef2f2;border-radius:6px;padding:12px 14px;margin:0 0 16px;">The pipeline run itself ended in "${escapeHtml(pipelineStatus)}" — outcomes below may be incomplete.</p>` : ''}
      ${cards || '<p style="font:400 14px -apple-system,sans-serif;color:#525252;">No categorized submissions in this run.</p>'}
      ${runUrl ? `<p style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#737373;margin-top:20px;"><a href="${escapeHtml(runUrl)}" style="color:#0a7ea4;">View the workflow run</a></p>` : ''}
    </div>`;

  return { subject, html };
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

  const resendKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!resendKey || !ownerEmail) {
    // Loud, and non-zero: a missing secret here means the owner silently stops
    // hearing about feedback — the exact failure mode this script exists to end.
    console.error('::error::RESEND_API_KEY or OWNER_EMAIL missing — owner NOT notified about this feedback run.');
    process.exit(1);
  }

  const { subject, html } = buildEmail(
    report,
    process.env.PIPELINE_STATUS || 'success',
    process.env.GITHUB_RUN_URL || ''
  );

  try {
    await postJSON('https://api.resend.com/emails', {
      from: 'Broadway Scorecard Pipeline <updates@broadwayscorecard.com>',
      to: [ownerEmail],
      subject,
      html,
    }, { Authorization: `Bearer ${resendKey}` });
    console.log(`Owner notified: "${subject}"`);
  } catch (err) {
    console.error(`::error::Failed to email feedback outcomes: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { buildEmail, describeOutcome };

if (require.main === module) {
  main().catch((err) => {
    console.error(`::error::notify-feedback-outcomes crashed: ${err.message}`);
    process.exit(1);
  });
}
