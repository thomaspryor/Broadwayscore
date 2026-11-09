// Guard for the phone "Tap to rate" star row on the show page (BRO-7074).
//
// Owner decision 2026-11-07: mobile web gets the same tappable star row the iOS
// app has. A first tap on a star opens the rating panel pre-filled. These checks
// pin the parts a later edit could silently break: the row is phones-only, the
// Rate it button yields to it only on phones, the tap targets stay at or above
// the 44px touch minimum, and the row neither flashes nor accepts stray keys.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hero = readFileSync(join(ROOT, 'src/components/show-page/ShowHeroRedesign.tsx'), 'utf8');
const stars = readFileSync(join(ROOT, 'src/components/user/StarRating.tsx'), 'utf8');

describe('mobile web star row on the show page', () => {
  test('only offered for a first rating on a show the viewer could have seen', () => {
    // The decision lives in src/lib/mobile-star-row.ts (behaviour tested in mobile-star-row-state.test.ts);
    // here we only pin that the hero uses it, and feeds it the signed-out local rating and the loaded flag.
    assert.match(hero, /getMobileStarRowState\(\{ showRateButton, hasRating, hasLocalRating: !!localRating, ratingStateKnown \}\)/);
    assert.match(hero, /const showMobileStars = mobileStarState !== 'hidden';/);
    assert.match(hero, /\.finally\(\(\) => setReviewsLoadedFor\(uid\)\)/);
  });

  test('row is phones-only and reuses the poster-stars pick handler with fill sizing', () => {
    const row = hero.match(/\{userFeaturesEnabled && showMobileStars && \([\s\S]*?\n      \)\}/);
    assert.ok(row, 'star row block not found');
    assert.match(row[0], /sm:hidden /);
    // While the viewer's ratings are still loading the row keeps its space but cannot be seen or tapped.
    assert.match(row[0], /mobileStarState === 'pending' \? 'invisible'/);
    assert.match(row[0], /inert=\{mobileStarState === 'pending'\}/);
    assert.match(row[0], /arrowKeys=\{false\}/);
    assert.match(row[0], /onRatingChange=\{handlePosterStarsPick\}/);
    assert.match(row[0], /\bfill\b/);
  });

  test('Rate it button is hidden on phones only while the star row shows', () => {
    assert.match(hero, /showMobileStars \? 'hidden sm:flex' : 'flex'/);
  });

  test('button grid keeps its columns in step with the hidden Rate it button', () => {
    assert.match(hero, /showMobileStars \? 'grid-cols-\[1fr_auto\] sm:grid-cols-\[1fr_1fr_auto\]'/);
    assert.match(hero, /showMobileStars \? 'grid-cols-1 sm:grid-cols-2'/);
  });

  test('phone star buttons are at least 44px tall and share the row width', () => {
    const m = stars.match(/fill \? 'flex h-(\d+) min-w-0 flex-1/);
    assert.ok(m, 'fill-mode star button classes not found');
    const px = Number(m[1]) * 4; // tailwind h-N = N * 4px
    assert.ok(px >= 44, `star button is ${px}px tall, below the 44px touch minimum`);
  });

  test('arrowKeys=false really stops arrow presses from committing a rating', () => {
    assert.match(stars, /arrowKeys = true/);
    assert.match(stars, /if \(readOnly \|\| !arrowKeys\) return;/);
  });
});
