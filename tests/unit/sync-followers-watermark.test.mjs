// BRO-3514: sync-followers.js stamped `lastSynced` (the next run's Formspree
// `since`) at SAVE time, so a signup arriving between fetch and save — or one
// fetched only by the run that lost a race to push core data — was never
// fetched again. The watermark is now the fetch start minus an overlap, and
// it does not move at all after a failed or partial (newest-pages-only) fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const https = require('https');
const { fetchAllSubmissions, nextSyncWatermark, SYNC_WATERMARK_OVERLAP_MS } = require('../../scripts/sync-followers.js');

const START = Date.parse('2026-10-13T12:00:00Z');

test('a complete fetch moves the watermark to fetch start minus the overlap, never to "now"', () => {
  const w = nextSyncWatermark('2026-10-12T00:00:00.000Z', START, { items: [], complete: true });
  assert.equal(w, new Date(START - SYNC_WATERMARK_OVERLAP_MS).toISOString());
  assert.ok(SYNC_WATERMARK_OVERLAP_MS >= 5 * 60_000, 'overlap must cover clock skew');
});

test('a failed or partial fetch keeps the previous watermark', () => {
  const prev = '2026-10-12T00:00:00.000Z';
  assert.equal(nextSyncWatermark(prev, START, null), prev);
  assert.equal(nextSyncWatermark(prev, START, { items: [{}], complete: false }), prev);
  assert.equal(nextSyncWatermark(null, START, { items: [{}], complete: false }), null, 'first run stays a full fetch');
});

function stubFormspree(pages) {
  const original = https.request;
  let call = 0;
  https.request = (options, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req; // real ClientRequest API; sync-followers arms an idle timeout (BRO-3840)
    req.end = () => {
      const page = pages[call++];
      const res = new EventEmitter();
      res.statusCode = page instanceof Error ? 500 : 200;
      setImmediate(() => {
        cb(res);
        res.emit('data', page instanceof Error ? 'boom' : JSON.stringify({ submissions: page }));
        res.emit('end');
      });
    };
    return req;
  };
  return () => { https.request = original; };
}

const page = (n, tag) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@example.org` }));

test('fetchAllSubmissions marks a mid-pagination failure as incomplete (the oldest pages are missing)', async () => {
  const restore = stubFormspree([page(100, 'new'), new Error('500')]);
  try {
    const r = await fetchAllSubmissions('form', 'tok', null);
    assert.equal(r.items.length, 100);
    assert.equal(r.complete, false);
    assert.equal(nextSyncWatermark('2026-10-01T00:00:00.000Z', START, r), '2026-10-01T00:00:00.000Z');
  } finally { restore(); }
});

test('fetchAllSubmissions: full pagination is complete; a first-page failure is null', async () => {
  let restore = stubFormspree([page(100, 'a'), page(3, 'b')]);
  try {
    const r = await fetchAllSubmissions('form', 'tok', null);
    assert.deepEqual([r.items.length, r.complete], [103, true]);
  } finally { restore(); }
  restore = stubFormspree([new Error('500')]);
  try {
    assert.equal(await fetchAllSubmissions('form', 'tok', null), null);
  } finally { restore(); }
});
