'use strict';
// Pure mirror of the test-summary job's "Check results" decision in
// .github/workflows/test.yml (BRO-2713). A job-level timeout reports
// 'cancelled', not 'failure', so both results make the summary red.
// On PRs a superseded run's jobs are also 'cancelled', but that whole run is
// replaced by the newer commit's run, so a red summary there is moot.
function summarizeNeeds(needs) {
  const results = Object.values(needs || {}).map((n) => n && n.result);
  const bad = results.some((r) => r === 'failure' || r === 'cancelled');
  return { failed: bad, message: bad ? 'Some tests failed' : 'All tests passed' };
}
module.exports = { summarizeNeeds };
