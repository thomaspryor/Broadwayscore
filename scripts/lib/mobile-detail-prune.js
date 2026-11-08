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

// Committed candidate ledger (BRO-7118). Tours are absent from the app index, so
// (b) is no evidence for them and (a) lives in a cache only vercel-deploy.yml
// restores, while the workflows that commit public/data/shows never see it: a
// closed tour whose reviews were all excluded kept its stale `rv` file forever
// (annie-tour-2022: page 0 reviews, public JSON 2). data/audit/*.json is staged
// by every committing workflow, so the candidates ride along in git.
function loadLedger(p) {
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return d && typeof d.candidates === 'object' && d.candidates ? d.candidates : {};
  } catch {
    return {};
  }
}

// Writes only on change, so a quiet run leaves no diff.
function saveLedger(p, candidates) {
  const sorted = {};
  for (const id of Object.keys(candidates).sort()) sorted[id] = true;
  const body = JSON.stringify({ _doc: 'Detail files invisible on the last full run (BRO-7118); a second consecutive run prunes them.', candidates: sorted }, null, 2) + '\n';
  let prev = null;
  try { prev = fs.readFileSync(p, 'utf8'); } catch { /* first write */ }
  if (prev !== body) fs.writeFileSync(p, body);
}

module.exports = { loadPriorIndexIds, planPrune, loadLedger, saveLedger };
