// Regression for the 2026-11-02 owner report: on iPhone the Critics' Take
// was wedged into the narrow middle column and made cards very tall. The
// take must render in its own full-width row (colspan=3), never inside the
// info column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { showCardHtml, criticsTakeHtml } = require('./newsletter-show-card.js');

const base = {
  posterHtml: '<img src="p.jpg">',
  infoHtml: '<div>INFO</div>',
  scoreColHtml: '<td>SCORE</td>',
};

test('take renders in its own full-width row, not inside the info column', () => {
  const html = showCardHtml({ ...base, takeHtml: criticsTakeHtml('Critics praise it…', 'https://x/show') });
  const rows = html.split('<tr>').slice(1);
  assert.equal(rows.length, 2, 'card has a main row and a take row');
  assert.ok(!rows[0].includes('Critics&#8217; Take'), 'take is not in the poster/info/score row');
  assert.match(rows[1], /<td colspan="3"/);
  assert.ok(rows[1].includes('Critics&#8217; Take'));
  assert.ok(rows[1].includes('Read more&nbsp;&rarr;'));
});

test('no take means no second row', () => {
  const html = showCardHtml({ ...base, takeHtml: criticsTakeHtml(null, 'https://x') });
  assert.equal(html.split('<tr>').length - 1, 1);
  assert.ok(!html.includes('colspan'));
});

test('read-more link is omitted without an href', () => {
  assert.ok(!criticsTakeHtml('A take', null).includes('Read more'));
  assert.equal(criticsTakeHtml('', 'https://x'), '');
});
