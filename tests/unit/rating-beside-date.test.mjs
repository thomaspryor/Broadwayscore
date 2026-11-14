// BRO-7140: exercise the shipped card, not a copy of its rating/byline logic.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
const React = require('react');
const previousReact = globalThis.React;
globalThis.React = React;
after(() => {
  unregister();
  if (previousReact === undefined) delete globalThis.React;
  else globalThis.React = previousReact;
});
const { renderToStaticMarkup } = require('react-dom/server');
const { JSDOM } = require('jsdom');
const ReviewsList = require('../../src/components/ReviewsList.tsx').default;
const { formatOriginalRating } = require('../../scripts/lib/format-original-rating');

function render(patch = {}) {
  const review = {
    outletId: 'test-outlet', outlet: 'Test Outlet', outletBadge: null,
    criticName: 'Test Critic', url: null, publishDate: '2025-11-07',
    reviewScore: 80, originalRating: formatOriginalRating('4/5'),
    ...patch,
  };
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(ReviewsList, { reviews: [review] })));
  const card = dom.window.document.querySelector('[data-testid="review-card"]');
  assert.ok(card);
  return { dom, card };
}

for (const raw of ['4/5', '3.5 out of 5', 'B+']) {
  test(`${raw}: desktop rating shares the date container and leaves the score badge alone`, () => {
    const rating = formatOriginalRating(raw);
    const { dom, card } = render({ originalRating: rating });
    try {
      const badge = card.querySelector('[role="meter"]');
      assert.equal(badge.textContent, '80');
      assert.ok(badge.classList.contains('w-11'));
      assert.ok(badge.classList.contains('sm:w-12'));
      // A wrapper under the badge was the original placement bug.
      assert.equal(badge.parentElement, card.firstElementChild);
      const label = card.querySelector('[data-testid="review-original-rating"]');
      assert.equal(label.textContent, `Rated ${rating}`);
      assert.equal(label.parentElement.textContent, `Rated ${rating} · Nov 7, 2025`);
      assert.ok(label.parentElement.classList.contains('hidden'));
      assert.ok(label.parentElement.classList.contains('sm:inline'));
      assert.equal(label.parentElement.parentElement, badge.parentElement);
    } finally { dom.window.close(); }
  });
}

for (const content of [{ quote: 'A review quote.' }, { summary: 'A review summary.' }, { pullQuote: 'A pull quote.' }, {}]) {
  test(`phone byline keeps the rating beside its date with ${Object.keys(content)[0] || 'no quote'}`, () => {
    const { dom, card } = render(content);
    try {
      const label = card.querySelector('[data-testid="review-original-rating-mobile"]');
      assert.equal(label.textContent, ' · 4/5 stars');
      assert.equal(label.parentElement.textContent, ', Nov 7, 2025 · 4/5 stars');
      assert.ok(label.parentElement.classList.contains('sm:hidden'));
      assert.match(label.closest('p').textContent, /Test Critic, Nov 7, 2025 · 4\/5 stars$/);
    } finally { dom.window.close(); }
  });
}

test('tour phone date line retains both the stop and the published rating', () => {
  const { dom, card } = render({ stopLabel: 'Chicago, IL' });
  try {
    const label = card.querySelector('[data-testid="review-original-rating-mobile"]');
    const line = label.parentElement;
    assert.ok(line.classList.contains('sm:hidden'));
    assert.equal(line.textContent, 'Nov 7, 2025 · Reviewed in Chicago, IL · 4/5 stars');
    assert.equal(card.querySelectorAll('[data-testid="review-original-rating-mobile"]').length, 1);
  } finally { dom.window.close(); }
});

test('a missing date still shows the rating in the header and phone byline', () => {
  const { dom, card } = render({ publishDate: '' });
  try {
    const label = card.querySelector('[data-testid="review-original-rating"]');
    assert.equal(label.parentElement.textContent, 'Rated 4/5 stars');
    assert.match(card.querySelector('p').textContent, /Test Critic, 4\/5 stars$/);
    assert.doesNotMatch(card.textContent, /Invalid Date|undefined|null/);
  } finally { dom.window.close(); }
});

test('unrated reviews keep their dates without a rating or dangling separator', () => {
  const { dom, card } = render({ originalRating: undefined });
  try {
    assert.equal(card.querySelector('[data-testid="review-original-rating"]'), null);
    assert.equal(card.querySelector('[data-testid="review-original-rating-mobile"]'), null);
    assert.match(card.querySelector('p').textContent, /Test Critic, Nov 7, 2025$/);
    assert.doesNotMatch(card.textContent, /Rated|stars| · /);
  } finally { dom.window.close(); }
});

test('web row mapper and mobile feed writer use the shared published-rating formatter', () => {
  // Call-site guards complement the rendered card tests and the formatter's
  // own behavior tests. The feed must omit absent ratings, not invent a score.
  const web = readFileSync(new URL('../../src/lib/show-review-items.ts', import.meta.url), 'utf8');
  const mobile = readFileSync(new URL('../../scripts/generate-mobile-show-details.js', import.meta.url), 'utf8');
  assert.match(web, /originalRating: formatOriginalRating\(r\.originalRating\) \?\? undefined/);
  assert.match(mobile, /require\('\.\/lib\/format-original-rating'\)/);
  assert.match(mobile, /const rating = formatOriginalRating\(r\.originalRating\);\s*if \(rating\) entry\.or = rating;/);
});
