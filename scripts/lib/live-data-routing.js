'use strict';
//
// live-data-routing.js (BRO-5788) — pure planning for check-corpus-drift.yml's
// "Live-data assertions" step. Each failing node:test (`<file>::<name>`, from
// tap-failure-parser.js) becomes its own routed condition: it files a Linear
// card once it stays red (owner-alert-router digest escalation) and resolves
// when green. Same shape as routePerAuditAlerts in check-corpus-drift.js.

const KEY_PREFIX = 'live-data-test:';
const MAX_KEY_LEN = 200;

function fileOfKey(k) { return String(k).slice(KEY_PREFIX.length).split('::')[0]; }

function conditionKeyFor(failureKey) {
  const k = `${KEY_PREFIX}${failureKey}`.replace(/\s+/g, ' ');
  if (k.length <= MAX_KEY_LEN) return k;
  // Hash the full text so two long names sharing a prefix keep distinct keys.
  const h = require('node:crypto').createHash('sha1').update(k).digest('hex').slice(0, 8);
  return `${k.slice(0, MAX_KEY_LEN - 9)}#${h}`;
}

/**
 * @param {Map<string,{file:string,name:string,failureType?:string,payload?:string}>} failures
 * @param {string[]} openKeys condition keys currently open in the ledger
 * @param {{sawTap:boolean,totals:{tests:number|null}}} parsed
 * @param {number} exitCode the node --test exit code
 * @returns {{route: object[], resolve: string[]}}
 */
function planLiveDataRouting(failures, openKeys, parsed, exitCode) {
  const route = [];
  const seen = new Set();
  for (const [fkey, f] of failures) {
    // Parent containers ("N subtests failed") duplicate their leaf failures.
    // cancelledByParent leaves are one hang fanning out; the run-level condition covers it.
    if (f.failureType === 'subtestsFailed' || f.failureType === 'cancelledByParent') continue;
    const conditionKey = conditionKeyFor(fkey);
    if (seen.has(conditionKey)) continue;
    seen.add(conditionKey);
    route.push({
      conditionKey,
      title: `Live-data test failing: ${f.name} (${f.file})`,
      description: `check-corpus-drift.yml "Live-data assertions" step: node:test "${f.name}" in ${f.file} is red against the live corpus.\n\n${String(f.payload || '(no assertion payload captured)').slice(0, 1500)}`,
      hint: f.file === '?' ? 'Open the latest Check Corpus Drift run, "Live-data assertions" step.' : `Run: node --test ${f.file}`,
      disposition: 'digest',
      cooldownHours: 24,
    });
  }
  // The run died before producing a verdict (non-zero exit, no failing leaf):
  // route that as its own condition rather than resolving anything.
  // A file that failed this run (load error, renamed test) has not shown its old
  // tests green, so its other open keys wait for a clean run of that file.
  const failedFiles = new Set(route.map((r) => fileOfKey(r.conditionKey)));
  const ranToVerdict = parsed.sawTap && parsed.totals.tests > 0 && parsed.totals.fail !== null; // summary lines present = TAP not truncated
  if (exitCode !== 0 && route.length === 0) {
    const conditionKey = `${KEY_PREFIX}run-crashed`;
    seen.add(conditionKey);
    route.push({
      conditionKey,
      title: 'Live-data assertions step exited non-zero with no parsed test failure',
      description: `node --test exited ${exitCode} but no failing test was parsed (crash, timeout or load error). See the check-corpus-drift.yml run log.`,
      hint: 'Open the latest Check Corpus Drift run, "Live-data assertions" step.',
      disposition: 'digest',
      cooldownHours: 24,
    });
  }
  // Resolve only on a run that reached a verdict; a crashed run proves nothing.
  const resolve = ranToVerdict
    ? openKeys.filter((k) => k.startsWith(KEY_PREFIX) && !seen.has(k) && !failedFiles.has(fileOfKey(k)))
    : [];
  return { route, resolve };
}

module.exports = { KEY_PREFIX, conditionKeyFor, planLiveDataRouting };
