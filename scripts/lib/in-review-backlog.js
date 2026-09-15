/**
 * in-review-backlog.js — the residual half of BRO-282: "no channel tells the
 * owner that something is waiting on their approval."
 *
 * BRO-282 shipped the ACTIVE half — an `awaiting-owner` label a session
 * applies when it knows it is blocked, surfaced by owner-approval-channel.js
 * as the digest's "Waiting on your approval" block. That channel only fires
 * when a session remembers to opt in.
 *
 * The PASSIVE half was never covered, and it is where the work actually
 * piles up. `In Review` is the state linear-dispatch.js's seed prompt tells
 * every dispatched session to land on when it finishes, so a correctly
 * behaved session parks there and closes — and then the flow ends. Measured
 * 2026-09-15: 125 issues in `In Review`, 120 of them real work, 100 idle 14+
 * days, 8 priority=Urgent. BRO-282 itself sat in that pile for 28 days,
 * unseen. Nothing read the state; no cron, no digest, no CLI.
 *
 * Deliberately NOT merged into owner-approval-channel.js's block. The two
 * blocks answer different questions and must stay separately readable:
 * "Waiting on your approval" is "this cannot ship without you", and this one
 * is "this says it is finished and nobody has looked" — that file's own
 * header explains why conflating the label with the state would make the
 * approval block noisy with ordinary finished work, and folding them now
 * would do exactly that in the other direction.
 *
 * The digest must NOT print 120 rows. A block the eye learns to skip is the
 * same failure as no block at all, so this reports a COUNT plus the few rows
 * that earn a line: Urgent first, then oldest. Everything else rolls into
 * moreCount and lives in the board.
 *
 * No I/O here (CLAUDE.md rule 15) — scripts/lib/linear-client.js fetches,
 * scripts/send-morning-digest.js and scripts/bsc-in-review.js call in for the
 * pure filtering/shaping.
 */
'use strict';

const IN_REVIEW_STATE = 'In Review';

// Automation files its own recurring rows as issues (the daily health digest
// autofix and the canary). They legitimately live in In Review and are not
// work the owner reviews, so counting them would inflate every number this
// block reports. Matched on the title prefixes those two producers use —
// digest-autofix.js's "BSC Daily: " rows and autofix-canary.js's "CANARY: ".
const NOISE_TITLE_RE = /^\s*(CANARY:|BSC Daily:)/;

// An item younger than this is not yet a leak — a session that finished an
// hour ago is supposed to be sitting in In Review waiting for the next
// morning's read. Ageing the block in at 3 days keeps "normal throughput"
// out of it, so a row appearing here always means something went unlooked-at
// across at least two digests.
const IDLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// Rows printed in the email. The rest become "+N more" — see header.
const MAX_ROWS = 6;

// Linear's priority scale: 0 = none, 1 = Urgent, 2 = High, 3 = Medium,
// 4 = Low. Only 1 is escalated here; "High" is the board's default for most
// filed work and would put ~80 rows in the escalated tier.
const URGENT_PRIORITY = 1;

function isRealInReview(issue) {
  if (!issue || !issue.state) return false;
  if (issue.state.name !== IN_REVIEW_STATE) return false;
  return !NOISE_TITLE_RE.test(String(issue.title || ''));
}

function isUrgent(issue) {
  return !!issue && issue.priority === URGENT_PRIORITY;
}

// Age is taken from updatedAt, unlike owner-approval-channel.js's
// waitingSince(), which deliberately avoids it. That file is dating ONE
// specific ask (an attach-approval comment) whose clock must not reset when
// the owner replies without resolving it. Here the question is the opposite —
// "has anyone touched this at all?" — and any activity, including a comment,
// is genuine evidence that it is not abandoned. So updatedAt is the right
// clock for this block and the wrong one for that one.
function idleMs(issue, now) {
  const raw = issue && issue.updatedAt;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now.getTime() - t);
}

function formatIdle(ms) {
  if (ms === null || ms === undefined) return null;
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  return `${days}d`;
}

/**
 * Rank, then shape. Urgent above non-urgent, oldest first within each tier,
 * unknown-age last (same reasoning as owner-approval-channel.js: there is
 * nothing to escalate about a row this cannot date, so it must not float to
 * the top where the eye reads it as most urgent).
 */
function buildInReviewRows(issues, { now = new Date() } = {}) {
  return (issues || [])
    .filter(isRealInReview)
    .map((issue) => {
      const ms = idleMs(issue, now);
      const urgent = isUrgent(issue);
      const label = formatIdle(ms);
      return {
        title: `${issue.identifier}: ${issue.title}`,
        detail:
          (urgent ? '⚠ Urgent — ' : '') +
          (label ? `finished, unreviewed ${label}` : 'finished, unreviewed'),
        url: issue.url,
        idleMs: ms,
        urgent,
      };
    })
    .sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      if (a.idleMs === null && b.idleMs === null) return 0;
      if (a.idleMs === null) return 1;
      if (b.idleMs === null) return -1;
      return b.idleMs - a.idleMs;
    });
}

/**
 * {generatedAt, bannerText, items, moreCount} — renderNamedDigestBlock's
 * shape, the same rail the "Needs your decision" and "Waiting on your
 * approval" blocks already ride.
 *
 * Returns null when nothing has been sitting long enough, so the digest omits
 * the block entirely rather than printing a standing zero row.
 *
 * The banner counts EVERY real In Review issue that has crossed IDLE_AFTER_MS,
 * not just the MAX_ROWS printed — the number is the point of the block, and
 * capping it at the row limit would under-report the backlog by design.
 */
function buildInReviewSection(
  issues,
  { now = new Date(), idleAfterMs = IDLE_AFTER_MS, maxRows = MAX_ROWS } = {}
) {
  const all = buildInReviewRows(issues, { now });
  const idle = all.filter((r) => r.idleMs !== null && r.idleMs >= idleAfterMs);
  if (!idle.length) return null;
  const urgentCount = idle.filter((r) => r.urgent).length;
  const stale14 = idle.filter((r) => r.idleMs >= 14 * 24 * 60 * 60 * 1000).length;
  const items = idle.slice(0, maxRows);
  const parts = [`${idle.length} finished item${idle.length === 1 ? '' : 's'} nobody has reviewed`];
  if (urgentCount) parts.push(`${urgentCount} urgent`);
  if (stale14) parts.push(`${stale14} idle 14d+`);
  return {
    generatedAt: now.toISOString(),
    bannerText: parts.join(' · '),
    items,
    moreCount: Math.max(0, idle.length - items.length),
  };
}

module.exports = {
  IN_REVIEW_STATE,
  NOISE_TITLE_RE,
  IDLE_AFTER_MS,
  MAX_ROWS,
  URGENT_PRIORITY,
  isRealInReview,
  buildInReviewRows,
  buildInReviewSection,
};
