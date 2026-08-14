/**
 * Track a user's content request from "routed" all the way to "live on the
 * site", and decide when it is actually done.
 *
 * WHY (2026-08-05, owner request): dispatching a workflow is not fixing
 * anything. Every prior notification in this pipeline stopped at intent —
 * "auto-dispatched", "needs review" — and nothing ever confirmed the show
 * appeared, the reviews landed, or the deploy shipped. The owner asked to be
 * told when a request is FULLY fixed, meaning visible on broadwayscorecard.com,
 * plus whether a systematic fix (a route that handles this ask shape from now
 * on) came with it.
 *
 * Deliberately PURE: no network, no fs. The caller fetches live show JSON and
 * hands it in, so the satisfaction rules are unit-testable against real payload
 * shapes instead of re-derived against a live site that changes hourly.
 *
 * Live payload shape (broadwayscorecard.com/data/shows/{id}.json) is the
 * compact one: `rv` = reviews array, `hi` = hero image path, `cat` = category.
 *
 * Colocated test: tests/unit/feedback-request-ledger.test.mjs
 */

/** Days after which an unsatisfied request is surfaced as stuck, not silently kept. */
const STALE_AFTER_DAYS = 3;

/** Cap on submitter free text copied into this committed, public-repo file. */
const MAX_STORED_MESSAGE = 500;

function entryKey(action, submissionId) {
  const subject = action.showId || action.title || 'unknown';
  return `${action.kind}:${String(subject).toLowerCase()}:${submissionId || 'nosub'}`;
}

/**
 * Build a ledger entry for one dispatchable action.
 *
 * `systematicFix` records that this ask shape now has a standing route, which
 * is the difference between "someone fixed my thing" and "this class of request
 * fixes itself from now on" — the owner asked to be told which one happened.
 */
function buildEntry(action, { submissionId, issueNumber, requestedAt, message, show }) {
  return {
    key: entryKey(action, submissionId),
    kind: action.kind,
    title: action.showTitle || action.title || null,
    market: action.market || null,
    showId: action.showId || null,
    reviewCountAtRequest:
      typeof action.reviewCountAtRequest === 'number' ? action.reviewCountAtRequest : null,
    workflow: action.workflow || null,
    issueNumber: issueNumber || null,
    submissionId: submissionId || null,
    requestedShowField: show || null,
    // Only content-fix entries carry these (existing-content-is-wrong asks,
    // as opposed to missing-show/missing-reviews/missing-image content
    // ADDITIONS). `contentErrorType` picks which evaluateEntry() rule below
    // applies; `expected` is that rule's own structured claim (outlet, name,
    // ceremony...) — never free text, so re-checking never has to parse prose.
    contentErrorType: action.contentErrorType || null,
    expected: action.expected || null,
    // Capped. This file is committed to a PUBLIC repo, and a submitter can type
    // anything into a free-text box. The same message is already posted verbatim
    // into a public GitHub issue by the issue-creation step, so the incremental
    // exposure here is nil — but an unbounded free-text field copied into git
    // history is worth bounding regardless (ship-check, 2026-08-05). Name and
    // email are deliberately never stored here at all.
    requestedMessage: message ? String(message).slice(0, MAX_STORED_MESSAGE) : null,
    requestedAt: requestedAt || new Date().toISOString(),
    status: 'open',
    satisfiedAt: null,
    systematicFix: {
      routed: true,
      route: action.kind,
      note: `Handled by the ${action.kind} route — future identical requests dispatch themselves.`,
    },
  };
}

/** How many individual reviews to name in one report before summarising. */
const MAX_NAMED_REVIEWS = 5;

/**
 * One live review rendered as the facts the owner asked to see (2026-08-05):
 * outlet, critic, date. The show itself heads the block that contains it.
 *
 * Compact live-payload keys: `o` outlet, `cn` critic, `d` publish date, `s`
 * score, `u` url. Every one can legitimately be absent on a real review (an
 * un-bylined stub has no `cn`; a network-tier review can have no `d`), so each
 * renders only when present instead of printing "undefined" at the owner.
 */
function describeReview(rv) {
  if (!rv || typeof rv !== 'object') return null;
  const outlet = rv.o || 'Unknown outlet';
  const critic = rv.cn && rv.cn !== 'Unknown' ? rv.cn : null;
  const parts = [critic ? `${critic}, ${outlet}` : outlet];
  if (rv.d) parts.push(rv.d);
  if (typeof rv.s === 'number') parts.push(`score ${rv.s}`);
  return { text: parts.join(' · '), url: rv.u || null };
}

