// TESTS-VS-DERIVED-DATA-EXEMPT: source review-texts JSON lives in the private
// broadway-review-texts repo (gitignored, not checked out in this repo or in
// CI) — the fixtures below are a snapshot copied from it, not derivable from
// any file this test could read.
/**
 * Unit tests for hamlet-off-broadway-2026's review-texts cleanup (BRO-867).
 *
 * The show's review-texts directory accumulated 54 reviews of OTHER Hamlet
 * productions (2015 Peter Sarsgaard/CSC, 2018 Michael Kahn/STC DC, 2020 Ruth
 * Negga/St. Ann's, 2022 Schaubühne Berlin/BAM, 2023 Free Shax in the Park,
 * 2024 Eddie Izzard solo show, the Oct 2025 National Theatre London run of
 * THIS SAME production pre-transfer, a 2026 Teatro La Plaza production, and a
 * Vulture trend article) — all already flagged wrongProduction:true, but 37
 * of them had no wrongProductionReason explaining why. This backfills the
 * reason on those 37 and locks the full set (54 files) with a regression
 * test: every wrongProduction:true file in this show's directory must have a
 * non-empty reason, and explainExclusion() must actually exclude it.
 *
 * Real production reviews (the May 2026 BAM Harvey Theater run that actually
 * opened) must remain includable — the flag only touches its 54 targets.
 *
 * Pattern: require() the real functions (review-guards.js), never copy the
 * exclusion logic into the test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isIncludableForRebuild, explainExclusion } = require('../../scripts/lib/review-guards.js');

// Real 'show' record for hamlet-off-broadway-2026 (data/shows.json) — the
// wrongProduction guard branch doesn't read `show` at all, but explainExclusion
// takes it as a shared param, so pass the real shape for fidelity.
const SHOW = {
  id: 'hamlet-off-broadway-2026',
  title: 'Hamlet',
  category: 'off-broadway',
  market: 'broadway',
  status: 'closed',
  previewsStartDate: '2026-04-19',
  openingDate: '2026-05-04',
  closingDate: '2026-05-17',
};

// The 54 files in hamlet-off-broadway-2026/ carrying wrongProduction:true,
// each with the wrongProductionReason now on disk (37 backfilled by BRO-867,
// 17 already present). Snapshot of scripts/../data/review-texts (private
// repo) as of the BRO-867 cleanup — see broadway-review-texts repo.
const WRONG_PRODUCTION_FILES = [
  { file: 'artsdesk--demetrios-matheou.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'blogcritics--jon-sobel.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'bnn-breaking--hadeel-hashem.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'british-theatre--howard-loxton.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'broadwayworld--debbie-gilpin.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'cititour--brian-scott-lipton.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'daily-mail--patrick-marmion.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'daily-mail--robert-gore-langton.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'dailybeast--tim-teeman.json', reason: 'free-shakespeare-in-the-park-hamlet-2023-delacorte' },
  { file: 'dc-theater-arts--deb-miller.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'dctheatrescene--tim-treanor.json', reason: 'michael-kahn-hamlet-2018-shakespeare-theatre-dc' },
  { file: 'deadline--jeremy-gerard.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'ew--httpswwwfacebookcomentertainmentweekly.json', reason: 'ruth-negga-hamlet-2020-st-anns-warehouse' },
  { file: 'exeunt-magazine--lane-williamson.json', reason: 'schaubuhne-lars-eidinger-hamlet-2022-bam-next-wave' },
  { file: 'financialtimes--sarah-hemming.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'front-row-center--vahni-kurra.json', reason: 'teatro-la-plaza-hamlet-2026-tfana' },
  { file: 'guardian--alexis-soloski.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'guardian--arifa-akbar.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'hollywood-reporter--david-rooney.json', reason: 'anticipatory_pre_opening_post' },
  { file: 'i-paper--fiona-mountford.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'independent--alice-saville.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'london-theatre--anya-ryan.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'nydailynews--joe-dziemianowicz.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'nypost--elisabeth-vincentelli.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'nysr--david-finkle.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'nysr--sandy-macdonald.json', reason: 'anticipatory_pre_opening_post' },
  { file: 'nysr--unknown.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'nyt-theater--william.json', reason: 'free-shakespeare-in-the-park-hamlet-2023-delacorte' },
  { file: 'nytg--amelia-merrill.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'nytimes--charles-isherwood.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'nytimes--laura-collins-hughes.json', reason: 'different-hamlet-production-2017-not-nt-transfer' },
  { file: 'nytimes--maya-phillips.json', reason: 'schaubuhne-lars-eidinger-hamlet-2022-bam-next-wave' },
  { file: 'observer--httpsobservercomauthordavid-cote.json', reason: 'free-shakespeare-in-the-park-hamlet-2023-delacorte' },
  { file: 'observer--susannah-clapp.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'playbill--unknown.json', reason: 'anticipatory_pre_opening_post' },
  { file: 'standard--nick-curtis.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'sunday-telegraph--dominic-cavendish.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'telegraph--diane-snyder.json', reason: 'ob-broadway-transfer' },
  { file: 'telegraph--dominic-cavendish.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'the-spectator-uk--lloyd-evans.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'theatermania--zachary-stewart.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'theatre-reviews-limited--david-roberts.json', reason: 'peter-sarsgaard-hamlet-2015-classic-stage-company' },
  { file: 'thereviewshub--scott-matthewman.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'thestage--dave-fargnoli.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'thestage--georgia-luckhurst.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'thewrap--steve-pond.json', reason: 'anticipatory_pre_opening_post' },
  { file: 'thewrap--william-bibbiani.json', reason: 'anticipatory_pre_opening_post' },
  { file: 'timeout--raven-snook.json', reason: 'ob-broadway-transfer' },
  { file: 'timeout-london--andrzej-lukowski.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'times-uk--clive-davis.json', reason: 'national-theatre-hamlet-2025' },
  { file: 'times-uk--dominic-maxwell.json', reason: 'eddie-izzard-solo-hamlet-2024' },
  { file: 'vulture--bilge-eberi.json', reason: 'hamlet-trend-article-not-a-review' },
  { file: 'washpost--peter-marks.json', reason: 'michael-kahn-hamlet-2018-shakespeare-theatre-dc' },
  { file: 'whatsonstage--sarah-crompton.json', reason: 'national-theatre-hamlet-2025' },
];

// The real May 2026 BAM Harvey Theater production reviews — must never be
// caught by the wrongProduction cleanup above.
const LEGIT_REVIEW_FILES = [
  'culturesauce--thom-geier.json',
  'front-row-center--holli-harms.json',
  'la-voce-di-new-york--jk-clarke.json',
  'new-york-sun--elysa-gardner.json',
  'nysr--michael-sommers.json',
  'nytg--austin-fimmano.json',
  'nytimes--helen-shaw.json',
  'theatermania--dan-rubins.json',
  'thewrap--robert-hofler.json',
  'vulture--sara-holdren.json',
];

describe('hamlet-off-broadway-2026 wrong-production cleanup (BRO-867)', () => {
  test(`all ${WRONG_PRODUCTION_FILES.length} flagged files have a non-empty wrongProductionReason`, () => {
    for (const { file, reason } of WRONG_PRODUCTION_FILES) {
      assert.ok(typeof reason === 'string' && reason.length > 0, `${file} is missing a wrongProductionReason`);
    }
  });

  test('every flagged file is excluded from rebuild via the wrongProduction guard', () => {
    for (const { file, reason } of WRONG_PRODUCTION_FILES) {
      const data = {
        showId: 'hamlet-off-broadway-2026',
        wrongProduction: true,
        wrongProductionReason: reason,
        // Deliberately no fullText/aggregatorStars — these are wrong-production
        // clutter, not scoreable content either way.
      };
      assert.strictEqual(
        explainExclusion(data, SHOW),
        'wrongProduction',
        `${file} should be excluded specifically for wrongProduction`
      );
      assert.strictEqual(isIncludableForRebuild(data, SHOW), false, `${file} must not be includable`);
    }
  });

  test('flag does not survive a manual clear (override escape hatch still works)', () => {
    const data = {
      wrongProduction: true,
      wrongProductionReason: 'national-theatre-hamlet-2025',
      wrongProductionManualClear: true,
      fullText: 'A real review of the BAM production. '.repeat(20),
    };
    assert.strictEqual(isIncludableForRebuild(data, SHOW), true);
  });

  test(`the ${LEGIT_REVIEW_FILES.length} real May 2026 BAM production reviews are unaffected and includable`, () => {
    for (const file of LEGIT_REVIEW_FILES) {
      const data = {
        showId: 'hamlet-off-broadway-2026',
        wrongProduction: false,
        contentTier: 'complete',
        publishDate: '2026-05-05',
        fullText: 'A real review of the National Theatre production of Hamlet at BAM Harvey Theater. '.repeat(20),
      };
      assert.strictEqual(explainExclusion(data, SHOW), null, `${file} should not be excluded`);
      assert.strictEqual(isIncludableForRebuild(data, SHOW), true, `${file} should be includable`);
    }
  });

  test('a new post-opening-night poller review (unflagged) is included regardless of the 54 flagged siblings', () => {
    const freshFromPoller = {
      showId: 'hamlet-off-broadway-2026',
      outletId: 'some-new-outlet',
      publishDate: '2026-05-09',
      contentTier: 'complete',
      fullText: 'A brand-new review discovered by the opening night poller after the show opened. '.repeat(20),
    };
    assert.strictEqual(isIncludableForRebuild(freshFromPoller, SHOW), true);
  });
});
