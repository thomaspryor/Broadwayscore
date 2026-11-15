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
 * @param {{ sentSlugCount: number, mappedCount: number, stateCount?: number }} p
 */
function fixRefusal({ sentSlugCount, mappedCount, stateCount = 0 }) {
  if (!sentSlugCount) {
    // No /show/ links in the sent HTML (missing html field, API shape change):
    // rewriting would wipe a non-empty record to [] — the same failure.
    return stateCount > 0
      ? `sent broadcast HTML has no /show/ links but state records ${stateCount} shows — the HTML read is broken, not the state; refusing to rewrite featuredShowIds`
      : null;
  }
  if (mappedCount * 2 < sentSlugCount) {
    return `only ${mappedCount} of ${sentSlugCount} sent /show/ slugs map to a show — the show lookup is broken, not the state; refusing to rewrite featuredShowIds`;
  }
  return null;
}

/**
 * Parse newsletter-state.json text. Missing file (null text) = fresh state;
 * anything unparseable or shapeless throws — a corrupt state file must never
 * be treated as empty, or --fix would write back only the issue it touched.
 */
function parseStateText(text, sourceLabel = 'newsletter-state.json') {
  if (text == null) return { issues: [] };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`${sourceLabel} is not valid JSON: ${e.message} — refusing to reconcile`);
  }
  if (!doc || !Array.isArray(doc.issues)) throw new Error(`${sourceLabel} has no issues array — refusing to reconcile`);
  return doc;
}

module.exports = { buildSlugIndex, parseShowsText, parseStateText, fixRefusal };
