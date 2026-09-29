'use strict';

/**
 * Cross-show image paths (BRO-4380).
 *
 * A show's images.* path under /images/shows/<id>/ must use its own id. When it
 * names another show's directory, that page renders the other show's art (38
 * entries did in 2026-09: phyl-off-broadway-2026 showed the BOCKING poster).
 *
 * Sharing is legitimate only between productions of the same show that the data
 * links explicitly: a regional tryout and its Broadway transfer
 * (transferredTo/transferOf), a tour leg and its tour family (tourParent), a
 * national tour and its Broadway parent (tourOf). Links are followed in both
 * directions and transitively, so a Chicago leg can use the Broadway art its
 * national-tour parent transferred to. Anything else needs an entry in
 * ALLOWED_SHARED_IMAGES with a reason. Pure: no I/O.
 */

const LINEAGE_FIELDS = ['transferredTo', 'transferOf', 'tourParent', 'tourOf'];

// showId -> { owner: <id whose /images/shows/ dir it may use>, reason }.
// Keep this short: every entry is a page deliberately showing another entry's art.
const ALLOWED_SHARED_IMAGES = {
  'kramerfauci-st-anns-off-broadway-2026': {
    owner: 'kramerfauci-off-broadway-2026',
    reason: 'same production transferred from NYU Skirball to St. Ann\'s Warehouse (priorRuns carries no id link)',
  },
};

const IMAGE_PATH_RE = /^\/images\/shows\/([^/]+)\//;

// Offenders that only warn in validate-data. The 25 entries known when the gate
// shipped (BRO-4380) were fixed by data/pending-fixes/bro-4380.json, so it is
// empty: every cross-show path is an error. Never add to it; fix the data or
// use ALLOWED_SHARED_IMAGES for deliberate sharing.
const CROSS_SHOW_IMAGES_BASELINE = new Set([]);

/** Ids connected to showId through lineage links (either direction), excluding itself. */
function lineageIds(showId, shows) {
  const adj = new Map();
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const s of shows || []) {
    for (const f of LINEAGE_FIELDS) if (typeof s[f] === 'string') link(s.id, s[f]);
  }
  const seen = new Set([showId]);
  const queue = [showId];
  while (queue.length) {
    for (const next of adj.get(queue.shift()) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  seen.delete(showId);
  return seen;
}

/**
 * Problems for one show: each images.<key> path under another show's id that
 * is neither lineage-linked nor allowlisted.
 * @returns {Array<{key, path, owner}>}
 */
function crossShowImageProblems(show, shows, allowlist = ALLOWED_SHARED_IMAGES) {
  if (!show || !show.images || typeof show.images !== 'object') return [];
  // Tours have their own, wider rule (any same-title Broadway production's
  // art): tour-family.js tourImageProblems, enforced in validate-data.js.
  if (show.category === 'tour') return [];
  const problems = [];
  let lineage = null;
  for (const [key, p] of Object.entries(show.images)) {
    if (typeof p !== 'string' || key.startsWith('_')) continue;
    const m = IMAGE_PATH_RE.exec(p);
    if (!m || m[1] === show.id) continue;
    const owner = m[1];
    if (allowlist[show.id] && allowlist[show.id].owner === owner) continue;
    if (!lineage) lineage = lineageIds(show.id, shows);
    if (lineage.has(owner)) continue;
    problems.push({ key, path: p, owner });
  }
  return problems;
}

/** Every offending show in the list. @returns {Array<{id, problems}>} */
function findCrossShowImages(shows, allowlist = ALLOWED_SHARED_IMAGES) {
  const out = [];
  for (const s of shows || []) {
    const problems = crossShowImageProblems(s, shows, allowlist);
    if (problems.length) out.push({ id: s.id, problems });
  }
  return out;
}

/**
 * Guard for writers: the images object to persist for showId with any path
 * under a different, unlinked show's directory replaced by null. Returns the
 * cleaned copy and the dropped entries so the caller can log them.
 */
function stripCrossShowImages(showId, images, shows, allowlist = ALLOWED_SHARED_IMAGES) {
  if (!images || typeof images !== 'object') return { images, dropped: [] };
  const probe = { id: showId, images };
  const dropped = crossShowImageProblems(probe, shows, allowlist);
  if (!dropped.length) return { images, dropped };
  const cleaned = { ...images };
  for (const d of dropped) cleaned[d.key] = null;
  return { images: cleaned, dropped };
}

/**
 * fetch-show-images-auto.js's last-resort production photo. The fallback list
 * lives on the run-wide verify context, so it holds every show's deferred
 * photos; before BRO-4380 the last-resort step took entry [0] for whichever
 * show asked, handing show A's /images/shows/A/thumbnail.jpg to shows B..N
 * (and the same object by reference, so later edits leaked between them).
 * Returns a copy of the first fallback recorded for showId, or null.
 */
function pickOwnProductionPhotoFallback(fallbacks, showId) {
  const own = (fallbacks || []).find(f => f && f.showId === showId);
  return own ? { ...own, images: { ...own.images } } : null;
}

module.exports = {
  CROSS_SHOW_IMAGES_BASELINE,
  pickOwnProductionPhotoFallback,
  ALLOWED_SHARED_IMAGES,
  LINEAGE_FIELDS,
  lineageIds,
  crossShowImageProblems,
  findCrossShowImages,
  stripCrossShowImages,
};
