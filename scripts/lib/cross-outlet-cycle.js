/**
 * Mutual crossOutletDuplicate 2-cycles (BRO-5265).
 *
 * detect-cross-outlet-duplicates.js flags the "secondary" copy of a text that
 * appears at two outlets with crossOutletDuplicate + crossOutletPrimaryFile.
 * Flagged rows stay in its comparison pool, so a later run whose primary pick
 * flipped (a refetch changed one text's length, an outlet tier changed) flagged
 * the OLD primary against the old secondary too. Both files then pointed at
 * each other, and the flat `crossOutletDuplicate === true` exclusion dropped
 * BOTH: the review vanished from scoring (17 show dirs, 2026-10-13).
 *
 * This module is the one rule for that shape, used by review-guards'
 * explainExclusion, rebuild-all-reviews.js's inline gate, the detector (to
 * refuse closing a cycle) and audit-duplicate-of-url-mismatch.js (report-only).
 *
 * Exactly one copy of a mutual pair is kept. Order of the tiebreak:
 *   1. a copy already excluded for another reason loses (keeping it would
 *      still drop the review);
 *   2. a copy whose text carries its own byline (named critic's surname
 *      appears in the text) beats one that does not;
 *   3. the lexically lower filename.
 * Both sides compute the same answer, so the pair always keeps one copy.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** "<showId>/<file>" or bare "<file>" -> { showId, file } (showId null for bare). */
function parsePointer(ptr) {
  if (typeof ptr !== 'string' || !ptr.endsWith('.json')) return null;
  const parts = ptr.split('/');
  return parts.length > 1 ? { showId: parts[parts.length - 2], file: parts[parts.length - 1] } : { showId: null, file: ptr };
}

/** Does `data`'s crossOutletPrimaryFile name <showId>/<file> (bare names resolve to showId)? */
function pointsAt(data, showId, file) {
  if (!data || data.crossOutletDuplicate !== true) return false;
  const p = parsePointer(data.crossOutletPrimaryFile);
  if (!p) return false;
  return p.file === file && (p.showId === null || p.showId === showId);
}

/**
 * The partner of a mutual crossOutletDuplicate 2-cycle, or null.
 * Only same-show-dir pairs count (the detector compares within one dir).
 *
 * @param {object} data   this file's record
 * @param {string} file   this file's basename
 * @param {string} showId this file's show dir name
 * @param {(f: string) => object|null} readSibling parsed sibling or null
 * @returns {{file: string, data: object} | null}
 */
function crossOutletCyclePartner(data, file, showId, readSibling) {
  if (!data || data.crossOutletDuplicate !== true) return null;
  const p = parsePointer(data.crossOutletPrimaryFile);
  if (!p || p.file === file) return null;
  if (p.showId !== null && p.showId !== showId) return null;
  const partner = readSibling(p.file);
  if (!partner || !pointsAt(partner, showId, file)) return null;
  return { file: p.file, data: partner };
}

/** True when the text names the record's own (non-Unknown) critic by surname. */
function textCarriesOwnByline(data) {
  if (!data || typeof data.fullText !== 'string' || !data.fullText) return false;
  const name = String(data.criticName || '').trim();
  if (!name || /^unknown$/i.test(name)) return false;
  const tokens = name.split(/\s+/).filter(t => t.length >= 3);
  const surname = tokens[tokens.length - 1];
  return !!surname && data.fullText.toLowerCase().includes(surname.toLowerCase());
}

/**
 * Which file of a mutual pair is kept. Pure and symmetric:
 * crossOutletCycleKeeper(a, b) === crossOutletCycleKeeper(b, a).
 *
 * @param {{file: string, data: object, excludedOtherwise?: boolean}} a
 * @param {{file: string, data: object, excludedOtherwise?: boolean}} b
 * @returns {string} the kept file's basename
 */
function crossOutletCycleKeeper(a, b) {
  const ax = !!a.excludedOtherwise, bx = !!b.excludedOtherwise;
  if (ax !== bx) return ax ? b.file : a.file;
  const ab = textCarriesOwnByline(a.data), bb = textCarriesOwnByline(b.data);
  if (ab !== bb) return ab ? a.file : b.file;
  return a.file < b.file ? a.file : b.file;
}

/**
 * Should a crossOutletDuplicate-flagged row be excluded as a copy?
 * True unless it is the kept side of a mutual 2-cycle.
 *
 * @param {object} data      this row (already known crossOutletDuplicate === true)
 * @param {string} filePath  absolute path of this row's file
 * @param {(d: object, p: string) => boolean} excludedOtherwise
 *   true when the row is excluded for a reason OTHER than crossOutletDuplicate
 *   (callers pass explainExclusion with ignoreCrossOutletDuplicate).
 * @param {(f: string) => object|null} [readSibling] defaults to reading the show dir
 */
function excludeAsCrossOutletCopy(data, filePath, excludedOtherwise, readSibling) {
  if (!filePath) return true;
  const showDir = path.dirname(filePath);
  const file = path.basename(filePath);
  const showId = path.basename(showDir);
  const read = readSibling || ((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { return null; }
  });
  const partner = crossOutletCyclePartner(data, file, showId, read);
  if (!partner) return true;
  const partnerPath = path.join(showDir, partner.file);
  const keeper = crossOutletCycleKeeper(
    { file, data, excludedOtherwise: excludedOtherwise(data, filePath) },
    { file: partner.file, data: partner.data, excludedOtherwise: excludedOtherwise(partner.data, partnerPath) },
  );
  return keeper !== file;
}

/**
 * Detector guard: would flagging `secondaryFile` as a copy of `primaryData`
 * close a 2-cycle (the primary is already flagged as a copy of the secondary)?
 */
function wouldCloseCrossOutletCycle(primaryData, showId, secondaryFile) {
  return pointsAt(primaryData, showId, secondaryFile);
}

module.exports = {
  parsePointer,
  crossOutletCyclePartner,
  crossOutletCycleKeeper,
  textCarriesOwnByline,
  excludeAsCrossOutletCopy,
  wouldCloseCrossOutletCycle,
};
