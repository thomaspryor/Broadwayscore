import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateOverrides, applyStopOverrides, applyAllOverrides } = require('./tour-stop-overrides.js');

const doc = JSON.parse(fs.readFileSync(new URL('../../data/tour-stop-overrides.json', import.meta.url), 'utf8'));
const fetched = [
  { city: 'Washington, DC', venue: 'National Theatre', start: '2026-11-24', end: '2026-11-29' },
  { city: 'Norfolk, VA', venue: 'Chrysler Hall', start: '2026-12-08', end: '2026-12-13' },
];

test('shipped overrides file is valid', () => assert.deepEqual(validateOverrides(doc), []));

test('a re-fetched (raw) schedule gets the manual date fix back', () => {
  const out = applyStopOverrides('hells-kitchen-tour-2025', fetched, doc.overrides);
  assert.equal(out[0].end, '2026-12-06');
  assert.deepEqual(out[1], fetched[1]);
  assert.equal(fetched[0].end, '2026-11-29', 'input not mutated');
});

test('other tours are untouched and re-applying is idempotent', () => {
  assert.deepEqual(applyStopOverrides('other-tour', fetched, doc.overrides), fetched);
  const once = applyStopOverrides('hells-kitchen-tour-2025', fetched, doc.overrides);
  assert.deepEqual(applyStopOverrides('hells-kitchen-tour-2025', once, doc.overrides), once);
});

test('overriding start still matches on the next fetch and after', () => {
  const ov = [{ tourId: 't', start: '2026-01-01', set: { start: '2026-01-02' }, was: { start: '2026-01-01' }, reason: 'x' }];
  const s = [{ city: 'A', venue: 'V', start: '2026-01-01', end: '2026-01-05' }];
  const once = applyStopOverrides('t', s, ov);
  assert.equal(once[0].start, '2026-01-02');
  assert.deepEqual(applyStopOverrides('t', once, ov), once);
});

test('applyAllOverrides reports only changed tours', () => {
  const tours = { 'hells-kitchen-tour-2025': { stops: structuredClone(fetched) }, b: { stops: structuredClone(fetched) } };
  assert.deepEqual(applyAllOverrides(tours, doc.overrides), ['hells-kitchen-tour-2025']);
  assert.deepEqual(applyAllOverrides(tours, doc.overrides), []);
});

test('validation rejects bad entries', () => {
  assert.ok(validateOverrides({ overrides: [{ tourId: 't', start: 'x', set: { foo: 1 } }] }).length >= 3);
  assert.ok(validateOverrides({}).length);
});

test('upstream correcting the date itself is drift: override skipped and reported', () => {
  const fixedUpstream = [{ ...fetched[0], end: '2026-12-13' }];
  const seen = [];
  const out = applyStopOverrides('hells-kitchen-tour-2025', fixedUpstream, doc.overrides, r => seen.push(r.status));
  assert.equal(out[0].end, '2026-12-13');
  assert.deepEqual(seen, ['drifted']);
});

test('an override whose stop vanished is reported unmatched', () => {
  const seen = [];
  applyStopOverrides('hells-kitchen-tour-2025', [fetched[1]], doc.overrides, r => seen.push(r.status));
  assert.deepEqual(seen, ['unmatched']);
});

test('colliding or chained overrides are rejected', () => {
  const a = { tourId: 't', start: '2026-01-01', set: { start: '2026-01-02' }, was: { start: '2026-01-01' }, reason: 'x' };
  const b = { tourId: 't', start: '2026-01-02', set: { end: '2026-01-09' }, was: { end: '2026-01-05' }, reason: 'x' };
  assert.ok(validateOverrides({ overrides: [a, b] }).some(e => /collides/.test(e)));
});
