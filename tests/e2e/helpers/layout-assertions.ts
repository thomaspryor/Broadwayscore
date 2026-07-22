import { type Page, type Locator, expect } from '@playwright/test';

/**
 * Reusable Playwright layout assertion helpers.
 * Detect overlap, off-screen, undersized tap targets, misalignment, horizontal overflow.
 *
 * All functions throw descriptive errors suitable for CI output.
 */

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

/** Minimum overlap in pixels to count as a real collision (not subpixel) */
const OVERLAP_TOLERANCE = 4;

/**
 * Get bounding boxes of all visible interactive elements inside a container.
 */
async function getInteractiveBounds(container: Locator): Promise<BoundingBox[]> {
  const selector = 'button, a, [role="button"], input, select, [role="tab"]';
  const elements = container.locator(selector);
  const count = await elements.count();
  // A 0 count here makes every caller (assertNoOverlaps, assertNothingOffScreen,
  // assertMinimumTapTargets) pass trivially — expect([]).toEqual([]) is always
  // true. If the interactive-elements selector drifts, these asserts silently
  // stop checking anything instead of failing loudly. Callers already guard
  // the container's own visibility before calling in; a 0 count past that
  // point means the selector itself broke, not that the container is
  // legitimately empty.
  expect(
    count,
    `getInteractiveBounds found 0 interactive elements (selector: ${selector}) — ` +
      `either the container is unexpectedly empty or the selector drifted, and ` +
      `every layout assertion built on this would pass having checked nothing`
  ).toBeGreaterThan(0);
  const boxes: BoundingBox[] = [];

  for (let i = 0; i < count; i++) {
    const el = elements.nth(i);
    if (!(await el.isVisible())) continue;
    const box = await el.boundingBox();
    if (!box) continue;
    // Get an accessible label for error messages
    const label =
      (await el.getAttribute('aria-label')) ||
      (await el.textContent())?.trim().slice(0, 40) ||
      `element[${i}]`;
    boxes.push({ ...box, label });
  }

  return boxes;
}

/**
 * Assert no interactive elements overlap by more than OVERLAP_TOLERANCE pixels.
 */
export async function assertNoOverlaps(container: Locator): Promise<void> {
  const boxes = await getInteractiveBounds(container);
  const failures: string[] = [];

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      if (overlapX > OVERLAP_TOLERANCE && overlapY > OVERLAP_TOLERANCE) {
        failures.push(
          `"${a.label}" overlaps "${b.label}" by ${Math.round(overlapX)}x${Math.round(overlapY)}px`
        );
      }
    }
  }

  expect(failures, 'Interactive element overlaps detected').toEqual([]);
}

/**
 * Assert no visible interactive element extends past viewport width.
 */
export async function assertNothingOffScreen(container: Locator): Promise<void> {
  const page = container.page();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('No viewport set');

  const boxes = await getInteractiveBounds(container);
  const failures: string[] = [];
  const tolerance = 2; // px tolerance for sub-pixel rendering

  for (const box of boxes) {
    const rightEdge = box.x + box.width;
    if (rightEdge > viewport.width + tolerance) {
      failures.push(
        `"${box.label}" right edge off-screen (x+w=${Math.round(rightEdge)} > viewport=${viewport.width})`
      );
    }
    if (box.x < -tolerance) {
      failures.push(
        `"${box.label}" left edge off-screen (x=${Math.round(box.x)})`
      );
    }
  }

  expect(failures, 'Off-screen interactive elements detected').toEqual([]);
}

/**
 * Assert all visible interactive elements meet minimum tap target size.
 */
export async function assertMinimumTapTargets(
  container: Locator,
  minSize = 28
): Promise<void> {
  const boxes = await getInteractiveBounds(container);
  const failures: string[] = [];

  for (const box of boxes) {
    if (box.width < minSize || box.height < minSize) {
      failures.push(
        `"${box.label}" tap target too small: ${Math.round(box.width)}x${Math.round(box.height)}px (min ${minSize})`
      );
    }
  }

  expect(failures, 'Undersized tap targets detected').toEqual([]);
}

/**
 * Assert direct children of a row are vertically aligned (y-midpoints within tolerance).
 */
export async function assertRowAlignment(
  row: Locator,
  tolerance = 4
): Promise<void> {
  const children = row.locator(':scope > *');
  const count = await children.count();
  // Same silent-no-op risk as getInteractiveBounds above: a 0 count here
  // falls through the "midpoints.length < 2" early-return below and the
  // caller sees a clean pass having verified nothing.
  expect(
    count,
    'assertRowAlignment found 0 direct children — selector or row locator drifted'
  ).toBeGreaterThan(0);
  const midpoints: { label: string; midY: number }[] = [];

  for (let i = 0; i < count; i++) {
    const child = children.nth(i);
    if (!(await child.isVisible())) continue;
    const box = await child.boundingBox();
    if (!box) continue;
    const label = (await child.textContent())?.trim().slice(0, 30) || `child[${i}]`;
    midpoints.push({ label, midY: box.y + box.height / 2 });
  }

  if (midpoints.length < 2) return; // Nothing to compare

  const avgMidY = midpoints.reduce((s, m) => s + m.midY, 0) / midpoints.length;
  const failures: string[] = [];

  for (const m of midpoints) {
    if (Math.abs(m.midY - avgMidY) > tolerance) {
      failures.push(
        `"${m.label}" misaligned: midpoint ${Math.round(m.midY)} vs avg ${Math.round(avgMidY)}`
      );
    }
  }

  expect(failures, 'Row elements misaligned').toEqual([]);
}

/**
 * Assert that elements matching a selector are horizontally centered within their parent.
 * Catches the recurring trash-icon-not-centered regression on grid cards.
 */
export async function assertElementsCenteredInParent(
  page: Page,
  selector: string,
  tolerance = 4
): Promise<void> {
  const results = await page.evaluate(({ sel, tol }) => {
    const elements = document.querySelectorAll(sel);
    const failures: string[] = [];
    elements.forEach((el, i) => {
      const parent = el.parentElement;
      if (!parent) return;
      const parentRect = parent.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const elCenterX = elRect.left + elRect.width / 2 - parentRect.left;
      const parentCenterX = parentRect.width / 2;
      const offset = Math.abs(elCenterX - parentCenterX);
      if (offset > tol) {
        const label = el.getAttribute('aria-label') || `element[${i}]`;
        failures.push(`"${label}" off-center by ${Math.round(offset)}px (center=${Math.round(elCenterX)} vs parent=${Math.round(parentCenterX)})`);
      }
    });
    return failures;
  }, { sel: selector, tol: tolerance });

  expect(results, 'Elements not centered in parent').toEqual([]);
}

/**
 * Assert page has no horizontal overflow (scrollWidth <= viewport width).
 */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('No viewport set');

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(
    scrollWidth,
    `Horizontal overflow: scrollWidth ${scrollWidth} > viewport ${viewport.width}`
  ).toBeLessThanOrEqual(viewport.width);
}
