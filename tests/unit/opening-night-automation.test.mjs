/**
 * Regression lock for BRO-994 (P1: Redesign opening-night automation).
 *
 * The Notion card proposed 3 alternates + a recommended combination to stop
 * opening-night discovery hanging on a single Cloudflare-protected aggregator
 * (BWW Review Roundup). By the time this card reached Linear, the redesign
 * had already shipped incrementally across many sessions:
 *   Alt 1 (direct outlet RSS/site feeds) — scripts/lib/rss-discovery.js
 *   Alt 2 (admin UI paste-and-commit form) — src/app/admin/ingest/
 *   Alt 3 (Browserbase fallback for BWW RR) — scripts/lib/bww-rr-discover.js
 *   Deploy-after-rebuild gate — .github/workflows/vercel-deploy.yml workflow_run trigger
 *
 * This test doesn't re-verify each component's own logic (those have their
 * own colocated tests). It locks the WIRING — that these pieces stay plugged
 * into opening-night-poller.js / vercel-deploy.yml / the admin API route —
 * so a future refactor can't silently strand the pipeline back on the single
 * BWW-RR-or-bust path this card was filed to eliminate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '../..');

const read = (relPath) => fs.readFileSync(path.join(repoRoot, relPath), 'utf8');

describe('Alt 1 — direct outlet RSS/feed discovery', () => {
  const { ALL_FEEDS, checkRSSFeeds, titleMatchesShow } = require('../../scripts/lib/rss-discovery.js');

  it('registers direct feeds for T1 outlets (no aggregator dependency)', () => {
    const outletIds = ALL_FEEDS.map(f => f.outletId);
    assert.ok(outletIds.includes('nytimes'), 'NYT Theater feed missing');
    assert.ok(outletIds.includes('variety'), 'Variety Legit feed missing');
    assert.ok(outletIds.includes('washpost'), 'WashPost feed missing');
  });

  it('exposes checkRSSFeeds as the discovery entry point', () => {
    assert.equal(typeof checkRSSFeeds, 'function');
  });

  it('title-matches a real show title against a realistic RSS item title', () => {
    assert.ok(titleMatchesShow('Review: Giant Brings a Sprawling Epic to Broadway', 'Giant'));
    assert.ok(!titleMatchesShow('Hamilton Tickets Go On Sale', 'Giant'));
  });

  it('is wired into opening-night-poller.js as a discovery source', () => {
    const src = read('scripts/opening-night-poller.js');
    assert.match(src, /require\(['"]\.\/lib\/rss-discovery['"]\)/);
    assert.match(src, /checkRSSFeeds\(/);
  });
});

describe('Alt 3 — Browserbase fallback for Cloudflare-protected aggregators', () => {
  it('opening-night-poller.js gates BWW RR discovery on Browserbase availability', () => {
    const src = read('scripts/opening-night-poller.js');
    assert.match(src, /BROWSERBASE_API_KEY/);
    assert.match(src, /BROWSERBASE_PROJECT_ID/);
    assert.match(src, /require\(['"]\.\/lib\/bww-rr-discover(\.js)?['"]\)/);
    assert.match(src, /discoverBwwRoundupUrl/);
  });

  it('bww-rr-discover.js exports a discovery function usable by the poller', () => {
    const mod = require('../../scripts/lib/bww-rr-discover.js');
    assert.equal(typeof mod.discoverBwwRoundupUrl, 'function');
  });
});

describe('Alt 2 — admin UI ingest form (auth-gated, commits via GitHub API)', () => {
  it('the admin ingest page and form exist', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/app/admin/ingest/page.tsx')));
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/app/admin/ingest/IngestForm.tsx')));
  });

  it('the ingest API route is auth-gated', () => {
    const src = read('src/app/api/admin/ingest-review/route.ts');
    assert.match(src, /isAdmin\(\)/, 'route must check isAdmin() before writing anything');
  });

  it('the ingest API route commits to the private review-texts repo via the GitHub API, not local git', () => {
    const src = read('src/app/api/admin/ingest-review/route.ts');
    assert.match(src, /PRIVATE_REPO_OWNER/);
    assert.match(src, /PRIVATE_REPO_NAME/);
    // No shelling out to `git commit`/`git push` from the API route — the whole
    // point of Alt 2 was eliminating local-git merge races (Beaches 2026-04-22).
    assert.doesNotMatch(src, /execSync\(['"`]git /);
  });

  it('shares the same protection-field builder as the CLI ingester (buildManualReviewFields)', () => {
    const src = read('src/app/api/admin/ingest-review/route.ts');
    assert.match(src, /buildManualReviewFields/);
  });
});

describe('Shared protection-field guarantee (fixes the class of bug, not one instance)', () => {
  const { buildManualReviewFields } = require('../../scripts/lib/manual-review-fields.js');

  it('an operator-vouched manual ingest sets every override field the guards check', () => {
    const fields = buildManualReviewFields({
      humanScore: 82,
      fullText: 'A glowing review of the production.',
    });
    // The Beaches 2026-04-22 incident: an earlier version of this block set
    // only 3 of the needed fields and 4 reviews were silently re-flagged.
    assert.equal(fields.wrongProduction, false);
    assert.equal(fields.wrongProductionManualClear, true);
    assert.equal(fields.wrongShow, false);
    assert.equal(fields.wrongShowManualClear, true);
    assert.equal(fields.allowEarlyDate, true);
    assert.equal(fields.humanReviewedWrongProduction, false);
    assert.equal(fields.humanReviewedWrongArticle, false);
    assert.deepEqual(fields.contentVerification, { isValid: true, confidence: 'manual', verifiedBy: 'manual-ingest', wrongProduction: false, wrongArticle: false });
    assert.equal(fields.manualContentTier, 'complete');
    // The per-file protectedFields lock must itself list the score + tier fields,
    // or a rebase can silently drop them even though the guard fields above hold.
    assert.ok(Array.isArray(fields.protectedFields));
    assert.ok(fields.protectedFields.includes('humanReviewScore'));
    assert.ok(fields.protectedFields.includes('manualContentTier'));
  });

  it('automated (non-operator-trust) ingest stays subject to every guard', () => {
    const fields = buildManualReviewFields({
      fullText: 'Auto-ingested review text.',
      operatorTrust: false,
    });
    assert.equal(fields.wrongProduction, undefined, 'automated ingest must not silently clear guards');
    assert.equal(fields.fetchMethod, 'url-ingest');
  });
});

describe('Deploy-after-rebuild gate', () => {
  it('vercel-deploy.yml deploys automatically when a rebuild completes, not just on a timer', () => {
    const src = read('.github/workflows/vercel-deploy.yml');
    assert.match(src, /workflow_run:/);
    assert.match(src, /Rebuild Reviews Data/);
    assert.match(src, /Rebuild Reviews \(Fast\)/);
  });
});
