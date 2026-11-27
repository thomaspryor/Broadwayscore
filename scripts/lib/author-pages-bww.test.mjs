// BRO-6956: BWW critic pages moved review titles into <h3 class="review-headline">,
// and every page parsed to 0, read by the audit as "no articles". A page-1
// failure of any kind must throw so the audit reports FETCH FAILED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const bww = require('./author-pages/bww.js');

const pad = '<!--' + 'x'.repeat(6000) + '-->';
const title = '<title>Chris Jones — Theater Critic Reviews | BroadwayWorld</title>';
// Block shape copied from the live page 2026-11-27 (texts replaced).
const block = (i, titleHtml) => `<div class="one-feed">
  <div class="review-show-header"><a class="review-show-name" href="/reviews/show-${i}">Show ${i}</a></div>
  <div class="top"><div class="title-block">${titleHtml}
    <div style="font-size:.85em;color:#888"><strong>From:</strong> Chicago Tribune &nbsp;|&nbsp; <strong>Date:</strong> 11/19/2026 </div>
  </div></div>
  <div style="clear:both;margin-top:8px"><p style="font-size:15px">Excerpt.</p>
    <div class="review-actions">
      <a href="https://www.chicagotribune.com/2026/11/19/review-show-${i}/" target="_blank" rel="noopener"
         class="review-action-btn review-action-primary">Read This Review</a>
    </div></div>
</div>`;
const NEW = (n) => `<html><head>${title}</head><body>${Array.from({ length: n }, (_, i) => block(i, `<h3 class="review-headline">Review: Show ${i} is great</h3>`)).join('\n')}${pad}</body></html>`;
const OLD = (n) => `<html><head>${title}</head><body>${Array.from({ length: n }, (_, i) => block(i, `<p style="font-weight:bold;font-size:1.1em">Review: Show ${i} is great</p>`)).join('\n')}${pad}</body></html>`;
const DRIFT = `<html><head>${title}</head><body>${block(0, '<h2 class="something-else">Review</h2>')}${pad}</body></html>`;

test('parses the current h3 review-headline markup and the older bold-p markup', () => {
  for (const html of [NEW(3), OLD(3)]) {
    const r = bww.parseReviews(html);
    assert.equal(r.length, 3);
    assert.deepEqual(r[0], { url: 'https://www.chicagotribune.com/2026/11/19/review-show-0/', title: 'Review: Show 0 is great', date: '2026-11-19', outlet: 'Chicago Tribune', source: 'bww' });
  }
});

test('page-1 failures throw instead of returning []', async () => {
  const cases = [
    async () => { throw new Error('All scraping methods failed'); },
    async () => ({ content: '<html></html>' }),
    async () => ({ content: `<html><head><title>BroadwayWorld</title></head>${pad}</html>` }),
    async () => ({ content: DRIFT }),
  ];
  for (const fetchPage of cases) await assert.rejects(bww.fetch('Chris-Jones', { fetchPage }));
});

test('paginates and stops when the page repeats', async () => {
  const seen = [];
  const r = await bww.fetch('Chris-Jones', { fetchPage: async (u) => { seen.push(u); return { content: NEW(2) }; } });
  assert.equal(r.length, 2);
  assert.equal(seen.length, 2);
});
