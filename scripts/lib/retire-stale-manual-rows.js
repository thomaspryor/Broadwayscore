'use strict';
// BRO-7257: pure planner for removing stale hand-entered rows from reviews.json.
// A manualEntry row always beats its pipeline twin in merge-reviews-json.js, so a wrong manual
// row (wrong critic, outdated score) can only be removed, not outvoted. Matches are exact:
// showId + outletId + critic + assignedScore + manualEntry:true, so nothing else can be hit.
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

function planRetire(reviews, targets) {
  const remove = new Set();
  const report = [];
  for (const t of targets) {
    const hits = [];
    reviews.forEach((r, i) => {
      if (r && r.manualEntry === true && r.showId === t.showId && r.outletId === t.outletId
        && norm(r.criticName) === norm(t.critic) && Number(r.assignedScore) === Number(t.score)) hits.push(i);
    });
    report.push({ ...t, matched: hits.length });
    hits.forEach((i) => remove.add(i));
  }
  return { remove, report };
}

function applyRetire(reviews, targets) {
  const { remove, report } = planRetire(reviews, targets);
  return { reviews: reviews.filter((_, i) => !remove.has(i)), removed: remove.size, report };
}

module.exports = { planRetire, applyRetire, norm };
