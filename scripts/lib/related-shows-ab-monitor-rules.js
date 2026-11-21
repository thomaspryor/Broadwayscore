/** Pure weekly result alerts. No winner judgment and no flag writes. */
const { ARMS, CUTOVER, STOPPING_N, JOIN_GAP_PROBLEM } = require('./related-shows-ab-analysis');
const { RELATED_SHOWS_FLAG } = require('./related-shows-ab');
const COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
const STALL_CHECK_MS = 5 * 24 * 60 * 60 * 1000;
const DOC_URL = 'https://github.com/thomaspryor/Broadwayscore/blob/main/docs/experiments/related-shows-position.md';

function decideRelatedShowsAlerts(summary, state = {}, nowMs = Date.now()) {
  const next = { ...state };
  const alerts = [];
  const primary = summary?.primary;
  const variants = summary?.variants;
  const validCounts = Array.isArray(variants) && variants.length === 2 && ARMS.every(name => {
    const matches = variants.filter(v => v.name === name);
    const v = matches[0];
    return matches.length === 1 && Number.isSafeInteger(v.n) && v.n >= 0
      && Number.isSafeInteger(v.conv) && v.conv >= 0 && v.conv <= v.n;
  });
  const problems = [];
  if (summary?.flag !== RELATED_SHOWS_FLAG || summary?.startDate !== CUTOVER
    || summary?.stoppingNPerArm !== STOPPING_N) problems.push('unexpected experiment or stopping design');
  if (!validCounts) problems.push('missing or invalid per-arm person counts');
  if (summary?.flagHealth?.ok !== true) problems.push('flag health failed or unavailable');
  if (primary?.suppressed) problems.push(`primary suppressed: ${primary.suppressed}`);
  if (primary?.degenerate) problems.push(`primary degenerate: ${primary.degenerate}`);
  // A suppressed or degenerate result already explains why p is empty; only
  // report a bad p when nothing else did.
  if (!primary?.suppressed && !primary?.degenerate
    && (!Number.isFinite(primary?.p) || primary.p < 0 || primary.p > 1 || !Number.isFinite(primary?.z))) {
    problems.push('the result came back without a usable p-value');
  }
  // Stalled exposure: cumulative n only grows, so no growth between weekly runs
  // means the exposure event or traffic broke. Compare at most every 5 days.
  if (validCounts && Math.min(...variants.map(v => v.n)) < STOPPING_N) {
    const minN = Math.min(...variants.map(v => v.n));
    const due = !Number.isFinite(state.lastMinNAt) || nowMs - state.lastMinNAt >= STALL_CHECK_MS;
    if (due) {
      if (Number.isFinite(state.lastMinNAt) && minN <= state.lastMinN) {
        problems.push('no new exposed people since the last weekly check (exposure may have stopped)');
      }
      next.lastMinN = minN;
      next.lastMinNAt = nowMs;
    }
  }
  if (problems.length) {
    // Drop a problem already quoted inside a longer one ("flag health failed"
    // also appears inside "primary suppressed: flag health failed").
    const shown = problems.filter(p => !problems.some(q => q !== p && q.includes(p)));
    const detail = `What the check found: ${shown.join('; ')}.`;
    const sampleReached = validCounts && variants.every(v => v.n >= STOPPING_N);
    // Only a small first-session join gap is statistical noise worth waiting on.
    // Anything else (cross-arm contamination, unhealthy flag, wrong design, a
    // missing arm, stalled exposure) breaks the test now, so it emails at once.
    const joinGapOnly = shown.every(p => p.includes(JOIN_GAP_PROBLEM));
    if (!sampleReached && joinGapOnly) {
      // Nobody is waiting on a readout yet, so there is nothing for the owner to
      // do. Log it (run summary) instead of emailing (BRO-6868, actionable-only).
      alerts.push({
        kind: 'data-problem', severity: 'warning', email: false, logOnly: true,
        title: 'Related shows test: numbers could not be read yet',
        description: `${detail} The planned sample of ${STOPPING_N.toLocaleString('en-US')} people per arm is not reached, so no readout is due.`,
      });
    } else {
      const stamp = next.lastDataProblemAlertAt;
      if (!Number.isFinite(stamp) || nowMs - stamp >= COOLDOWN_MS) {
        next.lastDataProblemAlertAt = nowMs;
        alerts.push({
          kind: 'data-problem', severity: 'error', email: true, stampKey: 'lastDataProblemAlertAt',
          subjectLabel: 'ACTION NEEDED',
          title: sampleReached
            ? 'Related shows test: enough people, but the results cannot be trusted'
            : 'Related shows test: the data has a problem',
          description: 'This is the A/B test on show pages (does a row of related shows near the reviews get more people '
            + 'to open a second page). '
            + (sampleReached
              ? `It has reached its planned ${STOPPING_N.toLocaleString('en-US')} people per arm, but the results check found a problem with the data, so there is no readout yet. `
              : 'It is still collecting people, but the weekly check found a problem that would spoil the results if left alone. ')
            + 'Nothing is broken on the site and no test setting changed. '
            + `${detail} The check repeats weekly and emails again after six days if this persists. Test write-up: ${DOC_URL}`,
        });
      }
    }
  } else if (variants.every(v => v.n >= STOPPING_N) && !next.readyToJudgeAlertAt) {
    next.readyToJudgeAlertAt = nowMs;
    alerts.push({
      kind: 'ready-to-judge', severity: 'error', email: true, stampKey: 'readyToJudgeAlertAt',
      title: 'Related shows test: planned sample reached',
      description: `The related shows test has reached its planned sample of ${STOPPING_N.toLocaleString('en-US')} people per arm `
        + `and is ready for your review. No experiment setting has changed. `
        + `From the weekly experiment monitor. Review the registered design: ${DOC_URL}`,
    });
  }
  return { alerts, state: next };
}

module.exports = { decideRelatedShowsAlerts, COOLDOWN_MS };
