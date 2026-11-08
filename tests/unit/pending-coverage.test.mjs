// BRO-7163 F11: a pending file that can never go live must not suppress a URL-less citation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { trackedPendingFiles } = require('../../scripts/lib/pending-coverage.js');

test('only no-byline strands count as tracked', () => {
  const files = [
    { name: 'a--1.json', rec: { pendingReason: 'no-byline' } },
    { name: 'b--2.json', rec: { pendingReason: 'date_implausible' } },
    { name: 'c--3.json', rec: { pendingReason: 'cross_market_contamination' } },
    { name: 'd--4.json', rec: { pendingReason: 'recreated_previously_excluded_url' } },
    { name: 'e--5.json', rec: null },
    { name: 'f--6.json', rec: {} },
  ];
  assert.deepEqual(trackedPendingFiles(files).map((f) => f.name), ['a--1.json']);
});

test('the audit wires its pending-outlet set through the helper (no filename-only pending set)', () => {
  const src = fs.readFileSync(new URL('../../scripts/audit-show-review-gap.js', import.meta.url), 'utf8');
  assert.match(src, /trackedPendingFiles\(pendingFiles\)/);
  assert.doesNotMatch(src, /pendingOutlets = new Set\(fs\.readdirSync\(pendingDir\)/);
});
