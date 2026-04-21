// Regression test for the Schmigadoon 2026 opening-night contamination class:
// A review-text file where contentVerification.wrongProduction=true is downgraded
// to confidence=low via an [OVERRIDE] string in the CV reasoning, which prevented
// the top-level wrongProduction flag from being set and let the file ship as
// Schmigadoon despite being an Every Brilliant Thing review.
//
// Four plugins must fire with severity=error against the synthetic bypass fixture:
//   1. slug-mismatch              (URL slug doesn't mention show)
//   2. roundup-url-mismatch       (bwwRoundupUrl points to different show)
//   3. fulltext-mentions-show     (fullText never mentions the show title)
//   4. cv-wrongproduction-unhandled (CV says wrong, shipped, no clear flag)
//
// Fixture is synthetic (no copyrighted review text) — just the structural fields
// that characterize the bypass. Real review-text files live in the private repo
// and are never committed to the public repo (copyright).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const SHOW = { id: 'schmigadoon-2026-fixture', title: 'Schmigadoon!', slug: 'schmigadoon' };

const CHECK_MODULES = [
  'slug-mismatch',
  'roundup-url-mismatch',
  'fulltext-mentions-show',
  'cv-wrongproduction-unhandled',
].map(name => ({
  name,
  mod: require(`../../scripts/lib/opening-night-checks/${name}.check.js`),
}));

// Synthetic fixture that reproduces the juan-a-ramirez bypass pattern:
// 1) CV LLM flagged wrongProduction=true, downgraded to confidence=low via [OVERRIDE]
// 2) No top-level wrongProduction — rebuild's top-level check passes
// 3) No human-review/manual/auto clear flag
// 4) URL slug points to a different show ("every-brilliant-thing")
// 5) bwwRoundupUrl points to a different show's roundup
// 6) fullText never mentions "Schmigadoon" — it's about a different production
const BYPASS_FIXTURE = {
  showId: 'schmigadoon-2026-fixture',
  outletId: 'theatrely',
  criticName: 'Test Critic',
  url: 'https://www.theatrely.com/post/daniel-radcliffe-crowd-sources-community-in-every-brilliant-thing-review',
  bwwRoundupUrl: 'https://www.broadwayworld.com/article/Review-Roundup-Tony-Winner-Daniel-Radcliffe-Stars-in-EVERY-BRILLIANT-THING-on-Broadway-20260312',
  publishDate: '2026-04-20',
  fullText: 'Synthetic test fixture. This text deliberately does not mention the show under review and is long enough to pass the minimum-length gates in fulltext-mentions-show.check.js. It describes an entirely different production to simulate cross-show contamination at ingest time. The placeholder text should never be confused with a real review body.  ' + 'lorem ipsum dolor sit amet, '.repeat(40),
  textWordCount: 300,
  isFullReview: true,
  contentTier: 'complete',
  contentVerification: {
    wrongProduction: true,
    confidence: 'low',
    reasoning: '[OVERRIDE: review within 1d of opening, likely correct production] The scraped content is a valid Broadway theater review, but it reviews the wrong production entirely.',
    issues: ['reviews a different production'],
  },
};

let tmpRoot;
let context;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-night-bypass-'));
  const showDir = path.join(tmpRoot, SHOW.id);
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, 'theatrely--test-critic.json'), JSON.stringify(BYPASS_FIXTURE));

  const syntheticShippedReview = {
    outletId: BYPASS_FIXTURE.outletId,
    criticName: BYPASS_FIXTURE.criticName,
    url: BYPASS_FIXTURE.url,
    assignedScore: 80,
    scoreSource: 'llm_ensemble',
    publishDate: BYPASS_FIXTURE.publishDate,
  };

  context = {
    reviewTextsRoot: tmpRoot,
    reviewsDoc: { [SHOW.id]: [syntheticShippedReview] },
    shows: [SHOW],
    driftState: {},
    criticConsensusDoc: {},
    now: new Date(),
  };
});

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('opening-night audit gate — juan-a-ramirez bypass class', () => {
  for (const { name, mod } of CHECK_MODULES) {
    it(`${name} fires with severity=error`, async () => {
      const result = await mod.run(SHOW, context);
      assert.equal(result.ok, false, `${name} should not be ok: ${result.message}`);
      assert.equal(result.severity, 'error', `${name} expected severity=error, got ${result.severity}: ${result.message}`);
    });
  }
});
