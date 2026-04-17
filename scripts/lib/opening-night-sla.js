'use strict';

const { sendAlert } = require('./discord-notify');

const DEFAULT_LOG = require('path').join(__dirname, '../../data/audit/stage-latency.jsonl');
const fs = require('fs');

/**
 * Read stage-latency.jsonl and find reviews that are stuck mid-pipeline.
 *
 * A review is "in-flight" if it has review-first-seen but NOT deployed-live.
 * Returns warnings (>= warningMinutes) and pages (>= pageMinutes).
 *
 * @param {object[]} latencyEntries  - parsed JSONL lines from stage-latency.jsonl
 * @param {object}   opts
 * @param {number}   [opts.warningMinutes=30]
 * @param {number}   [opts.pageMinutes=60]
 * @param {Date}     [opts.now]
 * @returns {{ warnings: object[], pages: object[] }}
 */
function evaluateSlaForReviews(latencyEntries, { warningMinutes = 30, pageMinutes = 60, now = new Date() } = {}) {
  // Build per-reviewKey stage maps
  const byKey = new Map();

  for (const e of latencyEntries) {
    if (!e.reviewKey || !e.showId) continue;
    const k = `${e.showId}||${e.reviewKey}`;
    if (!byKey.has(k)) byKey.set(k, { showId: e.showId, reviewKey: e.reviewKey, stages: {} });
    const entry = byKey.get(k);
    // Keep earliest timestamp per stage
    if (!entry.stages[e.stage] || e.at < entry.stages[e.stage]) {
      entry.stages[e.stage] = e.at;
    }
  }

  const warnings = [];
  const pages = [];

  for (const [, rv] of byKey) {
    const firstSeen = rv.stages['review-first-seen'];
    const deployed = rv.stages['deployed-live'];
    if (!firstSeen || deployed) continue; // not in-flight

    const elapsedMs = now - new Date(firstSeen);
    const elapsedMin = Math.floor(elapsedMs / 60000);

    // Parse outletId from reviewKey "{outletId}:{critic}:{url}"
    const outletId = rv.reviewKey.split(':')[0] || 'unknown';

    const item = { reviewKey: rv.reviewKey, showId: rv.showId, outletId, elapsedMin };

    if (elapsedMin >= pageMinutes) {
      pages.push(item);
    } else if (elapsedMin >= warningMinutes) {
      warnings.push(item);
    }
  }

  // Sort longest-waiting first
  warnings.sort((a, b) => b.elapsedMin - a.elapsedMin);
  pages.sort((a, b) => b.elapsedMin - a.elapsedMin);

  return { warnings, pages };
}

/**
 * Send Discord (+ optional email) alerts for SLA breaches.
 *
 * @param {{ warnings: object[], pages: object[] }} slaResult
 * @param {object} opts
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<void>}
 */
async function dispatchSlaAlerts({ warnings, pages }, { dryRun = false } = {}) {
  if (dryRun) {
    if (warnings.length) console.log(`[SLA dry-run] ${warnings.length} warning(s):`, warnings.map(w => `${w.showId}/${w.outletId} (${w.elapsedMin}m)`).join(', '));
    if (pages.length) console.log(`[SLA dry-run] ${pages.length} page(s):`, pages.map(p => `${p.showId}/${p.outletId} (${p.elapsedMin}m)`).join(', '));
    return;
  }

  if (warnings.length > 0) {
    const list = warnings.map(w => `• ${w.showId} / ${w.outletId} — ${w.elapsedMin} min in-flight`).join('\n');
    await sendAlert({
      title: `Opening Night SLA Warning — ${warnings.length} review(s) delayed`,
      description: `Reviews in pipeline for ≥30 min without deploying:\n${list}`,
      severity: 'warning',
    }).catch(e => console.error('[SLA] warning dispatch failed:', e.message));
  }

  if (pages.length > 0) {
    const list = pages.map(p => `• ${p.showId} / ${p.outletId} — ${p.elapsedMin} min in-flight`).join('\n');
    await sendAlert({
      title: `Opening Night SLA P0 — ${pages.length} review(s) stuck ≥60 min`,
      description: `Reviews stuck in pipeline for ≥60 min:\n${list}`,
      severity: 'error',
      email: true,
    }).catch(e => console.error('[SLA] page dispatch failed:', e.message));
  }
}

module.exports = { evaluateSlaForReviews, dispatchSlaAlerts };
