// Off-Broadway venue names must link to /off-broadway/theater/<slug> in every
// show-page surface that names the venue. The redesigned hero and the details
// block both rendered the venue as plain text for off-Broadway, so shows at
// Orpheum or St. Ann's Warehouse had no way into the venue page. The slug is
// resolved once in page.tsx (null when the freeform venue string has no page)
// and passed down; this guard fails if a surface stops using it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const PAGE = read('src/app/show/[slug]/page.tsx');
const HERO = read('src/components/show-page/ShowHeroRedesign.tsx');
const BELOW_FOLD = read('src/components/show-page/ShowPageBelowFold.tsx');

test('page.tsx passes the resolved off-Broadway venue slug to hero and below-fold', () => {
  const passes = PAGE.match(/offBroadwayVenueSlug=\{offBroadwayTheater\?\.slug \?\? null\}/g) ?? [];
  assert.equal(passes.length, 2, 'expected the slug to be passed to both ShowHeroRedesign and ShowPageBelowFold');
});

test('hero links off-Broadway venues to the venue page', () => {
  assert.ok(HERO.includes('`/off-broadway/theater/${offBroadwayVenueSlug}`'), 'hero must link to /off-broadway/theater/<slug>');
});

test('below-fold details link off-Broadway venues to the venue page', () => {
  assert.ok(BELOW_FOLD.includes('`/off-broadway/theater/${offBroadwayVenueSlug}`'), 'below-fold must link to /off-broadway/theater/<slug>');
});
