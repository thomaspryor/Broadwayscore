import type { Page } from '@playwright/test';

/**
 * Pin live, mutable show data inside a screenshot region before
 * `toHaveScreenshot` (BRO-7649).
 *
 * visual-regression.spec.ts runs in the push-time E2E job against production,
 * where Hamilton's review count, verdict tally and LLM-written Critics' Take
 * change with the corpus. On 2026-11-17 a regenerated Critics' Take (plus 43 to
 * 45 reviews) moved pixels with no code change, so a baseline that renders live
 * data goes red for reasons no code commit caused. This replaces that data with
 * fixed values so the screenshot only moves when layout or components move.
 *
 * What it pins, inside `rootSelector` only:
 *   - every digit becomes "8" (review counts, tally, score, price, years, dates);
 *   - the paragraph after the "Critics' Take" heading gets fixed copy;
 *   - the score breakdown bar's coloured segments are hidden (their widths are
 *     review-count ratios); the bar keeps its height.
 *
 * tests/unit/visual-baseline-stable-data.test.mjs fails if a spec screenshots a
 * live route without calling this first.
 */
export const FROZEN_CRITICS_TAKE =
  'Critics praise the score, the staging and the cast, calling the production ambitious and ' +
  'confident. A few reviews find the second act long, but most call it a must-see evening.';

export interface FreezeResult {
  digitsReplaced: number;
  criticsTakeFrozen: boolean;
  breakdownBarsFrozen: number;
}

export async function freezeLiveShowData(
  page: Page,
  rootSelector: string,
  opts: { requireCriticsTake?: boolean } = {},
): Promise<FreezeResult> {
  const result = await page.evaluate(
    ({ sel, take }) => {
      const roots = Array.from(document.querySelectorAll(sel));
      if (roots.length === 0) throw new Error(`freezeLiveShowData: no element matches ${sel}`);
      let digitsReplaced = 0;
      let criticsTakeFrozen = false;
      let breakdownBarsFrozen = 0;
      for (const root of roots) {
        // Critics' Take first, so its fixed copy is not digit-rewritten afterwards
        // (it has no digits anyway).
        for (const p of Array.from(root.querySelectorAll('p'))) {
          const label = (p.textContent || '').trim().replace(/[‘’]/g, "'").toLowerCase();
          if (label !== "critics' take") continue;
          const body = p.nextElementSibling;
          if (body) {
            body.textContent = take;
            criticsTakeFrozen = true;
          }
        }
        // ScoreBreakdownBar: role=img with an aria-label like "45 reviews: 39 raves, ...".
        for (const bar of Array.from(root.querySelectorAll('[role="img"][aria-label]'))) {
          if (!/^\d+ reviews?:/.test(bar.getAttribute('aria-label') || '')) continue;
          const track = bar.firstElementChild as HTMLElement | null;
          if (track) {
            for (const seg of Array.from(track.children)) (seg as HTMLElement).style.visibility = 'hidden';
            breakdownBarsFrozen++;
          }
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = node.nodeValue || '';
          if (!/\d/.test(text)) continue;
          digitsReplaced += (text.match(/\d/g) || []).length;
          node.nodeValue = text.replace(/\d/g, '8');
        }
      }
      return { digitsReplaced, criticsTakeFrozen, breakdownBarsFrozen };
    },
    { sel: rootSelector, take: FROZEN_CRITICS_TAKE },
  );
  if (opts.requireCriticsTake && !result.criticsTakeFrozen) {
    // Fail with a cause instead of a pixel diff: the heading moved or was renamed.
    throw new Error(`freezeLiveShowData: no "Critics' Take" heading found under ${rootSelector}`);
  }
  return result;
}
