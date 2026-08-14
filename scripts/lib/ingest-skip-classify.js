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
 * Three buckets, because two was one too few (ship-check on the first version,
 * 2026-08-09):
 *
 *   CONFLICT           two records disagree about reality, so exactly one of
 *                      them is wrong and a fix exists. Retrying never resolves
 *                      it. Loud, and counted as a residual gap until fixed.
 *   EXPECTED-REJECTION the write was refused and that refusal is CORRECT and
 *                      PERMANENT — no human action changes it. Visible in the
 *                      per-run log so it is never invisible, but never added to
 *                      `residual`: inflating the residual tally with these is
 *                      exactly the chronic hourly alarm the 2026-08-06
 *                      ship-check removed, and re-creating it would retrain the
 *                      owner to ignore the warning that matters.
 *   BENIGN             the desired end state already holds, or the URL
 *                      legitimately isn't a review. Quiet.
 *
 * The reason strings are a CONTRACT with scripts/lib/review-file-writer.js.
 * ingest-skip-classify.test.mjs greps that file for every `reason:` literal it
 * can emit and fails if one is in no list — so adding a skip reason there
 * without classifying it here breaks CI instead of silently defaulting to
 * quiet (which is the exact failure mode this module exists to remove).
 *
 * That grep is itself load-bearing, and its FIRST version was too narrow to see
 * two real literals: `onMerge-aborted` (capital M) and `empty-unknown: no URL,
 * no text, unknown critic` (colon + spaces inside the quoted literal). A
 * contract test that cannot see part of its contract is worse than none — it
 * reports coverage it does not have. Both the producer grep and the classifier
 * are therefore case-insensitive and colon-tolerant, and reasons are compared
 * lower-cased on both sides.
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
  // The URL is on a known aggregator domain while the resolved outlet is a
  // real outlet — the aggregator_url_mismatch contamination class (guard added
  // to createOrMergeReviewFile 2026-08-09). Same shape as 'cross-market':
  // refusing the write is correct, but a CITED review was dropped, and the
  // citation usually means the outlet's own URL was never resolved — the
  // roundup link stood in for it. Visible, not quiet.
  'aggregator-url-mismatch',
  // Same class, refinement side: the URL's domain resolved to an AGGREGATOR
  // outlet, so the writer refused to rewrite the real outlet onto it AND
  // refused the write. Also a CONFLICT, not an expected rejection — a cited
  // review was dropped and the roundup link stood in for the outlet's own URL.
  'aggregator-url-refinement-refused',
];

// EXPECTED REJECTION = the write was correctly refused and no human action
// changes that. Printed once per occurrence so it is never invisible, but
// deliberately NOT residual — see the three-bucket note in the header.
const EXPECTED_REJECTION_REASONS = [
  // Cross-market guard refused the write. On a genuine cross-market leak this
  // is the right answer forever; counting it as an unresolved conflict re-arms
  // the chronic hourly alarm on every show that legitimately has one.
  'cross-market',
  // A caller's onMerge hook aborted the merge (review-file-writer.js:752).
  // The caller decided not to write; that is its prerogative, not a data
  // disagreement. Lower-cased here because classifyIngestSkip lower-cases the
  // captured reason and the literal is `onMerge-aborted`.
  'onmerge-aborted',
  // Nothing to write at all: no URL, no text, unknown critic
  // (review-file-writer.js:532). No review was dropped because there was no
  // review — but it stays visible, since a caller producing these in bulk
  // means an upstream extractor is returning empty.
  'empty-unknown',
  // Tour/regional contamination guard refused the write
  // (review-file-writer.js:396, hoisted from gather-reviews by task #1150).
  // A tour-stop or regional-mounting review filed under this show is not a
  // review of this production — the refusal is correct and permanent, same
  // footing as cross-market.
  'tour-review',
];

// Desired end state already holds, or the URL legitimately isn't a review.
const BENIGN_REASONS = [
  'no-changes',                     // identical content already on disk
  'junk-outlet',                    // ticket sellers / listing pages
  'unregistered-outlet-empty-stub', // no text to lose; nothing was dropped
];

// Shared verdict lookup — both public entry points below reduce to this.
function classify(reasonLower, detail) {
  if (CONFLICT_REASONS.includes(reasonLower)) return { kind: 'conflict', reason: reasonLower, detail };
  if (EXPECTED_REJECTION_REASONS.includes(reasonLower)) return { kind: 'expected', reason: reasonLower, detail };
  if (BENIGN_REASONS.includes(reasonLower)) return { kind: 'benign', reason: reasonLower, detail };
  // Deliberately NOT benign: an unrecognised reason is a contract drift, and
  // defaulting it to quiet is how the original silent veto survived. The audit
  // counts these separately and prints them.
  return { kind: 'unclassified', reason: reasonLower, detail };
}

