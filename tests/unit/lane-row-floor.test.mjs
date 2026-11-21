/**
 * BRO-7646: a rebuild that never synced the opening-night lease file must still keep the lane's
 * reviews.json rows until their texts reach review-texts (fetch-guardian-reviews wiped 20 Fantasticks
 * press-night rows on 2026-11-17).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { laneRowsToKeep } = require('../../scripts/lib/opening-night-lane/lane-row-floor.js');
const { PROVENANCE_KEY, PRODUCTION_VERIFIED } = require('../../scripts/lib/opening-night-lane/trust-model.js');

const shows = [{ id: 'show-a', openingDate: '2026-11-16' }, { id: 'show-b', openingDate: '2026-10-01' }];
const laneRow = (url, showId = 'show-a') => ({
  showId, url, outletId: url.split('/')[2], assignedScore: 80,
  productionVerified: PRODUCTION_VERIFIED,
  [PROVENANCE_KEY]: { show: showId, night: '2026-11-16', source: 'aggregator', seenAt: '2026-11-17T03:10:00Z' },
});
const ctx = (over = {}) => ({ shows, now: '2026-11-17T05:00:00Z', canonicalUrl: u => u.replace(/\/$/, ''), textFiles: () => [], ...over });

describe('laneRowsToKeep', () => {
  it('leaves a row to the rebuild when the outlet already has a text file at a variant URL', () => {
    const existing = [laneRow('https://nyt.example/a')];
    assert.equal(laneRowsToKeep(existing, [], ctx({ textFiles: () => [{ url: 'http://www.nyt.example/a?amp', outletId: 'nyt.example' }] })).length, 0);
  });

  it('keeps nothing revoked or rebuilt-style (laneSource, no provenance block)', () => {
    const revoked = { ...laneRow('https://nyt.example/a'), laneRevoked: true };
    const rebuiltStyle = { showId: 'show-a', url: 'https://nyt.example/b', outletId: 'nyt.example', assignedScore: 80, laneSource: 'aggregator' };
    assert.equal(laneRowsToKeep([revoked, rebuiltStyle], [], ctx()).length, 0);
  });

  it('keeps lane rows the rebuild dropped', () => {
    const existing = [laneRow('https://nyt.example/a'), laneRow('https://variety.example/a')];
    assert.equal(laneRowsToKeep(existing, [], ctx()).length, 2);
  });

  it('keeps nothing the rebuild already produced (same canonical URL)', () => {
    const existing = [laneRow('https://nyt.example/a/')];
    assert.equal(laneRowsToKeep(existing, [{ showId: 'show-a', url: 'https://nyt.example/a' }], ctx()).length, 0);
  });

  it('leaves a row to the rebuild once its text file exists, so exclusions apply', () => {
    const existing = [laneRow('https://nyt.example/a')];
    assert.equal(laneRowsToKeep(existing, [], ctx({ textFiles: () => [{ url: 'https://nyt.example/a' }] })).length, 0);
  });

  it('skips leased shows (the lease carry-over already keeps them) and non-lane rows', () => {
    const existing = [laneRow('https://nyt.example/a'), { showId: 'show-a', url: 'https://blog.example/x', assignedScore: 60 }];
    assert.equal(laneRowsToKeep(existing, [], ctx({ leasedShowIds: new Set(['show-a']) })).length, 0);
    assert.equal(laneRowsToKeep(existing, [], ctx()).length, 1);
  });

  it('expires: a row whose text never arrived is not kept past the floor window', () => {
    assert.equal(laneRowsToKeep([laneRow('https://nyt.example/a')], [], ctx({ now: '2026-11-19T12:00:00Z' })).length, 1);
    assert.equal(laneRowsToKeep([laneRow('https://nyt.example/a')], [], ctx({ now: '2026-11-21T00:00:01Z' })).length, 0);
  });

  it('skips a stamp for another night and a show gone from shows.json', () => {
    assert.equal(laneRowsToKeep([laneRow('https://nyt.example/b', 'show-b')], [], ctx()).length, 0);
    assert.equal(laneRowsToKeep([laneRow('https://nyt.example/c', 'show-z')], [], ctx()).length, 0);
  });
});
