'use strict';
/**
 * wet-bleed-audit — find WestEndTheatre (WET) round-up rows and review-text
 * files that carry a NEIGHBOURING outlet's critic and URL (BRO-4858).
 *
 * The bug (fixed in BRO-4851): extractSectionReviews read each outlet block's
 * byline with an unbounded `$pub.nextAll('.reviewnewauthor').first()` and the
 * link right after that byline. A block with no byline took the byline AND the
 * link of the next outlet that had one. The fixed parser reads only the block
 * up to the next `.reviewnewpubhead`, so the same block now yields
 * `critic: null, reviewUrl: null`.
 *
 * WET's rendered pages are behind a Cloudflare challenge and the archive keeps
 * only the parsed rows (no HTML), so the pages cannot be re-parsed. The bug
 * leaves a fingerprint the parsed rows still show, though: the borrowed values
 * are copied verbatim, so a bled row has the SAME critic and the SAME url as a
 * later row in the same post, and that url belongs to the later row's outlet,
 * not its own. For such a row the fixed parser's output is known exactly:
 * the row had no byline of its own (or it would have read its own), so it
 * re-parses to `critic: null, reviewUrl: null`. findArchiveBleeds returns
 * exactly those rows; everything weaker is reported as a lead, never a fix.
 *
 * Pure functions only (no I/O). The CLI is scripts/audit-wet-roundup-bleed.js.
 */

const WET_HOST_RE = /(^|\.)westendtheatre\.com$/i;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function isWetUrl(url) {
  const h = hostOf(url || '');
  return !!h && WET_HOST_RE.test(h);
}

function knownCritic(name) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (!t || /^unknown$/i.test(t)) return null;
  return t;
}

function normCritic(name) {
  const k = knownCritic(name);
  return k ? k.toLowerCase().replace(/\s+/g, ' ') : null;
}

/**
 * Archive files come in two shapes: the scraper's `ratings` rows
 * ({outlet, stars, critic, excerpt, reviewUrl}) and the sweep's `reviews`
 * rows ({outlet, outletId, critic, stars, url}). Both keep page order.
 * A WET url on a row is the round-up post itself, not the outlet's review.
 */
function normalizeArchiveRows(archive) {
  const raw = Array.isArray(archive && archive.ratings) ? archive.ratings
    : Array.isArray(archive && archive.reviews) ? archive.reviews : [];
  return raw.map((r, index) => {
    const url = r.reviewUrl !== undefined ? r.reviewUrl : r.url;
    return {
      index,
      outlet: r.outlet || null,
      outletId: r.outletId || null,
      stars: r.stars ?? null,
      critic: knownCritic(r.critic),
      url: url && !isWetUrl(url) ? url : null,
    };
  });
}

/**
 * @param rows normalizeArchiveRows output (page order)
 * @param deps { outletIdFor(row) -> outletId, ownsUrl(outletId, url) -> boolean,
 *               sameHouse?(idA, idB) -> boolean (leads skip sister mastheads) }
 * @returns { bleeds: [...], leads: [...] }
 *   bleeds: rows that match the BRO-4851 fingerprint, with the fixed parser's
 *     value (`reparsed: {critic: null, url: null}`) and the donor row.
 *   leads:  a known critic shared with ANOTHER outlet's row in the post, when
 *     the url does not prove a bleed (different urls, or the url is the row's
 *     own outlet's). Report only: a freelancer can file for two outlets.
 */
function findArchiveBleeds(rows, deps) {
  const { outletIdFor, ownsUrl } = deps;
  const sameHouseFn = deps.sameHouse || ((x, y) => x === y);
  const ids = rows.map(r => outletIdFor(r));
  const bleeds = [];
  const leads = [];
  const bled = new Set();
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (!a.url) continue;
    // The donor is the LAST later row sharing critic + url: every block before
    // it without a byline borrowed the same values.
    let donor = -1;
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      if (b.url === a.url && normCritic(b.critic) === normCritic(a.critic) && ids[j] !== ids[i]) donor = j;
    }
    if (donor < 0) continue;
    const b = rows[donor];
    // The url must be the donor outlet's and not this row's own outlet's,
    // or the shared row could be a legitimate syndicated copy.
    if (!ownsUrl(ids[donor], a.url) || ownsUrl(ids[i], a.url)) continue;
    bled.add(i);
    bleeds.push({
      index: i,
      outlet: a.outlet,
      outletId: ids[i],
      stars: a.stars,
      stored: { critic: a.critic, url: a.url },
      reparsed: { critic: null, url: null },
      donor: { index: donor, outlet: b.outlet, outletId: ids[donor], critic: b.critic, url: b.url },
    });
  }
  for (let i = 0; i < rows.length; i++) {
    if (bled.has(i)) continue;
    const a = rows[i];
    const ca = normCritic(a.critic);
    if (!ca) continue;
    for (let j = 0; j < rows.length; j++) {
      // A bleed row's shared critic is already explained (reported as a bleed).
      if (j === i || bled.has(j) || ids[j] === ids[i] || sameHouseFn(ids[i], ids[j])) continue;
      if (normCritic(rows[j].critic) !== ca) continue;
      leads.push({
        index: i,
        outlet: a.outlet,
        outletId: ids[i],
        critic: a.critic,
        url: a.url,
        otherIndex: j,
        otherOutlet: rows[j].outlet,
        otherOutletId: ids[j],
        otherUrl: rows[j].url,
        adjacent: Math.abs(i - j) === 1,
        urlOwnedBySelf: a.url ? ownsUrl(ids[i], a.url) : null,
      });
    }
  }
  return { bleeds, leads };
}

