import { test, expect } from '@playwright/test';
import {
  measurePageWeight,
  noFlightPayloadDetectedMessage,
  overBudgetMessage,
  type PageWeight,
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
 */
const PAGE_WEIGHT_BUDGETS: Record<string, PageWeight> = {
  '/': { documentBytes: 1_020_000, rscBytes: 980_000 },
  '/west-end': { documentBytes: 1_280_000, rscBytes: 950_000 },
  '/off-broadway': { documentBytes: 910_000, rscBytes: 600_000 },
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

      expect(
        measured.documentBytes,
        overBudgetMessage(route, 'documentBytes', measured.documentBytes, budget.documentBytes),
      ).toBeLessThanOrEqual(budget.documentBytes);

      expect(
        measured.rscBytes,
        overBudgetMessage(route, 'rscBytes', measured.rscBytes, budget.rscBytes),
      ).toBeLessThanOrEqual(budget.rscBytes);
    });
  }
});
