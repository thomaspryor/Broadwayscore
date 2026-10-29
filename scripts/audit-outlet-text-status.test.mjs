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
