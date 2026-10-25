'use strict';

/**
 * Byte-identical art across unrelated shows (BRO-4393).
 *
 * BRO-4380 caught images.* PATHS under another show's folder. This is the
 * content-level cousin: two shows whose OWN files are byte-for-byte copies, so
 * one of them shows the other's poster (2026-09-29: 50 groups, e.g. Illinoise
 * carrying Hell's Kitchen art, Peter Pan Goes Wrong carrying The Play That
 * Goes Wrong's).
 *
 * Two shows may share a file when they are the same show: same title (accents,
 * case, punctuation and a trailing "(YYYY)" ignored), linked productions
 * (cross-show-images.js lineageIds: transfers and tours), a priorRuns[].id link
 * either way, an ALLOWED_SHARED_IMAGES pair, or a DUPLICATE_IMAGE_ALLOWLIST pair
 * below. Anything else is reported. Same-title productions sharing a file
 * (wrong revival art) are scripts/audit-duplicate-images.js's job, not this one.
 *
 * findDuplicateImageGroups is pure (CLAUDE.md §15); hashShowImageFiles does the
 * file I/O. Callers: scripts/validate-data.js (warning), the post-run audit in
 * scripts/fetch-show-images-auto.js. Test: scripts/lib/duplicate-images.test.mjs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lineageIds, ALLOWED_SHARED_IMAGES } = require('./cross-show-images');

// Pairs whose identical files were looked at and judged to be one production's
// art. Only add a pair after viewing the image; never to hide a wrong poster.
const DUPLICATE_IMAGE_ALLOWLIST = [
  {
    ids: ['othello-bedlam-off-broadway-2026', 'bedlams-othello-off-broadway-2026'],
    reason: 'Bedlam\'s Othello at the West End Theatre (NYC): the May 2026 run and its November return; the shared "BEDLAM presents Othello" production photo is that company\'s art (viewed 2026-10-15)',
  },
];

/** Title key: lowercase, no accents, no trailing "(YYYY)", letters and digits only. */
function titleKey(title) {
  return String(title || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/[^a-z0-9]/g, '');
}

function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Relatedness oracle over the show list: may a and b share a file?
 * Built once per call so lineage lookups are cached.
 */
function makeRelated(shows, { allowlist = DUPLICATE_IMAGE_ALLOWLIST, sharedAllowlist = ALLOWED_SHARED_IMAGES } = {}) {
  const byId = new Map((shows || []).filter(Boolean).map((s) => [s.id, s]));
  const allowed = new Set();
  for (const e of allowlist || []) {
    const ids = (e && e.ids) || [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) allowed.add(pairKey(ids[i], ids[j]));
  }
  for (const [id, e] of Object.entries(sharedAllowlist || {})) if (e && e.owner) allowed.add(pairKey(id, e.owner));
  const priorLinks = new Set();
  for (const s of byId.values()) {
    for (const r of Array.isArray(s.priorRuns) ? s.priorRuns : []) {
      if (r && typeof r.id === 'string' && r.id !== s.id) priorLinks.add(pairKey(s.id, r.id));
    }
  }
  const lineageCache = new Map();
  const lineageOf = (id) => {
    if (!lineageCache.has(id)) lineageCache.set(id, lineageIds(id, shows));
    return lineageCache.get(id);
  };
  return (a, b) => {
    if (a === b) return true;
    const sa = byId.get(a);
    const sb = byId.get(b);
    if (sa && sb) {
      const ka = titleKey(sa.title);
      if (ka && ka === titleKey(sb.title)) return true;
    }
    const k = pairKey(a, b);
    if (allowed.has(k) || priorLinks.has(k)) return true;
    return lineageOf(a).has(b);
  };
}

/**
 * Groups of byte-identical files used by shows that are not all related.
 * @param {Array<{showId, key, path, hash}>} files  one entry per images.<key> file
 * @param {Array<object>} shows
 * @returns {Array<{hash, ids: string[], files: Array<{showId, key, path}>}>}
 *   ids sorted; only groups whose shows split into 2+ unrelated clusters.
 */
function findDuplicateImageGroups(files, shows, opts = {}) {
  const related = makeRelated(shows, opts);
  const byHash = new Map();
  for (const f of files || []) {
    if (!f || !f.hash || !f.showId) continue;
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }
  const groups = [];
  for (const [hash, list] of byHash) {
    const ids = [...new Set(list.map((f) => f.showId))].sort();
    if (ids.length < 2) continue;
    // Connected components under "related"; one component = all one show.
    const comp = new Map(ids.map((id) => [id, id]));
    const find = (x) => (comp.get(x) === x ? x : find(comp.get(x)));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (find(ids[i]) !== find(ids[j]) && related(ids[i], ids[j])) comp.set(find(ids[j]), find(ids[i]));
      }
    }
    if (new Set(ids.map(find)).size < 2) continue;
    groups.push({ hash, ids, files: list.map(({ showId, key, path: p }) => ({ showId, key, path: p })) });
  }
  return groups.sort((a, b) => a.ids[0].localeCompare(b.ids[0]) || a.hash.localeCompare(b.hash));
}

/**
 * Hash every local images.<key> file the shows reference (keys starting "_"
 * and non-/images/ values skipped). Files with a size no other file has are
 * not read, since they cannot be byte-identical to anything.
 * @returns {{files: Array<{showId, key, path, hash}>, missing: Array<{showId, key, path}>}}
 */
function hashShowImageFiles(shows, publicDir) {
  const refs = [];
  const missing = [];
  for (const s of shows || []) {
    if (!s || !s.images || typeof s.images !== 'object') continue;
    for (const [key, p] of Object.entries(s.images)) {
      if (typeof p !== 'string' || key.startsWith('_') || !p.startsWith('/images/')) continue;
      const full = path.join(publicDir, p);
      let size;
      try { size = fs.statSync(full).size; } catch { missing.push({ showId: s.id, key, path: p }); continue; }
      refs.push({ showId: s.id, key, path: p, full, size });
    }
  }
  const sizeCount = new Map();
  for (const r of refs) sizeCount.set(r.size, (sizeCount.get(r.size) || 0) + 1);
  const hashCache = new Map();
  const files = [];
  for (const r of refs) {
    if (sizeCount.get(r.size) < 2) continue;
    if (!hashCache.has(r.full)) {
      try { hashCache.set(r.full, crypto.createHash('md5').update(fs.readFileSync(r.full)).digest('hex')); } catch { continue; }
    }
    files.push({ showId: r.showId, key: r.key, path: r.path, hash: hashCache.get(r.full) });
  }
  return { files, missing };
}

/** Convenience: hash then group. */
function auditDuplicateImages(shows, publicDir, opts = {}) {
  const { files, missing } = hashShowImageFiles(shows, publicDir);
  return { groups: findDuplicateImageGroups(files, shows, opts), hashed: files.length, missing };
}

module.exports = {
  DUPLICATE_IMAGE_ALLOWLIST,
  titleKey,
  makeRelated,
  findDuplicateImageGroups,
  hashShowImageFiles,
  auditDuplicateImages,
};
