// BRO-2731: review URLs the SERP census found on a domain with no
// outlet-registry.json entry were invisible to coverage telemetry
// (electra-persona: maryamphilpottblog.wordpress.com, boycottingtrends.blogspot.com).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { registeredHosts, isRegisteredHost, censusUrlsForShow, findUnregisteredCensusUrls } = require('./outlet-registry-census-reconciler.js');

const registry = { outlets: {
  _meta: { x: 1 },
  guardian: { domain: 'theguardian.com', domainAliases: ['www.guardian.co.uk'] },
  timeout: { domain: 'https://www.timeout.com/' },
  nodomain: { displayName: 'No Domain' },
} };

test('registered hosts come from domain and domainAliases, normalized', () => {
  const hosts = registeredHosts(registry);
  assert.deepEqual([...hosts].sort(), ['guardian.co.uk', 'theguardian.com', 'timeout.com']);
});

test('a subdomain of a registered domain is registered; a lookalike is not', () => {
  const hosts = registeredHosts(registry);
  assert.equal(isRegisteredHost('amp.theguardian.com', hosts), true);
  assert.equal(isRegisteredHost('theguardian.com', hosts), true);
  assert.equal(isRegisteredHost('nottheguardian.com', hosts), false);
  assert.equal(isRegisteredHost('com', hosts), false);
});

test('census union covers every arm plus newFromNaive, deduplicated', () => {
  const row = { arms: [{ urls: ['a', 'b'] }, { urls: ['b', 'c'] }], newFromNaive: ['d', 'a'] };
  assert.deepEqual(censusUrlsForShow(row).sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(censusUrlsForShow({}), []);
});

test('reports review-shaped URLs on unregistered domains, marks the ones on disk', () => {
  const hosts = registeredHosts(registry);
  const blog = 'https://maryamphilpottblog.wordpress.com/2026/08/24/electra-persona-national-theatre/';
  const blog2 = 'https://boycottingtrends.blogspot.com/2026/08/electra-persona-review.html';
  const hits = findUnregisteredCensusUrls([
    'https://www.theguardian.com/stage/2026/sep/01/electra-persona-review',
    blog,
    blog2,
    'https://www.facebook.com/nationaltheatre/posts/1',
    'https://news.yahoo.com/electra-persona-review-123.html',
    blog,
  ], hosts, new Set([blog2]));
  assert.deepEqual(hits, [
    { url: blog2, host: 'boycottingtrends.blogspot.com', onDisk: true, pending: false },
    { url: blog, host: 'maryamphilpottblog.wordpress.com', onDisk: false, pending: false },
  ]);
});

test('a url parked in _pending/ is marked pending, not missing (BRO-5261)', () => {
  const u = 'https://www.yeahlifestyle.com/review-the-hound-of-the-baskervilles/';
  const [row] = findUnregisteredCensusUrls([u], new Set(), new Set(), (x) => x, new Set([u]));
  assert.equal(row.onDisk, false);
  assert.equal(row.pending, true);
  const [row2] = findUnregisteredCensusUrls([u], new Set());
  assert.equal(row2.pending, false);
});

test('pendingUrlStates: an identity-rejected _pending file reads rejected, not pending (ship-check)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pendingUrlStates } = require('./outlet-registry-census-reconciler.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'census-pending-'));
  const dir = path.join(root, '_pending', 'show-a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a--x.json'), JSON.stringify({ url: 'https://a.com/r' }));
  fs.writeFileSync(path.join(dir, 'b--x.json'), JSON.stringify({ url: 'https://b.com/r', rssIdentityRejected: true }));
  const m = pendingUrlStates('show-a', (u) => u, root);
  assert.equal(m.get('https://a.com/r'), 'pending');
  assert.equal(m.get('https://b.com/r'), 'rejected');
  const [row] = findUnregisteredCensusUrls(['https://b.com/r'], new Set(), new Set(), (u) => u, m);
  assert.equal(row.rejected, true);
  assert.equal(row.pending, false);
  fs.rmSync(root, { recursive: true, force: true });
});
