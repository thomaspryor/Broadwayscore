/**
 * owner-approval-channel.js — pure decision logic for BRO-282: "no channel
 * tells the owner that something is waiting on their approval."
 *
 * Linear's built-in "In Review" state is already the generic signal every
 * dispatched session lands on when it finishes (linear-dispatch.js's own
 * seed prompt tells every session to set "In Review" on completion) — reusing
 * it for "blocked on an owner decision specifically" would conflate the two
 * and make the digest noisy with ordinary finished work. So this uses a
 * dedicated label (AWAITING_OWNER_LABEL) instead: one issue can be "In
 * Review" (session done, reviewable) AND separately "awaiting-owner"
 * (actively blocked — cannot ship without a plain-language yes from the
 * owner, e.g. the /visual-qa pre-push gate).
 *
 * BRO-420 (BRO-282 follow-up): the label alone has no expiry or state
 * transition, so an issue the owner approved but forgot to unlabel — or one
 * that just sat for days — reads identically to one labeled a minute ago.
 * waitingSince()/buildAwaitingOwnerRows() below add an age signal so a stale
 * row is visually distinct (sorted to the top, marked once past
 * STALE_AFTER_MS) instead of blending into a wall of identical "Waiting on
 * your approval" lines.
 *
 * No I/O here — scripts/lib/linear-client.js talks to the Linear API,
 * scripts/send-morning-digest.js and scripts/linear-attach-approval.js call
 * into this file for the pure filtering/shaping (CLAUDE.md rule 15).
 */
'use strict';

const { issueLabelNames } = require('./linear-dispatch.js');

const AWAITING_OWNER_LABEL = 'awaiting-owner';

// BRO-420 acceptance criteria: 48h+ untouched renders differently.
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

// Matches linear-attach-approval.js's summary comment — both its success
// wording ("Waiting on your approval: N visual-qa crop(s) attached above...")
// and its partial-failure wording start with this exact prefix.
const WAITING_SINCE_COMMENT_RE = /^Waiting on your approval/;

function isAwaitingOwner(issue) {
  return issueLabelNames(issue).includes(AWAITING_OWNER_LABEL);
}

// "Waiting since" for one issue. Deliberately NOT issue.updatedAt read
// directly by the caller — that field bumps on ANY activity on the issue,
// including the owner replying without removing the label (BRO-420's own
// motivating example), which would silently reset the staleness clock right
// when it matters most. Prefers the most recent linear-attach-approval.js
// summary comment (re-running the attach script posts a new one each time,
// so the latest is the current ask, not the first labeling). Falls back to
// issue.updatedAt when the issue was fetched without comments (or the label
// was added by hand, no matching comment), and to null when neither is
// available — callers must treat null as "age unknown", not "0".
//
// buildIssueQuery() (linear-dispatch.js) fetches `comments(first: 20)` —
// confirmed live against the Linear API that this connection orders newest
// first, so the cap keeps the most RECENT 20 comments, not the oldest 20.
// The only way this misses the true latest approval comment is 20+ replies
// on the issue since it was last labeled with none of them being a re-run of
// linear-attach-approval.js — at that point falling back to updatedAt (a
// slight understale rather than a crash) is an acceptable degradation.
function waitingSince(issue) {
  const comments = (issue && issue.comments && issue.comments.nodes) || [];
  const matchTimestamps = comments
    .filter((c) => c && typeof c.body === 'string' && WAITING_SINCE_COMMENT_RE.test(c.body))
    .map((c) => c.createdAt)
    .filter(Boolean)
    .sort(); // ISO 8601 strings sort correctly lexicographically
  if (matchTimestamps.length) return matchTimestamps[matchTimestamps.length - 1];
  return (issue && issue.updatedAt) || null;
}

function ageMs(issue, now) {
  const since = waitingSince(issue);
  if (!since) return null;
  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) return null;
  return Math.max(0, now.getTime() - sinceMs);
}