/**
 * Classify one ingest attempt from the child process's stdout.
 *
 * ingest-review-from-url.js prints `⚠️  Skipped: <reason>` on the skip path.
 * Emitted shapes that carry something after the reason:
 *   `cross-show-url-owned:<showId>`                     — no space, machine-readable
 *   `domain-mismatch: <human prose>`                    — space, prose (detail stays null)
 *   `empty-unknown: no URL, no text, unknown critic`    — same prose shape
 * so the detail group deliberately requires NO space after the colon; prose
 * variants classify correctly with detail === null. `onMerge-aborted` carries a
 * capital letter, so the reason charset is case-insensitive and the captured
 * reason is lower-cased before lookup (every list below is lower-case).
 *
 * @param {string} stdout  combined child stdout (may be '' when unavailable)
 * @returns {{kind: 'conflict'|'expected'|'benign'|'unclassified', reason: string|null, detail: string|null}}
 */
function classifyIngestSkip(stdout) {
  const text = String(stdout || '');
  const m = text.match(/Skipped:\s*([a-z0-9-]+)(?::(\S+))?/i);
  if (!m) return { kind: 'unclassified', reason: null, detail: null };
  return classify(m[1].toLowerCase(), m[2] || null);
}

/**
 * Classify a raw `reason` field the way createOrMergeReviewFile returns it
 * directly (scripts/lib/review-file-writer.js's `{ action: 'skipped', reason }`)
 * — for callers that hold the structured result in hand and never round-trip
 * through a child process's stdout. Same shapes, same three-bucket contract,
 * same lower-casing as classifyIngestSkip; only the input differs.
 *
 * Born from BRO-205: 6 scrape-*.js callers checked `result.action === 'skipped'`
 * (or special-cased only `domain-mismatch`) and filed every OTHER conflict
 * reason — cross-show-url-owned, no-outlet, suspicious-outlet-id,
 * aggregator-url-mismatch, aggregator-url-refinement-refused — under a generic
 * "already have it" counter. That is the same silent veto the gap audit fixed
 * in audit-show-review-gap.js, just reached through a different call shape.
 *
 * @param {string|null|undefined} rawReason  e.g. 'cross-show-url-owned:show-id', 'domain-mismatch: prose', 'junk-outlet'
 * @returns {{kind: 'conflict'|'expected'|'benign'|'unclassified', reason: string|null, detail: string|null}}
 */
function classifyReason(rawReason) {
  const text = String(rawReason || '');
  const m = text.match(/^([a-z0-9-]+)(?::(\S+))?/i);
  if (!m) return { kind: 'unclassified', reason: null, detail: null };
  return classify(m[1].toLowerCase(), m[2] || null);
}

/**
 * Human-readable, action-bearing line for a skip — used in the audit's
 * ::error::/::warning:: and any alert body. Never phrase a skip as "no-op": the
 * operator must be able to tell from the message alone whether there is
 * something to do, and if so what.
 *
 * Covers conflicts AND expected rejections. An expected-rejection message says
 * plainly that no action is needed, so a reader can stop there instead of
 * re-deriving that conclusion every run.
 */
function describeSkip(showId, url, { reason, detail }) {
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
    return `${showId}: ${url} was refused by the cross-market guard — expected rejection, no action needed unless this outlet really does cover this market (then fix its region in data/outlet-registry.json).`;
  }
  if (reason === 'onmerge-aborted') {
    return `${showId}: ${url} — the calling script's onMerge hook aborted the write. Expected rejection: the caller decided not to merge, no action needed here.`;
  }
  if (reason === 'empty-unknown') {
    return `${showId}: ${url} carried no URL, no text and no critic, so there was nothing to write. Expected rejection; if a caller produces these in bulk its extractor is returning empty.`;
  }
  if (reason === 'tour-review') {
    return `${showId}: ${url} looks like a tour-stop or regional-mounting review (BWW city subdirectory / local-paper tour coverage), not a review of this production — refused by the tour-contamination guard. Expected rejection; if this outlet genuinely reviewed THIS production, ingest with the correct production URL or fix isLikelyTourReview in review-guards.js.`;
  }
  if (reason === 'aggregator-url-mismatch') {
    return `${showId}: ${url} is an aggregator roundup page, so it was refused rather than filed as an outlet's own review `
      + `— find that outlet's own article URL (the roundup links to it) and ingest that instead. `
      + `Filing the roundup URL under a real outlet is the aggregator_url_mismatch defect validate-review-texts.js fails the trunk on.`;
  }
  if (reason === 'aggregator-url-refinement-refused') {
    return `${showId}: ${url} sits on an aggregator's roundup domain, so it is not that outlet's own review — the write was refused rather than silently refiled as the aggregator's review. `
      + `Find the outlet's own article URL (the roundup links to it) and ingest that. `
      + `A legitimate aggregator star-stub (aggregatorStars/originalScore present) is NOT refused — it lands under its true outlet instead (task #1325); this refusal only fires when there is no score to preserve.`;
  }
  return `${showId}: ${url} skipped as ${reason}${detail ? ` (${detail})` : ''}.`;
}

module.exports = {
  classifyIngestSkip,
  classifyReason,
  describeSkip,
  CONFLICT_REASONS,
  EXPECTED_REJECTION_REASONS,
  BENIGN_REASONS,
};
