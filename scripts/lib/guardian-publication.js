'use strict';

// Both Content API callers need the publication, not just the hosting domain.
const GUARDIAN_API_FIELDS = 'body,bodyText,headline,byline,standfirst,starRating,publication';
// The tone tags say how the Guardian itself filed the piece (tone/reviews, tone/features, ...).
const GUARDIAN_API_TAGS = 'tone';
const OBSERVER_CRITICS = new Set(['susannah clapp', 'kate kellaway', 'clare brennan']);

function isGuardianHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ['theguardian.com', 'guardian.co.uk'].some(h => host === h || host.endsWith('.' + h));
  } catch { return false; }
}

/**
 * Publication metadata wins over the host and byline. For aggregator/SERP
 * records without that field, BRO-6848 identifies these three Observer critics.
 * Scope that fallback to Guardian-hosted reviews, never other employers or the
 * New York Observer. Keep the existing registry id 'observer'; its market tier
 * is governed separately by src/config/outlet-tiers.json.
 */
function guardianReviewOutletId(record, publication = record.guardianApi?.publication) {
  const current = record.outletId;
  if (!['guardian', 'observer'].includes(current) || !isGuardianHost(record.url)) return current;
  const label = String(publication || '').trim().toLowerCase();
  if (label === 'the observer') return 'observer';
  if (['the guardian', 'theguardian.com', 'guardian.co.uk'].includes(label)) return 'guardian';
  // An unfamiliar publisher is not evidence for the byline fallback.
  if (label) return current;
  const critic = String(record.criticName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return OBSERVER_CRITICS.has(critic) ? 'observer' : current;
}

/** Apply at the writer, retaining the API evidence for future runs and audits. */
function applyGuardianPublication(record, publication) {
  if (publication) record.guardianApi = { ...record.guardianApi, publication };
  const outletId = guardianReviewOutletId(record);
  if (outletId !== record.outletId) {
    record.outletId = outletId;
    record.outlet = outletId === 'observer' ? 'Observer' : 'The Guardian';
  }
  return record;
}

/**
 * BRO-7593: the Guardian's own tone tag for a Content API item, as a non-review
 * reason, or null. Two Girls (2026) scored a Joey Sims feature ("did 2 Girls 1 Cup
 * change the way a generation thinks about sex?", tone/features, interviews with
 * eight men) as a 76 review: it came in from a BWW roundup link and the API fetch
 * stored its headline but never looked at how the Guardian filed it.
 *
 * Flags only when every tone tag is a named non-review tone and none is a review
 * tone (tone/reviews, tone/livereview, tone/albumreview, ...), with no star rating.
 * No tone tags at all (field not requested, old item) is not evidence.
 */
const GUARDIAN_NON_REVIEW_TONES = new Set([
  'tone/features', 'tone/news', 'tone/comment', 'tone/blog', 'tone/interview', 'tone/interviews',
  'tone/analysis', 'tone/explainers', 'tone/obituaries', 'tone/letters', 'tone/editorials',
]);
const tonesOf = (tags) => (Array.isArray(tags) ? tags : [])
  .map(t => String((t && t.id) || '')).filter(id => id.startsWith('tone/'));

function guardianToneNonReviewReason({ tags, starRating } = {}) {
  const tones = tonesOf(tags);
  if (tones.length === 0 || tones.some(t => /review/.test(t))) return null;
  if (!tones.every(t => GUARDIAN_NON_REVIEW_TONES.has(t))) return null;
  if (/^[1-5]$/.test(String(starRating == null ? '' : starRating).trim())) return null;
  return `${GUARDIAN_TONE_REASON_PREFIX} filed as ${tones.join(', ')}, not tone/reviews (BRO-7593)`;
}
const GUARDIAN_TONE_REASON_PREFIX = 'guardian-tone:';

/** True when a record's non-review flag comes from the publisher's own label, not a classifier. */
function isPublisherTaggedNonReview(data) {
  return !!data && data.isNonReview === true && typeof data.isNonReviewReason === 'string'
    && data.isNonReviewReason.startsWith(GUARDIAN_TONE_REASON_PREFIX);
}

/**
 * Writer side: record the tones and flag the record unless a human cleared it.
 * The opening-night lane does not bypass this (trust-model.js refuses the lane bypass for it): the lane stops LLM classifiers
 * overruling aggregator listings, and the Two Girls feature came in through one.
 */
function applyGuardianTone(record, { tags, starRating } = {}) {
  if (!Array.isArray(tags)) return null;
  record.guardianApi = { ...record.guardianApi, tones: tonesOf(tags) };
  const reason = guardianToneNonReviewReason({ tags, starRating });
  if (!reason || record.nonReviewManualClear === true) return null;
  if (record.isNonReview === true) {
    // A human flag stays as it is. A classifier flag is upgraded to the publisher's label so a later LLM
    // reclassify cannot clear it (and the row is not re-fetched once tones are recorded).
    const prior = String(record.isNonReviewReason || '');
    if (/^manual \(not a review\)/i.test(prior) || prior.startsWith(GUARDIAN_TONE_REASON_PREFIX)
      || record.manualNonReviewSet === true || record.manualNonReviewBy || record.manualReviewedBy) return null;
  }
  // lane-guarded: publisher label, deliberately not lane-bypassed (trust-model.js, BRO-7593)
  // lane-exempt: the Guardian's own tone tag is not a classifier verdict; trust-model.js refuses the lane bypass for it
  record.isNonReview = true;
  record.isNonReviewReason = reason;
  return reason;
}

module.exports = { GUARDIAN_API_FIELDS, GUARDIAN_API_TAGS, GUARDIAN_NON_REVIEW_TONES, guardianReviewOutletId, applyGuardianPublication, guardianToneNonReviewReason, isPublisherTaggedNonReview, applyGuardianTone };