// "just now" / "3h" / "2d" — coarse, digest-row-sized. Sub-hour ages read as
// "just now" so a few minutes of retry/timezone jitter doesn't paint a
// brand-new item as aged.
function formatAge(ms) {
  if (ms === null || ms === undefined) return null;
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

// {identifier, title, url}[] shaped issues -> renderNamedDigestBlock's
// {title, detail, url} item shape (autonomous-email-render.js) — same
// contract needs-you-snapshot.js already produces for the cmux-tab-based
// "Needs your decision" row, so this rides the same rendering rail rather
// than inventing a second item shape. Sorted oldest-first (BRO-420) so a
// stale row surfaces at the top of the digest block instead of wherever
// Linear's own ordering happened to place it.
function buildAwaitingOwnerRows(issues, { now = new Date() } = {}) {
  return (issues || [])
    .filter(isAwaitingOwner)
    .map((issue) => {
      const age = ageMs(issue, now);
      const stale = age !== null && age >= STALE_AFTER_MS;
      const ageLabel = formatAge(age);
      return {
        title: `${issue.identifier}: ${issue.title}`,
        detail: stale
          ? `⚠ Waiting on your approval — ${ageLabel} (stale)`
          : ageLabel
            ? `Waiting on your approval — ${ageLabel}`
            : 'Waiting on your approval',
        url: issue.url,
        waitingSince: waitingSince(issue),
        ageMs: age,
        stale,
      };
    })
    // Oldest first. Unknown-age (null) items sort LAST — there is nothing to
    // escalate about an item this function cannot date, so burying it below
    // every dated row (rather than at the top, which would read as "most
    // urgent" for the one item we know least about) is the safer default.
    .sort((a, b) => {
      if (a.ageMs === null && b.ageMs === null) return 0;
      if (a.ageMs === null) return 1;
      if (b.ageMs === null) return -1;
      return b.ageMs - a.ageMs;
    });
}

// Digest-shaped snapshot: {generatedAt, bannerText, items}. Returns null when
// nothing is waiting so the digest omits the block entirely — a standing
// zero-row trains the eye to skip it, which is the exact failure mode BRO-282
// exists to fix.
function buildAwaitingOwnerSection(issues, { now = new Date() } = {}) {
  const items = buildAwaitingOwnerRows(issues, { now });
  if (!items.length) return null;
  const staleCount = items.filter((i) => i.stale).length;
  return {
    generatedAt: now.toISOString(),
    bannerText:
      `${items.length} item${items.length === 1 ? '' : 's'} waiting on your approval` +
      (staleCount ? ` (${staleCount} stale 48h+)` : ''),
    items,
  };
}

// Fetches full issue data (comments included) for just the awaiting-owner
// subset, so waitingSince() can use the precise comment timestamp instead of
// falling back to issue.updatedAt. listOpenIssues()'s own query deliberately
// omits comments (fetching them for every one of the team's 100+ open issues
// to serve a handful of awaiting-owner rows would bloat every other caller of
// that query), so this is a second, targeted round trip.
//
// `getIssue` and `timeoutMs` are injected rather than importing
// linear-client.js directly — same shape as linear-client.js's own graphql()
// taking an injected sleepFn — so this orchestration (parallel fan-out,
// per-issue fallback, whole-batch timeout) is unit-testable with a stub, no
// live Linear call or network stub required. Best-effort: any issue whose
// re-fetch errors, or a fetch that doesn't finish within timeoutMs, is
// returned unenriched (so buildAwaitingOwnerRows falls back to its
// updatedAt-based dating instead of losing the row entirely).
//
// Also refreshes `labels` from the same re-fetch (not just `comments`):
// listOpenIssues()'s snapshot and this re-fetch are two separate round
// trips, so an owner who removes the awaiting-owner label in the gap between
// them must not have that removal ignored — the caller re-applies
// isAwaitingOwner() to THIS function's output (labels included) rather than
// trusting the earlier snapshot's label set (ship-check finding, BRO-420).
async function enrichWithComments(issues, { getIssue, timeoutMs = 15_000, onError } = {}) {
  if (!issues || !issues.length) return issues || [];
  // Timer handle captured so it can be cleared once the race settles either
  // way — an uncleared setTimeout keeps the event loop (and, under `node
  // --test`, the whole process) alive for the full timeoutMs even after
  // Promise.all already won the race, turning what should be a sub-ms call
  // into a real timeoutMs-long hang (caught by this file's own tests: the
  // "merges comments" happy-path test took 15s wall-clock before this fix,
  // with a passing assertion the whole time — the timer, not the logic, was
  // the problem).
  let timer;
  const timeout = (ms) =>
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    });
  try {
    return await Promise.race([
      Promise.all(
        issues.map(async (issue) => {
          try {
            const full = await getIssue(issue.identifier);
            return full ? { ...issue, comments: full.comments, labels: full.labels || issue.labels } : issue;
          } catch (err) {
            if (onError) onError(issue, err);
            return issue;
          }
        })
      ),
      timeout(timeoutMs),
    ]);
  } catch (err) {
    // Whole-batch timeout: even issues whose fetch already resolved are
    // discarded along with the slow one(s) — Promise.race has no way to keep
    // partial Promise.all results — so every row in this batch degrades to
    // updatedAt-based dating together, not just the slow issue's row.
    if (onError) onError(null, err);
    return issues;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  AWAITING_OWNER_LABEL,
  STALE_AFTER_MS,
  isAwaitingOwner,
  waitingSince,
  formatAge,
  buildAwaitingOwnerRows,
  buildAwaitingOwnerSection,
  enrichWithComments,
};
