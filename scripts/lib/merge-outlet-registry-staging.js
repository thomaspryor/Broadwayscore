/**
 * Push-time merge for data/audit/outlet-registry-staging.json — the outlets
 * scripts/rebuild-all-reviews.js REFUSED to auto-register (no resolvable
 * domain, a critic name, a domain collision; BRO-4370 / BRO-4401).
 *
 * ~20 workflows run the rebuild and then .github/actions/push-core-data,
 * which commits this file next to data/outlet-registry.json, so two runs
 * can easily push different snapshots from the same base. Without a merge
 * fn the push path falls back to ours-wins-outright and a concurrent run's
 * parked ids vanish until some later full rebuild re-parks them — which is
 * also the window in which audit-outlet-registry.js --strict reports them
 * as NEW gaps and turns Data Validation red.
 *
 * Document shape: { _comment, updatedAt, staged: [{ outletId, reason,
 * domainHint, reviewCount, exampleShowId, firstSeenAt, lastSeenAt }] }.
 *
 * Rules: union by outletId. On a shared id ours wins every field except
 * firstSeenAt (earliest of the two — the file's own "how long has this been
 * parked" clock). Remote-only rows are re-added: each full rebuild
 * regenerates the list from the whole corpus and self-prunes, so a stale
 * re-added row costs one cycle and a dropped row costs a red gate.
 */
'use strict';

function earliest(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b || a || null;
  if (Number.isNaN(tb)) return a;
  return ta <= tb ? a : b;
}

function latest(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b || a || null;
  if (Number.isNaN(tb)) return a;
  return ta >= tb ? a : b;
}

function asDoc(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * @param {object} ours  our parsed document
 * @param {object} remote  the remote tip's parsed document
 * @returns {{merged: object, stats: {added: number, kept: number, total: number}}}
 */
function mergeOutletRegistryStaging(ours, remote) {
  const oursDoc = asDoc(ours);
  const remoteDoc = asDoc(remote);
  const byId = new Map();
  for (const e of Array.isArray(remoteDoc.staged) ? remoteDoc.staged : []) {
    if (e && typeof e.outletId === 'string' && e.outletId) byId.set(e.outletId, e);
  }
  let kept = 0;
  const oursIds = new Set();
  for (const e of Array.isArray(oursDoc.staged) ? oursDoc.staged : []) {
    if (!e || typeof e.outletId !== 'string' || !e.outletId) continue;
    oursIds.add(e.outletId);
    const r = byId.get(e.outletId);
    if (r) {
      kept++;
      byId.set(e.outletId, { ...e, firstSeenAt: earliest(e.firstSeenAt, r.firstSeenAt) });
    } else {
      byId.set(e.outletId, e);
    }
  }
  const staged = [...byId.values()].sort((a, b) => a.outletId.localeCompare(b.outletId));
  const added = staged.filter((e) => !oursIds.has(e.outletId)).length;
  const merged = {
    ...remoteDoc,
    ...oursDoc,
    updatedAt: latest(oursDoc.updatedAt, remoteDoc.updatedAt),
    staged,
  };
  return { merged, stats: { added, kept, total: staged.length } };
}

module.exports = { mergeOutletRegistryStaging };
