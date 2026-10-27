'use strict';
// BRO-477: a simulated (Lighthouse) phone score is noisy. A drop or a low score on its
// own, with real-visitor numbers fine, is "usually ignorable" by the check's own text and
// re-filed the same card every time a different page wobbled (/west-end, then /off-broadway).
// The anomaly stays in data/audit/seo-health.json; the daily health row only warns on
// things that involve real visitors or escalated to an error.
function isLabOnlyNoise(a) {
  if (!a || a.severity === 'error') return false;
  if (a.type === 'cwv_lighthouse_drop') return true;
  return a.type === 'cwv_lighthouse_low' && /simulated test only/.test(String(a.message || ''));
}

function actionableSeoAnomalies(anomalies) {
  return (anomalies || []).filter(a => !isLabOnlyNoise(a));
}

module.exports = { isLabOnlyNoise, actionableSeoAnomalies };
