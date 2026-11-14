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

const { hasInlineDecision, findDecisionQuestion } = require('./decision-card-parse.js');

// The digest-autofix / canary pipeline files its own recurring rows as issues
// and dispatches them itself. They legitimately live in In Review and are not
// work the owner reviews, so counting them would inflate every number here.
//
// This predicate is IMPORTED, never restated. autofix-filed-marker.js's own
// header exists for exactly this reason ("A rename would silently stop the
// title check matching"), and the sibling owner-approval-channel.js imports
// its predicate rather than inlining one. A hand-rolled
// /^(CANARY:|BSC Daily:)/ was tried first and was measurably wrong: it let
// the email-worker's "Fix: BSC Daily: ..." title variant through as owner
// work, which every other layer in the repo treats as pipeline-owned (live
// example, BRO-212). Both ship-check reviewers found that independently.
const { isAutofixFiledIssue } = require('./autofix-filed-marker.js');

const IN_REVIEW_STATE = 'In Review';

// An item younger than this is not yet a leak — a session that finished an
// hour ago is supposed to be sitting in In Review waiting for the next
// morning's read. Ageing the block in at 3 days keeps "normal throughput"
// out of it, so a row appearing here always means something went unlooked-at
// across at least two digests.
const IDLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// The age at which a row stops being a queue and starts being a leak. Only
// used for the banner's escalation count; named rather than inlined so it
// reads next to IDLE_AFTER_MS above.
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

// Rows printed in the email. The rest become "+N more" — see header.
const MAX_ROWS = 6;

// At most this many of the printed rows may be urgent. Without the cap, a
// standing set of 6 urgent items monopolises every single email forever and
// the oldest rows — the actual leak this block exists to show — are never
// seen again (ship-check/Codex finding). Urgent still sorts first and still
// drives the banner count; it just cannot own the whole list.
const MAX_URGENT_ROWS = 4;

// Linear's priority scale: 0 = none, 1 = Urgent, 2 = High, 3 = Medium,
// 4 = Low. Only 1 is escalated here; "High" is the board's default for most
// filed work and would put ~80 rows in the escalated tier.
const URGENT_PRIORITY = 1;

// A Linear title has no length limit; needs-you-snapshot.js truncates at 220
// for the same reason — one 400-character title otherwise emits a single
// unreadable line into the owner's inbox.
const MAX_TITLE_CHARS = 220;

function isRealInReview(issue) {
  if (!issue || !issue.state) return false;
  if (issue.state.name !== IN_REVIEW_STATE) return false;
  return !isAutofixFiledIssue(issue);
}

// Owner markers (BRO-5433, tightened by BRO-6166). A card parked In Review is a decision FOR THE
// OWNER only when it says so: the awaiting-owner label (BRO-282), a real DECISION NEEDED line, an
// OWNER-ONLY: line, or an owner/crown card title. Everything else is technical work a worker
// finished; the owner never reviews it, so it must not be counted as "decisions for you"
// (2026-10-16 digest: 3 of 4 Review queue rows were technical).
// BRO-6166 (owner 2026-10-24: "are you sure those things actually need me?"): the old marker was a
// bare regex over title + description + every comment, so a card that merely MENTIONED the Mac
// coordinator tab ("check the 👑 OWNER watchdog tab") or the phrase "owner-only" in prose (as
// "owner-only stop", "Owner-only signed links") counted as the owner's. Now:
//   * DECISION NEEDED uses decision-card-parse.js hasInlineDecision(), the digest's own filters for a
//     real decision (needs ": <content>", skips code, placeholders and settled stubs), so "no
//     DECISION NEEDED here" and an echoed template do not count, while a worker's inline
//     "Report. DECISION NEEDED: pick A or B" still does;
//   * the crown/OWNER test applies to the TITLE only, and needs OWNER after the crown (OWNER_TITLE_RE);
//   * "owner-only" counts only as the start of a line ("OWNER-ONLY: why").
// The open-issues query carries no description or comments, so the digest first runs
// enrichForOwnerMarkers() on the idle cards that have no marker yet; stuck-card-closer reads the
// same fields from the full card. A card whose text cannot be read counts as owner-marked
// (shown), never as technical.
const AWAITING_OWNER_LABEL = 'awaiting-owner';
// A card TITLE addressed to the owner: a crown (then optional status emoji) followed by OWNER, or a title
// that starts with OWNER, as cmux tab titles and owner cards are written ("👑 OWNER: x", "❓ 👑 OWNER: x",
// "👑 🤖 OWNER: x"). Narrower than the reclaim sweep's OWNER_CARD_RE, which treats ANY crown in a title as an
// owner card: here a technical card whose title merely has a crown must not be shown to the human owner.
const OWNER_TITLE_RE = /\u{1F451}\s*(?:[^\w\s]\s*)*OWNER\b|^\W*OWNER\b/u;
const OWNER_ONLY_LINE_RE = /^\s*(?:[-*>]\s+)?\**OWNER[- ]ONLY\**\s*:/im;

