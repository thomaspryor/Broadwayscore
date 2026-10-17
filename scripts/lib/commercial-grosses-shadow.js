'use strict';

const { extractCostsFromPost, extractWeeklyFinancialsFromPost } = require('./reddit-grosses');

// A closed range becomes its midpoint. For an open profit range use its known
// bound, retaining the full range in the shadow report for the checker.
function representativeValue(low, high) {
  return low != null && high != null ? Math.round((low + high) / 2) : (low ?? high ?? null);
}

function commercialGrossesCandidate(selftext) {
  return extractWeeklyFinancialsFromPost(selftext, { includeCommercialFields: true }).map(row => ({
    showName: row.showName,
    weeklyGross: row.gross,
    capacity: row.capacity,
    atp: row.atp,
    grossLessFees: row.grossLessFees,
    estimatedWeeklyCost: representativeValue(row.costLow, row.costHigh),
    estimatedProfitLoss: row.profit ? representativeValue(row.profit.low, row.profit.high) : null,
    estimatedRecoupmentPct: row.recoupedLow == null ? null : [row.recoupedLow, row.recoupedHigh],
    commentary: row.commentary,
  }));
}

const FIGURE_FIELDS = [
  'weeklyGross', 'capacity', 'atp', 'grossLessFees', 'estimatedWeeklyCost',
  'estimatedProfitLoss', 'estimatedRecoupmentPct',
];
const showKey = row => row.showName.trim().toLowerCase();

// Report every unmatched show and numeric difference. Prose stays in the input
// file; only commentary presence is reported, never copied to a public report.
function compareGrossesRows(before, after) {
  const oldByShow = new Map(before.map(row => [showKey(row), row]));
  const newByShow = new Map(after.map(row => [showKey(row), row]));
  const differences = [];
  const commentaryDifferences = [];
  for (const [key, row] of newByShow) {
    const old = oldByShow.get(key);
    if (!old) continue;
    for (const field of FIGURE_FIELDS) {
      if (JSON.stringify(old[field] ?? null) !== JSON.stringify(row[field] ?? null)) {
        differences.push({ showName: row.showName, field, before: old[field] ?? null, after: row[field] ?? null });
      }
    }
    if ((old.commentary || '').trim() !== (row.commentary || '').trim()) {
      commentaryDifferences.push({
        showName: row.showName,
        beforeHasText: !!old.commentary?.trim(), afterHasText: !!row.commentary?.trim(),
      });
    }
  }
  return {
    beforeRows: before.length, afterRows: after.length,
    onlyBefore: before.filter(row => !newByShow.has(showKey(row))).map(row => row.showName),
    onlyAfter: after.filter(row => !oldByShow.has(showKey(row))).map(row => row.showName),
    duplicatesBefore: before.length - oldByShow.size,
    duplicatesAfter: after.length - newByShow.size,
    differences, commentaryDifferences,
    commentaryBefore: before.filter(row => row.commentary?.trim()).length,
    commentaryAfter: after.filter(row => row.commentary?.trim()).length,
  };
}

function compareCostParsers(posts) {
  let beforeRows = 0, afterRows = 0;
  const added = [], changed = [], removed = [];
  for (const post of posts) {
    const before = extractCostsFromPost(post.selftext);
    const after = extractCostsFromPost(post.selftext, { unescapeCosts: true });
    beforeRows += before.length;
    afterRows += after.length;
    // Preserve duplicate cost lines in a post rather than hiding them in a Map.
    const unmatched = [...after];
    for (const row of before) {
      const exact = unmatched.findIndex(candidate => candidate.showName === row.showName && candidate.cost === row.cost);
      if (exact >= 0) { unmatched.splice(exact, 1); continue; }
      const sameShow = unmatched.findIndex(candidate => candidate.showName === row.showName);
      if (sameShow >= 0) {
        changed.push({ postId: post.id, showName: row.showName, before: row.cost, after: unmatched[sameShow].cost });
        unmatched.splice(sameShow, 1);
      } else removed.push({ postId: post.id, ...row });
    }
    added.push(...unmatched.map(row => ({ postId: post.id, ...row })));
  }
  return { posts: posts.length, beforeRows, afterRows, added, changed, removed };
}

module.exports = { commercialGrossesCandidate, compareGrossesRows, compareCostParsers };
