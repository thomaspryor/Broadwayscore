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
const { foldDiacritics } = require('./title-match');

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
  const s = foldDiacritics(name).trim();
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
 * True when every alphabetic token of `name` (each ≥3 letters, so short
 * initials/particles don't gate) appears as a word in `text`. Case-insensitive.
 * Used to corroborate a recovered byline against the article body — the byline
 * of a review is almost always printed in its own text, so a name that does NOT
 * appear is a mis-extraction (e.g. a "Christopher Isherwood" file sitting on a
 * "Charles Isherwood" article) and must not be propagated.
 *
 * Fallback: some outlets (WSJ house style) only ever spell out the critic's
 * FIRST name in the standalone byline line, then refer to them by honorific +
 * surname in the body ("Mr. Isherwood is the Journal's theater critic") —
 * giant-2026/wsj is a live example, confirmed 2026-08-12. The full-name check
 * above still requires an exact all-tokens match as the default bar; this
 * fallback accepts an honorific immediately followed by the name's last
 * token. Surname-only verification is inherently weaker than full-name
 * verification (it can't tell "Charles Isherwood" from a hallucinated
 * "Christopher Isherwood" sharing the same surname) — the caller MUST pass
 * `allowHonorific: false` whenever a same-show record shows the surname
 * paired with a DIFFERENT first name, so the fallback never overrides that
 * exact ambiguity (see recoverBylinesForShow's surname-collision check,
 * adversarial review finding, card #190).
 *
 * @param {string} name
 * @param {string} text
 * @param {{allowHonorific?: boolean}} [opts] — allowHonorific (default true)
 * @returns {boolean}
 */
function nameCorroboratedBy(name, text, opts) {
  if (!name || !text || typeof text !== 'string') return false;
  const hay = foldDiacritics(text).toLowerCase();
  const tokens = foldDiacritics(name).split(/\s+/).map((t) => t.replace(/[^a-z]/gi, '')).filter((t) => t.length >= 3);
  if (!tokens.length) return false; // nothing substantive to match on
  if (tokens.every((t) => new RegExp(`\\b${t.toLowerCase()}\\b`).test(hay))) return true;
  const allowHonorific = !opts || opts.allowHonorific !== false;
  if (!allowHonorific) return false;
  const lastToken = tokens[tokens.length - 1];
  return new RegExp(`\\b(mr|ms|mx|mrs)\\.?\\s+${lastToken}\\b`, 'i').test(hay);
}

/**
 * Show-level recovery. Takes EVERY review-file record in one show directory and
 * returns the Unknown files that can be safely re-bylined from a same-URL
 * sibling.
 *
 * Four independent safety gates, all of which must pass:
 *   1. same-URL agreement — the named sibling(s) must share the Unknown file's
 *      canonical URL and agree on a single plausible name (pickRecoveredName).
 *   2. clean-source — the sibling PROVIDING the name must not itself be flagged
 *      (wrongProduction/wrongShow/isNonReview/contentTier==='invalid'). This is
 *      the critical gate: the scored review is the Unknown file; naming it to
 *      match a FLAGGED same-URL sibling turns the pair into a same-name/same-URL
 *      duplicate, and the rebuild's dedup can then let the flagged sibling win
 *      and DROP the scored review entirely (giant-2026/wsj lost its Charles
 *      Isherwood review this way, 2026-07-14). Losing a scored review is worse
 *      than an Unknown byline, so only propagate a name that a clean sibling
 *      carries.
 *   3. cross-outlet contamination guard — a real critic reviews a given show for
 *      ONE outlet, so a name claimed as an extracted byline by 2+ distinct
 *      outlets in the same show is stray contamination (e.g. "Ben Brantley"
 *      stamped onto amNY, Chicago Tribune, Hollywood Reporter, WashPost and NYT
 *      for one Glengarry dir) and is NOT propagated.
 *   4. body corroboration — the recovered name must actually appear in the
 *      article text (the Unknown file's OR the winning sibling's `fullText`).
 *      This kills the single-outlet mis-extraction path a lone mangled file
 *      would otherwise slip through gate 3 (a hallucinated "Christopher
 *      Isherwood" byline is rejected because the WSJ body names Charles).
 *      The honorific-only fallback (nameCorroboratedBy's second branch)
 *      verifies SURNAME only, so it is refused whenever a same-show record
 *      shows that surname under a DIFFERENT first name (surnameNames below)
 *      — this defeats the documented Christopher/Charles pattern where a
 *      competing spelling exists somewhere in the data. It does NOT defend
 *      against a wholly novel single-source hallucination with zero
 *      competing spelling anywhere in the show; closing that fully would
 *      require cross-checking a critic registry, which is out of scope here
 *      (adversarial review finding, card #190 — documented, not silently
 *      dropped).
 *
 * Gates 2-4 err toward skipping: a missed recovery just leaves "Unknown"
 * (the scored review is preserved), whereas a false accept either prints a
 * WRONG critic or drops a scored review.
 *
 * @param {Array<{file:string, outletId:string, url?:string, criticName?:string, fullText?:string, flagged?:boolean}>} records
 * @param {{requireCleanSource?: boolean}} [opts] — requireCleanSource (default
 *   true) enforces gate 2. Pass false only from a caller that displays the
 *   recovered name without ever writing it back to the source file — see
 *   recoverDisplayBylinesForShow below for why that makes gate 2 moot.
 * @returns {Array<{file:string, recoveredName:string}>}
 */
function recoverBylinesForShow(records, opts) {
  const requireCleanSource = !opts || opts.requireCleanSource !== false;
  const list = Array.isArray(records) ? records : [];

  // name(folded+lowercased) -> set of outletIds that carry it as a plausible
  // byline. Folded so "José Solís" (outlet A) and "Jose Solis" (outlet B) are
  // recognized as the same critic for the contamination gate below — without
  // this an accented/unaccented spelling split across outlets would dodge it.
  const nameOutlets = new Map();
  // surname(folded) -> set of distinct full plausible names sharing it, from
  // EVERY record in the show (adversarial review finding, card #190): gate 4's
  // honorific fallback only verifies a SURNAME against body text, which is not
  // enough to distinguish "Charles Isherwood" from a hallucinated "Christopher
  // Isherwood" — if the surname maps to 2+ distinct names anywhere in this
  // show, the ambiguity is real and the honorific fallback must be refused for
  // that surname (full-name match still applies, unaffected).
  const surnameNames = new Map();
  for (const r of list) {
    if (!isPlausiblePersonName(r.criticName)) continue;
    const key = foldDiacritics(r.criticName).trim().toLowerCase();
    if (!nameOutlets.has(key)) nameOutlets.set(key, new Set());
    nameOutlets.get(key).add(r.outletId);
    const nameTokens = key.split(/\s+/);
    const surnameKey = nameTokens[nameTokens.length - 1];
    if (!surnameNames.has(surnameKey)) surnameNames.set(surnameKey, new Set());
    surnameNames.get(surnameKey).add(key);
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
    const named = group.filter((r) => !unknowns.includes(r));
    // Gate 2: only CLEAN (unflagged) siblings may supply a name — a flagged
    // same-URL twin would merge-drop the scored review. Skippable by callers
    // that never write the name back to disk (see opts above).
    const nameSource = requireCleanSource ? named.filter((r) => !r.flagged) : named;
    const name = pickRecoveredName(nameSource.map((r) => r.criticName || ''));
    if (!name) continue;
    // Gate 3: cross-outlet contamination guard.
    const outlets = nameOutlets.get(foldDiacritics(name).trim().toLowerCase());
    if (outlets && outlets.size > 1) continue;
    // Gate 4: body corroboration in the Unknown's OR a sibling's fullText.
    // allowHonorific is refused when this surname has 2+ distinct full-name
    // spellings anywhere in the show — see surnameNames above.
    const nameFold = foldDiacritics(name).trim().toLowerCase();
    const surnameKey = nameFold.split(/\s+/).pop();
    const allowHonorific = (surnameNames.get(surnameKey)?.size || 0) <= 1;
    const corroborated = group.some((r) => nameCorroboratedBy(name, r.fullText, { allowHonorific }));
    if (!corroborated) continue;
    for (const u of unknowns) out.push({ file: u.file, recoveredName: name });
  }
  return out;
}

/**
 * Display-only variant of recoverBylinesForShow (card #190). Skips gate 2
 * (clean-source): the on-disk hazard gate 2 guards against — a rebuild
 * rename/dedup helper collapsing an Unknown file onto a same-name/same-URL
 * flagged twin and dropping the scored review (the 2026-07-14 giant-2026/wsj
 * incident, card #27) — can only happen when the recovered name is WRITTEN
 * onto the Unknown file on disk. This function's caller (rebuild-all-reviews.js)
 * only substitutes the name into the in-memory reviews.json record it emits;
 * the source JSON file's criticName stays "Unknown" forever, so there is no
 * name+URL collision for any dedup pass to ever see. Gates 1 (URL agreement),
 * 3 (cross-outlet contamination), and 4 (body corroboration) still apply.
 *
 * Gate 5 (adversarial review, card #190): rebuild-all-reviews.js's own
 * POST-PROCESSING passes collapse any two reviews sharing (show, outlet,
 * criticName) at reviews.json-emission time, keeping only the later
 * publishDate — that is how the pipeline already treats "same critic, same
 * outlet" as a true duplicate. Display-only recovery is immune to the
 * ON-DISK rename hazard above, but if the recovered name happens to match a
 * DIFFERENT already-named, unflagged (likely-scored) record at the same
 * outlet with a DIFFERENT URL, applying it would manufacture a fresh
 * same-name collision for that later pass to silently resolve — dropping a
 * live, distinct review instead of the excluded twin. Skip the recovery in
 * that case; leaving "Unknown" keeps both reviews (same "gates err toward
 * skipping" philosophy as gates 1-4).
 *
 * @param {Array<{file:string, outletId:string, url?:string, criticName?:string, fullText?:string, flagged?:boolean}>} records
 * @returns {Array<{file:string, recoveredName:string}>}
 */
function recoverDisplayBylinesForShow(records) {
  const list = Array.isArray(records) ? records : [];
  const recovered = recoverBylinesForShow(list, { requireCleanSource: false });
  const foldKey = (n) => foldDiacritics(n || '').trim().toLowerCase();
  // Tracks (outletId, foldedName, url) already accepted in THIS pass — catches
  // two different Unknown files independently recovering to the same critic at
  // the same outlet from different URLs, which the against-`list` check below
  // cannot see (neither file's ORIGINAL criticName is the recovered name, so
  // they never collide against each other's raw records — adversarial review
  // finding, card #190).
  const acceptedInPass = [];
  const out = [];
  for (const rec of recovered) {
    const src = list.find((r) => r.file === rec.file);
    if (!src) { out.push(rec); continue; }
    const srcUrl = canonicalReviewUrl(src.url);
    const recoveredKey = foldKey(rec.recoveredName);
    const collidesWithExisting = list.some((r) =>
      r.file !== rec.file &&
      r.outletId === src.outletId &&
      !r.flagged &&
      foldKey(r.criticName) === recoveredKey &&
      canonicalReviewUrl(r.url) !== srcUrl
    );
    const collidesWithPass = acceptedInPass.some((a) =>
      a.outletId === src.outletId &&
      a.nameKey === recoveredKey &&
      a.url !== srcUrl
    );
    if (collidesWithExisting || collidesWithPass) continue;
    acceptedInPass.push({ outletId: src.outletId, nameKey: recoveredKey, url: srcUrl });
    out.push(rec);
  }
  return out;
}

module.exports = {
  isPlausiblePersonName,
  pickRecoveredName,
  recoverBylineForEntry,
  recoverBylinesForShow,
  recoverDisplayBylinesForShow,
  nameCorroboratedBy,
};
