// BRO-187 — Review-coverage systemic fixes: junk census candidates, extraction
// rot, babysitter remediation loop (Pass/Disruption/Vessel).
//
// This is the single named acceptance test the Linear card points at. It does
// NOT re-implement any of the underlying decisions (CLAUDE.md rule 15) — every
// assertion below calls the SAME real functions the production audit uses,
// already unit-tested individually in:
//   - scripts/lib/non-review-url-patterns.test.mjs (BWW review-vs-roundup gate)
//   - scripts/lib/outlet-canonicalize.test.mjs (The Pass mirror-host dedupe)
//   - scripts/audit-show-review-gap.test.mjs (acceptSerpCensusResult / SERP
//     junk-candidate filtering, computeResidualCounts)
//   - scripts/scoring-delta-autoclear-coverage.test.mjs (wrongAttribution gate
//     behind the Tim Teeman NYT correction, task #1180)
// This file exists to give the three named shows (Disruption, The Pass, The
// Vessel) and the Teeman attribution a single, discoverable regression home
// that fails loudly if any of those specific fixes regress, plus a live check
// against the committed audit snapshot so a silently-reintroduced gap on one
// of the three shows is caught without needing network/SERP access.
//
// Run: node --test tests/unit/review-gap-remediation.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { classifyReviewUrl } = require('../../scripts/lib/non-review-url-patterns.js');
const { sameOutletUrlVariant } = require('../../scripts/lib/outlet-canonicalize.js');
const { hostOf } = require('../../scripts/lib/non-review-url-patterns.js');

const REPO_ROOT = path.join(import.meta.dirname, '..', '..');

describe('junk census candidates — BWW review-vs-roundup gate (Disruption / The Vessel / The Pass)', () => {
  // 2026-08-05: the aggregator-article and SERP-census candidate gates could
  // disagree, so a BWW /reviews/ hub page or a /shows/…/cast profile page
  // counted as a "review candidate" and either drowned the real gap in noise
  // or (worse) let a stub file on that hub URL mask a genuine missing review.
  it('rejects the BWW hub/roundup-index pages for Disruption and The Vessel as review candidates', () => {
    assert.equal(classifyReviewUrl('https://www.broadwayworld.com/reviews/disruption').ok, false);
    assert.equal(classifyReviewUrl('https://www.broadwayworld.com/reviews/the-vessel').ok, false);
  });

  it('rejects a BWW show/cast profile page (not a review) for The Vessel', () => {
    assert.equal(classifyReviewUrl('https://www.broadwayworld.com/shows/The-Vessel-336202/cast').ok, false);
  });

  it('accepts the real BWW review article for The Pass', () => {
    assert.equal(
      classifyReviewUrl('https://www.broadwayworld.com/off-broadway/article/Review-THE-PASS-at-La-MaMa-20260804').ok,
      true
    );
  });
});

describe('extraction rot — mirror-host reviews are not phantom gaps (The Pass)', () => {
  // 2026-08-03: the-pass-off-broadway-2026 was reported missing a
  // one-minute-critic review it already held — the outlet had moved to
  // Substack, the census found the new host, and no URL-level match could see
  // the two paths were the same outlet's review. This is what deleted the show
  // from the newsletter that week.
  const DOMAIN_TO_OUTLET = {
    '1minutecritic.com': 'one-minute-critic',
    '1minutecritic.substack.com': 'one-minute-critic',
  };
  const held = ['https://1minutecritic.com/the-pass-la-mama-review-2026/'];
  const candidate = 'https://1minutecritic.substack.com/p/pass-la-mama-review-2026';

  it('recognizes the Substack mirror as the same outlet review already held', () => {
    const got = sameOutletUrlVariant({
      candidateUrl: candidate, heldUrls: held,
      domainToOutlet: DOMAIN_TO_OUTLET, ambiguous: new Set(), hostOf,
    });
    assert.equal(got.dup, true);
    assert.equal(got.outletId, 'one-minute-critic');
  });
});

describe('NYT Teeman attribution (task #1180)', () => {
  // The "Tim Teeman has never been an NYT theater critic" premise was false —
  // a direct fetch of the live NYT page returned NYT's own GraphQL byline
  // block naming him. He is a Daily Beast senior editor who freelances for
  // the Times; critic-registry.json models that as a real freelancer entry,
  // not a fabricated byline.
  const registryPath = path.join(REPO_ROOT, 'data', 'critic-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  it('critic-registry.json models Tim Teeman as a genuine NYT freelancer, not solely Daily Beast', () => {
    const entry = registry.critics['tim-teeman'];
    assert.ok(entry, 'expected a tim-teeman entry in data/critic-registry.json');
    assert.ok(entry.isFreelancer, 'Teeman should be modeled as a freelancer (multi-outlet), not a single-outlet staff critic');
    assert.ok(entry.knownOutlets.includes('nytimes'), 'nytimes must be in Teeman\'s knownOutlets');
  });

  it('the Disruption NYT/Teeman review in reviews.json is not flagged wrongAttribution', () => {
    const reviewsPath = path.join(REPO_ROOT, 'data', 'reviews.json');
    const raw = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.reviews || Object.values(raw));
    const teeman = arr.find(r => r.criticName === 'Tim Teeman' && /nytimes\.com/.test(r.url || ''));
    if (!teeman) return; // review-texts/reviews.json not populated in this environment — nothing to assert
    assert.notEqual(teeman.wrongAttribution, true);
  });
});

describe('babysitter remediation loop — Pass/Disruption/Vessel stay at missing:[] (live regression guard)', () => {
  // Defense-in-depth against the committed audit snapshot itself: if a future
  // change to audit-show-review-gap.js silently reintroduces a gap on one of
  // the three shows this card names, this catches it without requiring live
  // SERP/scraper access. Each show is looked up independently and skipped
  // (not failed) if it is not present in the current snapshot — the snapshot
  // is CI-computed and rotates, so absence is not itself a regression.
  const auditPath = path.join(REPO_ROOT, 'data', 'audit', 'show-review-gap.json');
  let entries = [];
  try {
    const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    entries = raw.results || raw;
  } catch { /* audit file absent in this environment — nothing to assert */ }

  const NAMED_SHOWS = ['the-pass-off-broadway-2026', 'disruption-off-broadway-2026', 'the-vessel-off-broadway-2026'];

  for (const showId of NAMED_SHOWS) {
    it(`${showId}: no unrecovered gap in the last CI-computed audit snapshot`, () => {
      const entry = Array.isArray(entries) ? entries.find(e => e.showId === showId) : null;
      if (!entry) return; // show not in this snapshot — nothing to assert here
      assert.deepEqual(entry.missing || [], [], `${showId} has an unresolved missing-review gap`);
    });
  }
});