// --- Default outlet identity (review-normalization) -------------------------
// Lazy: the pure functions above take these as deps so tests can stub them.
let _rn = null;
function rn() { return _rn || (_rn = require('./review-normalization')); }

// Same outlet id the scraper writes (scrape-westendtheatre-roundups.js): WET is
// a London aggregator, so a bare "Time Out" is Time Out London. The label wins
// over a cached outletId: sweep-era caches hold stale ids ("The Sunday Times"
// cached as the-sun).
function defaultOutletIdFor(row) {
  let id = rn().normalizeOutlet(row.outlet || row.outletId);
  if (id === 'timeout') id = 'timeout-london';
  return id;
}
function defaultOwnsUrl(outletId, url) {
  if (!outletId || !url) return false;
  if (!rn().resolveOutletFromUrl(url)) return false;
  return !rn().isCrossOutletUrl(outletId, url);
}

// The UK Observer publishes on theguardian.com, though the registry's
// `observer` domain is observer.com (the New York Observer).
const SAME_HOUSE_PAIRS = [['guardian', 'observer']];
/**
 * Two outlet ids from one newspaper house (edition siblings, a shared primary
 * domain, or a known pair): a critic shared between them is normal, not a lead.
 */
function sameHouse(a, b) {
  if (!a || !b) return false;
  const na = rn().normalizeOutlet(a);
  const nb = rn().normalizeOutlet(b);
  if (na === nb) return true;
  if (rn().editionFamily(na).has(nb) || rn().editionFamily(nb).has(na)) return true;
  if (SAME_HOUSE_PAIRS.some(([x, y]) => (na === x && nb === y) || (na === y && nb === x))) return true;
  const ea = rn().getOutletFromRegistry(na);
  const eb = rn().getOutletFromRegistry(nb);
  const host = e => String((e && e.domain) || '').replace(/^www\./, '').toLowerCase();
  return !!host(ea) && host(ea) === host(eb);
}

/**
 * Replay guard for archived WET rows (gather-reviews and sweep-we-aggregators
 * read data/aggregator-archive/westendtheatre/<show>.json back). A row with the
 * BRO-4851 fingerprint is replayed as the fixed parser would have parsed it:
 * no critic, no url. Keeps each writer's empty shape: the scraper's `ratings`
 * rows use null, the sweep's `reviews` rows use 'Unknown' and ''.
 * @returns { rows, scrubbed } rows is a new array; input is not mutated.
 */
function scrubArchiveBleeds(rawRows, deps = {}) {
  if (!Array.isArray(rawRows) || rawRows.length < 2) return { rows: rawRows, scrubbed: [] };
  const d = { outletIdFor: defaultOutletIdFor, ownsUrl: defaultOwnsUrl, sameHouse, ...deps };
  const shaped = rawRows.some(r => r && Object.prototype.hasOwnProperty.call(r, 'reviewUrl'))
    ? { ratings: rawRows } : { reviews: rawRows };
  const { bleeds } = findArchiveBleeds(normalizeArchiveRows(shaped), d);
  if (!bleeds.length) return { rows: rawRows, scrubbed: [] };
  const byIndex = new Set(bleeds.map(b => b.index));
  const rows = rawRows.map((r, i) => {
    if (!byIndex.has(i)) return r;
    const out = { ...r, bleedScrubbed: 'BRO-4858: critic and url were the next outlet\'s (BRO-4851 parser bleed)' };
    if (Object.prototype.hasOwnProperty.call(r, 'reviewUrl')) { out.critic = null; out.reviewUrl = null; }
    if (Object.prototype.hasOwnProperty.call(r, 'url')) { out.critic = 'Unknown'; out.url = ''; }
    return out;
  });
  return { rows, scrubbed: bleeds };
}

/**
 * The review-text files a bled archive row produced: same show folder, the
 * row's outlet, holding the borrowed critic or the borrowed url.
 * @param files [{file, data}] for one show folder
 */
function matchBleedFiles(bleed, files) {
  const critic = normCritic(bleed.stored.critic);
  return files.filter(({ data }) => {
    if (!data || data.outletId !== bleed.outletId) return false;
    return (critic && normCritic(data.criticName) === critic) || (bleed.stored.url && data.url === bleed.stored.url);
  });
}

module.exports = {
  defaultOutletIdFor,
  defaultOwnsUrl,
  sameHouse,
  scrubArchiveBleeds,
  isWetUrl,
  knownCritic,
  normCritic,
  normalizeArchiveRows,
  findArchiveBleeds,
  matchBleedFiles,
};
