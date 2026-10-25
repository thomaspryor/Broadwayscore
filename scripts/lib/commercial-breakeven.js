/**
 * Keeps a commercial.json record's modelBreakeven in step with its
 * weeklyRunningCost between recoupment-model runs (BRO-4985).
 *
 * Break-even is linear in the weekly cost in the weekly tier
 * (recoupment-model.js: nut x cost-split.js breakEvenRatio) and
 * close to linear in the long-run tier (nut / (1 - costRate), where costRate
 * itself moves a little with the nut), so scaling by the cost ratio is an
 * interim figure (below the new cost only for an all-in cost) that the next model run replaces
 * (the daily stale-closures job and the Friday run both re-run it). It
 * rescales break-even only; recoupment % waits for that run.
 * merge-model-recoupment.js records the
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

/**
 * Slugs whose modelBreakeven is below their weeklyRunningCost (a stale model).
 * An all-in cost holds royalties and rent already, so it can sit above a
 * current break-even (BRO-6217) and is skipped.
 */
function breakevenBelowCost(shows) {
  const out = [];
  for (const [slug, r] of Object.entries(shows || {})) {
    if (r && isPositive(r.modelBreakeven) && isPositive(r.weeklyRunningCost) && r.weeklyRunningCostBasis !== 'all-in' && r.modelBreakeven < r.weeklyRunningCost) {
      out.push({ slug, modelBreakeven: r.modelBreakeven, weeklyRunningCost: r.weeklyRunningCost });
    }
  }
  return out;
}

module.exports = { syncBreakevenToCost, breakevenBelowCost };