/**
 * The reviews to NAME for a satisfied request — newest first.
 *
 * For missing-reviews the ledger records how many reviews existed at request
 * time but not WHICH, so the newest `now - before` are the ones that landed.
 * Sorted by publish date descending; an undated review sorts last rather than
 * being dropped, since dropping it could make the named list shorter than the
 * count the same report is claiming.
 */
function newReviewsFor(entry, reviews) {
  const sorted = [...reviews].sort((a, b) => String(b?.d || '').localeCompare(String(a?.d || '')));
  if (entry.kind !== 'missing-reviews') return sorted.slice(0, MAX_NAMED_REVIEWS);
  const before = entry.reviewCountAtRequest == null ? 0 : entry.reviewCountAtRequest;
  const added = Math.max(0, sorted.length - before);
  return sorted.slice(0, Math.min(added, MAX_NAMED_REVIEWS));
}

/**
 * Is this request now visible on the live site?
 *
 * `reviews` (2026-08-05, owner request) carries the specific reviews behind the
 * verdict. "0 → 1 review(s) live" gave the owner a number and nothing they
 * could check; they asked for outlet, critic, show and date. Always an array —
 * empty for the kinds that have no review to name.
 *
 * @param {object} entry     ledger entry
 * @param {object|null} live parsed {base}/data/shows/{id}.json, or null on 404
 * @returns {{satisfied: boolean, evidence: string, reviews: Array<{text: string, url: string|null}>}}
 */
function evaluateEntry(entry, live) {
  if (!live) {
    return { satisfied: false, evidence: 'show JSON not served by production yet', reviews: [] };
  }
  const reviews = Array.isArray(live.rv) ? live.rv : [];
  const named = () => newReviewsFor(entry, reviews).map(describeReview).filter(Boolean);

  if (entry.kind === 'missing-show') {
    // The show being served AT ALL is the whole ask. Reviews may follow later.
    return {
      satisfied: true,
      evidence: `live with ${reviews.length} review(s)${live.cat ? ` in ${live.cat}` : ''}`,
      reviews: named(),
    };
  }

  if (entry.kind === 'missing-reviews') {
    const before = entry.reviewCountAtRequest == null ? 0 : entry.reviewCountAtRequest;
    if (reviews.length > before) {
      return {
        satisfied: true,
        evidence: `${before} → ${reviews.length} review(s) live`,
        reviews: named(),
      };
    }
    return { satisfied: false, evidence: `still ${reviews.length} review(s), was ${before}`, reviews: [] };
  }

  if (entry.kind === 'missing-image') {
    if (live.hi) return { satisfied: true, evidence: `hero image live at ${live.hi}`, reviews: [] };
    return { satisfied: false, evidence: 'still no hero image in production', reviews: [] };
  }

  if (entry.kind === 'content-fix') {
    return evaluateContentFix(entry, live, reviews);
  }

  // Unknown kind: never claim satisfied. A wrong "it's fixed!" email is worse
  // than another day of waiting — it is how a request gets closed unfixed.
  return { satisfied: false, evidence: `no live-check rule for kind "${entry.kind}"`, reviews: [] };
}

