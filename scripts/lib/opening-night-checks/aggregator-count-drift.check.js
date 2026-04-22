'use strict';

const fs = require('fs');
const path = require('path');

const name = 'aggregator-count-drift';
const description = 'Aggregator extraction count-drift (BWW/DTLI reports more reviews than we extracted)';

const WARN_DELTA = 2;
const ERROR_DELTA = 5;

/**
 * Balusters postmortem CLASS 2 follow-through. gather-reviews.js already emits
 * reason='countDrift' to data/audit/exclusions-YYYY-MM-DD.jsonl whenever an
 * aggregator reports more reviews than we could extract. This plugin reads that
 * log and surfaces drifts in the opening-night checklist.
 *
 * Why not piggyback on review-count-match: that check compares file counts after
 * all extractors + scrapers ran. This one surfaces the upstream symptom
 * (extraction missed outlets at the aggregator layer) even when downstream
 * scrapers filled the gap via SERP/RSS/etc. If the aggregators drift, we want
 * to know before a harder opening night.
 *
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  const auditDir = path.join(__dirname, '..', '..', '..', 'data', 'audit');
  const now = context.now || new Date();
  const days = [now, new Date(now.getTime() - 86400000), new Date(now.getTime() - 2 * 86400000)];
  const records = [];

  for (const day of days) {
    const p = path.join(auditDir, `exclusions-${day.toISOString().slice(0, 10)}.jsonl`);
    if (!fs.existsSync(p)) continue;
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.showId !== show.id) continue;
      if (rec.reason !== 'countDrift') continue;
      records.push(rec);
    }
  }

  if (records.length === 0) {
    return {
      ok: true,
      severity: 'ok',
      message: 'No aggregator count-drift recorded in the last 3 days',
    };
  }

  // Use the worst-case delta across aggregators (most recent record per aggregator)
  const byAgg = new Map();
  for (const rec of records) {
    const agg = rec.details?.aggregator || 'unknown';
    const prev = byAgg.get(agg);
    if (!prev || (rec.ts && prev.ts && rec.ts > prev.ts)) byAgg.set(agg, rec);
  }
  const worst = [...byAgg.values()].reduce((acc, r) => {
    const d = r.details?.delta || 0;
    return d > acc.delta ? { delta: d, rec: r } : acc;
  }, { delta: 0, rec: null });

  let severity = 'ok';
  if (worst.delta >= ERROR_DELTA) severity = 'error';
  else if (worst.delta >= WARN_DELTA) severity = 'warning';
  if (severity === 'ok') {
    return { ok: true, severity, message: `Count-drift delta ${worst.delta} (below warn threshold ${WARN_DELTA})` };
  }

  const aggSummary = [...byAgg.entries()]
    .map(([agg, r]) => `${agg}: extracted ${r.details?.extracted ?? '?'} of ${r.details?.anchorUrls ?? r.details?.summaryTotal ?? '?'} (delta=${r.details?.delta ?? '?'})`)
    .join('; ');

  return {
    ok: false,
    severity,
    message: `Aggregator count-drift detected — ${aggSummary}. Re-run discovery or flag for human review.`,
    details: {
      records: [...byAgg.values()].map(r => ({ aggregator: r.details?.aggregator, delta: r.details?.delta, url: r.details?.url })),
    },
  };
}

module.exports = { name, description, run };
