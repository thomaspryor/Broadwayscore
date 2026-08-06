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
const { MAX_STORED_MESSAGE } = require('./lib/feedback-request-ledger.js');
const { describeDispatchesPlainly } = require('./lib/content-request-routing.js');

const REPORT_PATH = path.join(__dirname, '../data/audit/feedback-run-report.json');

/**
 * One block per submission saying, in plain English, what happened to it and —
 * when it stalled — what the owner can do in one click.
 *
 * Ordered worst-first so the thing needing the owner is never below the fold.
 *
 * WORDING (2026-08-05, owner on two real notifications): "I have no idea what
 * this email is telling me. It's all technical mumbo jumbo", and of a stalled
 * row, "this one is not clear nor is it actionable". So:
 *   - `detail` says what happened to their request, never what ran. Workflow
 *     filenames and JSON input blobs stay out of the owner's inbox; the plain
 *     sentence comes from content-request-routing.js's WORKFLOW_LABELS.
 *   - `whatNow` is present on every needsYou row and says, in one sentence,
 *     what happens next. The caller pairs it with a click-to-dispatch link.
 */
function describeOutcome(item) {
  const dispatched = (item.dispatches || []).filter((d) => d.ok);
  const failed = (item.dispatches || []).filter((d) => d && d.ok === false);
  const parked = (item.plannedActions || []).filter((a) => a.kind === 'unroutable');

  if (failed.length > 0) {
    return {
      rank: 0,
      state: 'COULD NOT START THE WORK',
      color: '#b91c1c',
      detail:
        `The site tried to start the work and GitHub refused it (${
          failed.map((d) => d.error || 'no reason given').join('; ')
        }). Nothing has been done about this request yet.`,
      whatNow: 'Someone has to look at why the job would not start, then get the request done.',
      needsYou: true,
    };
  }
  if (parked.length > 0) {
    return {
      rank: 1,
      state: 'HELD BACK ON PURPOSE',
      color: '#b45309',
      // The reasons are written for a human already (e.g. "already has 12
      // review(s); not auto-gathering"), so they are quoted rather than
      // re-worded — but framed as a deliberate hold, not a failure.
      detail: `The site deliberately did not act on this: ${parked.map((a) => a.reason).join('; ')}.`,
      whatNow: 'Decide whether it should happen anyway — the hold is a guardrail, not a verdict.',
      needsYou: true,
    };
  }
  if (dispatched.length > 0) {
    return {
      rank: 2,
      state: 'ALREADY BEING HANDLED',
      color: '#15803d',
      detail: `${describeDispatchesPlainly(dispatched)}. You will get another email when it is live on the site.`,
      needsYou: false,
    };
  }
  if (item.diagnosed) {
    return {
      rank: 2,
      state: 'ALREADY BEING HANDLED',
      color: '#15803d',
      detail: `${item.summary || 'The site worked out what was wrong and started a fix'}. You will get another email when it is live on the site.`,
      needsYou: false,
    };
  }
  if (item.category === 'Bug' || item.category === 'Content Error') {
    // Reached the bug path but produced neither a diagnosis nor a dispatch:
    // nothing in the request matched a show or an ask shape the site can route.
    return {
      rank: 1,
      state: 'NOBODY IS ON THIS YET',
      color: '#b45309',
      detail:
        'This is a real problem report, but the site could not work out which show or which kind of fix it is asking for, so nothing was started. It will sit here until someone picks it up.',
      whatNow: 'Read what they wrote, work out what they actually want, and get it done.',
      needsYou: true,
    };
  }
  return {
    rank: 3,
    state: 'NOTHING TO DO',
    color: '#525252',
    detail: item.email
      ? 'Not a problem report — a thank-you went back to the person who sent it.'
      : 'Not a problem report, and they left no email address, so there was nobody to reply to.',
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

  // NOTE: this description is queued into data/audit/alert-digest-queue.json,
  // which the workflow COMMITS to a PUBLIC repo. So it carries no submitter
  // name and no submitter email, ever, and the free-text message is capped —
  // exactly the rule scripts/lib/feedback-request-ledger.js already follows for
  // the sibling public ledger (the message itself is already verbatim in the
  // public GitHub issue, so the cap is belt-and-braces; identity is not).
  // The issue link is where the owner goes for who-sent-it.
  const lines = rows.map(({ item, outcome }) => {
    const issueUrl = item.issueNumber
      ? `https://github.com/thomaspryor/Broadwayscore/issues/${item.issueNumber}`
      : null;
    const message = item.message
      ? String(item.message).slice(0, MAX_STORED_MESSAGE)
      : '(no message)';
    // Front-loaded: the digest renders a queued row as clip(description, 200),
    // so the first line has to carry the whole meaning on its own — the show,
    // what happened to it, and what it needs.
    const block = [
      `${item.show || 'A message with no show named'} — ${outcome.detail || '—'}${outcome.whatNow ? ` ${outcome.whatNow}` : ''}`,
      `  They wrote: "${message}"`,
    ];
    if (issueUrl) block.push(`  Full details and who sent it: ${issueUrl}`);
    return block.join('\n');
  });

  const header = [
    `${items.length} message${items.length === 1 ? '' : 's'} from users came in${report.spamFlaggedCount ? `, plus ${report.spamFlaggedCount} flagged as spam` : ''}.`,
    needsYou > 0
      ? `${needsYou} of them stalled and need${needsYou === 1 ? 's' : ''} a person.`
      : 'All of them are being handled automatically. Nothing needs you.',
    failedRun
      ? `The run itself ended as "${pipelineStatus}", so some messages may not have been processed at all.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    // Deduped, then sorted: a report that lists the same submission twice must
    // produce the SAME key as one that lists it once, or the duplicate silently
    // slips past the router's cooldown as a "new" incident.
    conditionKey: `feedback-outcomes:${[...new Set(items.map(itemKey))].sort().join(',')}`,
    title,
    description: [header, ...lines].join('\n\n'),
    // Anything needing the owner, or a run that did not finish, is an error —
    // that is what decides the digest's severity ordering. A fully-automated
    // run is informational.
    severity: failedRun || needsYou > 0 ? 'error' : 'info',
    // A run where nothing stalled is a receipt, not a fix request. Without this
    // digest-autofix.js spends a whole session on "everything worked" (its
    // default for any queued row is auto-dispatch — see queueDigestLine).
    ...(failedRun || needsYou > 0 ? {} : {
      decision: true,
      decisionPrompt: 'Receipt only — every message in this run was handled automatically. Nothing to fix.',
    }),
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