function hasOwnerMarker(issue) {
  if (!issue) return false;
  const labels = (issue.labels && issue.labels.nodes) || [];
  if (labels.some((l) => l && l.name === AWAITING_OWNER_LABEL)) return true;
  if (issue.ownerMarkerUnknown) return true;
  if (OWNER_TITLE_RE.test(issue.title || '')) return true;
  const text = `${issue.title || ''}\n${issue.description || ''}\n${issue.commentText || ''}`;
  // findDecisionQuestion also reads the heading form ("## DECISION NEEDED" + question on the next line, BRO-6443).
  return hasInlineDecision(text) || !!findDecisionQuestion(text) || OWNER_ONLY_LINE_RE.test(text);
}

const OWNER_MARKER_QUERY = `query($id: String!) {
  issue(id: $id) { description comments(first: 100) { nodes { body } } }
}`;
const MAX_ENRICH = 40;

/**
 * Fill description + commentText on the idle In Review cards that carry no
 * marker yet, so a DECISION NEEDED that lives in the body or in a worker's
 * report comment still reaches the owner. Mutates and returns `issues`.
 * A failed read sets ownerMarkerUnknown (shown to the owner, fail safe); cards
 * past MAX_ENRICH are treated the same way rather than silently hidden.
 * @param {Array} issues listOpenIssues() rows
 * @param {(query:string, vars:object)=>Promise<any>} graphql
 */
