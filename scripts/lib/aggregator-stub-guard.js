'use strict';

/**
 * Refusal reason for a NEW BWW/LBO excerpt stub, or null to allow it.
 *
 * gather-reviews.js has two write paths. createReviewFile() checks junk and
 * sentence-fragment outlet ids; the aggregator excerpt-stub path
 * (saveAggregatorStub) checked nothing. A BWW roundup parse there kept
 * re-creating how-to-dance-in-ohio-2023/how-to-dance-in-ohio-is-an-underdog-
 * itself--sammi-cannold.json: a sentence fragment as outlet and the show's
 * director as critic. Deleted by hand 2026-09-06, back on the next gather
 * 2026-10-06, where it failed validate-data's creative-as-critic check and
 * with it every validate-gated core-data push (BRO-4884).
 *
 * @param {object} args
 * @param {string} args.outletId - normalized outlet id of the stub
 * @param {string} args.criticName
 * @param {object|null} args.show - shows.json record for the stub's show
 * @returns {string|null}
 */
function aggregatorStubRejection({ outletId, criticName, show }) {
  const { isJunkOutlet, isSuspiciousOutletId } = require('./review-normalization');
  const { evaluateCreditedPersonAsCritic } = require('./creative-as-critic');
  if (isJunkOutlet(outletId)) return 'junkOutlet';
  if (isSuspiciousOutletId(outletId)) return 'suspiciousOutlet';
  if (evaluateCreditedPersonAsCritic(show || null, criticName || '').kind === 'creative') return 'creditedPersonAsCritic';
  return null;
}

module.exports = { aggregatorStubRejection };
