'use strict';
// BRO-5182: which commercial-pending-review.json entries are already covered by
// a cited commercial.json record. Pure: callers pass the parsed files.
//
// An entry is "covered" (safe to drop from pending) only when ALL hold:
//   - its show resolves to a commercial.json record with at least one source URL
//   - the show is not upcoming/announced (no public figures exist to source yet)
//   - the record carries real data (a capitalization, a non-TBD designation, or recouped:true)
//   - every claim the pending entry makes is already present and equal in the record:
//     capitalization, weeklyRunningCost, recouped:true, and a non-TBD designation.
// Anything that differs stays pending: a conflicting figure needs a person.
// Nothing here ever writes a recouped flag or a figure into commercial.json.

const { buildShowKeyIndex, resolveCommercialSlug } = require('./commercial-slug-key');

const HELD_STATUSES = new Set(['upcoming', 'announced']);
const isTbd = (d) => d == null || String(d).trim() === '' || /^tbd$/i.test(String(d).trim());
const hasUrl = (rec) => Array.isArray(rec.sources) && rec.sources.some((s) => s && typeof s.url === 'string' && s.url);

function classifyPendingEntry(key, entry, commercialShows, index) {
  const r = resolveCommercialSlug(key, entry, index);
  const status = r.show && r.show.status;
  const rec = commercialShows[r.slug];
  const out = { key, slug: r.slug, status: status || null };
  if (!r.resolved) return { ...out, covered: false, reason: 'key does not resolve to a show' };
  // A person is waiting on these (BRO-4990 backfill holds, truth reviews, owner approvals).
  if (entry.requiresHumanReview || entry.truthReview || entry.backfill || entry.ownerApproved) {
    return { ...out, covered: false, reason: 'held for a person (requiresHumanReview/truthReview/backfill/ownerApproved)' };
  }
  if (!rec) return { ...out, covered: false, reason: 'no commercial.json record' };
  if (HELD_STATUSES.has(status)) return { ...out, covered: false, reason: `show is ${status}; held` };
  if (!hasUrl(rec)) return { ...out, covered: false, reason: 'record has no cited source' };
  const filled = rec.capitalization != null || !isTbd(rec.designation) || rec.recouped === true;
  if (!filled) return { ...out, covered: false, reason: 'record has no sourced figures yet' };
  if (entry._reviewHold) return { ...out, covered: false, reason: 'review hold' };
  if (entry.capitalization != null && rec.capitalization !== entry.capitalization) {
    return { ...out, covered: false, reason: `capitalization differs (pending ${entry.capitalization}, record ${rec.capitalization ?? 'none'})` };
  }
  if (entry.weeklyRunningCost != null && rec.weeklyRunningCost !== entry.weeklyRunningCost) {
    return { ...out, covered: false, reason: `weeklyRunningCost differs (pending ${entry.weeklyRunningCost}, record ${rec.weeklyRunningCost ?? 'none'})` };
  }
  if (entry.recouped === true && entry.recoupedDate && rec.recoupedDate && String(entry.recoupedDate).slice(0, 4) !== String(rec.recoupedDate).slice(0, 4)) {
    return { ...out, covered: false, reason: `recoupedDate year differs (pending ${entry.recoupedDate}, record ${rec.recoupedDate})` };
  }
  if (entry.recouped === true && rec.recouped !== true) {
    return { ...out, covered: false, reason: 'pending claims recouped:true, record does not' };
  }
  if (!isTbd(entry.designation) && String(entry.designation).toLowerCase() !== String(rec.designation).toLowerCase()) {
    return { ...out, covered: false, reason: `designation differs (pending ${entry.designation}, record ${rec.designation})` };
  }
  const claims = entry.capitalization != null || entry.weeklyRunningCost != null || entry.recouped === true || !isTbd(entry.designation);
  if (!claims) return { ...out, covered: false, reason: 'pending entry makes no claim to match' };
  return { ...out, covered: true, reason: 'record is cited and carries every pending claim' };
}

function reconcilePending(pendingShows, commercialShows, showsData) {
  const index = buildShowKeyIndex(showsData);
  const results = Object.entries(pendingShows).map(([k, e]) => classifyPendingEntry(k, e, commercialShows, index));
  return { results, drop: results.filter((x) => x.covered).map((x) => x.key), keep: results.filter((x) => !x.covered) };
}

module.exports = { classifyPendingEntry, reconcilePending };
