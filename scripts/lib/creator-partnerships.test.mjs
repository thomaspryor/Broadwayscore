import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  VALID_STATUSES,
  loadPartnerships,
  loadCreators,
  joinPartnershipsWithCreators,
  summarizeByStatus,
} = require('./creator-partnerships.js');

describe('joinPartnershipsWithCreators', () => {
  test('merges partnership status onto creator identity fields', () => {
    const partnerships = [
      { creatorId: 'a', status: 'active', notes: 'sent contract', lastContactedAt: '2026-08-01' },
    ];
    const creators = [
      { id: 'a', name: 'Creator A', primaryPlatform: 'tiktok', subscribers: '10K' },
    ];
    const result = joinPartnershipsWithCreators(partnerships, creators);
    assert.strictEqual(result.length, 1);
    assert.deepStrictEqual(result[0], {
      creatorId: 'a',
      name: 'Creator A',
      primaryPlatform: 'tiktok',
      subscribers: '10K',
      status: 'active',
      notes: 'sent contract',
      lastContactedAt: '2026-08-01',
    });
  });

  test('drops partnerships referencing an unknown creatorId', () => {
    const partnerships = [{ creatorId: 'ghost', status: 'prospect', notes: null, lastContactedAt: null }];
    const result = joinPartnershipsWithCreators(partnerships, []);
    assert.deepStrictEqual(result, []);
  });

  test('defaults missing notes/lastContactedAt to null', () => {
    const partnerships = [{ creatorId: 'a', status: 'prospect' }];
    const creators = [{ id: 'a', name: 'Creator A', primaryPlatform: 'youtube', subscribers: null }];
    const result = joinPartnershipsWithCreators(partnerships, creators);
    assert.strictEqual(result[0].notes, null);
    assert.strictEqual(result[0].lastContactedAt, null);
  });
});

describe('summarizeByStatus', () => {
  test('counts every valid status, including zero counts', () => {
    const summary = summarizeByStatus([{ status: 'prospect' }, { status: 'prospect' }, { status: 'active' }]);
    assert.deepStrictEqual(summary, {
      prospect: 2,
      contacted: 0,
      active: 1,
      declined: 0,
      inactive: 0,
    });
  });

  test('ignores unrecognized status values rather than throwing', () => {
    const summary = summarizeByStatus([{ status: 'bogus' }]);
    assert.strictEqual(Object.values(summary).reduce((a, b) => a + b, 0), 0);
  });
});

describe('data file shape (real files, catches schema drift)', () => {
  test('every partnership creatorId resolves against video-creators.json', () => {
    const partnerships = loadPartnerships();
    const creators = loadCreators();
    const joined = joinPartnershipsWithCreators(partnerships, creators);
    assert.strictEqual(
      joined.length,
      partnerships.length,
      'a partnership row references a creatorId missing from data/video-creators.json'
    );
  });

  test('every partnership status is one of VALID_STATUSES', () => {
    const partnerships = loadPartnerships();
    for (const p of partnerships) {
      assert.ok(VALID_STATUSES.includes(p.status), `unexpected status "${p.status}" for ${p.creatorId}`);
    }
  });
});
