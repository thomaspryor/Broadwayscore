// Both show-page headers must render the same trust lines (BRO-4525).
//
// The lines that link a production to its relatives (tour parent, tour stops,
// regional tryout and its Broadway transfer) used to live inline in the legacy
// header in page.tsx, so the redesigned hero silently dropped them. They now
// live in one server component, ShowTrustLines, that both headers render.
// This guard fails if a trust line is added back inline in page.tsx, or if
// either header stops rendering the shared component.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const TRUST_LINES = read('src/components/show-page/ShowTrustLines.tsx');
const PAGE = read('src/app/show/[slug]/page.tsx');
const HERO = read('src/components/show-page/ShowHeroRedesign.tsx');

const TESTIDS = [
  'tour-trust-line',
  'regional-trust-line',
  'tour-parent-line',
  'tour-stops-line',
];

test('every trust line is defined in ShowTrustLines', () => {
  for (const id of TESTIDS) {
    assert.ok(TRUST_LINES.includes(`data-testid="${id}"`), `${id} missing from ShowTrustLines.tsx`);
  }
});

test('page.tsx does not define trust lines inline', () => {
  for (const id of TESTIDS) {
    assert.ok(
      !PAGE.includes(`data-testid="${id}"`),
      `${id} is inline in page.tsx; add it to ShowTrustLines.tsx so both headers get it`,
    );
  }
});

test('legacy header renders ShowTrustLines', () => {
  assert.match(PAGE, /^\s*<ShowTrustLines show=\{show\} \/>\s*$/m);
});

test('redesigned hero receives ShowTrustLines and renders it', () => {
  assert.ok(PAGE.includes('trustLines={<ShowTrustLines show={show} />}'), 'RedesignOn hero no longer gets trustLines');
  assert.match(HERO, /data-testid="hero-trust-lines">\{trustLines\}</);
});

// Owner decision 2026-11-09: the Broadway page's top card must not carry the
// "Pre-Broadway tryout" line. Tryouts live in "Other Productions" below the fold.
test('top card has no Pre-Broadway tryout line', () => {
  assert.ok(!TRUST_LINES.includes('Pre-Broadway tryout'), 'tryout line is back in ShowTrustLines.tsx');
  assert.ok(!TRUST_LINES.includes('tryout-link-line'), 'tryout-link-line is back in ShowTrustLines.tsx');
});

// Owner decision 2026-11-10 (BRO-7259): the Broadway page's top card must not
// carry the blue "On tour" / "National tour" line. It shipped with the tour
// launch (BRO-4211 Phase D) without the owner approving it on its own.
test('top card has no On tour / National tour line', () => {
  assert.ok(!TRUST_LINES.includes('on-tour-line'), 'on-tour-line is back in ShowTrustLines.tsx');
  assert.ok(!TRUST_LINES.includes('on-tour-link'), 'on-tour-link is back in ShowTrustLines.tsx');
  assert.ok(!TRUST_LINES.includes('getToursOf'), 'ShowTrustLines.tsx reads getToursOf again');
  assert.ok(!PAGE.includes('on-tour-line'), 'on-tour-line is inline in page.tsx');
  assert.ok(!HERO.includes('on-tour-line'), 'on-tour-line is in ShowHeroRedesign.tsx');
});
