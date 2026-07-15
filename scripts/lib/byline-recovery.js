/**
 * byline-recovery.js
 *
 * Recovers a critic byline for a review that landed in reviews.json as
 * "Unknown" when a SAME-URL sibling file for the same show+outlet already
 * carries the real name. This is the exact pathology from the 2026-07-14
 * Whoopi opening-night audit (card #27): the first fetch of a page missed the
 * byline (→ `outlet--unknown.json`, which stayed scoreable and won the rebuild
 * dedup), while a later re-fetch extracted the name (→ `outlet--<name>.json`,
 * often flagged wrongProduction/invalid and excluded). The scored entry shows
 * "Unknown" even though the name is sitting in a sibling file at the same URL.
 *
 * Pure + data-free so it unit-tests against fixtures (CLAUDE rule 15). The
 * driver script (scripts/recover-unknown-bylines.js) supplies the file records.
 */

'use strict';

const { canonicalReviewUrl } = require('./review-url-clusters');

// Tokens that appear inside a mis-extracted byline but are never a real critic
// name: outlet/section words, byline chrome ("Reviewed by"), and CMS date
// labels ("Updated November"). Compared case-insensitively per whitespace token.
const NOISE_TOKENS = new Set([
  'the', 'by', 'staff', 'team', 'editor', 'editors', 'reviewed', 'review',
  'reviews', 'written', 'posted', 'updated', 'published', 'guest', 'contributor',
  'standard', 'unknown', 'anonymous', 'view', 'posts', 'admin', 'correspondent',
]);

/**
 * True when `name` reads as a real personal byline (2–4 capitalized tokens,
 * each with real letters, none of them outlet/chrome noise). Deliberately
 * conservative: a false accept writes a wrong name onto a scored review, which
 * is worse than leaving it "Unknown".
 *
 * Rejects: "The Standard" (outlet), "LynGardner" (single un-split token),
 * "Reviewed by" / "Updated November" (chrome/date), "Holly O'" (truncation
 * artifact — trailing single-letter token).
 *
 * @param {*} name
 * @returns {boolean}
 */
function isPlausiblePersonName(name) {
  if (!name || typeof name !== 'string') return false;
  const s = name.trim();
  if (!s || s.toLowerCase() === 'unknown') return false;
  const tokens = s.split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false; // real names split
  for (const t of tokens) {
    if (NOISE_TOKENS.has(t.toLowerCase())) return false;
    if (!/^[A-Z]/.test(t)) return false;                    // each token Capitalized
    if (!/^[A-Za-z.'’-]+$/.test(t)) return false;           // alphabetic + name punctuation only
    if (t.length > 25) return false;
    const isInitial = /^[A-Z]\.?$/.test(t);                 // "J." / "J" — legit initial
    const letters = t.replace(/[^A-Za-z]/g, '');
    if (!isInitial && letters.length < 2) return false;     // rejects "O'" truncation tails
  }
  return true;
}

/**
 * Given the critic names found on the SAME-URL sibling files of an "Unknown"
 * review, return the single recoverable name — or null when there is no
 * plausible name, or when the plausible names disagree (ambiguous: that is the
 * byline-explosion case handled by review-url-clusters, not a safe recovery).
 *
 * @param {string[]} siblingNames
 * @returns {string|null}
 */
function pickRecoveredName(siblingNames) {
  const plausible = [];
  const seen = new Set();
  for (const n of siblingNames || []) {
    if (!isPlausiblePersonName(n)) continue;
    const key = n.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    plausible.push(n.trim());
  }
  return plausible.length === 1 ? plausible[0] : null;
}

/**
 * Full per-entry decision. `entry` is the scored review whose criticName is
 * Unknown; `siblings` are the OTHER review records for the same show+outlet.
 * Returns the recovered name (a same-canonical-URL sibling's plausible byline)
 * or null.
 *
 * @param {{criticName?:string, url?:string}} entry
 * @param {Array<{criticName?:string, url?:string}>} siblings
 * @returns {string|null}
 */
function recoverBylineForEntry(entry, siblings) {
  const cn = (entry && entry.criticName || '').trim().toLowerCase();
  if (cn && cn !== 'unknown') return null;         // already named
  const u = canonicalReviewUrl(entry && entry.url);
  if (!u) return null;                             // no URL → can't match a sibling
  const names = (siblings || [])
    .filter((s) => canonicalReviewUrl(s && s.url) === u)
    .map((s) => (s && s.criticName) || '');
  return pickRecoveredName(names);
}

/**
 * Show-level recovery. Takes EVERY review-file record in one show directory and
 * returns the Unknown files that can be safely re-bylined from a same-URL
 * sibling.
 *
 * Beyond the per-group same-URL rule, this applies a cross-outlet contamination
 * guard: a real critic reviews a given show for ONE outlet, so if a candidate
 * name is claimed as an extracted byline by 2+ distinct outlets in the same
 * show, it is stray contamination (e.g. "Ben Brantley" stamped onto amNY,
 * Chicago Tribune, Hollywood Reporter, WashPost and NYT for one Glengarry dir)
 * and is NOT propagated. Skipping such a name costs at most a legitimate
 * syndicated-wire recovery (AP → HuffPost) — a false accept would print a wrong
 * critic on a scored review, which is worse.
 *
 * @param {Array<{file:string, outletId:string, url?:string, criticName?:string}>} records
 * @returns {Array<{file:string, recoveredName:string}>}
 */
function recoverBylinesForShow(records) {
  const list = Array.isArray(records) ? records : [];

  // name(lowercased) -> set of outletIds that carry it as a plausible byline.
  const nameOutlets = new Map();
  for (const r of list) {
    if (!isPlausiblePersonName(r.criticName)) continue;
    const key = r.criticName.trim().toLowerCase();
    if (!nameOutlets.has(key)) nameOutlets.set(key, new Set());
    nameOutlets.get(key).add(r.outletId);
  }

  // Group by (outletId, canonical URL).
  const groups = new Map();
  for (const r of list) {
    const u = canonicalReviewUrl(r.url);
    if (!u) continue;
    const key = `${r.outletId}\n${u}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const unknowns = group.filter((r) => {
      const c = (r.criticName || '').trim().toLowerCase();
      return !c || c === 'unknown';
    });
    if (!unknowns.length || unknowns.length === group.length) continue;
    const name = pickRecoveredName(group.filter((r) => !unknowns.includes(r)).map((r) => r.criticName || ''));
    if (!name) continue;
    // Cross-outlet contamination guard.
    const outlets = nameOutlets.get(name.toLowerCase());
    if (outlets && outlets.size > 1) continue;
    for (const u of unknowns) out.push({ file: u.file, recoveredName: name });
  }
  return out;
}

module.exports = { isPlausiblePersonName, pickRecoveredName, recoverBylineForEntry, recoverBylinesForShow };
