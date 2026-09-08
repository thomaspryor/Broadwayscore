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
 * Does this publishDate carry a real time-of-day AND an explicit timezone?
 *   "2026-08-25T20:51:56-04:00" → true
 *   "2026-08-25T20:51:56"       → FALSE (no zone)
 *   "2026-08-25", "August 25, 2026" → false
 *
 * The zone requirement is not pedantry. `new Date("2026-08-25T20:51:56")` is parsed in
 * the LOCAL zone, so the same corpus value resolves to 20:51Z in CI (UTC) and 00:51Z on
 * a New York laptop — a 4-hour swing on a 24-hour threshold, which would make the SLA
 * disagree with itself depending on where it ran. lib/time-to-publish-sla.js:104 hits
 * the same problem and keeps zone-less values in a separate `assumedZone` basis rather
 * than passing them off as measured; this metric has no such basis, so it declines them.
 *
 * @param {*} v
 * @returns {boolean}
 */
function hasPrecisePublishTime(v) {
  if (typeof v !== 'string') return false;
  if (!/T\d{2}:\d{2}/.test(v)) return false;
  return /([zZ]|[+-]\d{2}:?\d{2})$/.test(v.trim());
}

/**
 * Roundup-timestamp bleed: the same instant stamped on many outlets of one show.
 *
 * An aggregator roundup page has ONE datePublished; an extractor that reads it while
 * splitting out N per-outlet reviews writes that single instant onto all N files.
 * Corpus-wide (2026-09-07): 1,853 review-text files carry an HH:MM time, but only 466
 * also carry an explicit zone (see hasPrecisePublishTime) — and 440 of those 466 are
 * contaminated, leaving ~26 usable clock rows in a 42,808-file corpus. Clusters run up
 * to 26 outlets on one identical second (moulin-rouge-the-musical-west-end-2021,
 * 2022-04-22T12:57:06-04:00); paranormal-activity-2026 has 13 outlets on
 * 2026-08-25T20:51:56-04:00, including variety and vulture — two of the T1 rows this
 * SLA reports on. 75 of 77 clusters sit on odd seconds (the bleed signature); none sit
 * at 00:00/00:01, the shape a coordinated embargo would take.
 *
 * NOTE: this guard is currently DORMANT on the live path — t1-sla-report.js joins
 * publishDate from reviews.json, where 0 of 20,344 rows carry a time at all. It guards
 * the moment precise times start arriving (or a report-time join is added), which is
 * exactly when an unguarded clock would begin publishing confident wrong numbers.
 *
 * Two outlets landing on the same SECOND is overwhelmingly bleed rather than coincidence,
 * but it is not proof: a syndicated wire story (AP carried by many papers) legitimately
 * keeps one datePublished, and a coordinated embargo could in principle line up. The
 * guard still fires at 2+ outlets, because the two error directions are not symmetric:
 *   • false positive → a real row leaves the DENOMINATOR. We measure fewer reviews.
 *   • false negative → a fabricated instant becomes the CLOCK. We publish a confident,
 *                      wrong latency for a named outlet.
 * Only the second lies to the owner, so this errs toward excluding — the same trade
 * isPublishDateSuspect already makes above, for the same reason.
 *
 * Keyed on the parsed INSTANT, not the raw string: "2026-08-25T20:51:56-04:00" and
 * "2026-08-26T00:51:56Z" are one moment written two ways, and a string key would let
 * that pair slip through as two distinct timestamps.
 *
 * Pure. Returns the set of `${showId}|${epochMs}` keys that are contaminated.
 * @param {Array<{showId?:string, outletId?:string, publishDate?:string}>} rows
 * @returns {Set<string>}
 */
function sharedStampKey(showId, publishDate) {
  const ms = new Date(publishDate).getTime();
  return Number.isFinite(ms) ? `${showId}|${ms}` : null;
}

function findSharedPublishTimestamps(rows) {
  const outletsByStamp = new Map();
  for (const r of rows || []) {
    if (!r || !hasPrecisePublishTime(r.publishDate)) continue;
    const key = sharedStampKey(r.showId, r.publishDate);
    if (!key) continue;
    if (!outletsByStamp.has(key)) outletsByStamp.set(key, new Set());
    outletsByStamp.get(key).add(r.outletId);
  }
  const shared = new Set();
  for (const [key, outlets] of outletsByStamp) {
    if (outlets.size > 1) shared.add(key);
  }
  return shared;
}

/**
 * Classify a review for the SLA. Pure.
 * @param {object} r { publishDate, firstSeenAt, publishDateSource? }
 * @param {string|null} showCreatedAt  ISO (shows.json discoveredAt / openingDate)
 * @param {Set<string>} [sharedStamps]  from findSharedPublishTimestamps (optional)
 * @returns {{ measurable:boolean, reason?:string, clockStart:string|null }}
 */
