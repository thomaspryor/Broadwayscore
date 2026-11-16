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
 * Flags only when the API returned tone tags, none is tone/reviews, and there is
 * no star rating. No tags at all (field not requested, old item) is not evidence.
 */
function guardianToneNonReviewReason(content) {
  if (!content || !Array.isArray(content.tags)) return null;
  const tones = content.tags.map(t => String((t && t.id) || '')).filter(id => id.startsWith('tone/'));
  if (tones.length === 0 || tones.includes('tone/reviews')) return null;
  const star = content.fields ? content.fields.starRating : content.starRating;
  if (/^[1-5]$/.test(String(star == null ? '' : star).trim())) return null;
  return `guardian-tone: filed as ${tones.join(', ')}, not tone/reviews (BRO-7593)`;
}

/** Writer side: flag the record, unless a human cleared it or the opening-night lane holds it. */
function applyGuardianTone(record, content, { bypass = false } = {}) {
  const reason = guardianToneNonReviewReason(content);
  if (Array.isArray(content && content.tags)) {
    const tones = content.tags.map(t => t && t.id).filter(id => String(id || '').startsWith('tone/'));
    record.guardianApi = { ...record.guardianApi, tones };
  }
  if (!reason || bypass || record.nonReviewManualClear === true || record.isNonReview === true) return null;
  record.isNonReview = true;
  record.isNonReviewReason = reason;
  return reason;
}

module.exports = { GUARDIAN_API_FIELDS, GUARDIAN_API_TAGS, guardianReviewOutletId, applyGuardianPublication, guardianToneNonReviewReason, applyGuardianTone };
