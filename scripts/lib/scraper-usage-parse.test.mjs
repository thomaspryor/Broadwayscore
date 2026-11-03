import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
const { parse } = createRequire(import.meta.url)('./scraper-usage-parse.js');

const L = (tag, rec) => `2026-11-03T00:00:00Z ${tag} ${JSON.stringify(rec)}`;

test('memo-skips are tallied separately, not counted as calls', () => {
  const p = parse([
    L('[SB Call]', { host: 'telegraph.co.uk', fn: 'render', success: false, status: 500, credits: 5 }),
    L('[SB Call]', { host: 'ew.com', fn: 'render', success: true, status: 200, credits: 5 }),
    L('[SB Call]', { host: 'ew.com', fn: 'run-memo-skip', success: false, status: 'run-memo-skip', credits: 0 }),
  ]);
  assert.equal(p.scrapingbee.reqs, 2);
  assert.equal(p.scrapingbee.ok, 1);
  assert.equal(p.scrapingbee.skips, 1);
  assert.equal(p.scrapingbee.credits, 10);
  assert.equal(p.scrapingbee.hosts['ew.com'].reqs, 1);
});

test('each provider tag routes to its own bucket; bad JSON and untagged lines ignored', () => {
  const p = parse([
    L('[SD Call]', { host: 'a.com', success: true, credits: 1 }),
    L('[BD Call]', { host: 'b.com', success: false, credits: 0 }),
    L('[BD Call]', { host: 'b.com', fn: 'run-memo-skip', success: false, status: 'run-memo-skip' }),
    '[SB Call] {not json',
    'unrelated line',
  ]);
  assert.deepEqual([p.scrapingdog.reqs, p.brightdata.reqs, p.brightdata.skips, p.scrapingbee.reqs], [1, 1, 1, 0]);
});
