'use strict';
/**
 * sibling-production-cast — content check for a review filed under one
 * production of a title whose text only names ANOTHER production's people.
 *
 * Why (BRO-5499): Sea Wall (Off-Broadway, Oct 2026, Andrew Scott) held a 2019
 * Broadway "Sea Wall / A Life" review (Tom Sturridge, Jake Gyllenhaal) scored
 * 88. It had no publishDate and an Unknown critic, so every URL-date guard
 * failed open; the LLM scoreability check only sees title/venue/market, and the
 * entry's own cast was the 2019 cast copied over, so a cast-based check could
 * not have caught it either. The text itself is the evidence: it names the
 * earlier production's actors and none of this production's.
 *
 * A review is flagged only when ALL hold:
 *   - this show has cast/creative names on file (nothing to compare otherwise),
 *   - the text names at least two cast members of a same-title sibling entry
 *     who are NOT on this entry,
 *   - the text names NO cast/creative member of this entry,
 *   - the sibling is not a declared return of this production (priorRuns link),
 *     and is in the same market (cross-market and tour/regional legs reuse names).
 * A review of the right production that mentions an earlier staging in passing
 * almost always names its own cast too, so it is left alone.
 *
 * Pure: no I/O (CLAUDE.md §15). Tests: sibling-production-cast.test.mjs.
 */

const { toDateMs } = require('./date-utils');

const MIN_TEXT_CHARS = 400;
const MIN_SIBLING_NAMES = 2;

function foldName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Sea Wall / A Life" -> "sea wall"; "Hamilton: The Musical" -> "hamilton". */
function titleKey(title) {
  const head = String(title || '').replace(/\s*\(.*?\)/g, '').split(/\s*(?:\/|:|–|—| - )\s*/)[0];
  return foldName(head).replace(/^the /, '');
}

function sameTitle(a, b) {
  const ka = titleKey(a && a.title);
  const kb = titleKey(b && b.title);
  return !!ka && ka === kb;
}

function namesOf(show, { castOnly = false } = {}) {
  const out = new Set();
  for (const c of (show && show.cast) || []) if (c && c.name) out.add(foldName(c.name));
  if (castOnly) return [...out].filter((n) => n.split(' ').length >= 2 && n.length >= 7);
  for (const c of (show && show.creativeTeam) || []) {
    if (!c || !c.name) continue;
    // "Kaye Voyce and Christopher Peterson" lists two people in one row.
    for (const part of String(c.name).split(/\s+(?:and|&)\s+|,/)) out.add(foldName(part));
  }
  return [...out].filter((n) => n.split(' ').length >= 2 && n.length >= 7);
}

function declaresReturnOf(show, sibling) {
  const runs = Array.isArray(show && show.priorRuns) ? show.priorRuns : [];
  if (runs.some((r) => (typeof r === 'string' ? r === sibling.id
    : r && (r.id === sibling.id || r.showId === sibling.id || r.productionId === sibling.id)))) return true;
  // Most priorRuns are {openingDate, venue} objects with no id: the shared matcher knows them.
  try { return require('./prior-run-sibling').isReturnOfProduction(show, sibling); } catch { return false; }
}

function marketOf(show) {
  return (show && (show.market || show.category)) || '';
}

function comparableMarkets(a, b) {
  const ma = marketOf(a);
  const mb = marketOf(b);
  if (!ma || ma !== mb) return false;
  return !['tour', 'regional'].includes(ma) && !['tour', 'regional'].includes(a.category) && !['tour', 'regional'].includes(b.category);
}

const DAY_MS = 86400000;
function reviewDateFitsRun(publishDate, sib) {
  if (!publishDate) return true; // undated: no evidence either way
  const pub = toDateMs(publishDate); // handles "April 22nd, 2014" (a bare Date.parse returns NaN)
  const open = toDateMs(sib && sib.openingDate);
  if (Number.isNaN(pub) || Number.isNaN(open)) return true;
  const close = toDateMs(sib.closingDate);
  const end = Number.isNaN(close) ? open + 400 * DAY_MS : close;
  return pub >= open - 60 * DAY_MS && pub <= end + 120 * DAY_MS;
}

