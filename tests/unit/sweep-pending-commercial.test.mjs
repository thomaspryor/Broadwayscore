// Unit tests for sweep-pending-commercial.js classifyEntry (BRO-4990).
// Requires the real function (CLAUDE.md §15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { classifyEntry } = require('../../scripts/sweep-pending-commercial');

const shows = { a: { slug: 'a', category: 'broadway', openingDate: '2021-10-01' } };
const old = new Date(Date.now() - 400 * 86_400_000).toISOString();

describe('classifyEntry', () => {
  it('archives an unheld low-confidence row past the age limit', () => {
    assert.equal(classifyEntry('a', { confidence: 'low', researchedAt: old, openingDate: '2021-10-01' }, shows).action, 'archive');
  });

  // Ship-check P1: archiving a held backfill row dropped its attempt count,
  // so the Saturday sweep re-researched the show every ~180 days forever.
  it('keeps a held backfill row (and a noData attempt record) however old', () => {
    for (const extra of [{}, { noData: true }]) {
      const entry = { confidence: 'low', researchedAt: old, openingDate: '2021-10-01', requiresHumanReview: true, backfill: 'BRO-4990', ...extra };
      assert.equal(classifyEntry('a', entry, shows).action, 'keep');
    }
  });

  it('still archives an out-of-scope row even when held', () => {
    const ob = { b: { slug: 'b', category: 'off-broadway', openingDate: '2021-10-01' } };
    assert.equal(classifyEntry('b', { confidence: 'low', researchedAt: old, requiresHumanReview: true }, ob).action, 'archive');
  });
});
