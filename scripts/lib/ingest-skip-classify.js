/**
 * ingest-skip-classify.js — is an ingest no-op benign, or a data conflict?
 *
 * Born 2026-08-09 from a live coverage hole. ingest-review-from-url.js exits 0
 * for every skip class, so audit-show-review-gap.js could only tell "a file
 * landed" from "no file landed" and lumped ALL non-landing exits into one
 * benign `noop` bucket (added ship-check 2026-08-06 to stop a chronic hourly
 * alarm). That was right for "no-changes" and wrong for `cross-show-url-owned`:
 *
 *   I'm Every Woman's Guardian, Times and Evening Standard reviews were filed
 *   under the-car-man-west-end-2026 by an in-place URL upgrade. Cross-show URL
 *   ownership therefore refused every attempt to file them under the show that
 *   actually owns them. The hourly audit tried, was vetoed, printed "no-op",
 *   and repeated — for days. The gap WAS counted (those URLs stay in
 *   `missing`, so `uncollected` saw them); what was missing is that nothing
 *   said the collection attempt was being structurally blocked, or by whom, so
 *   every run looked like "still waiting on a fetch" instead of "two shows
 *   claim this URL and a human must pick one".
 *
 * The distinction that matters: a CONFLICT is a skip where two records
 * disagree about reality, so exactly one of them is wrong and a fix exists. It
 * can never resolve itself by being retried. A BENIGN skip is one where the
 * desired end state already holds, or the URL legitimately isn't a review.
 *
 * The reason strings are a CONTRACT with scripts/lib/review-file-writer.js.
 * ingest-skip-classify.test.mjs greps that file for every `reason:` literal it
 * can emit and fails if one is in neither list — so adding a skip reason there
 * without classifying it here breaks CI instead of silently defaulting to
 * quiet (which is the exact failure mode this module exists to remove).
 *
 * Pure per CLAUDE.md §15 — audit-show-review-gap.js wires it, the test
 * require()s it.
 */

'use strict';

// CONFLICT = two records disagree about reality; exactly one is wrong.
// Retrying never fixes these, and staying quiet caps coverage silently.
const CONFLICT_REASONS = [
  // Another show's directory already owns this URL (emitted as
  // `cross-show-url-owned:<owningShowId>`). Either that show is contaminated
  // or this citation is wrong — always a real data bug.
  'cross-show-url-owned',
  // The resolved outlet's registered domain doesn't match the URL's host
  // (emitted as `domain-mismatch: <prose>`). A misrouted outlet id, or a
  // registry entry missing a domain the outlet actually publishes on — e.g. an
  // outlet that moved to Substack. Drops a real review on the floor.
  'domain-mismatch',
  // No outlet could be resolved at all — the review is discarded. With
  // ingest-review-from-url.js's provisional fallback this should be rare, and
  // when it happens it means a URL we cannot attribute.
  'no-outlet',
  // Outlet id failed the slug sanity check (garbage provisional slug). Real
  // review, unusable attribution — needs a registry entry.
  'suspicious-outlet-id',
  // Cross-market guard rejected the write. Correct behaviour on a genuine
  // leak, but it is a rejection of a cited review, so it must stay visible
  // rather than reading as "nothing to do".
  'cross-market',
];

// Desired end state already holds, or the URL legitimately isn't a review.
const BENIGN_REASONS = [
  'no-changes',                     // identical content already on disk
  'junk-outlet',                    // ticket sellers / listing pages
  'unregistered-outlet-empty-stub', // no text to lose; nothing was dropped
];

/**
 * Classify one ingest attempt from the child process's stdout.
 *
 * ingest-review-from-url.js prints `⚠️  Skipped: <reason>` on the skip path.
 * Two emitted shapes carry a detail after the reason:
 *   `cross-show-url-owned:<showId>`      — no space, machine-readable
 *   `domain-mismatch: <human prose>`     — space, prose (detail stays null)
 * so the detail group deliberately requires NO space after the colon; prose
 * variants classify correctly with detail === null.
 *
 * @param {string} stdout  combined child stdout (may be '' when unavailable)
 * @returns {{kind: 'conflict'|'benign'|'unclassified', reason: string|null, detail: string|null}}
 */
function classifyIngestSkip(stdout) {
  const text = String(stdout || '');
  const m = text.match(/Skipped:\s*([a-z0-9-]+)(?::(\S+))?/i);
  if (!m) return { kind: 'unclassified', reason: null, detail: null };
  const reason = m[1].toLowerCase();
  const detail = m[2] || null;
  if (CONFLICT_REASONS.includes(reason)) return { kind: 'conflict', reason, detail };
  if (BENIGN_REASONS.includes(reason)) return { kind: 'benign', reason, detail };
  // Deliberately NOT benign: an unrecognised reason is a contract drift, and
  // defaulting it to quiet is how the original silent veto survived. The audit
  // counts these separately and prints them.
  return { kind: 'unclassified', reason, detail };
}

/**
 * Human-readable, action-bearing line for a conflict — used in the audit's
 * ::error:: and any alert body. Never phrase a conflict as "no-op": the
 * operator must be able to act on it from the message alone.
 */
function describeConflict(showId, url, { reason, detail }) {
  if (reason === 'cross-show-url-owned') {
    return `${showId}: ${url} is already owned by ${detail || 'another show'} — one of the two is contaminated. `
      + `Inspect data/review-texts/${detail || '<owner>'}/ for this URL; if that copy is the misfiled one, flag it `
      + `wrongShow with a manual wrongShowReason (that releases ownership), then re-ingest here.`;
  }
  if (reason === 'domain-mismatch') {
    return `${showId}: ${url} was rejected because the resolved outlet's registered domain doesn't match the URL host `
      + `— add the host to that outlet's domainAliases in data/outlet-registry.json, or pass the correct --outlet.`;
  }
  if (reason === 'no-outlet' || reason === 'suspicious-outlet-id') {
    return `${showId}: ${url} could not be attributed to a usable outlet (${reason}) — add a registry entry for its host.`;
  }
  if (reason === 'cross-market') {
    return `${showId}: ${url} was rejected by the cross-market guard — confirm the review really belongs to this market.`;
  }
  return `${showId}: ${url} skipped as ${reason}${detail ? ` (${detail})` : ''}.`;
}

module.exports = { classifyIngestSkip, describeConflict, CONFLICT_REASONS, BENIGN_REASONS };
