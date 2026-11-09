// BRO-7085: Time Out keeps one evergreen url per title and re-dates it when a
// show returns, so the stored publishDate is the republish date and the date
// gates (21d/35d) pass. The page's own "This review is from <year>" line is the
// only signal. Real functions only (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateDateGuard } = require('../../scripts/lib/date-guard.js');
const { textNamesEarlierRun, republishGuardOpen } = require('../../scripts/lib/run-contamination.js');

// Verbatim page heads from data/review-texts (private repo), trimmed.
const OAK_TREE = {
  outletId: 'timeout-london',
  url: 'https://www.timeout.com/london/theatre/an-oak-tree-review',
  publishDate: '2026-09-22',
  fullText: 'Review An Oak Tree 4 out of 5 stars Starring a different celebrity each night, Tim Crouch’s experimental meditation on the nature of grief remains a thing of wonder Theatre, West End The Other Palace, Victoria 9 Oct 15 Nov 2026 Recommended Wednesday 23 September 2026 Share Copy Link Written by Tim Bano Theatre freelancer Advertising Time Out says This review is from 2025. An Oak Tree returns yet again for 2026 as part of a season at The Other Palace.',
};
const OAK_SHOW = { id: 'an-oak-tree-off-west-end-2026', title: 'An Oak Tree', category: 'off-west-end', market: 'west-end', previewsStartDate: '2026-10-07', openingDate: '2026-10-08' };

const DINO = {
  outletId: 'timeout-london',
  url: 'https://www.timeout.com/london/theatre/dinosaur-world-livereview',
  publishDate: '2026-06-07',
  fullText: 'Review Dinosaur World Live 3 out of 5 stars Charming dino-puppet fun for ages three and above Theatre, Children\'s Troubadour Wembley Park Theatre, Wembley 3 Aug 6 Sept 2026 Recommended Monday 8 June 2026 Share Copy Link Written by Andrzej Lukowski Theatre Editor, UK Advertising Time Out says This review is from the 2018 Regent’s Park Open Air Theatre run for Dinosaur World Live . The last time the beasts of the Mesozoic era descended upon Regent’s Park it was for Dinosaur Zoo.',
  allowEarlyDate: true,
  wrongProductionManualClear: true,
  humanReviewedWrongProduction: false,
};
const DINO_SHOW = { id: 'dinosaur-world-live-off-west-end-2026', title: 'Dinosaur World Live', category: 'off-west-end', market: 'west-end', previewsStartDate: '2026-07-28', openingDate: '2026-08-01' };

test('An Oak Tree: the date gate passes the republish date, the page marker does not', () => {
  const gate = evaluateDateGuard({ pubDate: new Date(OAK_TREE.publishDate), show: OAK_SHOW, outletId: OAK_TREE.outletId });
  assert.equal(gate.flag, false, 'publishDate 2026-09-22 is inside the 21d window, so the date gate alone cannot catch it');
  assert.equal(textNamesEarlierRun(OAK_TREE, OAK_SHOW), true);
});

test('Dinosaur World Live: date gate fires and the marker names the 2018 run', () => {
  const gate = evaluateDateGuard({ pubDate: new Date(DINO.publishDate), show: DINO_SHOW, outletId: DINO.outletId });
  assert.equal(gate.flag, true);
  assert.equal(textNamesEarlierRun(DINO, DINO_SHOW), true);
});

test('a declared prior run makes the marker the same production\'s own coverage', () => {
  const show = { ...OAK_SHOW, priorRuns: [{ openingDate: '2025-03-01', closingDate: '2025-04-30', venue: 'Young Vic' }] };
  assert.equal(textNamesEarlierRun(OAK_TREE, show), false);
});

test('a play\'s own history in the middle of a review is not a marker', () => {
  const r = { ...OAK_TREE, fullText: 'x '.repeat(900) + 'The play was first published in 1962 and this review is from the heart.' };
  assert.equal(textNamesEarlierRun(r, OAK_SHOW), false);
});

test('republish guard stays open over a SCRIPT clear (the An Oak Tree re-clear)', () => {
  const scriptCleared = {
    wrongProductionManualClear: true,
    wrongProductionOverride: true,
    wrongProductionOverrideSetBy: 'clear-stale-wrong-production-flags.js',
  };
  assert.equal(republishGuardOpen(scriptCleared, { auditOpen: false }), true);
});

test('republish guard stays shut over a person\'s clear (Dinosaur World Live) and lane holds', () => {
  assert.equal(republishGuardOpen(DINO, { auditOpen: false }), false);
  assert.equal(republishGuardOpen({ wrongProductionManualClear: true }, { auditOpen: false }), false, 'hand-set clear has no .js setter');
  assert.equal(republishGuardOpen({ wrongProductionManualClear: true, wrongProductionOverrideSetBy: 'x.js', allowEarlyDate: true }, { auditOpen: false }), false);
  assert.equal(republishGuardOpen({ wrongProductionManualClear: true, wrongProductionOverrideSetBy: 'x.js' }, { auditOpen: false, laneHeld: true }), false);
  assert.equal(republishGuardOpen({}, { auditOpen: true }), true);
});

test('wiring: the sweep and the rebuild both call the shared predicates', () => {
  const sweep = readFileSync(new URL('../../scripts/clear-stale-wrong-production-flags.js', import.meta.url), 'utf8');
  assert.equal((sweep.match(/textNamesEarlierRun\(/g) || []).length, 2, 'scan-time and apply-time');
  const rebuild = readFileSync(new URL('../../scripts/rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(rebuild, /republishGuardOpen\(d, \{ auditOpen: wpAuditOpen/);
});

test('a book\'s own republication in the same sentence is not a marker (The Pianist, Stage Door)', () => {
  const show = { id: 'the-pianist-off-west-end-2026', title: 'The Pianist', category: 'off-west-end', market: 'west-end', previewsStartDate: '2026-10-20', openingDate: '2026-10-23' };
  const r = { publishDate: '2026-10-25', fullText: 'An extraordinary story played beautifully ⭐⭐⭐⭐ What’s it about? The Pianist began as Władysław Szpilman’s account of surviving the Holocaust in Warsaw. First published in 1946 as Death of a City, the memoir was withdrawn by Poland’s censors before being republished in 1998 through the efforts of his son, Andreas.' };
  assert.equal(textNamesEarlierRun(r, show), false);
});

test('article datelines that use a work word still match (story/film/play)', () => {
  const { republishMarker } = require('../../scripts/lib/run-contamination.js');
  assert.equal(republishMarker('This story was originally published in The Guardian on 12 May 2021.')?.year, 2021);
  assert.equal(republishMarker('A version of this story was originally published in Time Out on May 3, 2023.')?.year, 2023);
  assert.equal(republishMarker('Theater Film Music Originally published on May 3 2021')?.year, 2021);
  assert.equal(republishMarker('This story was republished in 2022 with new reporting.')?.year, 2022);
  assert.equal(republishMarker('the memoir was withdrawn by censors before being republished in 1998'), null);
});
