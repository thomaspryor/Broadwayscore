// Class guard for the Search Console "Not found (404)" alert of 2026-11-09:
// regional shows (1,287 of them) have no /theater/<venue> page, so any show-page
// venue link that can render /theater/<slug> must exclude category 'regional'
// first. The "Where" row in ShowPageBelowFold fell through to that link and
// every regional show page shipped a dead link that crawlers followed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = [
  'src/components/show-page/ShowPageBelowFold.tsx',
  'src/components/show-page/ShowHeroRedesign.tsx',
  'src/app/show/[slug]/page.tsx',
];
// A broadway-house link built from the show's own venue (not from a looked-up theater object).
const VENUE_THEATER_LINK = /`\/theater\/\$\{(?:venueSlug|slugify\(foldVenueName\(show\.venue\)\))\}`/g;
const WINDOW = 1200;
// A real branch condition ("|| isRegional", "isRegional ||", "isRegional ?"), not just a nearby mention.
const REGIONAL_EXCLUSION = /\|\|\s*isRegional\b|\bisRegional\s*(?:\|\||\?)|category === 'regional'\s*(?:\|\||\?)/;
// Tour shows have no house either; the same condition must exclude them.
const TOUR_EXCLUSION = /\bisTour\b|category === 'tour'/;

test('every show-page /theater/<venue> link sits behind a regional exclusion', () => {
  let seen = 0;
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let m;
    VENUE_THEATER_LINK.lastIndex = 0;
    while ((m = VENUE_THEATER_LINK.exec(src))) {
      seen++;
      const before = src.slice(Math.max(0, m.index - WINDOW), m.index);
      assert.match(before, REGIONAL_EXCLUSION, `${rel}: /theater/ venue link has no regional exclusion within ${WINDOW} chars`);
      assert.match(before, TOUR_EXCLUSION, `${rel}: /theater/ venue link has no tour exclusion within ${WINDOW} chars`);
    }
  }
  assert.ok(seen >= 3, `expected to find the 3 show-page venue links, found ${seen} (pattern drifted?)`);
});
