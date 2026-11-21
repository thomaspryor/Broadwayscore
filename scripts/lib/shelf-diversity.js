'use strict';
/**
 * shelf-diversity.js — keep the homepage's themed shelves from all leading
 * with the same shows (BRO-7461).
 *
 * Most themed shelves (lotteries, rush, Tony winners, date night, kids) sort by
 * critic score, so the same top scorers opened every row and stacked on top of
 * each other. diversifyShelves walks the shelves in page order and, for a
 * shelf marked `diversify`, moves shows that already sat in the first
 * LEAD_WINDOW cards of an earlier shelf to the back of that shelf. Nothing is
 * removed. Ranked shelves (box office, sold out, closing soon...) are not
 * marked and keep their true order, but their lead cards still count as seen.
 *
 * A shelf with fewer than MIN_FRESH unseen shows keeps its order: reshuffling
 * a short list would only swap one repeat for another.
 */

const LEAD_WINDOW = 5; // about what a desktop row shows before scrolling
const MIN_FRESH = 3;
// FeaturedRow in src/components/HomePageClient.tsx hides a shelf with fewer
// shows than its minCount (default 4). A hidden shelf's shows were never seen,
// so they must not push anything back. shelf-diversity.test.js pins this
// default to the component's.
const DEFAULT_MIN_COUNT = 4;

/**
 * @template {{ shows: Array<{ id: string }>, diversify?: boolean, minCount?: number }} T
 * @param {T[]} shelves in page order
 * @param {{ leadWindow?: number, minFresh?: number, maxVisible?: number }} [opts]
 *   maxVisible: how many cards the page renders per shelf. When set, only the
 *   visible cards are reordered, so a show pushed back never falls off the
 *   end of a shelf that has no "View all" link (BRO-7462 review).
 * @returns {T[]} shelves with the same fields and possibly reordered `shows`
 */
function diversifyShelves(shelves, opts = {}) {
  const leadWindow = opts.leadWindow ?? LEAD_WINDOW;
  const minFresh = opts.minFresh ?? MIN_FRESH;
  const maxVisible = opts.maxVisible ?? Infinity;
  const seen = new Set();
  return shelves.map(shelf => {
    let shows = shelf.shows;
    if (shelf.diversify) {
      const head = shows.slice(0, maxVisible);
      const fresh = head.filter(s => !seen.has(s.id));
      if (fresh.length >= minFresh) {
        shows = [...fresh, ...head.filter(s => seen.has(s.id)), ...shows.slice(maxVisible)];
      }
    }
    const visible = shows.length >= (shelf.minCount ?? DEFAULT_MIN_COUNT);
    if (visible) for (const s of shows.slice(0, leadWindow)) seen.add(s.id);
    return shows === shelf.shows ? shelf : { ...shelf, shows };
  });
}

module.exports = { diversifyShelves, LEAD_WINDOW, MIN_FRESH, DEFAULT_MIN_COUNT };
