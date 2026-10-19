/**
 * Failure reason recorded in ingestResults when an ingest child exits non-zero.
 * BRO-4608: the audit kept only 100 chars, which cut paywall / bot-block / fetch
 * errors (thestage, timeout, uktw, whatsonlive, yourlocalguardian, aol) mid-sentence
 * so the audit file could not say why a real review was uncollectable.
 */
const { execErrorDetail } = require('./exec-error-detail');

const INGEST_REASON_MAX = 600;

function ingestFailureReason(err) {
  return execErrorDetail(err, INGEST_REASON_MAX);
}

module.exports = { ingestFailureReason, INGEST_REASON_MAX };
