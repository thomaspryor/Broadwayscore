/**
 * Keeps a commercial.json record's modelBreakeven in step with its
 * weeklyRunningCost between recoupment-model runs (BRO-4985).
 *
 * Break-even is linear in the weekly cost in both model tiers
 * (recoupment-model.js: nut x (1 - rentPct) / (1 - varRate - theaterPct),
 * and nut / (1 - costRate)), so when a writer changes the cost the
 * break-even scales by the same factor. merge-model-recoupment.js records the
 * cost it used as modelCostBasis; the commercial write guard calls
 * syncBreakevenToCost() on every save, so a cost refresh (the Reddit cost
 * gap-fill, an approved fix, the weekly LLM update) can no longer leave a
 * break-even below the cost it is built on (operation-mincemeat 536,585 vs
 * 560,000, 2026-10-06). The full model still re-runs on Fridays.
 *
 * Pure: no I/O.
 */

const isPositive = (n) => Number.isFinite(n) && n > 0;

/**
 * Rescale record.modelBreakeven to the record's current weeklyRunningCost.
 * Only when the model recorded the cost it used; a model run on an
 * estimated cost (modelCostBasis null) is left for the next model run.
 * @returns {boolean} true when the record changed
 */
function syncBreakevenToCost(record) {
  if (!record || !isPositive(record.modelBreakeven)) return false;
  const basis = record.modelCostBasis;
  const cost = record.weeklyRunningCost;
  if (!isPositive(basis) || !isPositive(cost) || basis === cost) return false;
  record.modelBreakeven = Math.round((record.modelBreakeven * cost) / basis);
  record.modelCostBasis = cost;
  return true;
}

/** Slugs whose modelBreakeven is below their weeklyRunningCost (a stale model). */
function breakevenBelowCost(shows) {
  const out = [];
  for (const [slug, r] of Object.entries(shows || {})) {
    if (r && isPositive(r.modelBreakeven) && isPositive(r.weeklyRunningCost) && r.modelBreakeven < r.weeklyRunningCost) {
      out.push({ slug, modelBreakeven: r.modelBreakeven, weeklyRunningCost: r.weeklyRunningCost });
    }
  }
  return out;
}

module.exports = { syncBreakevenToCost, breakevenBelowCost };
