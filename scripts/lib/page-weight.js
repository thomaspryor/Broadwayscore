'use strict';

// Page-weight budgets for the market list pages (BRO-5991). /west-end shipped
// 4.6MB of HTML and ~500 <img> because every shelf and the whole main list
// were server-rendered; the homepage window pattern (INITIAL_SHOW_COUNT +
// IntersectionObserver, shelves capped) brought it back down. These budgets
// stop it quietly regrowing.

// htmlFile is relative to .next/server/app after `next build`.
const MARKET_PAGE_BUDGETS = [
  { route: '/west-end', htmlFile: 'west-end.html', maxBytes: 1_000_000, maxImgs: 150 },
  { route: '/off-broadway', htmlFile: 'off-broadway.html', maxBytes: 1_000_000, maxImgs: 150 },
  { route: '/off-west-end', htmlFile: 'off-west-end.html', maxBytes: 1_000_000, maxImgs: 150 },
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

module.exports = { MARKET_PAGE_BUDGETS, measureHtml, evaluateBudget };
