// BRO-8447: Jermyn Street prints "19 November 2026 - 3 January 2027" (year on both ends).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseLondonEvidence, londonSources } = require('../../scripts/lib/london-venue-validation.js');

const page = (range) => `<html><body><main><h1>It's A Wonderful Life!</h1><p>${range} TICKETS</p><h2>Overview</h2></main></body></html>`;
const show = { title: 'It’s a Wonderful Life', venue: 'Jermyn Street Theatre', openingDate: '2026-11-24' };

describe('parseLondonEvidence date ranges', () => {
  it('reads a range with the year on both ends', () => {
    const ev = parseLondonEvidence(page('19 November 2026 - 3 January 2027'), show);
    assert.deepEqual(ev.dates, { openingDate: '2026-11-19', closingDate: '2027-01-03' });
  });
  it('still reads a range with the year only on the end', () => {
    const ev = parseLondonEvidence(page('28 Aug - 7 Nov 2026'), show);
    assert.deepEqual(ev.dates, { openingDate: '2026-08-28', closingDate: '2026-11-07' });
  });
  it('Jermyn Street Theatre is a validation source', () => {
    assert.ok(londonSources(show).includes('jermynstreettheatre.co.uk'));
  });
});
