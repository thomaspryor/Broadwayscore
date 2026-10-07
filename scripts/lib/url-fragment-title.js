'use strict';

/**
 * url-fragment-title.js — is this "title" actually a piece of a URL?
 *
 * BRO-3915. `tabdates-off-west-end-2026` sat in shows.json as a real show,
 * status `announced`, venue Hampstead Theatre, with image paths minted for it
 * — and its title was the literal string `?tab=dates`. A venue-listing scraper
 * had followed a tab control on a what's-on page and treated the query string
 * it linked to as a production.
 *
 * A phantom show is not a cosmetic problem. It gets a slug, a browse-page
 * card, an images directory, a discovery record, and a place in every
 * coverage audit's denominator — and because its `openingDate` is null it is
 * invisible to exactly the date-windowed checks that would otherwise notice
 * something was wrong (the same null-date blind spot that cost The Winter's
 * Tale and An American Daughter their entire review sets; see
 * lib/uncollected-strand.js).
 *
 * So the rule is enforced at validate-data as a hard error rather than left
 * to whichever scraper happens to be the culprit: there are eight-plus write
 * paths into shows.json, fixing one does not stop the next, and this is
 * cheap to check for all of them.
 *
 * WHAT THIS MUST NOT DO
 * ---------------------
 * `& Juliet` (and-juliet-2022, Stephen Sondheim Theatre) is a real Broadway
 * show whose real title begins with an ampersand. The obvious rule — "reject
 * a title starting with ? or &" — flags it immediately. An over-broad guard
 * that hard-errors on a genuine title is worse than the phantom it catches:
 * it blocks CI on correct data until someone weakens the rule, and a weakened
 * rule catches nothing. So `&` alone is never a signal here; what identifies a
 * URL fragment is the `key=value` shape, or a leading `?`.
 */

/**
 * True when a show title is a URL fragment rather than a production name.
 *
 * Signals, all of which require punctuation no real title carries in this
 * arrangement:
 *   - starts with `?` — a bare query string (`?tab=dates`)
 *   - contains `key=value` — a query parameter (`tab=dates`, `&page=2`)
 *   - starts with `&` AND contains `=` — a trailing query fragment, while
 *     plain `& Juliet` passes untouched
 *   - is a bare path or URL (`/whats-on`, `https://…`)
 *
 * @param {string} title
 * @returns {boolean}
 */
function isUrlFragmentTitle(title) {
  if (typeof title !== 'string') return false;
  const t = title.trim();
  if (!t) return false;
  if (t.startsWith('?')) return true;
  // key=value with no spaces around the `=`. A real title may contain an
  // equals sign in prose ("E = mc2"), which is why the parameter shape — a
  // bare word, `=`, then a value — is the test rather than the character.
  if (/(^|[?&])[A-Za-z0-9_.-]+=[^\s]*/.test(t)) return true;
  if (/^https?:\/\//i.test(t)) return true;
  if (/^\/[A-Za-z0-9_\-/]*$/.test(t)) return true;
  return false;
}

/**
 * Why a title was rejected, for an actionable error message.
 * @param {string} title
 * @returns {string|null}
 */
function urlFragmentReason(title) {
  if (!isUrlFragmentTitle(title)) return null;
  const t = String(title).trim();
  if (t.startsWith('?')) return 'starts with "?" — a bare query string';
  if (/^https?:\/\//i.test(t)) return 'is a URL';
  if (/^\/[A-Za-z0-9_\-/]*$/.test(t)) return 'is a URL path';
  return 'contains a key=value query parameter';
}

module.exports = { isUrlFragmentTitle, urlFragmentReason };
