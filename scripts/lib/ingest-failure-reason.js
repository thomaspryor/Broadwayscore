/**
 * Failure reason recorded in ingestResults when an ingest child exits non-zero.
 * BRO-4608: the audit kept only 100 chars, which cut paywall / bot-block / fetch
 * errors (thestage, timeout, uktw, whatsonlive, yourlocalguardian, aol) mid-sentence
 * so the audit file could not say why a real review was uncollectable.
 */
const { execErrorDetail } = require('./exec-error-detail');

const INGEST_REASON_MAX = 600;

// A parent-side timeout or kill gives err.message like "spawnSync node ETIMEDOUT"
// with no child text; the child's own diagnosis is only on err.stderr.
function ingestFailureReason(err) {
  const base = execErrorDetail(err, 0);
  const stderr = String(err && err.stderr || '').trim();
  const detail = stderr && !base.includes(stderr.split('\n').pop()) && !/\n/.test(base)
    ? `${base} | ${execErrorDetail({ message: stderr }, 0)}`
    : base;
  return detail.slice(0, INGEST_REASON_MAX);
}

module.exports = { ingestFailureReason, INGEST_REASON_MAX };
