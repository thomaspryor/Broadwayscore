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
 *   - the score breakdown bar's coloured segments get equal fixed widths (real
 *     widths are review-count ratios); colours and height still render;
 *   - with `pinLongText`, every text run over 40 characters (e.g. a review's
 *     pull quote) becomes fixed copy.
 *
 * A late client re-render can put live text back after a one-shot DOM edit, so
 * the freeze waits for network idle, then re-applies until two passes in a row
 * (500ms apart) find nothing to change.
 *
 * tests/unit/visual-baseline-stable-data.test.mjs fails if a spec screenshots a
 * live route without calling this first.
 */
export const FROZEN_CRITICS_TAKE =
  'Critics praise the score, the staging and the cast, calling the production ambitious and ' +
  'confident. A few reviews find the second act long, but most call it a must-see evening.';

export const FROZEN_LONG_TEXT =
  'A fixed sentence that stands in for live review copy so the screenshot does not move.';

export interface FreezeResult {
  digitsReplaced: number;
  criticsTakeFrozen: boolean;
  breakdownBarsFrozen: number;
}

export async function freezeLiveShowData(
  page: Page,
  rootSelector: string,
  opts: { requireCriticsTake?: boolean; pinLongText?: boolean } = {},
): Promise<FreezeResult> {
  // toHaveScreenshot scrolls the element into view, and below-the-fold regions
  // (the review list) hydrate lazily and re-render, wiping a freeze done
  // earlier. Scroll first and let the network go quiet so the freeze lands on
  // the final render, then require two clean passes in a row.
  await page.locator(rootSelector).first().scrollIntoViewIfNeeded();
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const total: FreezeResult = { digitsReplaced: 0, criticsTakeFrozen: false, breakdownBarsFrozen: 0 };
  let cleanPasses = 0;
  for (let pass = 0; pass < 10; pass++) {
    const r = await freezeOnce(page, rootSelector, !!opts.pinLongText);
    total.digitsReplaced += r.digitsReplaced;
    total.criticsTakeFrozen ||= r.criticsTakeFrozen;
    total.breakdownBarsFrozen = Math.max(total.breakdownBarsFrozen, r.breakdownBarsFrozen);
    cleanPasses = r.changes === 0 ? cleanPasses + 1 : 0;
    if (cleanPasses >= 2) break;
    if (pass === 9) throw new Error(`freezeLiveShowData: ${rootSelector} kept re-rendering live data`);
    await page.waitForTimeout(500);
  }
  if (opts.requireCriticsTake && !total.criticsTakeFrozen) {
    // Fail with a cause instead of a pixel diff: the heading moved or was renamed.
    throw new Error(`freezeLiveShowData: no "Critics' Take" heading found under ${rootSelector}`);
  }
  return total;
}

async function freezeOnce(page: Page, rootSelector: string, pinLongText: boolean) {
  return page.evaluate(
    ({ sel, take, longText, pinLong }) => {
      let changes = 0;
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
            if (body.textContent !== take) {
              body.textContent = take;
              changes++;
            }
            criticsTakeFrozen = true;
          }
        }
        // ScoreBreakdownBar: role=img with an aria-label like "45 reviews: 39 raves, ...".
        for (const bar of Array.from(root.querySelectorAll('[role="img"][aria-label]'))) {
          if (!/^\d+ reviews?:/.test(bar.getAttribute('aria-label') || '')) continue;
          const track = bar.firstElementChild as HTMLElement | null;
          if (track && track.children.length > 0) {
            // Integer % so the browser does not normalise it and the re-apply check settles.
            const width = `${Math.floor(100 / track.children.length)}%`;
            for (const seg of Array.from(track.children)) {
              const el = seg as HTMLElement;
              if (el.style.width !== width) {
                el.style.width = width;
                changes++;
              }
            }
            breakdownBarsFrozen++;
          }
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = node.nodeValue || '';
          if (pinLong && text.trim().length > 40 && text !== longText) {
            node.nodeValue = longText;
            changes++;
            continue;
          }
          // Already-pinned digits are 8s: count only digits still to replace, so a
          // settled region reports zero changes.
          if (!/[0-79]/.test(text)) continue;
          changes++;
          digitsReplaced += (text.match(/[0-79]/g) || []).length;
          node.nodeValue = text.replace(/\d/g, '8');
        }
      }
      return { digitsReplaced, criticsTakeFrozen, breakdownBarsFrozen, changes };
    },
    { sel: rootSelector, take: FROZEN_CRITICS_TAKE, longText: FROZEN_LONG_TEXT, pinLong: pinLongText },
  );
}
