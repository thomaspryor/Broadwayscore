/**
 * The show page's sticky score bar must stack BELOW the site header. The
 * header (z-[60]) holds the phone menu drawer and the search / market
 * dropdowns; a bar above it painted over the open menu (BRO-4616, the
 * "< 92 Hamilton" bar covering the My Shows card).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const zOf = (src, re) => {
  const m = src.match(re);
  assert.ok(m, `pattern not found: ${re}`);
  return Number(m[1]);
};

test('sticky score header stacks below the site header', () => {
  const layout = readFileSync(new URL('../../src/app/layout.tsx', import.meta.url), 'utf8');
  const sticky = readFileSync(new URL('../../src/components/StickyScoreHeader.tsx', import.meta.url), 'utf8');
  const headerZ = zOf(layout, /<header className="fixed top-0[^"]*\bz-\[(\d+)\]/);
  const stickyZ = zOf(sticky, /className="[^"]*\bz-\[(\d+)\][^"]*"\s*\n\s*role="banner"/);
  assert.ok(stickyZ < headerZ, `StickyScoreHeader z-[${stickyZ}] must be below the site header z-[${headerZ}]`);
});
