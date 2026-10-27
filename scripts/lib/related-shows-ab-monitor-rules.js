/** Pure weekly result alerts. No winner judgment and no flag writes. */
const { ARMS, CUTOVER, STOPPING_N } = require('./related-shows-ab-analysis');
const { RELATED_SHOWS_FLAG } = require('./related-shows-ab');
const COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
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
  if (!Number.isFinite(primary?.p) || primary.p < 0 || primary.p > 1 || !Number.isFinite(primary?.z)) {
    problems.push('primary test has no finite probability and statistic');
  }
  if (problems.length) {
    const stamp = next.lastDataProblemAlertAt;
    if (!Number.isFinite(stamp) || nowMs - stamp >= COOLDOWN_MS) {
      next.lastDataProblemAlertAt = nowMs;
      alerts.push({
        kind: 'data-problem', severity: 'error', email: true, stampKey: 'lastDataProblemAlertAt',
        title: 'Related shows test: results need a data check',
        description: `The related shows test needs a data check before its results can be read. `
          + `No experiment setting has changed. Details for the maintainer: ${problems.join('; ')}. `
          + `From the weekly experiment monitor. ${DOC_URL}`,
      });
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