function mentions(foldedText, name) {
  const idx = foldedText.indexOf(name);
  if (idx === -1) return false;
  const before = idx === 0 ? ' ' : foldedText[idx - 1];
  const after = foldedText[idx + name.length] || ' ';
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/**
 * @param {string} text review body
 * @param {object} show shows.json entry the review is filed under
 * @param {Array<object>} allShows shows.json entries
 * @param {{publishDate?: string|null}} [opts] a review dated outside the sibling's run is not the sibling's
 * @returns {null | {siblingId: string, siblingNamesFound: string[], reason: string}}
 */
function findSiblingProductionCastMismatch(text, show, allShows, { publishDate = null } = {}) {
  if (!show || typeof text !== 'string' || text.length < MIN_TEXT_CHARS) return null;
  const ownAll = new Set(namesOf(show));
  if (ownAll.size === 0) return null;
  const folded = foldName(text);
  for (const sib of allShows || []) {
    if (!sib || sib.id === show.id || !sameTitle(sib, show) || declaresReturnOf(show, sib)) continue;
    // Cross-market pairs (Broadway vs West End vs a tour) share casts and creatives and have
    // their own market guards; tours/regional legs reuse the parent production's names.
    if (!comparableMarkets(show, sib)) continue;
    // A review dated far outside the sibling's run cannot be that sibling's: it is this production's
    // review recalling the earlier cast (Chicago 1996 revival review naming the 1975 original cast).
    if (!reviewDateFitsRun(publishDate, sib)) continue;
    // What tells the two productions apart: people on THIS entry who are not on the sibling. The
    // playwright is on both (Simon Stephens), so naming him proves nothing either way.
    const sibAll = new Set(namesOf(sib));
    const ownOnly = [...ownAll].filter((n) => !sibAll.has(n));
    if (ownOnly.length === 0) continue; // cannot tell the productions apart from names
    if (ownOnly.some((n) => mentions(folded, n))) continue; // names this production's people
    // Cast only, not creatives (every production's reviews name the playwright / composer). Two names
    // are required unless the sibling lists fewer than two (shows.json cast lists are often partial:
    // the 2019 Sea Wall row holds only Tom Sturridge).
    const sibOnlyCast = namesOf(sib, { castOnly: true }).filter((n) => !ownAll.has(n));
    const found = sibOnlyCast.filter((n) => mentions(folded, n));
    if (found.length >= Math.max(1, Math.min(MIN_SIBLING_NAMES, sibOnlyCast.length))) {
      return {
        siblingId: sib.id,
        siblingNamesFound: found,
        reason: `Text names ${found.join(', ')} (${sib.id}) and none of this production's cast or creatives: a different production of the same title`,
      };
    }
  }
  return null;
}

/**
 * shows.json rows whose cast list was copied from a same-title, same-market sibling entry of a different
 * year: an IBDB wrong-show match put the 2022 Broadway Macbeth cast on the 2026 Met Opera Macbeth, and the
 * 1999 Charlie Brown cast on a 2026 92NY run (BRO-5499). Pairs share >= 80% of the smaller cast, open 3+
 * years apart, and neither declares the other as a prior run.
 * @returns {Array<{showId: string, siblingId: string, shared: number, of: number, year: number}>}
 */
function findCopiedSiblingCasts(allShows) {
  const groups = new Map();
  for (const s of allShows || []) {
    const k = titleKey(s && s.title);
    if (k) (groups.get(k) || groups.set(k, []).get(k)).push(s);
  }
  // Year from the date string itself: a local-time getFullYear() turns '2023-01-01' into 2022 under a US timezone,
  // and a missing/unparseable date must stay NaN so the pair is skipped rather than counted as decades apart.
  const yearOf = (s) => {
    const m = /^(\d{4})-\d{2}/.exec(String((s && (s.openingDate || s.previewsStartDate)) || ''));
    return m ? Number(m[1]) : NaN;
  };
  const out = [];
  for (const grp of groups.values()) {
    for (let i = 0; i < grp.length; i++) {
      for (let j = i + 1; j < grp.length; j++) {
        const a = grp[i];
        const b = grp[j];
        if (!comparableMarkets(a, b) || declaresReturnOf(a, b) || declaresReturnOf(b, a)) continue;
        if (!Number.isFinite(yearOf(a)) || !Number.isFinite(yearOf(b))) continue;
        if (Math.abs(yearOf(a) - yearOf(b)) < 3) continue;
        const na = namesOf(a, { castOnly: true });
        const nb = new Set(namesOf(b, { castOnly: true }));
        const of = Math.min(na.length, nb.size);
        if (of < 2) continue;
        const shared = na.filter((n) => nb.has(n)).length;
        if (shared / of >= 0.8) {
          // report the LATER entry: an earlier production's cast is the original, the later one inherited it
          const [later, earlier] = yearOf(a) >= yearOf(b) ? [a, b] : [b, a];
          out.push({ showId: later.id, siblingId: earlier.id, shared, of, year: yearOf(later) });
        }
      }
    }
  }
  return out;
}

module.exports = {
  findCopiedSiblingCasts, findSiblingProductionCastMismatch, titleKey, namesOf, MIN_TEXT_CHARS, MIN_SIBLING_NAMES };
