// BRO-7680: the header market menu must cap its own height and scroll.
//
// The header is `fixed`, so a menu taller than the screen cannot be scrolled to
// by scrolling the page. With every launched city hub the menu is ~1,000px
// tall, which hid Washington DC, Los Angeles, San Diego and Boston on phones
// (owner report 2026-11-17). Adding the next hub or market must never do that
// again, so the container has to carry: a viewport-relative max-height that
// leaves room for the 56px top offset, overflow-y scrolling, and
// overscroll-contain (so a flick at the end does not scroll the page behind).
//
// This is the cheap source-level pin (runs in the unit gate). The real-browser
// check is the "market menu: every market is reachable" block in
// tests/e2e/smoke.spec.ts, which opens the menu on phone viewports and taps
// every row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/components/MarketNav.tsx', import.meta.url), 'utf8');

function menuClasses() {
  const m = src.match(/data-testid="market-menu"\s+className="([^"]+)"/);
  assert.ok(m, 'MarketNav must keep a data-testid="market-menu" container (the e2e check finds the menu by it)');
  return m[1].split(/\s+/);
}

test('market menu scrolls inside itself instead of running off the screen', () => {
  const classes = menuClasses();
  assert.ok(
    classes.includes('overflow-y-auto') || classes.includes('overflow-y-scroll'),
    'menu needs overflow-y-auto: without it rows past the screen edge are unreachable on phones',
  );
  assert.ok(classes.includes('overscroll-contain'), 'menu needs overscroll-contain so scrolling it does not scroll the page behind');
});

test('market menu max-height is viewport-relative and leaves room for its top offset', () => {
  const classes = menuClasses();
  const top = classes.find((c) => /^top-\d+$/.test(c));
  assert.ok(top, 'menu is positioned with a top-N offset from the header');
  const topRem = Number(top.slice(4)) / 4; // tailwind spacing: N * 0.25rem

  // Plain vh is the base, dvh (tracks Safari's collapsing toolbar) is layered on top.
  const maxH = classes.filter((c) => /max-h-\[calc\(100d?vh-[\d.]+rem\)\]$/.test(c));
  assert.ok(maxH.some((c) => c.startsWith('max-h-[calc(100vh-')), 'needs the plain vh max-height fallback');
  assert.ok(maxH.some((c) => /dvh-/.test(c)), 'needs the dvh max-height (iOS Safari toolbar)');
  for (const c of maxH) {
    const reserve = Number(c.match(/-([\d.]+)rem\)\]$/)[1]);
    assert.ok(
      reserve > topRem,
      `${c} must reserve more than the ${topRem}rem top offset, or the menu's bottom edge still falls off the screen`,
    );
  }
});
