/**
 * dispatch-overlap-check — pure predicate that flags when the card bsc-next
 * is about to dispatch overlaps ANOTHER already-in_progress card, so a second
 * workspace doesn't independently duplicate work a live session is already
 * doing.
 *
 * Confirmed twice in one session's task list (card #917):
 *   1. #893 and #902 both independently fixed the identical bug in
 *      scripts/audit-show-review-gap.js — discovered only at merge time via a
 *      git conflict, after both sessions had already spent real time +
 *      scraper credits.
 *   2. #897 and #911 are literally duplicate-titled cards ("Extract
 *      pushCookieSecretWithMeta() helper...") both dispatched separately.
 *
 * Unlike findLiveWorkspaceForTask (bsc-next.js) — which only catches a SECOND
 * dispatch of the SAME task id — this catches two DIFFERENT task ids whose
 * notes describe the same underlying work: a shared scripts/ file path, or
 * (when no path is mentioned, the #897/#911 class) a near-identical title.
 *
 * Non-blocking by design (first cut, per the card): callers print the
 * warning and dispatch anyway. Refusing outright would need a much higher
 * false-positive bar than a plain path/title match clears — two cards can
 * legitimately touch the same file for unrelated reasons.
 */

'use strict';

// scripts/foo/bar.js, scripts/foo.ts, scripts/foo.mjs, scripts/foo.sh —
// deliberately scoped to scripts/ (where every real collision so far has
// happened) rather than src/ or data/, which would pull in far noisier
// generic paths (e.g. every card mentioning "src/app/page.tsx" boilerplate).
const FILE_PATH_RE = /\bscripts\/\S+\.(?:js|ts|mjs|sh)\b/g;

function filePathsIn(text) {
  return new Set((String(text || '').match(FILE_PATH_RE) || []));
}

// Case/whitespace-insensitive normalization so "Extract pushCookieSecretWithMeta()  helper"
// vs "extract pushcookiesecretwithmeta() helper" still counts as the same title.
function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// A short prefix match (e.g. both starting with "Fix:") is coincidence, not
// evidence — same >=20-char floor bsc-next.js's own title-based duplicate
// guard (findLiveWorkspaceForTask / titleMatchesSubject) uses, so this stays
// consistent with the bar already proven in production.
const TITLE_MATCH_MIN_LEN = 20;

// Task #1672: distinguishes a byte-for-byte normalized match ('exact' — proof,
// not a hint; see dispatch-guards.js's exactTitleOverlapGuard) from a mere
// startsWith prefix overlap ('prefix' — still only suggestive, stays
// warn-only). Second-opinion review, 2026-08-16: spot-checked live task
// mirror, 7 exact-title-duplicate groups among 197 in_progress cards, all
// confirmed genuine duplicates (different Notion UUIDs, same bug) — no false
// positive found for the exact case.
function titleMatchKind(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na.length < TITLE_MATCH_MIN_LEN || nb.length < TITLE_MATCH_MIN_LEN) return null;
  if (na === nb) return 'exact';
  if (na.startsWith(nb) || nb.startsWith(na)) return 'prefix';
  return null;
}

function titlesOverlap(a, b) {
  return titleMatchKind(a, b) !== null;
}

function cardText(card) {
  return `${card && card.subject ? card.subject : ''}\n${card && card.notes ? card.notes : ''}`;
}

// targetCard / inProgressCards: { id, subject, notes } (subject/notes ==
// task.subject / (card.notes || task.description) in bsc-next.js's shape —
// callers pass whatever text they have, this only ever reads subject+notes).
// Returns the array of colliding cards (each annotated with why it collided),
// empty when nothing overlaps. Never throws on missing/malformed input.
function findOverlappingCards(targetCard, inProgressCards) {
  if (!targetCard) return [];
  const targetId = String((targetCard && targetCard.id) || '');
  const targetPaths = filePathsIn(cardText(targetCard));
  const targetSubject = (targetCard && targetCard.subject) || '';

  return (inProgressCards || [])
    .filter(c => c && String(c.id) !== targetId)
    .map(c => {
      // Exact title match checked FIRST and wins even when the pair also
      // shares a file path — a byte-for-byte subject match against live
      // in_progress work is proof on its own, not merely corroborated by a
      // shared path (task #1672).
      const titleKind = titleMatchKind(targetSubject, c.subject);
      if (titleKind === 'exact') return { card: c, reason: 'exact-title-match', sharedPaths: [] };
      const sharedPaths = [...filePathsIn(cardText(c))].filter(p => targetPaths.has(p));
      if (sharedPaths.length) return { card: c, reason: 'shared-file-path', sharedPaths };
      if (titleKind === 'prefix') return { card: c, reason: 'similar-title', sharedPaths: [] };
      return null;
    })
    .filter(Boolean);
}

module.exports = { findOverlappingCards, filePathsIn, titlesOverlap, titleMatchKind, normalizeTitle };
