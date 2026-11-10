/**
 * BRO-7304: carry a live review across the gap a URL move leaves behind.
 *
 * A canonical URL move (url-change-invariant.js) clears everything derived from
 * the old URL: fullText, llmScore, aggregatorStars, originalScore. The file is
 * then textless/scoreless until collect-review-texts re-fetches it and the
 * ensemble re-scores it, which for an old show can take days (the needsRefetch
 * drain is capped per run and ranked by show recency). Every rebuild in that
 * gap drops the review from reviews.json, so it vanishes from the live site.
 * On 2026-11-10 a single sweep wiped 28 files across 12 shows; the per-show
 * regression gate (>2 lost per show) never fired because the loss was 1-3 per
 * show.
 *
 * This module decides which dropped rows to carry forward from the previous
 * reviews.json. A row is held only when ALL of these hold:
 *   - it was in the previous reviews.json and is absent from the new build
 *   - its source file carries a `_urlChangedClear` stamp newer than `windowMs`
 *   - the file has no scoring signal now (no assignedScore/llmScore/
 *     originalScore/aggregatorStars): the wipe is the reason it was dropped
 *   - no exclusion flag explains the drop (wrongShow/wrongProduction,
 *     duplicateOf, isRoundupArticle, invalid tier, wrong_content): those are
 *     intentional cleanups and must not be undone
 *   - the old URL was not proven wrong (`_previousWrongFlags`): its score
 *     describes a different article and must not be kept
 * The hold lapses when the stamp ages out, or on its own the moment the file
 * is scored again (the new row then exists and the old one is not needed).
 *
 * Pure except for reading review files from `reviewTextsDir`.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

function rowKey(r) {
  return `${r.showId}|${String(r.outletId || r.outlet || '').toLowerCase()}|${String(r.criticName || '').toLowerCase()}`;
}

function hasScoreSignal(d) {
  return d.assignedScore != null || !!d.llmScore || d.originalScore != null || !!d.aggregatorStars;
}

function hasExclusionFlag(d) {
  return !!(
    d.wrongShow || d.wrongProduction || d.duplicateOf || d.isRoundupArticle ||
    d.contentTier === 'invalid' || d.incompleteReason === 'wrong_content' ||
    d._previousWrongFlags
  );
}

/**
 * Why a file would (not) keep its previously-live row. Returns null when it
 * should be held, else a short reason string.
 */
function holdRefusal(d, nowMs, windowMs) {
  const c = d && d._urlChangedClear;
  if (!c || !c.at) return 'no-url-change-stamp';
  const at = Date.parse(c.at);
  if (!Number.isFinite(at)) return 'bad-stamp';
  if (nowMs - at > windowMs) return 'stamp-expired';
  if (hasScoreSignal(d)) return 'has-score-signal';
  if (hasExclusionFlag(d)) return 'exclusion-flag';
  return null;
}

/**
 * @param {object} o
 * @param {object[]} o.previousRows  rows of the reviews.json being replaced
 * @param {object[]} o.newRows       rows of the build about to be written
 * @param {string}   o.reviewTextsDir
 * @param {number}   [o.nowMs]
 * @param {number}   [o.windowMs]
 * @param {Set<string>} [o.skipShowIds] shows not rebuilt here (leased): never touched
 * @returns {{held: object[], heldDetails: object[], skipped: Map<string, number>}}
 */
function findUrlWipeHolds({ previousRows, newRows, reviewTextsDir, nowMs = Date.now(), windowMs = DEFAULT_WINDOW_MS, skipShowIds = new Set() }) {
  const present = new Set(newRows.map(rowKey));
  const droppedByShow = new Map();
  for (const r of previousRows || []) {
    if (!r || !r.showId || skipShowIds.has(r.showId)) continue;
    if (present.has(rowKey(r))) continue;
    if (!droppedByShow.has(r.showId)) droppedByShow.set(r.showId, []);
    droppedByShow.get(r.showId).push(r);
  }

  const held = [];
  const heldDetails = [];
  const skipped = new Map();
  const bump = (why) => skipped.set(why, (skipped.get(why) || 0) + 1);

  for (const [showId, rows] of droppedByShow) {
    const showDir = path.join(reviewTextsDir, showId);
    let files;
    try { files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && !f.startsWith('.')); } catch { files = []; }
    const parsed = [];
    for (const f of files) {
      try { parsed.push({ f, d: JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')) }); } catch { /* unreadable */ }
    }
    for (const row of rows) {
      const key = rowKey(row);
      // The file for this row: same outlet+critic (a url match alone is too loose).
      const byKey = parsed.filter(({ d }) =>
        rowKey({ showId, outletId: d.outletId || d.outlet, criticName: d.criticName }) === key);
      const candidates = byKey;
      if (!candidates.length) { bump('no-source-file'); continue; }
      // Prefer the file that actually carries the stamp.
      const pick = candidates.find(({ d }) => d._urlChangedClear) || candidates[0];
      const why = holdRefusal(pick.d, nowMs, windowMs);
      if (why) { bump(why); continue; }
      held.push(row);
      heldDetails.push({
        showId,
        file: pick.f,
        outletId: row.outletId,
        criticName: row.criticName,
        assignedScore: row.assignedScore,
        clearedAt: pick.d._urlChangedClear.at,
        needsRefetch: pick.d.needsRefetch === true,
      });
    }
  }
  return { held, heldDetails, skipped };
}

module.exports = { findUrlWipeHolds, holdRefusal, rowKey, DEFAULT_WINDOW_MS };
