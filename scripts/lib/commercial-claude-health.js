'use strict';
/**
 * Tells a systemic Anthropic/network failure apart from "no evidence found"
 * in batch-commercial-research.js (BRO-3837). A per-request timeout or API
 * outage used to look like a normal run with zero results; now the run exits
 * non-zero when most Claude attempts died of infrastructure causes.
 */

const INFRA_PATTERNS = [
  /timed out/i,
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/,
  /socket hang up/i,
  /Claude API error:.*(overloaded|rate.?limit|api_error|authentication|credit|billing|internal|not_found|invalid.?model|model.*not found)/i,
  /Claude API error: HTTP \d{3}/i,
];

/** True when the error says the call itself failed, not that the answer was empty or unparseable. */
function isInfraError(err) {
  const msg = err && err.message ? err.message : String(err || '');
  return INFRA_PATTERNS.some((re) => re.test(msg));
}

const MIN_ATTEMPTS = 3;
const INFRA_FAIL_RATIO = 0.5;

/**
 * { systemic, message } for a run that made `attempts` Claude calls, `infra` of
 * which failed for infrastructure reasons. Small runs never trip it.
 */
function claudeHealthVerdict({ attempts, infra }) {
  if (!(attempts >= MIN_ATTEMPTS) || !(infra / attempts >= INFRA_FAIL_RATIO)) return { systemic: false, message: '' };
  return {
    systemic: true,
    message: `${infra} of ${attempts} Claude analyses failed on timeouts or API errors, so the empty results are an outage, not "no evidence found"`,
  };
}

module.exports = { isInfraError, claudeHealthVerdict, MIN_ATTEMPTS, INFRA_FAIL_RATIO };
