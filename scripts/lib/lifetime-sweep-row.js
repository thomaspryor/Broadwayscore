'use strict';

/**
 * Digest-row verdict for a lifetime-sweep snapshot (data/audit/*-lifetime.json),
 * shared by health-check.js's "Data quality: <check> lifetime sweep" rows.
 *
 * Trigger (BRO-7204): when the snapshot carries actionableOpen (the sweep was
 * given an isActionable rule, see lifetime-sweep-runner.js), the row warns
 * while any hit with positive evidence of the bypass class is open (first
 * seen with evidence < 96h ago and still in the sweep). New hits with no
 * evidence either way ride in the message as backlog. Before this, the
 * slug-mismatch row warned on every newly ingested headline-URL review, the
 * morning digest filed a card for each, and each card could only be "fixed" by
 * one more URL-shape special case: 7 cards in 30 days.
 * Snapshots without the field keep the old newSinceLastRun trigger.
 *
 * @param {Object} o
 * @param {string} o.name
 * @param {Object|null} o.snap       - parsed snapshot, or null when missing
 * @param {number} o.ageHours
 * @param {string} o.scriptName
 * @param {string} o.stepName
 * @param {string} o.unit
 * @param {function(number): string} o.formatAge
 */
function lifetimeSweepRowResult({ name, snap, ageHours, scriptName, stepName, unit, formatAge }) {
  if (!snap) {
    return { name, status: 'warn', message: 'No lifetime-sweep snapshot yet (cron not yet run)', hint: `node scripts/${scriptName}` };
  }
  const age = formatAge(ageHours);
  if (!(ageHours <= 48)) {
    return { name, status: 'error', message: `Lifetime-sweep snapshot is ${age} old (>48h) — the daily sweep itself has stopped running`, hint: `Check the "${stepName}" step in data-health-check.yml` };
  }
  const evidenceAware = !!(snap.actionableOpen && typeof snap.actionableOpen === 'object');
  const newAll = snap.newSinceLastRun || 0;
  if (evidenceAware) {
    const open = Object.keys(snap.actionableOpen).length;
    if (open > 0) {
      return {
        name,
        status: 'warn',
        message: `${open} ${unit} with contamination evidence open (${snap.newActionableSinceLastRun || 0} new since last run; ${snap.totalViolations} total across ${snap.showsWithViolations} show(s), ${age} ago)`,
        hint: `node scripts/${scriptName} --json --no-snapshot to triage; the open ones are the keys of actionableOpen in the snapshot (flag wrongShow or fix the attribution; each stays open up to 96h or until it leaves the sweep)`,
      };
    }
    const backlog = newAll > 0 ? `; ${newAll} new hit(s) with no contamination evidence added to the backlog` : '';
    return { name, status: 'pass', message: `No open violations with contamination evidence (${snap.totalViolations} known baseline across ${snap.scanned} show(s)${backlog}, ${age} ago)` };
  }
  if (newAll > 0) {
    return { name, status: 'warn', message: `${newAll} NEW ${unit} since last run (${snap.totalViolations} total across ${snap.showsWithViolations} show(s), ${age} ago)`, hint: `node scripts/${scriptName} --json to triage; check newViolationKeys in the snapshot for which ones are new` };
  }
  return { name, status: 'pass', message: `No new violations since last run (${snap.totalViolations} known baseline across ${snap.scanned} show(s), ${age} ago)` };
}

module.exports = { lifetimeSweepRowResult };
