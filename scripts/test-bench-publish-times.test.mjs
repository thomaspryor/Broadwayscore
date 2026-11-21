// BRO-7167: pure parts of the test-bench publish-time collector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractPublishTime, precisionOf, nightRow, keepPrevious } = require('./test-bench-publish-times.js');

test('extracts published_time in either attribute order, then JSON-LD, then <time>', () => {
  assert.deepEqual(extractPublishTime('<meta property="article:published_time" content="2026-10-30T03:00:00+00:00">'), { value: '2026-10-30T03:00:00+00:00', source: 'article:published_time' });
  assert.equal(extractPublishTime('<meta content="2026-04-23T21:30:13-04:00" property="article:published_time" />').value, '2026-04-23T21:30:13-04:00');
  assert.equal(extractPublishTime('<script>{"datePublished": "2026-04-24T01:30:00Z"}</script>').source, 'json-ld datePublished');
  assert.equal(extractPublishTime('<time datetime="2026-04-24">Apr 24</time>').value, '2026-04-24');
  assert.deepEqual(extractPublishTime(''), { value: null, source: null });
});

test('precision: exact needs a zone, a bare clock time is assumed-zone, a date is date', () => {
  assert.equal(precisionOf('2026-10-30T03:00:00+00:00'), 'exact');
  assert.equal(precisionOf('2026-10-30T03:00:00'), 'assumed-zone');
  assert.equal(precisionOf('2026-10-30'), 'date');
  assert.equal(precisionOf(null), null);
});

test('night row marks a corrected embargo and counts fetch failures', () => {
  const show = { id: 'x', title: 'X', category: 'broadway', openingDate: '2026-10-29' };
  const rows = ['A', 'B', 'C'].map((o) => ({ outlet: o, publishedTime: '2026-10-30T03:00:00Z', precision: 'exact', status: 200 }))
    .concat([{ outlet: 'D', publishedTime: null, precision: null, status: 403 }]);
  const r = nightRow({ show, pressNight: { embargoAt: '2026-10-30T02:00:00Z' }, rows, collectedAt: 't' });
  assert.equal(r.estimate.from, 'press-night record');
  assert.equal(r.observed.at, '2026-10-30T03:00:00.000Z');
  assert.equal(r.embargoCorrected, true);
  assert.equal(r.fetchFailed, 1);
  const est = nightRow({ show, pressNight: null, rows: [], collectedAt: 't' });
  assert.equal(est.estimate.at, '2026-10-30T02:00:00.000Z'); // 22:00 EDT
  assert.equal(est.embargoCorrected, false);
});

test('keepPrevious: a blocked re-run keeps the earlier night, a working one replaces it', () => {
  const prev = { observed: { source: 'observed-cluster' } };
  assert.equal(keepPrevious(prev, [{ status: 403 }, { status: 'timeout' }]), true);
  assert.equal(keepPrevious(prev, []), true);
  assert.equal(keepPrevious(prev, [{ status: 403 }, { status: 200 }]), false);
  assert.equal(keepPrevious(undefined, [{ status: 403 }]), false);
});
