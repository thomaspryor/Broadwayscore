/**
 * @typedef {'ok'|'warning'|'error'} CheckSeverity
 *
 * @typedef {Object} CheckResult
 * @property {string} name        - Check identifier (matches check file name)
 * @property {string} description - Human-readable description
 * @property {boolean} ok         - true if no actionable problem
 * @property {CheckSeverity} severity
 * @property {string} message     - Human-readable status line
 * @property {Object} [details]   - Optional structured detail for --json output
 *
 * @typedef {Object} CheckContext
 * @property {Object} reviewsDoc          - Parsed reviews.json (map of showId → reviews[])
 * @property {string} reviewTextsRoot     - Absolute path to data/review-texts/
 * @property {Object} driftState          - Parsed data/audit/drift-state.json (or {})
 * @property {Object} criticConsensusDoc  - Parsed data/critic-consensus.json (or {})
 * @property {Date}   now                 - Current timestamp
 *
 * @typedef {Object} CheckModule
 * @property {string} name
 * @property {string} description
 * @property {function(Object, CheckContext): CheckResult} run
 */

module.exports = {};
