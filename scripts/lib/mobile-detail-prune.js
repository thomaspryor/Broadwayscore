// Orphan-prune decision for public/data/shows/{id}.json (BRO-4826).
//
// Grace period: a detail file is deleted only once the show has been invisible
// for two consecutive full runs. Evidence of "previous run" comes from either
//   (a) pruneCandidates in the hash cache (only restored by vercel-deploy.yml), or
//   (b) the committed public/data/mobile-shows.json as it stood BEFORE this run
//       (generate-mobile-artifacts.sh writes the index after the details), so an
//       id absent from it was already invisible on the previous committed run.
// (b) needs no workflow cache, so the workflows that actually commit
// public/data/shows (rebuild-fast, rebuild-reviews, opening-night-poller) can prune.
const fs = require('fs');

// Returns Set of ids in the prior index, or null if unreadable/empty (fail safe:
// null contributes no grace evidence, so nothing is pruned on its account).
function loadPriorIndexIds(indexPath) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const arr = idx && Array.isArray(idx.shows) ? idx.shows : null;
    if (!arr || arr.length === 0) return null;
    return new Set(arr.map(s => s && s.id).filter(Boolean));
  } catch {
    return null;
  }
}

// orphanIds: orphan candidates (invisible now). Returns { toPrune, nextCandidates, skipped, ceiling }.
// indexCovers(id): true when the index generator WOULD have listed this id had it
// been visible. Categories hidden from the app feed (tours) are never in the index,
// so their absence proves nothing and they must wait for a cache candidate.
function planPrune({ orphanIds, previousCandidates = {}, priorIndexIds = null, indexCovers = () => true, showCount }) {
  const toPrune = [];
  const nextCandidates = {};
  for (const id of orphanIds) {
    const graceSatisfied = !!previousCandidates[id] || (priorIndexIds !== null && indexCovers(id) && !priorIndexIds.has(id));
    if (graceSatisfied) toPrune.push(id);
    else nextCandidates[id] = true;
  }
  const ceiling = Math.max(50, Math.round(showCount * 0.1));
  if (toPrune.length > ceiling) {
    // Not consumed: stay armed so a genuine batch prunes once the anomaly clears.
    for (const id of toPrune) nextCandidates[id] = true;
    return { toPrune: [], nextCandidates, skipped: true, skippedCount: toPrune.length, ceiling };
  }
  return { toPrune, nextCandidates, skipped: false, ceiling };
}

module.exports = { loadPriorIndexIds, planPrune };
