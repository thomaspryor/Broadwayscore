// Keyed three-way merge for data/audit/opening-night-express-completed.json
// ({ shows: { [showId]: record } }), used by push-via-git-api.sh's
// apiFallbackMerge path (BRO-5955). The local push path does not call this:
// its registry entry's localReconcile (additions-only) keeps git's line-level
// blend for shared keys.
//
// Writers: opening-night-express.yml adds shows[id] once per show under a
// PER-SHOW concurrency group, so two shows' Express pushes race;
// opening-night-broadcast.yml sets broadcastDraftedAt/DraftId on an existing
// record. Nothing deletes keys today, but a key the base held and we dropped
// stays dropped. On 2026-10-22 a whole-file overlay erased
// the-imaginary-invalid-2026 (81788096e4).
//
// Per key:
//   - remote only, not in base → remote added it: keep it.
//   - remote only, in base     → we deleted it: stays gone.
//   - both sides, ours unchanged since base, remote changed → take remote
//     (e.g. the broadcast fields another run set after our fork point).
//   - otherwise ours.
// No base: ours unchanged (without it "remote added" and "we deleted" look
// the same), which is what the overlay did before.
const { isDeepStrictEqual } = require('util');

function showsOf(doc) {
  const o = doc && doc.shows;
  return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
}

function mergeExpressCompleted(local, remote, base) {
  const ours = showsOf(local);
  const theirs = showsOf(remote);
  const baseShows = showsOf(base);
  const stats = { added: 0, tookRemote: 0, deletesHonored: 0, baseAvailable: !!baseShows };
  if (!ours || !theirs || !baseShows) return { merged: local, stats };
  const out = { ...ours };
  for (const [k, v] of Object.entries(theirs)) {
    if (!(k in out)) {
      if (k in baseShows) { stats.deletesHonored++; continue; }
      out[k] = v;
      stats.added++;
    } else if (k in baseShows && isDeepStrictEqual(out[k], baseShows[k]) && !isDeepStrictEqual(v, baseShows[k])) {
      out[k] = v;
      stats.tookRemote++;
    }
  }
  return { merged: { ...local, shows: out }, stats };
}
mergeExpressCompleted.requiresTrueBase = true;

module.exports = { mergeExpressCompleted };
