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
    requestedMessage: message || null,
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

/**
 * Is this request now visible on the live site?
 *
 * @param {object} entry     ledger entry
 * @param {object|null} live parsed {base}/data/shows/{id}.json, or null on 404
 * @returns {{satisfied: boolean, evidence: string}}
 */
function evaluateEntry(entry, live) {
  if (!live) {
    return { satisfied: false, evidence: 'show JSON not served by production yet' };
  }
  const reviews = Array.isArray(live.rv) ? live.rv : [];

  if (entry.kind === 'missing-show') {
    // The show being served AT ALL is the whole ask. Reviews may follow later.
    return {
      satisfied: true,
      evidence: `live with ${reviews.length} review(s)${live.cat ? ` in ${live.cat}` : ''}`,
    };
  }

  if (entry.kind === 'missing-reviews') {
    const before = entry.reviewCountAtRequest == null ? 0 : entry.reviewCountAtRequest;
    if (reviews.length > before) {
      return { satisfied: true, evidence: `${before} → ${reviews.length} review(s) live` };
    }
    return { satisfied: false, evidence: `still ${reviews.length} review(s), was ${before}` };
  }

  if (entry.kind === 'missing-image') {
    if (live.hi) return { satisfied: true, evidence: `hero image live at ${live.hi}` };
    return { satisfied: false, evidence: 'still no hero image in production' };
  }

  // Unknown kind: never claim satisfied. A wrong "it's fixed!" email is worse
  // than another day of waiting — it is how a request gets closed unfixed.
  return { satisfied: false, evidence: `no live-check rule for kind "${entry.kind}"` };
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

module.exports = {
  STALE_AFTER_DAYS,
  entryKey,
  buildEntry,
  evaluateEntry,
  staleEntries,
  mergeEntries,
  daysSince,
};
