/**
 * Compact "related shows" payload for the iOS app (public/data/related-shows-mobile.json).
 *
 * data/related-shows.json is ~630 KB because each entry repeats long show ids. The app only
 * needs the open and closed picks, so ids go into one table and picks are indexes into it
 * (~90 KB raw, ~30 KB gzip). Picks may be stored as a show id OR a slug (data-core accepts
 * both); both are resolved to the show id here, unknown ids are dropped, and so are picks
 * of the show itself.
 *
 * Shape: { _v: 1, ids: [showId, ...], r: { "<idx of source show>": [[openIdx...], [closedIdx...]] } }
 */
const FORMAT_VERSION = 1;

function buildMobileRelated(relatedShows, shows) {
  const byId = new Map();
  const bySlug = new Map();
  for (const s of shows) {
    byId.set(s.id, s);
    bySlug.set(s.slug, s);
  }
  const ids = [];
  const index = new Map();
  const idx = (id) => {
    if (!index.has(id)) { index.set(id, ids.length); ids.push(id); }
    return index.get(id);
  };
  const resolve = (ref, selfId) => {
    const hit = byId.get(ref) || bySlug.get(ref);
    return hit && hit.id !== selfId ? hit.id : null;
  };
  const r = {};
  for (const [sourceId, entry] of Object.entries(relatedShows || {})) {
    if (!byId.has(sourceId)) continue;
    const open = (entry.relatedOpenIds || []).map(x => resolve(x, sourceId)).filter(Boolean);
    const closed = (entry.relatedClosedIds || []).map(x => resolve(x, sourceId)).filter(Boolean);
    if (!open.length && !closed.length) continue;
    r[idx(sourceId)] = [open.map(idx), closed.map(idx)];
  }
  return { _v: FORMAT_VERSION, ids, r };
}

module.exports = { buildMobileRelated, FORMAT_VERSION };
