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
const { classifyReviewUrl, hostOf } = require('../../scripts/lib/non-review-url-patterns.js');
const { sameOutletUrlVariant, _buildDomainMap } = require('../../scripts/lib/outlet-canonicalize.js');
const { resolveReviewTextsDir } = require('../../scripts/lib/review-texts-dir.js');

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
  // Built from the REAL outlet-registry.json (same call the audit itself
  // makes), not a hand-copied map — so alias-registry drift (one-minute-critic
  // losing its substack.com alias) fails this test instead of going unnoticed.
  const { domainToOutlet, ambiguous } = _buildDomainMap();
  const held = ['https://1minutecritic.com/the-pass-la-mama-review-2026/'];
  const candidate = 'https://1minutecritic.substack.com/p/pass-la-mama-review-2026';

  it('one-minute-critic.com and its substack.com mirror are still registered as the same outlet', () => {
    assert.equal(domainToOutlet['1minutecritic.com'], 'one-minute-critic');
    assert.equal(domainToOutlet['1minutecritic.substack.com'], 'one-minute-critic');
  });

  it('recognizes the Substack mirror as the same outlet review already held', () => {
    const got = sameOutletUrlVariant({
      candidateUrl: candidate, heldUrls: held,
      domainToOutlet, ambiguous, hostOf,
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

  it('the source-of-truth review file (data/review-texts/disruption-off-broadway-2026/nytimes--tim-teeman.json) is not flagged wrongAttribution', () => {
    // Source-of-truth first, per-file, not the aggregated derived output —
    // review-texts is what rebuild-all-reviews.js reads FROM to produce
    // reviews.json, so a pin against the derived file alone can silently
    // rot if a rebuild changes without the source record changing too.
    const reviewTextsDir = resolveReviewTextsDir();
    const sourcePath = path.join(reviewTextsDir, 'disruption-off-broadway-2026', 'nytimes--tim-teeman.json');
    let source;
    try {
      source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    } catch {
      return; // review-texts (private repo) not checked out in this environment — nothing to assert
    }
    assert.equal(source.criticName, 'Tim Teeman');
    assert.notEqual(source.wrongAttribution, true);
    assert.ok(
      /not fabricated/i.test(source.crossOutletVerifiedNote || ''),
      'expected the task #1180 correction note confirming the live-page byline is genuine'
    );

    // Cross-check against the derived output reviews.json rolls up from this
    // same source file — if they disagree, the rebuild pipeline itself is
    // the bug, and that is worth failing loudly on too.
    const reviewsPath = path.join(REPO_ROOT, 'data', 'reviews.json');
    let arr;
    try {
      const raw = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
      arr = Array.isArray(raw) ? raw : (raw.reviews || Object.values(raw));
    } catch {
      return; // reviews.json not populated in this environment — nothing further to assert
    }
    const teeman = arr.find(r => r.showId === 'disruption-off-broadway-2026' && r.criticName === 'Tim Teeman');
    assert.ok(teeman, 'expected a Tim Teeman review for disruption-off-broadway-2026 in data/reviews.json');
    assert.ok(/nytimes\.com/.test(teeman.url || ''), 'expected the Disruption Teeman review to be an nytimes.com URL');
    assert.notEqual(teeman.wrongAttribution, true);
  });
});

describe('babysitter remediation loop — Pass/Disruption/Vessel stay at missing:[] (live regression guard)', () => {
  // Defense-in-depth against the committed audit snapshot itself: if a future
  // change to audit-show-review-gap.js silently reintroduces a gap on one of
  // the three shows this card names, this catches it without requiring live
  // SERP/scraper access. The audit file is cumulative (entries are carried
  // forward run over run, per audit-show-review-gap.js's header comment on
  // #893), so once a show has an entry it should keep one — a show that
  // silently drops out of the snapshot is exactly the kind of "quietly
  // stopped being checked" regression this card is about, so absence is a
  // hard failure, not a skip. Only the file being entirely unreadable (e.g. a
  // cloud environment without data/audit/ populated) skips this suite.
  const auditPath = path.join(REPO_ROOT, 'data', 'audit', 'show-review-gap.json');
  let entries = null;
  try {
    const raw = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    entries = raw.results || raw;
  } catch { /* audit file absent in this environment — handled per-test below */ }

  const NAMED_SHOWS = ['the-pass-off-broadway-2026', 'disruption-off-broadway-2026', 'the-vessel-off-broadway-2026'];

  for (const showId of NAMED_SHOWS) {
    it(`${showId}: no unrecovered gap in the last CI-computed audit snapshot`, () => {
      if (!Array.isArray(entries)) return; // audit file not present in this environment — nothing to assert
      const entry = entries.find(e => e.showId === showId);
      assert.ok(entry, `expected ${showId} to have an entry in data/audit/show-review-gap.json (cumulative — it should not silently disappear)`);
      assert.deepEqual(entry.missing || [], [], `${showId} has an unresolved missing-review gap`);
    });
  }
});
