// Tests for scripts/lib/rage-click-summary.js (BRO-3657 cluster). Rows mirror
// the real 2026-10-12 HogQL output that produced the unactionable cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIN_RAGE_USERS, pageKeyForPath, describeElement, qualifyingRageRows,
  summarizeRageClicks, isBackedRageClickIssue,
} = require('./rage-click-summary.js');

// [page, elementText, tag, href, nearestId, n, users]
const ROWS = [
  ['/', null, 'input', '', 'show-search', 98, 2],
  ['/', 'Broadway', 'a', '/', '', 3, 3],
  ['/discount-tickets', '$40', 'span', '', '', 2, 2],
  ['/show/the-outsiders', 'Emma Pittman', 'a', '/cast/emma-pittman', '', 2, 1],
  ['/west-end', '69', 'div', '/show/beetlejuice-west-end', '', 2, 1],
];

test('floor is two distinct visitors', () => {
  assert.equal(MIN_RAGE_USERS, 2);
  const pages = qualifyingRageRows(ROWS).map((r) => r.page);
  assert.deepEqual(pages, ['/', '/', '/discount-tickets']);
});

test('one visitor hammering a working link never reaches the prompt', () => {
  const text = summarizeRageClicks(ROWS);
  assert.doesNotMatch(text, /Emma Pittman/);
  assert.doesNotMatch(text, /"69"/);
});

test('summary names the element, not just its text', () => {
  const text = summarizeRageClicks(ROWS);
  assert.match(text, /\[page key: homepage\]: 3x by 3 visitors on <a href="\/"> "Broadway"/);
  assert.match(text, /<input> near #show-search/);
  assert.match(text, /\[page key: discount-tickets\]: 2x by 2 visitors on <span> "\$40"/);
});

test('empty or missing rows give an empty section', () => {
  assert.equal(summarizeRageClicks([]), '');
  assert.equal(summarizeRageClicks(undefined), '');
  assert.equal(describeElement(null, null, null, null), '(unknown element)');
});

test('page keys', () => {
  assert.equal(pageKeyForPath('/'), 'homepage');
  assert.equal(pageKeyForPath(''), 'homepage');
  assert.equal(pageKeyForPath('/show/the-lion-king'), 'show-page');
  assert.equal(pageKeyForPath('/west-end/'), 'west-end');
  assert.equal(pageKeyForPath('/browse/best-recent-shows'), 'browse-best-recent-shows');
});

test('rage-click issues must match a qualifying page; other types pass', () => {
  assert.equal(isBackedRageClickIssue({ evidence_key: 'rage_click:discount-tickets:price-chip' }, ROWS), true);
  assert.equal(isBackedRageClickIssue({ evidence_key: 'rage_click:show-page:cast-links' }, ROWS), false);
  assert.equal(isBackedRageClickIssue({ evidence_key: 'rage_click:west-end:score-badge' }, ROWS), false);
  assert.equal(isBackedRageClickIssue({ evidence_key: 'rage_click:homepage:logo' }, []), false);
  assert.equal(isBackedRageClickIssue({ evidence_key: 'funnel_drop:email-gate:conversion' }, []), true);
  assert.equal(isBackedRageClickIssue({}, []), true);
});

test('page match ignores case and surrounding spaces from the model', () => {
  assert.equal(isBackedRageClickIssue({ evidence_key: 'rage_click: Discount-Tickets :price-chip' }, ROWS), true);
});

test('a row the filter keeps never renders as a bare "(unknown element)" (BRO-5261)', () => {
  assert.equal(describeElement('', '/tickets', '', ''), 'link to "/tickets"');
  assert.equal(describeElement('div', '', '', '  \n'), '<div>');
  assert.equal(describeElement('', '', '', ' Buy '), '"Buy"');
  assert.equal(describeElement(' ', ' ', ' ', ' '), '(unknown element)');
  const rows = [
    ['/show/x', '', '', '/tickets', '', 20, 5],
    ['/show/y', '  ', ' ', '', '', 20, 5],
  ];
  const q = qualifyingRageRows(rows);
  assert.deepEqual(q.map((r) => r.page), ['/show/x']);
  for (const r of q) assert.doesNotMatch(r.element, /unknown element/);
});
