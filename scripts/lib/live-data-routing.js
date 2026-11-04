'use strict';
//
// live-data-routing.js (BRO-5788) — pure planning for check-corpus-drift.yml's
// "Live-data assertions" step. Each failing node:test (`<file>::<name>`, from
// tap-failure-parser.js) becomes its own routed condition: it files a Linear
// card once it stays red (owner-alert-router digest escalation) and resolves
// when green. Same shape as routePerAuditAlerts in check-corpus-drift.js.

const KEY_PREFIX = 'live-data-test:';
const MAX_KEY_LEN = 200;

// BRO-6983: a live-data test that stays red must end up with an owner. Plain
// 'digest' never filed a card (eight tests sat red since 2026-10-29 with no
// ticket, and the morning digest kept calling them "no automatic fix"). 'auto'
// with deferFilingHours files ONE card once the same incident has stayed open
// that long; shorter blips stay a digest line (owner-alert-router BRO-4487).
const OWNED_AFTER_HOURS = 72;
// Mirrors owner-alert-router INCIDENT_GAP_RESET_HOURS.
const INCIDENT_GAP_RESET_HOURS = 96;
const OWNED_AFTER_PERSISTING = { disposition: 'auto', deferFilingHours: OWNED_AFTER_HOURS, cooldownHours: 24 };
// Zero-tolerance conditions never count as "known": they keep the job red.
const ALWAYS_NEW = /class-A cross-market/i;

/**
 * PURE. Split this run's routed failures into NEW (job stays red) and KNOWN
 * (already owned: a card exists, or the router has the condition on its
 * deferred-card path and the incident has been open past OWNED_AFTER_HOURS, so a card is due). The job is red only for NEW ones.
 * @param {{conditionKey:string}[]} route plan.route from planLiveDataRouting
 * @param {Record<string,object>} conditions owner-alert-router ledger conditions, read BEFORE routing
 */
function splitNewAndKnown(route, conditions, nowMs = Date.now()) {
  const newKeys = [];
  const knownKeys = [];
  for (const r of route) {
    const c = (conditions || {})[r.conditionKey];
    const openedMs = c ? Date.parse(c.incidentOpenedAt || c.firstSeen || '') : NaN;
    // Not seen for INCIDENT_GAP_RESET_HOURS: the router starts a fresh incident (and a fresh 72h defer).
    const lastSeenMs = c ? Date.parse(c.lastSeen || '') : NaN;
    const sameIncident = Number.isFinite(lastSeenMs) && (nowMs - lastSeenMs) / 3600000 <= INCIDENT_GAP_RESET_HOURS;
    const owned = !!c && c.status === 'open' && sameIncident
      && (!!(c.linearIdentifier || c.cardId) || (c.deferredAuto === true && Number.isFinite(openedMs) && (nowMs - openedMs) / 3600000 >= OWNED_AFTER_HOURS));
    (owned && !ALWAYS_NEW.test(r.conditionKey) ? knownKeys : newKeys).push(r.conditionKey);
  }
  return { newKeys, knownKeys };
}

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
      ...OWNED_AFTER_PERSISTING,
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
      ...OWNED_AFTER_PERSISTING,
    });
  }
  // Resolve only on a run that reached a verdict; a crashed run proves nothing.
  const resolve = ranToVerdict
    ? openKeys.filter((k) => k.startsWith(KEY_PREFIX) && !seen.has(k) && !failedFiles.has(fileOfKey(k)))
    : [];
  return { route, resolve };
}

module.exports = { KEY_PREFIX, conditionKeyFor, planLiveDataRouting, splitNewAndKnown, OWNED_AFTER_HOURS };
