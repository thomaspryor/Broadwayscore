/**
 * Unit tests for scripts/lib/bulk-import-preflight.js.
 *
 * Notion 362637c5-416f-81ee — the orchestrator must refuse a batch when any
 * input show-id is missing from shows.json or has null/empty category/market.
 * Tests pin the contract; production wiring lives in run-bulk-historical-import.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkShowsJsonMetadata } = require('../../scripts/lib/bulk-import-preflight');

describe('checkShowsJsonMetadata — happy path', () => {
  it('passes when every id has category + market', () => {
    const shows = [
      { id: 'evita-west-end-2025', category: 'west-end', market: 'west-end' },
      { id: 'hadestown-bway-2019', category: 'broadway', market: 'broadway' },
    ];
    const result = checkShowsJsonMetadata(shows, ['evita-west-end-2025', 'hadestown-bway-2019']);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.missing, []);
    assert.deepStrictEqual(result.nullCategory, []);
    assert.deepStrictEqual(result.nullMarket, []);
  });

  it('passes when off-broadway / off-west-end are correctly tagged', () => {
    const shows = [
      { id: 'ob-show', category: 'off-broadway', market: 'broadway' },
      { id: 'owe-show', category: 'off-west-end', market: 'west-end' },
    ];
    const result = checkShowsJsonMetadata(shows, ['ob-show', 'owe-show']);
    assert.strictEqual(result.ok, true);
  });

  it('passes on an empty id list (no-op preflight)', () => {
    const result = checkShowsJsonMetadata([{ id: 'x', category: 'broadway', market: 'broadway' }], []);
    assert.strictEqual(result.ok, true);
  });
});

describe('checkShowsJsonMetadata — rejects gaps', () => {
  it('reports ids not in shows.json', () => {
    const shows = [{ id: 'present', category: 'broadway', market: 'broadway' }];
    const result = checkShowsJsonMetadata(shows, ['present', 'missing-a', 'missing-b']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.missing, ['missing-a', 'missing-b']);
    assert.deepStrictEqual(result.nullCategory, []);
    assert.deepStrictEqual(result.nullMarket, []);
  });

  it('reports null category', () => {
    const shows = [{ id: 'schmig', category: null, market: 'broadway' }];
    const result = checkShowsJsonMetadata(shows, ['schmig']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.nullCategory, ['schmig']);
  });

  it('reports empty-string category', () => {
    const shows = [{ id: 'schmig', category: '', market: 'broadway' }];
    const result = checkShowsJsonMetadata(shows, ['schmig']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.nullCategory, ['schmig']);
  });

  it('reports missing category field', () => {
    const shows = [{ id: 'schmig', market: 'broadway' }];
    const result = checkShowsJsonMetadata(shows, ['schmig']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.nullCategory, ['schmig']);
  });

  it('reports null market', () => {
    const shows = [{ id: 'schmig', category: 'broadway', market: null }];
    const result = checkShowsJsonMetadata(shows, ['schmig']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.nullMarket, ['schmig']);
  });

  it('reports null category AND null market on the same id', () => {
    const shows = [{ id: 'schmig', category: null, market: null }];
    const result = checkShowsJsonMetadata(shows, ['schmig']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.nullCategory, ['schmig']);
    assert.deepStrictEqual(result.nullMarket, ['schmig']);
  });

  it('partitions gaps across many ids', () => {
    const shows = [
      { id: 'a', category: 'broadway', market: 'broadway' },        // ok
      { id: 'b', category: null,       market: 'broadway' },        // null category
      { id: 'c', category: 'west-end', market: null      },         // null market
      // d intentionally not in shows.json
    ];
    const result = checkShowsJsonMetadata(shows, ['a', 'b', 'c', 'd']);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.missing, ['d']);
    assert.deepStrictEqual(result.nullCategory, ['b']);
    assert.deepStrictEqual(result.nullMarket, ['c']);
  });
});