function classifyMeasurability(r, showCreatedAt, sharedStamps) {
  if (!r || !r.publishDate) {
    return { measurable: false, reason: 'no-publish-date', clockStart: null };
  }
  const pubMsRaw = new Date(r.publishDate).getTime();
  // An unparseable publishDate ("undefined", "not a date") used to fall through as NaN:
  // clockStart became "Invalid Date", ageMs NaN, and `NaN <= 24h` is false — so it was
  // silently counted as a BREACH instead of surfacing in the unmeasurable bucket. A
  // metric that reports garbage as failure is worse than one that admits it cannot see.
  if (!Number.isFinite(pubMsRaw)) {
    return { measurable: false, reason: 'unparseable-publish-date', clockStart: null };
  }
  const stampKey = sharedStampKey(r.showId, r.publishDate);
  const contaminated = !!(sharedStamps && stampKey && sharedStamps.has(stampKey));
  // Reported ahead of the fetch-date heuristic: bled stamps are same-second copies, so
  // they usually ALSO trip day-equality, and 'publish-eq-fetch-date' would mask the
  // real, fixable cause (an extractor copying a roundup's datePublished onto N files).
  if (contaminated) {
    return { measurable: false, reason: 'shared-roundup-timestamp', clockStart: null };
  }
  // An explicit fetch-date stamp is never a clock, however precise it looks. The
  // override below deliberately bypasses isPublishDateSuspect, which would otherwise
  // catch this — and firstSeenAt is already a full zoned ISO, so a collector that wrote
  // its fetch instant into publishDate would be "precise" AND unique, giving
  // clockStart ≈ firstSeenAt, ageMs ≈ 0, and a fabricated SLA *hit*. That inflates the
  // number, which is the one direction this metric must never fail in.
  if (r.publishDateSource === 'fetch-date') {
    return { measurable: false, reason: 'publish-eq-fetch-date', clockStart: null };
  }
  const precise = hasPrecisePublishTime(r.publishDate);
  // A trustworthy per-article timestamp OVERRIDES the same-day fetch-date heuristic
  // below. That heuristic exists only because, with day-resolution dates, a real
  // same-day retrieval is indistinguishable from a scraper stamping "today" — so it
  // conservatively excludes both. An unshared HH:MM instant IS that distinguisher (a
  // fetch-date stamp writes a DATE, not a time of day), and it is precisely what the
  // publishDateSource escape hatch was reserved for. Without this override the metric
  // discards its own best rows: a review published 20:51 ET and scored 22:28 ET the
  // same evening trips day-equality and the FASTEST retrievals vanish from the
  // denominator — the metric would punish exactly the behaviour it rewards.
  if (!precise && isPublishDateSuspect(r)) {
    return { measurable: false, reason: 'publish-eq-fetch-date', clockStart: null };
  }
  const pubMs = pubMsRaw;
  // Day-resolution publishDate cannot support a 24h SLA. Its clock start is midnight
  // UTC, but reviews drop in the EVENING: a NYT review published ~21:00 ET on opening
  // night and scored 22:28 ET the same evening reads as 26.5h — a breach — because the
  // clock began 26.5h earlier at 00:00 UTC. Every measured row landed in a tight band
  // just above the threshold (26.5/31.3/33.0/37.9/38.9h), the signature of a fixed
  // offset rather than a slow pipeline, and the report printed a flat "SLA: 0%".
  // The imprecision (±24h) is >= the threshold (24h), so these are UNMEASURABLE, not
  // failures. They are surfaced in their own bucket instead of faking a 0%.
  // `contaminated` already returned above, so this is the day-resolution case only.
  if (!precise) {
    return { measurable: false, reason: 'date-only-publish-date', clockStart: null };
  }
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
  // Contamination is detected across ALL tiers before filtering: a T3 blog sharing an
  // instant with a T1 is what proves the T1's stamp came off a roundup page, so
  // narrowing to tier 1 first would hide the very evidence the guard needs.
  const sharedStamps = findSharedPublishTimestamps(reviews);
  let measured = 0, withinSla = 0, unmeasurable = 0, unscored = 0;
  const unmeasurableSample = [];
  const unmeasurableByReason = {};
  for (const r of reviews) {
    if (!tierOk(r.tier)) continue;
    const m = classifyMeasurability(r, r.showCreatedAt, sharedStamps);
    if (!m.measurable) {
      unmeasurable++;
      unmeasurableByReason[m.reason] = (unmeasurableByReason[m.reason] || 0) + 1;
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
    unmeasurableByReason,
  };
}

module.exports = {
  isPublishDateSuspect,
  classifyMeasurability,
  computeSla,
  hasPrecisePublishTime,
  findSharedPublishTimestamps,
  DAY_MS,
};
