'use strict';
// newsletter-sent-reconcile.js — pure guards for
// scripts/newsletter/verify-sent-vs-state.mjs.
//
// WHY (2026-11-15): the data clone's `git pull --rebase --autostash` left
// conflict markers in shows.json. verify-sent-vs-state.mjs read it through a
// `catch { return fallback }` loader, got `{ shows: [] }`, mapped 0 of the 28
// slugs in last week's SENT Broadway broadcast (0 of 18 for West End), and
// --fix rewrote both issues' featuredShowIds to [] and pushed it to main. That
// silently disabled the anti-repeat guard: every show sent last week was
// eligible to re-air. Two guards close it:
//   1. buildSlugIndex: the show list is required input. Unreadable or empty
//      shows.json is a hard error, never "no shows".
//   2. fixRefusal: a --fix that could map fewer than half of the sent slugs to
//      shows is a broken lookup, not drift. Refuse instead of rewriting.

/** Map slug -> id. Throws on anything that is not a non-empty show list. */
function buildSlugIndex(showsDoc, sourceLabel = 'shows.json') {
  const shows = showsDoc && Array.isArray(showsDoc.shows) ? showsDoc.shows : null;
  if (!shows || shows.length === 0) {
    throw new Error(`${sourceLabel} has no shows (unreadable, conflicted, or empty) — refusing to reconcile newsletter state against it`);
  }
  return new Map(shows.filter((s) => s && s.slug).map((s) => [s.slug, s.id]));
}

/** Parse the show list from raw file text. Throws with the file label on bad JSON. */
function parseShowsText(text, sourceLabel = 'shows.json') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    const marker = /^(<{7}|={7}|>{7})( |$)/m.test(String(text)) ? ' (contains git conflict markers)' : '';
    throw new Error(`${sourceLabel} is not valid JSON${marker}: ${e.message}`);
  }
  return buildSlugIndex(doc, sourceLabel);
}

/**
 * Returns a reason string when rewriting featuredShowIds from this lookup is
 * unsafe, or null when it is fine.
 * @param {{ sentSlugCount: number, mappedCount: number }} p
 */
function fixRefusal({ sentSlugCount, mappedCount }) {
  if (!sentSlugCount) return null; // nothing sent with show links: nothing to rewrite from
  if (mappedCount * 2 < sentSlugCount) {
    return `only ${mappedCount} of ${sentSlugCount} sent /show/ slugs map to a show — the show lookup is broken, not the state; refusing to rewrite featuredShowIds`;
  }
  return null;
}

module.exports = { buildSlugIndex, parseShowsText, fixRefusal };
