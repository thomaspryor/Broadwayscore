/** BRO-6486: --zero-char-hosts flags a host whose recent files all hold 0 chars. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { zeroCharHosts, urlShape } = require('./audit-outlet-text-status.js');

const NOW = Date.parse('2026-10-29T00:00:00Z');
const row = (url, chars, firstSeenAt = '2026-10-27T00:00:00Z', extra = {}) =>
  ({ show: 's', file: 'f.json', outletId: 'o', url, chars, firstSeenAt, excludedBy: null, urlShape: urlShape(url), ...extra });

test('flags a host whose three recent files are all empty', () => {
  const rows = [1, 2, 3].map((i) => row(`https://exeuntnyc.com/reviews/r${i}/attachment/p${i}/`, 0));
  const out = zeroCharHosts(rows, 30, NOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].host, 'exeuntnyc.com');
  assert.deepEqual(out[0].urlShapes, ['wp-attachment']);
  assert.equal(out[0].silent, 3);
  assert.deepEqual(out[0].byLastFailure, { none: 3 });
});

test('counts null, none and not_attempted as silent and reports logged failures separately', () => {
  const reasons = [null, 'none', 'not_attempted', 'url_dead_404', 'garbage_content'];
  const rows = reasons.map((lastFailure, i) => row(`https://mixed.com/${i}`, 0, undefined, { lastFailure }));
  const [out] = zeroCharHosts(rows, 30, NOW);
  assert.equal(out.files, 5);
  assert.equal(out.silent, 3);
  assert.deepEqual(out.byLastFailure, { none: 2, not_attempted: 1, url_dead_404: 1, garbage_content: 1 });
});

test('hosts with only logged failures do not alert, regardless of failure type', () => {
  const rows = ['newjerseynewsroom.com', 'online.wsj.com', 'theepochtimes.com', 'womanaroundtown.com']
    .flatMap((host) => ['url_dead_404', 'garbage_content', 'url_content_mismatch', 'partial_text']
      .map((lastFailure, i) => row(`https://${host}/${i}`, 0, undefined, { lastFailure })));
  assert.deepEqual(zeroCharHosts(rows, 30, NOW), []);
});

test('silent rows must be a strict majority of the recent zero-char files', () => {
  for (const reasons of [
    [null, 'url_dead_404', 'partial_text'],
    [null, 'not_attempted', 'url_dead_404', 'partial_text'],
  ]) {
    const rows = reasons.map((lastFailure, i) => row(`https://known.com/${i}`, 0, undefined, { lastFailure }));
    assert.deepEqual(zeroCharHosts(rows, 30, NOW), []);
  }
});

test('old and excluded rows do not affect the failure breakdown or silent majority', () => {
  const rows = [1, 2, 3].map((i) => row(`https://silent.com/${i}`, 0));
  rows.push(row('https://www.silent.com/old', 0, '2025-01-01T00:00:00Z', { lastFailure: 'url_dead_404' }));
  rows.push(row('https://silent.com/excluded', 0, undefined, { excludedBy: 'wrongShow', lastFailure: 'partial_text' }));
  const [out] = zeroCharHosts(rows, 30, NOW);
  assert.equal(out.files, 3);
  assert.equal(out.silent, 3);
  assert.deepEqual(out.byLastFailure, { none: 3 });
});

test('one readable recent file clears the host', () => {
  const rows = [row('https://a.com/1', 0), row('https://a.com/2', 0), row('https://a.com/3', 4200)];
  assert.equal(zeroCharHosts(rows, 30, NOW).length, 0);
});

test('old files, excluded files and too few files do not count', () => {
  const rows = [
    row('https://b.com/1', 0, '2025-01-01T00:00:00Z'), row('https://b.com/2', 0, '2025-01-01T00:00:00Z'), row('https://b.com/3', 0),
    row('https://c.com/1', 0), row('https://c.com/2', 0), row('https://c.com/3', 0, undefined, { excludedBy: 'duplicateOf' }),
  ];
  assert.equal(zeroCharHosts(rows, 30, NOW).length, 0);
});
