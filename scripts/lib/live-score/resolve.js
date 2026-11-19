'use strict';
// BRO-7803: client-side decision. Pure: given what the page was built with and
// what the network returned, say whether to apply the overlay. Anything off
// returns { apply:false } and the static server HTML stays. Never throws.

const { SCHEMA } = require('./core');

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Step 1: is there a usable pointer entry for this page? Returns { entry } or { reason }. */
function chooseEntry({ showId, staticRev, kill, pointer }) {
  try {
    if (!kill || kill.schema !== SCHEMA || kill.enabled !== true) return { reason: 'kill-switch' };
    if (!pointer || pointer.schema !== SCHEMA || !pointer.shows || typeof pointer.shows !== 'object') return { reason: 'bad-pointer' };
    const entry = pointer.shows[showId];
    if (!entry) return { reason: 'no-entry' };
    if (typeof entry.v !== 'string' || !isNum(entry.rev)) return { reason: 'bad-entry' };
    if (!isNum(staticRev)) return { reason: 'bad-static-rev' };
    if (!(entry.rev > staticRev)) return { reason: 'static-newer-or-equal' };
    return { entry };
  } catch (_e) {
    return { reason: 'error' };
  }
}

const VIEW_FIELDS = ['score', 'reviewCount', 'tier1Count', 'tier2Count', 'showTBD', 'reviewsRemaining', 'noReviewsExpected', 'criticsTakeMode'];

/** Step 2: validate the downloaded payload against the entry and the page. */
function validatePayload({ payload, entry, showId, staticRev, staticReviewCount }) {
  try {
    if (!payload || payload.schema !== SCHEMA) return { reason: 'schema' };
    if (payload.showId !== showId) return { reason: 'show-mismatch' };
    if (payload.v !== entry.v) return { reason: 'version-mismatch' };
    if (payload.rev !== entry.rev) return { reason: 'rev-mismatch' };
    if (!(payload.rev > staticRev)) return { reason: 'static-newer-or-equal' };
    const v = payload.view;
    if (!v || typeof v !== 'object') return { reason: 'no-view' };
    if (!isNum(v.reviewCount) || !isNum(v.tier1Count) || !isNum(v.tier2Count)) return { reason: 'bad-counts' };
    if (v.score !== null && !isNum(v.score)) return { reason: 'bad-score' };
    if (typeof v.showTBD !== 'boolean') return { reason: 'bad-tbd' };
    if (!v.showTBD && v.score === null) return { reason: 'scored-without-score' };
    if (!isNum(v.reviewsRemaining) || typeof v.noReviewsExpected !== 'boolean') return { reason: 'bad-view' };
    for (const f of VIEW_FIELDS) if (!(f in v)) return { reason: 'missing-' + f };
    if (!Array.isArray(payload.reviews)) return { reason: 'bad-reviews' };
    // The hero count, the breakdown bar and the row list must tell one story.
    if (payload.reviews.length !== v.reviewCount) return { reason: 'count-rows-mismatch' };
    if (!payload.tombstone && isNum(staticReviewCount) && v.reviewCount < staticReviewCount) return { reason: 'review-count-regression' };
    return { ok: true, view: v, reviews: payload.reviews };
  } catch (_e) {
    return { reason: 'error' };
  }
}

module.exports = { chooseEntry, validatePayload, VIEW_FIELDS };
