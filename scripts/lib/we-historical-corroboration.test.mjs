import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordsAgree, isCorroborated } = require('./we-historical-corroboration.js');

test('recordsAgree: exact match', () => {
  const a = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  const b = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  assert.equal(recordsAgree(a, b), true);
});

test('recordsAgree: tolerates opening-date drift within the window (preview vs press night)', () => {
  const a = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' };
  const b = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-23' };
  assert.equal(recordsAgree(a, b), true);
});

test('recordsAgree: rejects opening dates outside the window', () => {
  const a = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' };
  const b = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2025-01-15' };
  assert.equal(recordsAgree(a, b), false);
});

test('recordsAgree: rejects venue mismatch (same title, different production)', () => {
  const a = { title: 'Cats', venue: 'London Palladium', openingDate: '2024-06-01' };
  const b = { title: 'Cats', venue: 'New Wimbledon Theatre', openingDate: '2024-06-05' };
  assert.equal(recordsAgree(a, b), false);
});

test('recordsAgree: rejects title mismatch', () => {
  const a = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  const b = { title: 'The Cherry Orchard', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  assert.equal(recordsAgree(a, b), false);
});

test('recordsAgree: fails closed when either side is missing an opening date (title+venue alone is not enough — venues restage the same title years apart)', () => {
  const a = { title: 'Cats', venue: 'London Palladium', openingDate: null };
  const b = { title: 'Cats', venue: 'London Palladium', openingDate: '2019-06-01' };
  assert.equal(recordsAgree(a, b), false);
  assert.equal(recordsAgree(b, a), false);
});

test('recordsAgree: normalizes accents/case in title and venue', () => {
  const a = { title: 'JUNO AND THE PAYCOCK', venue: 'gielgud theatre', openingDate: '2024-10-03' };
  const b = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' };
  assert.equal(recordsAgree(a, b), true);
});

test('isCorroborated: 2 independent sources agreeing → corroborated', () => {
  const candidate = { title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03', discoverySource: 'theatre-record' };
  const sources = [
    { source: 'wikipedia', title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-03' },
    { source: 'olivier-eligibility', title: 'Juno and the Paycock', venue: 'Gielgud Theatre', openingDate: '2024-10-07' },
  ];
  const result = isCorroborated(candidate, sources);
  assert.equal(result.corroborated, true);
  assert.deepEqual(result.agreeingSources.sort(), ['olivier-eligibility', 'wikipedia']);
});

test('isCorroborated: only 1 independent source agreeing → NOT corroborated', () => {
  const candidate = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30', discoverySource: 'theatre-record' };
  const sources = [
    { source: 'wikipedia', title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' },
  ];
  const result = isCorroborated(candidate, sources);
  assert.equal(result.corroborated, false);
});

test('isCorroborated: TR self-agreement does NOT count toward the threshold (circularity guard)', () => {
  const candidate = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30', discoverySource: 'theatre-record' };
  const sources = [
    { source: 'theatre-record', title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' },
    { source: 'wikipedia', title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' },
  ];
  const result = isCorroborated(candidate, sources);
  assert.equal(result.corroborated, false);
  assert.deepEqual(result.agreeingSources, ['wikipedia']);
});

test('isCorroborated: same source listed twice counts once, not twice', () => {
  const candidate = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' };
  const sources = [
    { source: 'wikipedia', title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' },
    { source: 'wikipedia', title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-31' },
  ];
  const result = isCorroborated(candidate, sources);
  assert.equal(result.corroborated, false);
  assert.equal(result.agreeingSources.length, 1);
});

test('isCorroborated: irrelevant sources (different show) do not falsely corroborate', () => {
  const candidate = { title: 'Barcelona', venue: 'Donmar Warehouse', openingDate: '2024-10-30' };
  const sources = [
    { source: 'wikipedia', title: 'The Cherry Orchard', venue: 'Donmar Warehouse', openingDate: '2024-10-30' },
    { source: 'olivier-eligibility', title: 'Barcelona', venue: 'Royal Court', openingDate: '2024-10-30' },
  ];
  const result = isCorroborated(candidate, sources);
  assert.equal(result.corroborated, false);
});
