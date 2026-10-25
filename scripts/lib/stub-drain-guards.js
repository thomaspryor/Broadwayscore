'use strict';
/**
 * Guards for draining user_show_stubs into diary-shows.json (BRO-4525).
 *
 * Any signed-in user can insert a stub row with an id and mezz_prod_id of
 * their choosing (RLS only pins created_by), so the nightly drain must not
 * trust either: the id must not already belong to a catalog entry.
 * (Deleting stale unresolved stubs was tried and rejected: a Mezzanine error
 * body looks like "no production", and the stub is the only metadata a user's
 * reviews/watchlist rows have for that id.)
 */

/** True when the stub's id already names a shows.json / diary-shows.json entry. */
function isStubIdClaimed(row, usedSlugs) {
  return usedSlugs.has(row.id);
}

module.exports = { isStubIdClaimed };
