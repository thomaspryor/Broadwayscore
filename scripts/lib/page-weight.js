'use strict';

// Page-weight budgets for the market list pages (BRO-5991). /west-end shipped
// 4.6MB of HTML and ~500 <img> because every shelf and the whole main list
// were server-rendered; the homepage window pattern (INITIAL_SHOW_COUNT +
// IntersectionObserver, shelves capped) brought it back down. These budgets
// stop it quietly regrowing.

// htmlFile is relative to .next/server/app after `next build`.
const MARKET_PAGE_BUDGETS = [
  { route: '/west-end', htmlFile: 'west-end.html', maxBytes: 1_000_000, maxImgs: 150 },
  // /off-broadway: 1.09MB before BRO-6325 (ItemList JSON-LD listed ~470 closed shows); ~0.5MB after.
  { route: '/off-broadway', htmlFile: 'off-broadway.html', maxBytes: 650_000, maxImgs: 150 },
  { route: '/off-west-end', htmlFile: 'off-west-end.html', maxBytes: 1_000_000, maxImgs: 150 },
];

// Other big hub pages (BRO-5968). Googlebot reads only the first 2MB of an
// HTML file; /browse/best-broadway-shows-all-time was 7.3MB with 545 of its
// 755 show links past the cutoff. 1.8MB leaves headroom under that limit.
// Image caps sit ~1.5x above what each page rendered when trimmed (2026-10-23).
const HUB_PAGE_BUDGETS = [
  { route: '/browse/best-broadway-shows-all-time', htmlFile: 'browse/best-broadway-shows-all-time.html', maxBytes: 1_800_000, maxImgs: 150 },
  { route: '/award-score', htmlFile: 'award-score.html', maxBytes: 1_800_000, maxImgs: 350 },
  { route: '/browse/west-end-shows', htmlFile: 'browse/west-end-shows.html', maxBytes: 1_800_000, maxImgs: 150 },
  { route: '/browse/best-broadway-soundtracks', htmlFile: 'browse/best-broadway-soundtracks.html', maxBytes: 1_800_000, maxImgs: 150 },
  { route: '/cast', htmlFile: 'cast.html', maxBytes: 1_800_000, maxImgs: 150 },
];

// The two highest-traffic page types (BRO-6278). The homepage inlined ~300kB of
// shelf and search data it only needs after scroll; show pages inlined every
// review row and related-show card. Budgets sit ~20% above the post-trim size
// so ordinary data growth passes and a re-inlined payload does not.
// Show pages: one representative route (a long-running Broadway show).
const CORE_PAGE_BUDGETS = [
  { route: '/', htmlFile: 'index.html', maxBytes: 400_000, maxImgs: 120 },
  { route: '/show/hamilton-2015/', htmlFile: 'show/hamilton-2015.html', maxBytes: 330_000, maxImgs: 120 },
];

function measureHtml(html) {
  const bytes = Buffer.byteLength(html, 'utf8');
  const imgs = (html.match(/<img\b/gi) || []).length;
  return { bytes, imgs };
}

function evaluateBudget(budget, html) {
  const { bytes, imgs } = measureHtml(html);
  const violations = [];
  if (bytes > budget.maxBytes) violations.push(`${budget.route}: HTML ${bytes} bytes exceeds ${budget.maxBytes}`);
  if (imgs > budget.maxImgs) violations.push(`${budget.route}: ${imgs} <img> exceeds ${budget.maxImgs}`);
  return { route: budget.route, bytes, imgs, violations };
}

module.exports = { MARKET_PAGE_BUDGETS, HUB_PAGE_BUDGETS, CORE_PAGE_BUDGETS, measureHtml, evaluateBudget };
