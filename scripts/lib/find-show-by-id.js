'use strict';

// Live-data guards hard-code show ids. A rename (scripts/lib/show-id-rename.js,
// or a bulk market reclassification like the 2026-11 West End -> Off-West-End
// pass that moved ~97 ids) keeps the old id in the show's `aliases`, so a
// guard that looks the id up by `s.id === id` alone goes red on a rename that
// lost nothing (BRO-6975: the Snowman hero guard and the TM-gap guard). Look
// up by id first, then by alias, so the guard keeps checking the same show.
// Plain-JS twin of findShowByIdOrAlias in src/lib/data-core.ts (which tests
// can't import without the whole data layer); keep the two rules identical.
function findShowByIdOrAlias(shows, id) {
  if (!id) return null;
  const list = Array.isArray(shows) ? shows : (shows && shows.shows) || [];
  return list.find((s) => s && s.id === id)
    || list.find((s) => s && Array.isArray(s.aliases) && s.aliases.includes(id))
    || null;
}

module.exports = { findShowByIdOrAlias };
