'use strict';
/**
 * Guards for draining user_show_stubs into diary-shows.json (BRO-4525).
 *
 * Any signed-in user can insert a stub row with an id and mezz_prod_id of
 * their choosing (RLS only pins created_by), so the nightly drain must not
 * trust either: the id must not already belong to a catalog entry, and a
 * stub whose production never resolves must age out instead of pinning the
 * oldest-200 window forever.
 */

const STALE_STUB_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the stub's id already names a shows.json / diary-shows.json entry. */
function isStubIdClaimed(row, usedSlugs) {
  return usedSlugs.has(row.id);
}

/** True when a stub that could not resolve is old enough to delete. */
function isStubStale(row, now = Date.now()) {
  const created = Date.parse(row.created_at);
  return Number.isFinite(created) && now - created > STALE_STUB_MS;
}

module.exports = { isStubIdClaimed, isStubStale, STALE_STUB_MS };
