/**
 * newsletter-audit-targets.js
 *
 * Which shows the weekly newsletter draft hands to a targeted review-gap audit
 * (BRO-4592). The hourly back-catalogue audit cannot be relied on to reach a
 * featured show in time (2026-10-04: Arias with a Twist and Purpose shipped
 * never audited), so the draft workflow dispatches audit-aggregator-gap.yml with
 * exactly the shows the issue displays a score for.
 *
 * Source of truth is the generated meta (openingShows is the set pre-send-check
 * gates on; ledeShows adds shows only the lede names). Order puts the shows with
 * the least audit coverage first, because a time-budgeted run stops at the budget.
 */

const { SHOW_ID_RE } = require('./gap-audit-show-filter');

/**
 * @param {{openingShows?: Array, ledeShows?: Array}} meta parsed A-<week>.meta.json
 * @param {Record<string, {at?: string}>} [checkpoint] gap-audit-checkpoint.json
 * @returns {string[]} de-duplicated, valid show ids, least-recently-audited first
 */
function auditTargetIds(meta, checkpoint = {}) {
  const seen = new Set();
  const ids = [];
  for (const ref of [...(meta?.openingShows || []), ...(meta?.ledeShows || [])]) {
    const id = ref && ref.id;
    if (!id || !SHOW_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const ts = id => {
    const t = new Date(checkpoint?.[id]?.at || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  // Array.prototype.sort is stable, so equal timestamps keep meta order.
  return ids.sort((a, b) => ts(a) - ts(b));
}

module.exports = { auditTargetIds };

if (require.main === module) {
  const fs = require('fs');
  const [metaPath, checkpointPath] = process.argv.slice(2);
  if (!metaPath) { console.error('usage: newsletter-audit-targets.js <meta.json> [checkpoint.json]'); process.exit(2); }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  let checkpoint = {};
  try { if (checkpointPath) checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); } catch { /* no checkpoint = all never-audited */ }
  console.log(auditTargetIds(meta, checkpoint).join(','));
}
