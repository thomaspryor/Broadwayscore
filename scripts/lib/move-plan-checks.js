'use strict';
/**
 * move-plan-checks (BRO-6488): advisories for a review-file-op move that the
 * executor will apply cleanly but that still leaves the review wrong.
 *
 * Both hit the bro-6488 plan (2026-10-29):
 *   1. The file carries a content-check wrongProduction/wrongShow verdict that
 *      named the production it is being moved TO. review-file-move only clears
 *      flags that describe the folder (locationFlagsStaleAfterMove), so the
 *      moved review stays excluded until a plan sets the manual-clear marker.
 *      5 of 6 moved reviews stayed hidden.
 *   2. Another file in the source folder holds the same url (a second copy under
 *      an "unknown" byline). Byline enrichment later renamed it into the moved
 *      file's old name and the same review went live on two productions.
 */
const path = require('path');
const { normalizeUrl } = require('./url-utils');
const { locationFlagsStaleAfterMove } = require('./wrong-production-autoclear');

const MANUAL_CLEAR = { wrongProduction: 'wrongProductionManualClear', wrongShow: 'wrongShowManualClear' };

const urlKey = (u) => (/^https?:\/\//i.test(String(u || '')) ? normalizeUrl(String(u)).replace(/^https?:\/\/(www\.)?/i, '') : '');
const norm = (p) => path.posix.normalize(String(p || '')).replace(/^\.\//, '');

/**
 * Warnings for one move action. `readJson(rel)` returns a parsed review file or
 * null; `listFolder(folder)` returns its .json file names. `actions` is the
 * whole plan, so a manual clear or a delete elsewhere in it counts.
 */
function movePlanWarnings(a, actions, { readJson, listFolder }) {
  // execute-approved-fix.js treats 'rename' exactly like 'move'.
  if (!a || a.type !== 'review-file-op' || !['move', 'rename'].includes(a.operation) || !a.sourcePath || !a.destPath) return [];
  const src = norm(a.sourcePath);
  const dest = norm(a.destPath);
  const data = readJson(src);
  if (!data) return [];
  const out = [];
  const srcFolder = src.split('/')[0];
  const crossFolder = srcFolder !== dest.split('/')[0];
  const stale = crossFolder ? locationFlagsStaleAfterMove(data, srcFolder) : {};
  const planClears = (field) => actions.some((x) => x && x.type === 'review-field-edit' && norm(x.file) === dest
    && x.field === MANUAL_CLEAR[field] && x.newValue);
  // A same-folder rename keeps its flags by design; only a cross-folder move
  // is meant to land the review somewhere it counts.
  for (const field of crossFolder ? Object.keys(MANUAL_CLEAR) : []) {
    if (data[field] !== true || stale[field] || data[MANUAL_CLEAR[field]] || planClears(field)) continue;
    out.push(`${dest} keeps ${field}=true after the move, so it stays excluded; if the review is about the destination production, add a ${MANUAL_CLEAR[field]} edit on ${dest} to this plan`);
  }
  const key = urlKey(data.url);
  if (key) {
    const handled = new Set(actions.filter((x) => x && x.type === 'review-file-op' && x.sourcePath).map((x) => norm(x.sourcePath)));
    for (const f of listFolder(srcFolder)) {
      const rel = `${srcFolder}/${f}`;
      if (rel === src || handled.has(rel) || path.extname(f) !== '.json') continue;
      const other = readJson(rel);
      if (other && urlKey(other.url) === key) out.push(`${rel} holds the same url as ${src}; move or delete it in this plan too, or it stays on ${srcFolder}`);
    }
  }
  return out;
}

module.exports = { movePlanWarnings };
