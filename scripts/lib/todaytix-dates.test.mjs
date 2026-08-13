import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyTodayTixStartDate,
  unconfirmedStartFlags,
  productionIdYear,
  TODAYTIX_TRUSTED_START_WINDOW_DAYS,
} = require('./todaytix-dates.js');

const NOW = Date.parse('2026-08-12T12:00:00Z');
const q = (d) => classifyTodayTixStartDate(d, 'Test Show', { now: NOW, quiet: true });
const daysOut = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);

test('inside the trust window → previewsStartDate, nothing quarantined', () => {
  const r = q(daysOut(30));
  assert.equal(r.previewsStartDate, daysOut(30));
  assert.equal(r.unconfirmedStartDate, null);
});

test('a past date is still trusted (a running show, not a recycled ID)', () => {
  const r = q('2026-06-01');
  assert.equal(r.previewsStartDate, '2026-06-01');
  assert.equal(r.unconfirmedStartDate, null);
});

test('beyond the trust window → quarantined, previewsStartDate stays null', () => {
  // The real 2027 Encores! dates: 174d, 216d and 258d out from 2026-08-12.
  for (const d of ['2027-02-03', '2027-03-17', '2027-04-28']) {
    const r = q(d);
    assert.equal(r.previewsStartDate, null, `${d} must not be trusted`);
    assert.equal(r.unconfirmedStartDate, d, `${d} must be kept, not dropped`);
  }
});

test('the window boundary is exclusive on the trusted side', () => {
  assert.equal(q(daysOut(TODAYTIX_TRUSTED_START_WINDOW_DAYS)).previewsStartDate, daysOut(TODAYTIX_TRUSTED_START_WINDOW_DAYS));
  assert.equal(q(daysOut(TODAYTIX_TRUSTED_START_WINDOW_DAYS + 2)).unconfirmedStartDate, daysOut(TODAYTIX_TRUSTED_START_WINDOW_DAYS + 2));
});

test('a quarantined date promotes itself once time passes — no separate pass', () => {
  // Same input date, evaluated 6 months later: Feb 3 2027 is 174d out from
  // Aug 2026 (quarantined) but 26d out from Jan 2027 (trusted). This is the
  // whole reason the window is relative to "now" rather than stamped once.
  const later = Date.parse('2027-01-08T12:00:00Z');
  const r = classifyTodayTixStartDate('2027-02-03', 'Encores! Charlie Brown', { now: later, quiet: true });
  assert.equal(r.previewsStartDate, '2027-02-03');
  assert.equal(r.unconfirmedStartDate, null);
});

test('missing / unparseable input yields neither field', () => {
  for (const bad of [null, undefined, '', 'null', 'not-a-date']) {
    const r = q(bad);
    assert.equal(r.previewsStartDate, null, `${JSON.stringify(bad)} → no previewsStartDate`);
    assert.equal(r.unconfirmedStartDate, null, `${JSON.stringify(bad)} → nothing quarantined`);
  }
});

test('unconfirmedStartFlags carries the date and nothing else', () => {
  assert.deepEqual(unconfirmedStartFlags('2027-02-03'), { unconfirmedStartDate: '2027-02-03' });
});

test('unconfirmedStartFlags must NOT set provisional', () => {
  // Regression guard (second-opinion review 2026-08-12): `provisional` means
  // venue/classification confidence (validate-data.js:529), and
  // validate-show-venue.js:110 turns it into a Playbill cross-check that
  // test.yml runs as a BLOCKING --fail-on-mismatch gate. A show whose Playbill
  // page won't exist for months would fail it on every push until opening.
  const flags = unconfirmedStartFlags('2027-02-03');
  assert.equal('provisional' in flags, false);
  assert.equal('discoverySource' in flags, false);
});

test('unconfirmedStartFlags normalizes to YYYY-MM-DD (ids become file paths)', () => {
  assert.deepEqual(unconfirmedStartFlags('02/03/2027'), { unconfirmedStartDate: '2027-02-03' });
  assert.deepEqual(unconfirmedStartFlags('2027-02-03T20:00:00Z'), { unconfirmedStartDate: '2027-02-03' });
});

test('unconfirmedStartFlags is empty when there is nothing quarantined', () => {
  assert.deepEqual(unconfirmedStartFlags(null), {});
  assert.deepEqual(unconfirmedStartFlags(undefined), {});
  assert.deepEqual(unconfirmedStartFlags('not-a-date'), {});
});

test('productionIdYear prefers openingDate, then previews, then the quarantined date', () => {
  assert.equal(productionIdYear({ openingDate: '2027-02-03', previewsStartDate: '2026-01-01', unconfirmedStartDate: '2025-01-01' }), '2027');
  assert.equal(productionIdYear({ openingDate: null, previewsStartDate: '2026-11-01', unconfirmedStartDate: '2027-02-03' }), '2026');
  assert.equal(productionIdYear({ openingDate: null, previewsStartDate: null, unconfirmedStartDate: '2027-02-03' }), '2027');
});

test('productionIdYear returns null (never a non-year string) when no date is usable', () => {
  assert.equal(productionIdYear({}), null);
  assert.equal(productionIdYear({ openingDate: null, previewsStartDate: null, unconfirmedStartDate: null }), null);
  assert.equal(productionIdYear({ unconfirmedStartDate: 'not-a-date' }), null);
  // A non-ISO input must still yield exactly 4 digits, never "02/03/2027".
  assert.match(productionIdYear({ unconfirmedStartDate: '02/03/2027' }), /^\d{4}$/);
});