/** Case/whitespace-insensitive outlet name match — "BroadwayWorld" vs "broadwayworld ". */
function sameOutlet(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The "Manual Fix Needed" content-error asks (2026-08-13, task #1440 audit of
 * ~/Documents/claude-outputs/feedback-form-audit-2026-08-13.md): reports that
 * EXISTING site content is wrong, as opposed to missing-show/missing-reviews/
 * missing-image which ask for content that doesn't exist yet. These never got
 * the "did it actually ship?" treatment those three kinds have had since
 * 2026-08-05 — ~10 were closed as GitHub issues despite the paired email
 * saying the auto-fix explicitly failed, and one (Kinky Boots NJ tour, issue
 * #150) was still broken 6 months later with nothing watching it.
 *
 * `entry.contentErrorType` selects the rule; `entry.expected` is that rule's
 * structured claim, set by whatever builds the entry — never inferred from
 * free text here, so a wrong guess can't manufacture a false "it's fixed".
 * A type with no rule yet (or one this payload can't verify, e.g. awards
 * data isn't in {base}/data/shows/{id}.json) reports that honestly and stays
 * open — staleEntries() still surfaces it after STALE_AFTER_DAYS instead of
 * the silence this whole change exists to replace.
 */
function evaluateContentFix(entry, live, reviews) {
  const type = entry.contentErrorType;
  const expected = entry.expected || {};

  if (type === 'new-show-record') {
    // The show record existing (correctly) at all is the whole ask — same
    // bar as missing-show, for a record that had to be rebuilt from scratch.
    return {
      satisfied: true,
      evidence: `live with ${reviews.length} review(s)${live.cat ? ` in ${live.cat}` : ''}`,
      reviews: [],
    };
  }

  if (type === 'wrong-critic-name') {
    const match = reviews.find((r) => r && expected.outlet && sameOutlet(r.o, expected.outlet));
    if (!match) return { satisfied: false, evidence: `no live review found yet for ${expected.outlet || 'that outlet'}`, reviews: [] };
    if (expected.criticName && match.cn === expected.criticName) {
      return { satisfied: true, evidence: `${expected.outlet} review now credited to ${expected.criticName}`, reviews: [] };
    }
    return {
      satisfied: false,
      evidence: `${expected.outlet} review still credited to ${match.cn || 'no byline'}, not ${expected.criticName || 'the corrected name'}`,
      reviews: [],
    };
  }

  if (type === 'outlet-rename') {
    if (expected.newOutletName && reviews.some((r) => r && sameOutlet(r.o, expected.newOutletName))) {
      return { satisfied: true, evidence: `outlet now shows as "${expected.newOutletName}"`, reviews: [] };
    }
    return {
      satisfied: false,
      evidence: `outlet still not showing as "${expected.newOutletName || 'the corrected name'}"`,
      reviews: [],
    };
  }

  if (type === 'single-review') {
    const match = reviews.find((r) => r && expected.outlet && sameOutlet(r.o, expected.outlet));
    if (match) {
      const named = describeReview(match);
      return { satisfied: true, evidence: `${expected.outlet} review is now live`, reviews: named ? [named] : [] };
    }
    return { satisfied: false, evidence: `still no ${expected.outlet || 'that'} review live`, reviews: [] };
  }

  if (type === 'wrong-award-co-winner') {
    // Awards data (ceremony/category winners) is not in the compact live show
    // payload this checker fetches — there is no public endpoint to verify
    // against yet. Never guess: report the gap honestly rather than silently
    // claiming satisfied or dropping the ask.
    return {
      satisfied: false,
      evidence: 'awards data is not exposed in the live show payload — cannot auto-verify; will keep surfacing as stuck until confirmed manually',
      reviews: [],
    };
  }

  return { satisfied: false, evidence: `no live-check rule for content error type "${type}"`, reviews: [] };
}

/** Days between an ISO timestamp and now. Returns 0 on an unparseable date. */
function daysSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (now - t) / 86400000;
}

/**
 * Entries that have waited too long without going live.
 *
 * These get reported, never auto-closed: a request that quietly failed its
 * workflow is exactly the thing that used to vanish, so it must get louder over
 * time rather than expire.
 */
function staleEntries(ledger, now = Date.now()) {
  return (ledger.entries || []).filter(
    (e) => e.status === 'open' && daysSince(e.requestedAt, now) >= STALE_AFTER_DAYS
  );
}

/** Add entries, skipping any key already tracked (a resubmitted request is not a new one). */
function mergeEntries(ledger, newEntries) {
  const out = { entries: Array.isArray(ledger?.entries) ? [...ledger.entries] : [] };
  const seen = new Set(out.entries.map((e) => e.key));
  let added = 0;
  for (const e of newEntries) {
    if (!e || seen.has(e.key)) continue;
    seen.add(e.key);
    out.entries.push(e);
    added++;
  }
  return { ledger: out, added };
}

// NOTE on "give me something to click" (owner, 2026-08-05): a mailto: link to
// the email worker's +claude alias was tried here and removed. The reports that
// carry these entries reach the owner as digest rows, and the digest renders a
// row as clip(description, 200) — a URL-encoded mailto is shredded by that, and
// send-morning-digest.js already hangs a signed one-click "Dispatch a fix" link
// on every row that survives to "Needs your attention" while digest-autofix.js
// auto-dispatches the rest. The click already exists; what was missing was a
// report worth clicking from.

module.exports = {
  STALE_AFTER_DAYS,
  MAX_STORED_MESSAGE,
  MAX_NAMED_REVIEWS,
  entryKey,
  buildEntry,
  evaluateEntry,
  evaluateContentFix,
  describeReview,
  newReviewsFor,
  staleEntries,
  mergeEntries,
  daysSince,
};
