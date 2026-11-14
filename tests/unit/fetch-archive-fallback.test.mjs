import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fetchWithArchiveFallback, latestCaptureTimestamp } = require('../../scripts/lib/fetch-archive-fallback.js');
const BIG = '<html>' + 'x'.repeat(600) + '</html>';

test('live success never touches the archive', async () => {
  let cdx = 0;
  const r = await fetchWithArchiveFallback('https://o.test/r', { fetchPageFn: async () => ({ content: BIG }), fetchJson: async () => { cdx++; return null; } });
  assert.equal(r.via, 'live'); assert.equal(cdx, 0);
});
test('live throw falls back to the newest archive copy', async () => {
  const seen = [];
  const r = await fetchWithArchiveFallback('https://o.test/r', {
    fetchPageFn: async (u) => { seen.push(u); if (!u.includes('web.archive.org')) throw new Error('403'); return { html: BIG }; },
    fetchJson: async () => [['timestamp'], ['20261030010101'], ['20261031020202']],
  });
  assert.equal(r.via, 'archive'); assert.equal(r.snapshot, '20261031020202');
  assert.equal(seen[1], 'https://web.archive.org/web/20261031020202id_/https://o.test/r');
});
test('short live HTML counts as a failure', async () => {
  const r = await fetchWithArchiveFallback('https://o.test/r', { fetchPageFn: async () => ({ content: 'tiny' }), fetchJson: async () => null });
  assert.equal(r.html, null); assert.match(r.error, /no usable HTML/);
});
test('no capture means a recorded reason, not a throw', async () => {
  const r = await fetchWithArchiveFallback('https://o.test/r', { fetchPageFn: async () => { throw new Error('boom'); }, fetchJson: async () => [['timestamp']] });
  assert.equal(r.html, null); assert.match(r.error, /no archive\.org capture/);
});
test('malformed cdx timestamp is ignored', async () => {
  assert.equal(await latestCaptureTimestamp('u', { fetchJson: async () => [['timestamp'], ['bad']] }), null);
});

test('archiveCopyDisposition: thin archive copy queues a stub when asked, else refuses', () => {
  const { archiveCopyDisposition: d } = require('../../scripts/lib/fetch-archive-fallback.js');
  assert.equal(d({ viaArchive: false, explicitSnapshot: false, stubOnFailure: true, textLength: 10 }), 'ok');
  assert.equal(d({ viaArchive: true, explicitSnapshot: false, stubOnFailure: true, textLength: 313 }), 'stub');
  assert.equal(d({ viaArchive: true, explicitSnapshot: false, stubOnFailure: false, textLength: 313 }), 'refuse');
  assert.equal(d({ viaArchive: false, explicitSnapshot: true, stubOnFailure: true, textLength: 313 }), 'refuse');
  assert.equal(d({ viaArchive: true, explicitSnapshot: false, stubOnFailure: true, textLength: 4000 }), 'ok');
});
