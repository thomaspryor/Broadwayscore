'use strict';

/**
 * t1-sla.js — pure measurability + retrieval-clock helpers for the T1 SLA
 * (sprint-plan-t1-retrieval.md S2-T6 + S2-T8).
 *
 * The SLA answers: of the T1 reviews we eventually scored, what fraction reached a
 * live score within 24h of when they FIRST became retrievable? The clock start is
 *   clockStart = max(publishDate, showCreatedAt)
 * — a review can't be "retrieved fast" before it was published OR before we tracked
 * the show (a late catalog add: showCreatedAt ≈ shows.json `discoveredAt`).
 *
 * PROVENANCE GUARD (the unmeasurable bucket): a publishDate that merely equals the
 * date we first saw the review — with no independent page metadata — is a fetch-date
 * stamp, not a real publication date (the Newsday-backfill class: a scraper wrote
 * "today" as publishDate for an old review). Those reviews, and reviews with no
 * publishDate at all, are UNMEASURABLE: they are surfaced in their own bucket, never
 * silently dropped, and never counted in the SLA denominator (they'd fake-inflate or
 * fake-deflate the number). Only reviews with a trustworthy clock are measured.
 */

const DAY_MS = 86400000;

function dayOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Is this review's publishDate untrustworthy as a clock source?
 * @param {object} r  { publishDate, firstSeenAt, publishDateSource? }
 * @returns {boolean}
 */
function isPublishDateSuspect(r) {
  if (!r || !r.publishDate) return true;                       // no date → can't measure
  // An explicit page-metadata provenance clears suspicion (future-proof: the field
  // does not exist in the corpus yet, so this is a no-op until collection stamps it).
  if (r.publishDateSource && r.publishDateSource !== 'fetch-date') return false;
  // publishDate == the day we first saw it, with no independent source → treat as a
  // fetch-date stamp (the Newsday-backfill class). This is deliberately conservative:
  // a genuinely same-day retrieval is ALSO excluded, because without a provenance
  // field we can't distinguish it from a stamp. Excluding a few real same-day wins is
  // safer than letting fabricated "instant" retrievals inflate the SLA. Once
  // collection stamps publishDateSource this heuristic is bypassed (branch above).
  const p = dayOf(r.publishDate);
  const seen = dayOf(r.firstSeenAt);
  return !!(p && seen && p === seen);
}

/**
 * Classify a review for the SLA. Pure.
 * @param {object} r { publishDate, firstSeenAt, publishDateSource? }
 * @param {string|null} showCreatedAt  ISO (shows.json discoveredAt / openingDate)
 * @returns {{ measurable:boolean, reason?:string, clockStart:string|null }}
 */
function classifyMeasurability(r, showCreatedAt) {
  if (isPublishDateSuspect(r)) {
    return { measurable: false, reason: !r || !r.publishDate ? 'no-publish-date' : 'publish-eq-fetch-date', clockStart: null };
  }
  const pubMs = new Date(r.publishDate).getTime();
  const createdMs = showCreatedAt ? new Date(showCreatedAt).getTime() : NaN;
  const clockMs = Number.isFinite(createdMs) ? Math.max(pubMs, createdMs) : pubMs;
  return { measurable: true, clockStart: new Date(clockMs).toISOString() };
}

/**
 * Compute the retrieval SLA over a set of reviews. Each review needs:
 *   { publishDate, firstSeenAt, scoredAt, showCreatedAt, tier }
 * scoredAt = when a live score was first attached (from stage-latency / rebuild).
 * Only MEASURABLE, eventually-scored reviews count. Returns the headline % plus the
 * unmeasurable bucket so nothing is hidden.
 *
 * @param {Array<object>} reviews
 * @param {object} [opts] { withinHours=24, tierFilter=(t)=>t===1 }
 */
function computeSla(reviews, opts = {}) {
  const withinHours = opts.withinHours != null ? opts.withinHours : 24;
  const tierOk = opts.tierFilter || ((t) => t === 1);
  let measured = 0, withinSla = 0, unmeasurable = 0, unscored = 0;
  const unmeasurableSample = [];
  for (const r of reviews) {
    if (!tierOk(r.tier)) continue;
    const m = classifyMeasurability(r, r.showCreatedAt);
    if (!m.measurable) {
      unmeasurable++;
      if (unmeasurableSample.length < 25) unmeasurableSample.push({ showId: r.showId, outletId: r.outletId, reason: m.reason });
      continue;
    }
    if (!r.scoredAt) { unscored++; continue; }                 // not eventually-scored (yet)
    measured++;
    const ageMs = new Date(r.scoredAt).getTime() - new Date(m.clockStart).getTime();
    if (ageMs <= withinHours * (DAY_MS / 24)) withinSla++;
  }
  return {
    withinHours,
    measured,
    withinSla,
    pct: measured ? Math.round((withinSla / measured) * 1000) / 10 : null,
    unmeasurable,
    unscored,
    unmeasurableSample,
  };
}

module.exports = { isPublishDateSuspect, classifyMeasurability, computeSla, DAY_MS };
