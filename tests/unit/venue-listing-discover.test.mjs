// Per-venue fixture tests for scripts/lib/venue-listing-discover.js.
//
// Fixtures captured live 2026-05-26 (see tests/fixtures/ob-discovery/).
// Subagent baseline counts: Atlantic 6, Vineyard 2, Signature 14, MCC 5.
//
// Why: ship-check QA reviewer flagged the lib as untested, and the
// pre-mortem PRIMARY scenario is "Atlantic banner-class reuse leaks
// phantom shows past the gate." A fixture test catches selector rot
// before it ships — if the parser starts returning 14 from a 6-baseline
// fixture, the test fails and a real reviewer can decide whether the
// fixture is stale or the parser regressed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OB_VENUE_CONFIGS, parseVenueListingHtml } = require('../../scripts/lib/venue-listing-discover.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'ob-discovery');

// Subagent-verified counts from /tmp/ob-venue-playwright-findings.md.
// expectedMin = an absolute floor; expectedMax catches selector-leak
// regressions (e.g. Atlantic banner showing 14 phantoms). Bands tolerate
// minor venue-page changes without false-failing the test.
const EXPECTED = {
  'Atlantic Theater':  { min: 4,  max: 10, mustInclude: ['indian-princesses', 'reservoir'] },
  'Vineyard Theatre':  { min: 1,  max: 6,  mustInclude: ['girls', 'msblackforpresident'] },
  'Signature Theatre': { min: 5,  max: 20, mustInclude: ['animal-wisdom', 'king-of-the-yees', 'miles-for-mary'] },
  'MCC Theater':       { min: 3,  max: 12, mustInclude: ['birthright', 'cold-war-choir-practice'] },
};

for (const venue of OB_VENUE_CONFIGS) {
  const slug = venue.name.toLowerCase().replace(/\s+/g, '-');
  const fixturePath = join(FIXTURE_DIR, slug + '.html');
  const expected = EXPECTED[venue.name];

  test(`${venue.name}: fixture parses to band ${expected.min}..${expected.max}`, () => {
    if (!existsSync(fixturePath)) {
      assert.fail(`fixture missing: ${fixturePath} — capture via scripts/smoke-ob-discovery.js`);
    }
    const html = readFileSync(fixturePath, 'utf8');
    const candidates = parseVenueListingHtml(venue, html);

    assert.ok(candidates.length >= expected.min,
      `${venue.name}: got ${candidates.length} candidates, expected >=${expected.min}. Titles: ${candidates.map(c => c.title).join(', ')}`);
    assert.ok(candidates.length <= expected.max,
      `${venue.name}: got ${candidates.length} candidates, expected <=${expected.max}. Selector may be leaking — titles: ${candidates.map(c => c.title).join(', ')}`);

    // Each "must include" slug must appear in at least one candidate's slug.
    const allSlugs = candidates.map(c => c.slug).join(' | ');
    for (const required of expected.mustInclude) {
      assert.ok(
        candidates.some(c => c.slug.includes(required)),
        `${venue.name}: expected a candidate with slug containing "${required}", got slugs: ${allSlugs}`
      );
    }
  });

  test(`${venue.name}: parser rejects empty html`, () => {
    assert.deepEqual(parseVenueListingHtml(venue, ''), []);
    assert.deepEqual(parseVenueListingHtml(venue, '<html></html>'), []);
  });
}