async function enrichForOwnerMarkers(issues, graphql, { now = new Date(), idleAfterMs = IDLE_AFTER_MS } = {}) {
  const todo = (issues || []).filter((i) => isRealInReview(i) && !hasOwnerMarker(i)
    && idleMs(i, now) !== null && idleMs(i, now) >= idleAfterMs);
  let n = 0;
  for (const issue of todo) {
    if (n++ >= MAX_ENRICH) { issue.ownerMarkerUnknown = true; continue; }
    try {
      const data = await graphql(OWNER_MARKER_QUERY, { id: issue.identifier });
      const full = data && data.issue;
      if (!full) { issue.ownerMarkerUnknown = true; continue; }
      issue.description = full.description || '';
      issue.commentText = ((full.comments && full.comments.nodes) || []).map((c) => c && c.body).filter(Boolean).join('\n');
    } catch (_) {
      issue.ownerMarkerUnknown = true;
    }
  }
  return issues;
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
//
// What updatedAt CANNOT support, and what the wording below is careful not to
// claim (ship-check/Codex finding): it does not prove nobody looked. A bot
// relabelling an issue bumps it, and a human reading an issue without
// touching it does not. So every string this module emits says "idle" — an
// observable fact about the timestamp — and never "unreviewed" or "nobody has
// reviewed", which would be asserting something this data cannot show.
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
function buildInReviewRows(issues, { now = new Date(), ownerOnly = false } = {}) {
  return (issues || [])
    .filter(isRealInReview)
    .filter((issue) => !ownerOnly || hasOwnerMarker(issue))
    .map((issue) => {
      const ms = idleMs(issue, now);
      const urgent = isUrgent(issue);
      const label = formatIdle(ms);
      // Guard both halves: a Linear issue missing either field would
      // otherwise render the literal row "undefined: undefined" into the
      // owner's inbox (ship-check finding).
      const id = issue.identifier || '(no id)';
      const rawTitle = issue.title ? String(issue.title) : '(untitled)';
      const title = rawTitle.length > MAX_TITLE_CHARS
        ? `${rawTitle.slice(0, MAX_TITLE_CHARS - 1)}…`
        : rawTitle;
      return {
        title: `${id}: ${title}`,
        // "idle", never "unreviewed" — see idleMs()'s header for why this
        // data cannot support the stronger claim.
        detail:
          (urgent ? '⚠ Urgent — ' : '') +
          (label ? `finished; idle in review ${label}` : 'finished; idle in review'),
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
  { now = new Date(), idleAfterMs = IDLE_AFTER_MS, maxRows = MAX_ROWS, maxUrgentRows = MAX_URGENT_ROWS, ownerOnly = false } = {}
) {
  const all = buildInReviewRows(issues, { now, ownerOnly });
  const idle = all.filter((r) => r.idleMs !== null && r.idleMs >= idleAfterMs);
  if (!idle.length) return null;

  const urgent = idle.filter((r) => r.urgent);
  const rest = idle.filter((r) => !r.urgent);
  // Urgent first, but capped (see MAX_URGENT_ROWS) so a standing urgent set
  // cannot own every row forever. Any unused urgent budget is spent on the
  // oldest rows instead — `rest` is already oldest-first from
  // buildInReviewRows, so slicing preserves that order.
  const items = [...urgent.slice(0, Math.min(maxUrgentRows, maxRows)), ...rest].slice(0, maxRows);

  // Reduce, not Math.max(...spread): `idle` is unbounded (400+ rows is a real
  // scenario this block is meant to survive) and spreading a large array into
  // an argument list is the classic stack-overflow shape.
  const oldestMs = idle.reduce((max, r) => (r.idleMs > max ? r.idleMs : max), 0);
  const oldestLabel = formatIdle(oldestMs);
  const stale = idle.filter((r) => r.idleMs >= STALE_AFTER_MS).length;

  // Says what the owner is being asked to DO, not just what state things are
  // in: "Parked in review: 60 finished items nobody has reviewed" reads as a
  // status line and got skimmed past in review ("It sounds like a status, not
  // an action"). The oldest age is carried in the banner because the COUNT
  // alone goes stale — it can sit at 60 for weeks and become wallpaper, while
  // the oldest age always moves.
  const parts = [`${idle.length} finished item${idle.length === 1 ? '' : 's'} waiting for your review`];
  if (urgent.length) parts.push(`${urgent.length} urgent`);
  if (oldestLabel) parts.push(`oldest ${oldestLabel}`);
  if (stale) parts.push(`${stale} idle 14d+`);

  return {
    generatedAt: now.toISOString(),
    bannerText: parts.join(' · '),
    items,
    moreCount: Math.max(0, idle.length - items.length),
  };
}

/**
 * How many real In Review cards idle past the threshold carry NO owner marker
 * (BRO-5433). The digest counts them under Technical details; the closer
 * (stuck-card-closer.js) is what actually moves them.
 */
function countTechnicalInReview(issues, { now = new Date(), idleAfterMs = IDLE_AFTER_MS } = {}) {
  return (issues || []).filter((issue) => {
    if (!isRealInReview(issue) || hasOwnerMarker(issue)) return false;
    const ms = idleMs(issue, now);
    return ms !== null && ms >= idleAfterMs;
  }).length;
}

module.exports = {
  AWAITING_OWNER_LABEL,
  hasOwnerMarker,
  enrichForOwnerMarkers,
  countTechnicalInReview,
  IN_REVIEW_STATE,
  IDLE_AFTER_MS,
  STALE_AFTER_MS,
  MAX_ROWS,
  MAX_URGENT_ROWS,
  MAX_TITLE_CHARS,
  URGENT_PRIORITY,
  isRealInReview,
  buildInReviewRows,
  buildInReviewSection,
};
