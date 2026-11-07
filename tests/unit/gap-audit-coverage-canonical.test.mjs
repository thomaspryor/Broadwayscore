/**
 * Guards audit-show-review-gap.js `isCoveredFile`, which decides whether a dir file
 * "covers" an aggregator-listed review.
 *
 * Rationale (Notion 386637c5-416f-81b9 follow-up): the old logic counted a file as
 * covered when classifyShowFile()==='clean' — which only checked the wrong-production,
 * wrong-show, duplicate, and roundup flags. An empty-body / stub file carries none of those
 * flags, so it read as 'clean' and the gap audit treated the review as covered — even
 * though rebuild excludes it for low content-tier. Glengarry WE's empty Times review hit
 * exactly this hole. isCoveredFile now delegates to the canonical isIncludableForRebuild,
 * so "covered" == "rebuild would include it" by definition. This freezes that contract.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isCoveredFile, classifyShowFile } = require('../../scripts/audit-show-review-gap.js');

const show = {
  id: 'glengarry-glen-ross-west-end-2026',
  category: 'west-end',
  previewsStartDate: '2026-06-04',
  openingDate: '2026-06-17',
  closingDate: '2026-07-18',
};

describe('gap audit canonical coverage', () => {
  test('empty-body in-window file is NOT counted as covered', () => {
    const empty = { _file: 'times-uk--clive-davis.json', url: 'https://www.thetimes.com/x', publishDate: '2026-06-18', fullText: '', contentTier: 'stub' };
    assert.equal(isCoveredFile(empty, show), false);
  });

  test('full-body in-window review IS counted as covered', () => {
    const full = {
      _file: 'times-uk--clive-davis.json',
      url: 'https://www.thetimes.com/x',
      publishDate: '2026-06-18',
      fullText: 'x'.repeat(2000),
      contentTier: 'complete',
      manualContentTier: 'complete',
    };
    assert.equal(isCoveredFile(full, show), true);
  });

  test('wrongProduction file is not covered', () => {
    const wp = { _file: 'guardian--x.json', url: 'https://www.theguardian.com/x', publishDate: '2026-06-18', fullText: 'x'.repeat(2000), wrongProduction: true };
    assert.equal(isCoveredFile(wp, show), false);
  });

  test('classifyShowFile labels an empty-body file as emptyBody (reporting)', () => {
    assert.equal(classifyShowFile({ fullText: '', contentTier: 'stub' }), 'emptyBody');
    assert.equal(classifyShowFile({ fullText: 'x'.repeat(2000) }), 'clean');
  });
});
