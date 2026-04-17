import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { countBwwRrOutlets } = require('../../scripts/lib/bww-rr-scraper.js');

const fixtureHtml = fs.readFileSync(
  path.resolve(__dirname, '../fixtures/opening-night/bww-rr-giant-sample.html'),
  'utf8'
);

// Inline check runner so we can test the check logic without network calls
// (the check itself calls fetchPage which would require scraper setup)
// We test countBwwRrOutlets directly per §15 — the pure extraction function.

describe('bww-rr-scraper: countBwwRrOutlets', () => {
  it('parses articleBody format and returns correct review count', () => {
    const count = countBwwRrOutlets(fixtureHtml);
    // fear-of-13-2026 RR has 6 critics listed
    assert.ok(count >= 5 && count <= 8, `expected ~6 critics, got ${count}`);
  });

  it('returns 0 for empty/null HTML', () => {
    assert.equal(countBwwRrOutlets(''), 0);
    assert.equal(countBwwRrOutlets(null), 0);
  });

  it('returns 0 for HTML with no recognizable review format', () => {
    const bogus = '<html><body>No reviews here</body></html>';
    assert.equal(countBwwRrOutlets(bogus), 0);
  });

  it('counts BlogPosting entries in new-format pages', () => {
    // Synthetic new-format page with 3 BlogPosting entries
    const newFormat = `<html><head>
      <script type="application/ld+json">
      { "@type": "Article", "articleBody": "text",
        "hasPart": [
          {"@type":"BlogPosting","author":"Critic A"},
          {"@type":"BlogPosting","author":"Critic B"},
          {"@type":"BlogPosting","author":"Critic C"}
        ]
      }
      </script></head><body></body></html>`;
    // The regex counts "@type": "BlogPosting" occurrences
    const count = countBwwRrOutlets(newFormat);
    assert.equal(count, 3);
  });
});

describe('bww-rr-count-mismatch check (logic)', () => {
  it('no bwwRoundupUrl — returns warning not error', async () => {
    const check = require('../../scripts/lib/opening-night-checks/bww-rr-count-mismatch.check.js');
    const show = { id: 'test-2026', title: 'Test', openingDate: '2026-04-15' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
    const result = await check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /No bwwRoundupUrl/);
  });
});
