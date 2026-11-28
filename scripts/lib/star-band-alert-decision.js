'use strict';
// BRO-7512: pure decision for detect-star-band-regressions.js alert handling.
// 'resolve' = a clean corpus run (no actionable finding; false-truncation is report-only) so the
// open 'star-band:regressions' ledger row must be closed. Before this the detector returned
// silently and the row stayed open for weeks after the flagged reviews had drained.
function actionableFindings(findings) {
  return (findings || []).filter((f) => f && f.kind !== 'false-truncation');
}
function shouldResolveStarBandAlert(findings) {
  return actionableFindings(findings).length === 0;
}
module.exports = { actionableFindings, shouldResolveStarBandAlert };
