// BRO-8447: Verdict extractor returned 0 for its-a-wonderful-life-a-live-radio-play-2026
// because a link-less stub archive was reused for 14 days. Requires the real functions.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, '../fixtures/playbill-verdict', n), 'utf8');
const { extractReviewLinksFromArticle, isArchiveReusable } = require('../../scripts/lib/playbill-verdict-discover.js');

const NOW = Date.parse('2026-11-28T12:00:00Z');
const hoursAgo = (h) => NOW - h * 3600000;

describe('Playbill Verdict extractor (Wonderful Life fixture)', () => {
  it('extracts the critics links and none of the ticketing links', () => {
    const r = extractReviewLinksFromArticle(fx('its-a-wonderful-life-2026-live.html'), 'x');
    const domains = r.map((x) => x.outletDomain);
    assert.ok(r.length >= 12, `expected >=12, got ${r.length}`);
    assert.ok(domains.includes('vulture.com'));
    assert.ok(domains.includes('nydailynews.com'));
    assert.ok(!domains.some((d) => /telecharge|itsawonderfullifebway/.test(d)));
  });
  it('script no longer carries its own copy of the extractor', () => {
    const src = fs.readFileSync(path.join(here, '../../scripts/scrape-playbill-verdict.js'), 'utf8');
    assert.ok(!/^function extractReviewLinksFromArticle/m.test(src));
  });
});

describe('isArchiveReusable', () => {
  const live = fx('its-a-wonderful-life-2026-live.html');
  const stub = fx('stub-no-links.html');
  it('reuses a page with links for up to 14 days', () => {
    assert.equal(isArchiveReusable(live, hoursAgo(24 * 10), { now: NOW }), true);
    assert.equal(isArchiveReusable(live, hoursAgo(24 * 15), { now: NOW }), false);
  });
  it('does not pin a link-less stub for 14 days', () => {
    assert.equal(isArchiveReusable(stub, hoursAgo(2), { now: NOW }), true);
    assert.equal(isArchiveReusable(stub, hoursAgo(30), { now: NOW }), false);
  });
  it('rejects empty html', () => {
    assert.equal(isArchiveReusable('', hoursAgo(1), { now: NOW }), false);
  });
});
