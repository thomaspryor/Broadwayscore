/**
 * Recouped-claim triage and rejection memory for the commercial pending queue.
 *
 * sweep-pending-commercial.js used to file a Linear card for EVERY pending
 * recouped claim (BRO-3807..3818, BRO-4560..4562, BRO-5009/5010):
 *   - stale duplicates: ID-keyed rows (wicked-2003) whose claim commercial.json
 *     already carries under the slug. reconcile-recoupment-claims.js closes
 *     those (isStaleDuplicate), but it runs AFTER the sweep, and until
 *     BRO-5049 its deletions were re-added by the push-time union merge, so
 *     the same rows were filed again every week.
 *   - wrong production: bare-slug keys resolve to the CURRENT production
 *     (bug -> the 2026 MTC revival, mamma-mia -> the 2025 tour stop) and
 *     carried recoupment articles about an earlier run or a tour.
 *
 * Decisions reuse the existing rules: isStaleDuplicate (recoupment-reconcile-
 * gate.js) and checkRecoupmentProduction (recoupment-production-guard.js).
 * The only rule added here is the tour-stop one: a Broadway engagement
 * recorded as a tour stop never recoups on its own.
 *
 * Accepting a claim always needs a person and a cited source (CLAUDE.md,
 * Commercial). Nothing here ever sets recouped:true.
 */

const { resolveCommercialSlug } = require('./commercial-slug-key');
const { isStaleDuplicate } = require('./recoupment-reconcile-gate');
const { checkRecoupmentProduction } = require('./recoupment-production-guard');

const REJECTED = 'rejected-recouped-claim';

// Strip volatile URL bits (utm_*, fbclid, gclid, ref, hash, trailing slash) so
// a single article shared with different tracking params still matches a prior
// rejection. Ship-check P1: without this, the same NYT recoupment article
// keeps re-surfacing through trivial URL variations.
function normalizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.hash = '';
    const drop = [];
    for (const k of u.searchParams.keys()) {
      if (k.startsWith('utm_') || ['fbclid', 'gclid', 'mc_eid', 'mc_cid', 'ref', 'source'].includes(k)) {
        drop.push(k);
      }
    }
    for (const k of drop) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, '');
  } catch { return url; }
}

/** Normalized URLs in a recoupedSource, which is a bare URL or (deep research) prose with links. */
function urlsIn(text) {
  if (typeof text !== 'string') return [];
  // Sentence punctuation after a link in prose is not part of the URL.
  return (text.match(/https?:\/\/[^\s)\]>"']+/g) || []).map((u) => normalizeUrl(u.replace(/[.,;:!?]+$/, '')));
}

/** Every source URL an archive record says was rejected. */
function rejectedSourcesOf(record) {
  if (!record) return [];
  const out = new Set(Array.isArray(record.rejectedSources) ? record.rejectedSources : []);
  if (record.archivedReason === REJECTED) for (const u of urlsIn(record.recoupedSource)) out.add(u);
  return [...out];
}

/** Has this source URL been rejected for this show slug before? */
function isRejectedSource(archive, slug, url) {
  const norm = normalizeUrl(url);
  if (!norm) return false;
  return rejectedSourcesOf(archive && archive.shows && archive.shows[slug]).includes(norm);
}

/**
 * The rejected URL when EVERY URL a claim cites was rejected for this slug,
 * else null. A claim that also cites a new source still needs a person.
 */
function rejectedClaimSource(archive, slug, recoupedSource) {
  const urls = urlsIn(recoupedSource);
  if (!urls.length || !urls.every((u) => isRejectedSource(archive, slug, u))) return null;
  return urls[0];
}

/**
 * Write an archive record without losing earlier rejections: archive.shows
 * holds one record per key, so a later write (aged-out, another rejection)
 * would otherwise erase the URL the scraper must keep skipping.
 */
function writeArchiveRecord(archive, key, record) {
  archive.shows = archive.shows || {};
  const sources = new Set([...rejectedSourcesOf(archive.shows[key]), ...rejectedSourcesOf(record)]);
  archive.shows[key] = sources.size ? { ...record, rejectedSources: [...sources] } : record;
}

/** Record a rejected claim under the show slug (where the scraper looks it up). */
function recordRejection(archive, { slug, pendingKey, entry, detail, now }) {
  writeArchiveRecord(archive, slug, {
    ...entry,
    ...(pendingKey && pendingKey !== slug ? { pendingKey } : {}),
    archivedAt: now,
    archivedReason: REJECTED,
    archivedDetail: detail,
  });
}

/**
 * @param {string} key - pending-queue key
 * @param {object} entry - pending entry carrying a recouped claim
 * @param {{commercialShows?: object, showKeyIndex?: {bySlug: Map, byId: Map}}} ctx
 * @returns {null | {verdict: 'stale-duplicate'|'wrong-production', slug: string, reason: string}}
 *   null = a person must decide.
 */
function triageRecoupedClaim(key, entry, ctx = {}) {
  const { commercialShows, showKeyIndex } = ctx || {};
  if (!showKeyIndex || !entry) return null;
  const { slug, show, resolved } = resolveCommercialSlug(key, entry, showKeyIndex);
  if (!resolved) return null;
  const existing = commercialShows && Object.prototype.hasOwnProperty.call(commercialShows, slug)
    ? commercialShows[slug]
    : null;

  if (isStaleDuplicate(existing, entry)) {
    return { verdict: 'stale-duplicate', slug, reason: `commercial.json "${slug}" already carries this recoupment, cited (${existing.recoupedDate || 'no date'})` };
  }

  const check = checkRecoupmentProduction({ show, recoupedDate: entry.recoupedDate, url: urlsIn(entry.recoupedSource)[0] });
  if (!check.ok) return { verdict: 'wrong-production', slug, reason: `wrong production: ${check.reason}` };

  if (existing && (existing.productionType === 'tour-stop' || existing.designation === 'Tour Stop')) {
    return { verdict: 'wrong-production', slug, reason: `wrong production: "${slug}" is a tour-stop engagement; recoupment belongs to the tour or the original run` };
  }
  return null;
}

module.exports = {
  REJECTED,
  normalizeUrl,
  urlsIn,
  isRejectedSource,
  rejectedClaimSource,
  writeArchiveRecord,
  recordRejection,
  triageRecoupedClaim,
};
