import { test, expect } from '@playwright/test';
import {
  countFlightSlugs,
  measurePageWeight,
  noFlightPayloadDetectedMessage,
  overBudgetMessage,
  scaleBudgetForCatalog,
  type CatalogBudget,
} from './helpers/page-weight';

/**
 * Page-weight budget gate (card #961).
 *
 * Card #419 found /show/hamilton shipping a 789KB document (645KB of it an
 * inlined RSC flight payload carrying 21 other shows' review corpora), and
 * the only signal anything had regressed was a weekly Lighthouse lab score
 * that oscillated 64-81 across weeks and named the wrong page in the alert.
 * This asserts real uncompressed document bytes and inlined-RSC bytes per
 * representative non-show route on every push/PR/daily run (see
 * show-pages.spec.ts for the /show/[slug] equivalent, which already has its
 * own sampled-show harness).
 *
 * PAGE_WEIGHT_BUDGETS below = production document bytes measured 2026-08-03
 * (`curl -s --compressed <url> | wc -c`) x1.25 headroom, rounded up to the
 * nearest 10KB. rscBytes = bytes of `self.__next_f.push(...)` flight chunks
 * in that same fetch, same x1.25/10KB rounding.
 *
 * IMPORTANT: these routes are currently carrying the unresolved bloat
 * tracked by #962 (review-array payloads reaching pages that shouldn't need
 * them) — every route measured 65-96% RSC share of its document on
 * 2026-08-03. These budgets lock in TODAY'S weight so it can't silently get
 * worse; they are a ceiling, not a target. Ratchet them down once #962 (and
 * any homepage/browse-page sibling of it) lands.
 *
 * Catalog growth (2026-09-29): /west-end and /off-broadway serialize every
 * show in their market, so a fixed byte ceiling went red whenever shows were
 * added (/west-end hit 1,301,110 vs 1,280,000 with 366 shows; /off-broadway
 * was re-derived the same morning and sat 2% under again by night). Listing
 * routes now carry `baselineItems` = distinct flight slugs at measurement
 * time, and the budget scales by items/baselineItems (capped at x1.5, past
 * which the test fails and asks for a re-derivation). Per-show bloat still
 * fails: it raises bytes without raising the slug count. /west-end and
 * /off-broadway were re-measured on production 2026-09-29 (doc/rsc/slugs:
 * 1,302,158/972,108/366 and 891,402/592,938/137) x1.1, rounded up to 10KB.
 * Re-derived 2026-10-08 (BRO-4900) after the West End historical backfill
 * took /west-end past x1.5: 1,797,808/1,291,440/562 and
 * 1,101,133/691,676/193, same x1.1/10KB rule. Bytes per show fell on both
 * routes (3,558 -> 3,199 and 6,507 -> 5,705), so this was catalog growth.
 */
const PAGE_WEIGHT_BUDGETS: Record<string, CatalogBudget> = {
  // Not scaled: the homepage's 317 slugs (2026-09-29) are curated sections,
  // not one market's catalog, so more shows there is a change to review, not
  // growth. 2026-09-29 production: 889,058 doc / 856,189 rsc (budget unchanged).
  '/': { documentBytes: 1_020_000, rscBytes: 980_000 },
  '/west-end': { documentBytes: 1_980_000, rscBytes: 1_430_000, baselineItems: 562 },
  '/off-broadway': { documentBytes: 1_220_000, rscBytes: 770_000, baselineItems: 193 },
  // Fixed-content guide page: no slugs in its payload, never scaled.
  '/guides/best-broadway-musicals': { documentBytes: 460_000, rscBytes: 270_000 },
};

test.describe('Page weight budget', () => {
  for (const [route, budget] of Object.entries(PAGE_WEIGHT_BUDGETS)) {
    test(`${route} stays under its document-weight budget`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response?.ok(), `${route} did not return a 2xx response (status ${response?.status()})`).toBeTruthy();

      const html = (await response?.text()) ?? '';
      expect(html.length, `${route} returned an empty response`).toBeGreaterThan(0);

      const measured = measurePageWeight(html);

      // Anti-vacuity: a Next.js flight-encoding change would otherwise zero
      // out rscBytes and let the assertion below pass forever (see
      // noFlightPayloadDetectedMessage in helpers/page-weight.ts).
      expect(measured.rscBytes, noFlightPayloadDetectedMessage(route)).toBeGreaterThan(0);

      // Listing routes: scale by catalog growth. A zero slug count on a route
      // that had a baseline means the slug regex went vacuous, not that the
      // market emptied — fail rather than silently use the unscaled budget.
      const items = countFlightSlugs(html);
      if (budget.baselineItems) {
        expect(items, `${route}: no show slugs found in the flight payload; the slug regex in helpers/page-weight.ts needs updating`).toBeGreaterThan(0);
      }
      const scaled = scaleBudgetForCatalog(route, budget, items);
      expect(scaled.outgrown, scaled.outgrown ?? '').toBeNull();

      expect(
        measured.documentBytes,
        overBudgetMessage(route, 'documentBytes', measured.documentBytes, scaled.documentBytes),
      ).toBeLessThanOrEqual(scaled.documentBytes);

      expect(
        measured.rscBytes,
        overBudgetMessage(route, 'rscBytes', measured.rscBytes, scaled.rscBytes),
      ).toBeLessThanOrEqual(scaled.rscBytes);
    });
  }
});
