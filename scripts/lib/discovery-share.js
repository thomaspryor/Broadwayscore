'use strict';

/**
 * discovery-share.js — pure maths for scripts/report-discovery-share.js (BRO-7934).
 *
 * Which pipeline found each review file, how many came from a BACKSTOP (a file the
 * gap audits found means primary discovery missed it), how many have no caller
 * recorded, and whether review-texts/_pending is growing.
 */

// Pipelines whose finds are primary-discovery misses.
const BACKSTOP_PIPELINES = new Set(['audit-show-review-gap', 'audit-aggregator-gap', 'audit-reverse-discovery', 'audit-t1-silent-gaps', 'evidence-review-catchup']);
// `source` values that name no pipeline by themselves: the reader form / hand dispatch need a caller.
const CALLER_DECIDES = new Set(['submit-review-form', 'ingest-urls', 'manual-entry', 'manual']);

/** Pipeline label for one review file: the caller when recorded, else the collector source. */
function pipelineOf(file) {
  if (typeof file.ingestSource === 'string' && file.ingestSource) return file.ingestSource;
  if (typeof file.source === 'string' && file.source) return CALLER_DECIDES.has(file.source) ? `${file.source} (no caller)` : file.source;
  return '(no source)';
}

/**
 * @param {Array<{source?:string, ingestSource?:string, stamp?:string}>} files stamp = textFetchedAt || classifiedAt
 * @param {{sinceMs?:number}} opts only files stamped at/after sinceMs count (default: all)
 */
function discoveryShare(files, { sinceMs = 0 } = {}) {
  const byPipeline = {};
  let total = 0;
  let noCaller = 0;
  let backstop = 0;
  for (const f of files) {
    const t = Date.parse(f.stamp || '');
    if (sinceMs && !(Number.isFinite(t) && t >= sinceMs)) continue;
    const p = pipelineOf(f);
    byPipeline[p] = (byPipeline[p] || 0) + 1;
    total++;
    if (p.endsWith('(no caller)')) noCaller++;
    if (BACKSTOP_PIPELINES.has(p)) backstop++;
  }
  const rows = Object.entries(byPipeline)
    .map(([pipeline, count]) => ({ pipeline, count, share: total ? count / total : 0, backstop: BACKSTOP_PIPELINES.has(pipeline) }))
    .sort((a, b) => b.count - a.count);
  return { total, noCaller, backstop, backstopShare: total ? backstop / total : 0, rows };
}

/**
 * Is _pending growing? history = [{date:'YYYY-MM-DD', pending:n}] oldest first, ending today.
 * Growth = today vs the LOWEST count in the prior `windowDays`; alerts when it grew by at least
 * `minGrowth` files AND `minRatio`x (a drain that keeps up hovers near its floor).
 */
function pendingGrowthVerdict(history, { windowDays = 7, minGrowth = 100, minRatio = 1.25 } = {}) {
  const rows = (history || []).filter((r) => r && Number.isFinite(r.pending)).slice(-(windowDays + 1));
  if (rows.length < 3) return { status: 'insufficient-history', rows: rows.length, alert: false };
  const today = rows[rows.length - 1].pending;
  const floor = Math.min(...rows.slice(0, -1).map((r) => r.pending));
  const growth = today - floor;
  const alert = growth >= minGrowth && today >= floor * minRatio;
  return { status: alert ? 'growing' : 'ok', today, floor, growth, alert };
}

module.exports = { BACKSTOP_PIPELINES, pipelineOf, discoveryShare, pendingGrowthVerdict };
