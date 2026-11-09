'use strict';

// Both Content API callers need the publication, not just the hosting domain.
const GUARDIAN_API_FIELDS = 'body,bodyText,headline,byline,standfirst,starRating,publication';
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

module.exports = { GUARDIAN_API_FIELDS, guardianReviewOutletId, applyGuardianPublication };
