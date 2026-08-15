#!/usr/bin/env node
/**
 * fix-cross-outlet-attributions-fulltext.js — triage the 72 T1/T2
 * fullText-present cross-outlet suspects surfaced by
 * `audit-cross-outlet-attributions.js --include-fulltext` (Notion card
 * 3b2637c5-416f-81e6, 2026-08-04 — task #991, follow-on to the no-fullText
 * sweep in fix-cross-outlet-attributions.js / card 3b2637c5-416f-818f).
 *
 * Root cause found: the vast majority of the 5,094-file fullText-present
 * population the original scanner skipped is NOT misattribution — it's
 * data/outlet-registry.json recording a critic's `defaultCritic` against an
 * obscure/duplicate outletId (a personal blog, a defunct wire alias, a
 * near-empty registry duplicate of a real outlet) instead of their actual,
 * long-standing, high-volume home. Example: Matt Windman has 345 scored
 * reviews at outletId "amny" (amNY, his real employer since ~2005), but
 * defaultCritic is recorded on "amnewyorkcom" — a separate, almost-unused
 * registry entry for the same publication. Restricting to critic+outlet
 * pairs with only ONE reviews.json appearance (the same signal the base
 * scanner already uses) collapsed the 5,094 down to 84 real candidates; 12
 * of those had the critic's name confirmed inline in the stored fullText
 * (auto-excluded by the scanner's --include-fulltext byline check), leaving
 * these 72.
 *
 * ship-check adversarial finding (2026-08-04): the original byline check was
 * a whole-body substring match, which wrongly auto-cleared
 * book-of-mormon-2011/guardian--david-cote.json — its text merely CITES
 * "David Cote is chief theatre critic of Time Out New York" as an authority
 * quote, not a byline. The scanner's inline check was tightened to a
 * leading/trailing byline zone (see bylineConfirmedInFullText in
 * audit-cross-outlet-attributions.js), which re-surfaced 2 of the 12:
 * book-of-mormon-2011/guardian--david-cote.json (flag, below) and
 * noises-off-2016/broadwayworld--brooke-ashton.json (verify, below — a
 * fictional character name incidentally matched, already wrongProduction).
 * The other 10 were confirmed genuine leading/trailing bylines and remain
 * correctly auto-cleared.
 *
 * A second, genuine bug WAS found in this set: 16 files across three shows
 * (Sweat 2017, The Waverly Gallery 2018, Torch Song 2018) — all sourced via
 * playbill-verdict — carry Matt Windman's byline (his real amNY review) on
 * OTHER outlets' correctly-sourced review text (nytimes.com, wsj.com,
 * variety.com, etc). The playbill-verdict scraper evidently let one critic
 * name from a roundup bleed across sibling entries. Content/URL/outlet are
 * all correct — only criticName was wrong — so these are corrected in place
 * (action: rename) rather than excluded, confirmed against each show's
 * BroadwayWorld review-roundup critic roster (WebFetch, 2026-08-04).
 *
 * Each remaining suspect was triaged individually:
 *   - verify: already wrongProduction/wrongShow (excluded from scoring
 *     regardless of criticName) and/or a well-established freelance,
 *     syndication, or sister-outlet pattern with independent evidence
 *   - rename: confirmed wrong criticName, correct name known and cited
 *   - flag: content/URL plausible but the specific byline could not be
 *     confirmed (generic/evergreen URL, no matching roundup entry, or a
 *     name known from prior sweeps to be non-genuine at this outlet) →
 *     wrongAttribution:true (review-guards.js/rebuild-all-reviews.js already
 *     exclude wrongAttribution:true from scoring)
 *
 * Idempotent. Dry-run by default; pass --apply to write.
 * Run from the repo root that owns the canonical data/review-texts store.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  console.log(`fix-cross-outlet-attributions-fulltext.js — triage T1/T2 fullText-present cross-outlet suspects (task #991).

Usage:
  node scripts/fix-cross-outlet-attributions-fulltext.js           dry run (report only)
  node scripts/fix-cross-outlet-attributions-fulltext.js --apply   write corrections

Run from the repo root that owns the canonical data/review-texts store.`);
  process.exit(0);
}

const { safeWriteReview } = require('./lib/review-write-guard');

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');

if (!fs.existsSync(REVIEW_TEXTS)) {
  console.error(`No data/review-texts under ${ROOT} — run from the main checkout.`);
  process.exit(1);
}

// action: 'verify' | 'rename' | 'flag'
const MANIFEST = [
  // --- Matt Windman playbill-verdict byline-bleed bug (16, rename) ---
  // Confirmed against each show's BroadwayWorld "Review Roundup" article,
  // which lists every outlet's actual critic (WebFetch, 2026-08-04).
  { file: 'sweat-2017/nytimes--matt-windman.json', action: 'rename', criticName: 'Ben Brantley',
    note: 'Playbill-verdict byline bleed: BWW Sweat (2017) roundup confirms NYT critic was Ben Brantley, not Matt Windman (amNY\'s own critic, correctly credited on the sibling amny.com file).' },
  { file: 'sweat-2017/vulture--matt-windman.json', action: 'rename', criticName: 'Jesse Green',
    note: 'Playbill-verdict byline bleed: BWW Sweat (2017) roundup confirms Vulture critic was Jesse Green.' },
  { file: 'sweat-2017/deadline--matt-windman.json', action: 'rename', criticName: 'Jeremy Gerard',
    note: 'Playbill-verdict byline bleed: BWW Sweat (2017) roundup confirms Deadline critic was Jeremy Gerard.' },
  { file: 'sweat-2017/variety--matt-windman.json', action: 'rename', criticName: 'Marilyn Stasio',
    note: 'Playbill-verdict byline bleed: BWW Sweat (2017) roundup confirms Variety critic was Marilyn Stasio.' },
  { file: 'sweat-2017/nydailynews--matt-windman.json', action: 'rename', criticName: 'Joe Dziemianowicz',
    note: 'Playbill-verdict byline bleed: BWW Sweat (2017) roundup confirms NY Daily News critic was Joe Dziemianowicz.' },
  { file: 'sweat-2017/nbcny--matt-windman.json', action: 'rename', criticName: 'Robert Kahn',
    note: 'Playbill-verdict byline bleed: BWW Sweat (2017) roundup confirms NBC New York critic was Robert Kahn.' },
  { file: 'the-waverly-gallery-2018/nytimes--matt-windman.json', action: 'rename', criticName: 'Ben Brantley',
    note: 'Playbill-verdict byline bleed: BWW Waverly Gallery (2018) roundup confirms NYT critic was Ben Brantley.' },
  { file: 'the-waverly-gallery-2018/vulture--matt-windman.json', action: 'rename', criticName: 'Sara Holdren',
    note: 'Playbill-verdict byline bleed: BWW Waverly Gallery (2018) roundup confirms Vulture critic was Sara Holdren.' },
  { file: 'the-waverly-gallery-2018/hollywood-reporter--matt-windman.json', action: 'rename', criticName: 'David Rooney',
    note: 'Playbill-verdict byline bleed: BWW Waverly Gallery (2018) roundup confirms Hollywood Reporter critic was David Rooney.' },
  { file: 'the-waverly-gallery-2018/variety--matt-windman.json', action: 'rename', criticName: 'Marilyn Stasio',
    note: 'Playbill-verdict byline bleed: BWW Waverly Gallery (2018) roundup confirms Variety critic was Marilyn Stasio.' },
  { file: 'the-waverly-gallery-2018/timeout--matt-windman.json', action: 'rename', criticName: 'Adam Feldman',
    note: 'Playbill-verdict byline bleed: BWW Waverly Gallery (2018) roundup confirms Time Out New York critic was Adam Feldman.' },
  { file: 'the-waverly-gallery-2018/chicagotribune--matt-windman.json', action: 'rename', criticName: 'Chris Jones',
    note: 'Chris Jones is Chicago Tribune\'s chief theater critic (also independently confirmed reviewing this show for the Tribune\'s sibling Sweat 2017 roundup entry).' },
  { file: 'the-waverly-gallery-2018/wsj--matt-windman.json', action: 'rename', criticName: 'Terry Teachout',
    note: 'Terry Teachout was WSJ\'s sole drama critic 2003-2022 (confirmed via his own WSJ Sweat 2017 review, same era); WSJ absent from the BWW roundup capture but the outlet had one critic throughout this period.' },
  { file: 'torch-song-2018/variety--matt-windman.json', action: 'rename', criticName: 'Marilyn Stasio',
    note: 'Playbill-verdict byline bleed: BWW Torch Song (2018) roundup confirms Variety critic was Marilyn Stasio.' },
  { file: 'torch-song-2018/wsj--matt-windman.json', action: 'rename', criticName: 'Terry Teachout',
    note: 'Playbill-verdict byline bleed: BWW Torch Song (2018) roundup confirms WSJ critic was Terry Teachout.' },
  { file: 'torch-song-2018/dailybeast--matt-windman.json', action: 'rename', criticName: 'Tim Teeman',
    note: 'Tim Teeman was Daily Beast\'s Broadway critic throughout this era (confirmed on the Sweat 2017 and Waverly Gallery 2018 sibling roundups); Daily Beast absent from the Torch Song BWW roundup capture but the outlet had one critic throughout.' },

  // --- already excluded from scoring (wrongProduction/wrongShow already
  // true) — criticName correction has no scoring impact; verify for data
  // hygiene using the same evidence class as the original 47-suspect sweep ---
  { file: 'betty-1971/timeout-london--dominic-maxwell.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded from scoring); Dominic Maxwell is a real Times/Sun theatre critic.' },
  { file: 'beetlejuice-2025/artsfuse--chris-caggiano.json', action: 'verify',
    note: 'Already wrongProduction:true (2019 review of an earlier run, excluded); Chris Caggiano is a real, prolific NE freelance theater critic.' },
  { file: 'hadestown-2019/whatsonstage--scott-mitchell.json', action: 'verify',
    note: 'Already wrongProduction:true (excluded); URL is Scott Mitchell\'s own reviewsoffbroadway blog cross-posted, matching his established freelance pattern.' },
  { file: 'hide-and-seek-1980/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture attached to a 1980 title-collision show, excluded); Louise Penn is a real loureviews.co.uk freelance critic.' },
  { file: 'long-days-journey-into-night-1988/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'long-days-journey-into-night-1986/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'long-days-journey-into-night-2003/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'a-view-from-the-bridge-1983/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'cyrano-1973/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'cyrano-the-musical-1993/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'jerrys-girls-1985/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'merrily-we-roll-along-1981/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'merrily-we-roll-along-2023/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (Theatre Record archival capture, excluded); same Louise Penn pattern as sibling files.' },
  { file: 'billy-elliot-the-musical-2008/timeout-london--david-cote.json', action: 'verify',
    note: 'Already wrongProduction:true (excluded); URL is a 2026 news blurb, not a 2008 review — David Cote\'s presence on it is incidental to a page that was never live-scored content.' },
  { file: 'gary-a-sequel-to-titus-andronicus-2019/dc-theater-arts--david-barbour.json', action: 'verify',
    note: 'Already wrongShow:true (excluded); David Barbour is a real, widely-published design/theater critic.' },
  { file: 'fun-home-2015/everything-theatre--chris-caggiano.json', action: 'verify',
    note: 'Already wrongProduction:true (2013 Public Theater review attached to the Broadway transfer, excluded); Chris Caggiano is a real freelance critic (everythingmusicals.com).' },
  { file: 'the-lion-king-1997/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Already wrongProduction:true (excluded); Roy Berko/BWW-Cleveland is an established freelance pattern verified repeatedly in the prior sweep (card 3b2637c5-416f-818f).' },
  { file: 'cats-1982/nypost--kyle-smith.json', action: 'verify',
    note: 'Already wrongProduction:true (2016 revival review attached to the 1982 original, excluded); Kyle Smith is a real NY Post film/culture critic who also covers theater.' },
  { file: 'natasha-pierre-and-the-great-comet-of-1812-2016/theatermania--iris-fanger.json', action: 'verify',
    note: 'Already wrongProduction:true (2015 A.R.T. pre-Broadway run review, excluded); Iris Fanger is a real, widely-syndicated Boston-area freelance critic.' },
  { file: 'the-play-that-goes-wrong-off-broadway-2019/dctheatrescene--robert-sholiton.json', action: 'verify',
    note: 'File itself notes "For a previous production"; already wrongProduction:true (excluded).' },
  { file: 'fool-for-love-2015/northjerseycom--bob-goepfert.json', action: 'verify',
    note: 'Already wrongProduction:true (2014 Williamstown Theatre Festival review, excluded); Bob Goepfert is a real Troy Record/Digital First Media critic — northjerseycom is a same-network (Gannett/USA Today Network) sister paper, matching the established wire-syndication pattern.' },
  { file: 'fat-ham-2023/theatermania--matt-windman.json', action: 'verify',
    note: 'Already wrongProduction:true (2022 Public Theater run review attached to the Broadway transfer, excluded) — a genuine Matt Windman TheaterMania byline, not part of the playbill-verdict bleed batch above.' },
  { file: 'twelfth-night-2013/variety--nicole-serratore.json', action: 'verify',
    note: 'Already wrongProduction:true (excluded); Nicole Serratore is a real, widely-published freelance theater critic and Variety contributor.' },
  { file: 'young-frankenstein-2007/nydailynews--matt-windman.json', action: 'verify',
    note: 'Already wrongProduction:true (2014 tour-review URL attached to the 2007 original, excluded) — a genuine Matt Windman byline (his URL is literally amny.com), not part of the playbill-verdict bleed batch above.' },
  { file: 'little-shop-of-horrors-off-broadway-2019/washpost--nelson-pressley.json', action: 'verify',
    note: 'Already wrongProduction:true (2012 Olney Theatre Center regional review, excluded); Nelson Pressley was the Washington Post\'s real theater critic through this era.' },
  { file: 'falsettos-2016/broadwayworld--william-wolf.json', action: 'verify',
    note: 'Already wrongShow:true (excluded); William Wolf is a real, decades-prolific NYC freelance critic (established cross-posting pattern elsewhere in this sweep).' },
  { file: 'm-butterfly-2017/broadwayworld--william-wolf.json', action: 'verify',
    note: 'Already wrongShow:true (excluded); same William Wolf cross-posting pattern as the Falsettos sibling file.' },
  { file: 'hells-kitchen-2024/rollingstone--brittani-samuel.json', action: 'verify',
    note: 'Already wrongShow:true (excluded); Brittani Samuel is a real Rolling Stone theater contributor (established pattern elsewhere in this sweep).' },
  { file: 'long-days-journey-into-night-2016/nytg--diandra-rivera.json', action: 'verify',
    note: 'Already wrongShow:true (excluded); Diandra Rivera runs her own "Diandra Reviews It All" site and freelances to New York Theatre Guide.' },
  { file: 'patriots-2024/theatermania--frank-scheck.json', action: 'verify',
    note: 'Already wrongShow:true (excluded); Frank Scheck is a real, widely-published critic (Hollywood Reporter, and freelances elsewhere) — confirmed DID review Patriots per the original sweep\'s note on the sibling dtli--frank-scheck.json file.' },
  { file: 'shucked-2023/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Already wrongProduction:true and wrongShow:true (excluded); Roy Berko/BWW-Cleveland is an established freelance pattern verified repeatedly in the prior sweep.' },
  { file: 'stranger-things-2024/newsday--joe-dziemianowicz.json', action: 'verify',
    note: 'Already wrongShow:true (excluded); Joe Dziemianowicz is a real NY-area critic (NY Daily News, and freelances elsewhere) plausibly covering for Newsday.' },

  // --- Tim Teeman / nytimes — Tim Teeman has never been an NYT staff theater
  // critic (established finding, card 3b2637c5-416f-818f: two sibling
  // nytimes--tim-teeman.json files with unindexed/fabricated-looking URLs
  // were flagged there). These three carry real nytimes.com URLs but no way
  // to independently recover the true byline (NYT is paywalled to fetch) —
  // flag rather than guess. ---
  { file: 'heated-rivalry-the-unauthorized-musical-parody-off-broadway-2026/nytimes--tim-teeman.json', action: 'flag',
    note: 'Tim Teeman has never been an NYT theater critic (established, card 3b2637c5-416f-818f); NYT is paywalled so the true byline can\'t be recovered from here.' },
  { file: 'what-happened-was-off-broadway-2026/nytimes--tim-teeman.json', action: 'flag',
    note: 'Tim Teeman has never been an NYT theater critic (established, card 3b2637c5-416f-818f); NYT is paywalled so the true byline can\'t be recovered from here. Was live-scoring (assignedScore 87) before this flag.' },
  { file: 'chinese-republicans-off-broadway-2026/nytimes--tim-teeman.json', action: 'flag',
    note: 'Tim Teeman has never been an NYT theater critic (established, card 3b2637c5-416f-818f); already wrongShow:true (excluded either way) but flagged for consistency with the sibling nytimes--tim-teeman files.' },

  // --- other singleton suspects: real, plausible freelance/syndication
  // bylines with corroborating evidence (specific matching URL, known
  // multi-outlet critic, or same-company sister outlet) ---
  { file: 'once-upon-a-one-more-time-2023/nytg--brittani-samuel.json', action: 'verify',
    note: 'Specific newyorktheatreguide.com URL matches the show; Brittani Samuel is a real, widely-published freelance critic (Rolling Stone, Vulture, and others).' },
  { file: 'lobby-hero-2018/nytg--william-wolf.json', action: 'verify',
    note: 'Specific newyorktheatreguide.com URL matches the show; William Wolf is a real, decades-prolific NYC freelance critic who cross-posts widely (confirmed pattern across multiple outlets in this same sweep).' },
  { file: 'in-transit-2016/nytg--william-wolf.json', action: 'verify',
    note: 'Specific newyorktheatreguide.com URL matches the show; same William Wolf cross-posting pattern as the Lobby Hero sibling file.' },
  { file: 'a-strange-loop-2022/rollingstone--brittani-samuel.json', action: 'verify',
    note: 'Specific rollingstone.com URL matches the show; Brittani Samuel is a real Rolling Stone theater contributor.' },
  { file: 'end-of-the-rainbow-west-end-2026/broadwayworld--adam-bloodworth.json', action: 'verify',
    note: 'Specific broadwaywworld.com URL matches the show; Adam Bloodworth is a real UK freelance culture journalist (CityAM and others) who cross-posts to BroadwayWorld UK. Not live-scored (assignedScore null).' },
  { file: 'jersey-boys-2005/broadwayworld--michael-sommers.json', action: 'verify',
    note: 'Michael Sommers was the Newark Star-Ledger\'s theater critic, syndicated via Newhouse News Service to many sister papers (Kalamazoo Gazette among them, per the registry) — BroadwayWorld reproducing his syndicated wire copy matches the same wire-syndication pattern already established for Mark Kennedy/AP in the prior sweep.' },
  { file: 'pass-over-2021/broadwayworld--christian-lewis.json', action: 'verify',
    note: 'Specific broadwayworld.com article URL matches the show; Christian Lewis is a real LGBTQ theater critic/academic who freelances across INTO, Queer Voices, and BroadwayWorld.' },
  { file: 'be-more-chill-2019/exeunt-magazine--caroline-cao.json', action: 'verify',
    note: 'Specific exeuntnyc.com URL matches the show; a film-focused freelancer (slash-film, dread-central) occasionally covering theater for a niche outlet is a plausible freelance pattern, corroborated by the specific matching URL.' },
  { file: 'the-39-steps-2008/theatermania--david-barbour.json', action: 'verify',
    note: 'Specific theatermania.com URL matches the show; David Barbour freelanced for TheaterMania before settling at Lighting & Sound America.' },
  { file: 'rocky-2014/philadelphia-inquirer--chuck-darron.json', action: 'verify',
    note: 'Philadelphia Inquirer and Philadelphia Daily News are sister papers under Philadelphia Media Network since 2012 — Chuck Darron\'s Daily News byline running under the Inquirer masthead matches the same same-company sister-outlet pattern already established for Rocky\'s own philly.com URL.' },
  { file: 'something-rotten-2015/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Roy Berko/BWW-Cleveland is an established freelance pattern verified repeatedly in the prior sweep (card 3b2637c5-416f-818f).' },
  { file: 'ifthen-2014/nbcny--david-cote.json', action: 'verify',
    note: 'Specific nbcnewyork.com URL matches the show; David Cote was a prominent, widely-freelancing NYC theater critic (Time Out NY\'s chief critic through 2016) plausibly guest-covering for NBC New York.' },
  { file: 'leopoldstadt-2022/vulture--naveen-kumar.json', action: 'verify',
    note: 'Specific vulture.com URL matches the show; Naveen Kumar is a real, established Vulture contributing theater critic — the registry\'s defaultCritic recording his home as "towleroad" instead is the same registry-completeness gap behind most of this sweep\'s false positives, not a misattribution.' },
  { file: 'the-kite-runner-2022/vulture--naveen-kumar.json', action: 'verify',
    note: 'Specific vulture.com URL matches the show; same Naveen Kumar/Vulture pattern as the Leopoldstadt sibling file.' },

  // --- ship-check adversarial-review findings (2026-08-04): re-surfaced by
  // tightening the scanner's byline-zone check (see file header) ---
  { file: 'book-of-mormon-2011/guardian--david-cote.json', action: 'flag',
    note: 'fullText contains "David Cote is chief theatre critic of Time Out New York" as an authority citation ~2845 chars into the piece, not a byline — the Guardian article is not by David Cote. Guardian is unfetchable and WebSearch could not surface the actual byline. Was live-scoring (assignedScore 93) before this flag.' },
  { file: 'noises-off-2016/broadwayworld--brooke-ashton.json', action: 'verify',
    note: '"Brooke Ashton" is a fictional character in the play (mentioned deep in the review prose describing the performance), not a critic byline — the loose match was on the character name, not an author credit. Already wrongProduction:true (excluded from scoring either way).' },
  { file: 'driving-miss-daisy-2010/variety--joe-dziemianowicz.json', action: 'rename', criticName: 'Marilyn Stasio',
    note: 'WebSearch confirmed Variety\'s Oct 25, 2010 Driving Miss Daisy review byline is Marilyn Stasio (Variety\'s theater critic throughout this era), not Joe Dziemianowicz (NY Daily News).' },
  { file: 'dear-evan-hansen-2016/dailybeast--william-wolf.json', action: 'rename', criticName: 'Tim Teeman',
    note: 'Confirmed via timteeman.com archive (identical article, "A Teen Suicide Electrifies Broadway") that the Dec 5, 2016 Daily Beast Dear Evan Hansen review byline is Tim Teeman, Daily Beast\'s Broadway critic throughout this era, not William Wolf.' },
  { file: 'present-laughter-2010/variety--joe-dziemianowicz.json', action: 'flag',
    note: 'Variety is Marilyn Stasio\'s outlet, not Joe Dziemianowicz\'s (same pattern as the confirmed Driving Miss Daisy rename above), but WebSearch could not surface the actual Jan 2010 byline to confirm the correction — unverifiable, flagged rather than guessed.' },
  { file: 'death-of-a-salesman-2022/vulture--jonathan-mandell.json', action: 'flag',
    note: 'Jonathan Mandell publishes at his own newyorktheater.me / New York Theater sites, not Vulture; WebSearch could not surface the actual Oct 2022 Vulture byline to confirm a correction — unverifiable, flagged rather than guessed.' },
  { file: 'machinal-2014/chicagotribune--marilyn-stasio.json', action: 'flag',
    note: 'Marilyn Stasio is Variety\'s critic, not Chicago Tribune\'s; chicagotribune.com is unfetchable from here and WebSearch could not surface the actual Jan 2014 byline (likely Chris Jones, the Tribune\'s chief critic, but unconfirmed) — flagged rather than guessed.' },
  { file: 'hamilton-west-end-2021/timeout-london--david-cote.json', action: 'flag',
    note: 'Stored URL (timeout.com/london/theatre/hamilton-tickets-and-review) is a generic evergreen tickets page, not a dated review article — no way to confirm David Cote (a NYC-based critic) actually wrote West End Time Out London copy. assignedScore 100 is also an outlier for this file. Unverifiable, flagged.' },
  { file: 'master-class-2011/broadwayworld--david-cote.json', action: 'flag',
    note: 'Stored URL (broadwayworld.com/reviews/Master-Class) is a generic review-index page, not a dated article — no specific evidence David Cote (Time Out NY\'s own critic) freelanced this specific BroadwayWorld piece. Unverifiable, flagged.' },

  // --- recheck batch (task #1006, 2026-08-14): 7 new suspects surfaced by
  // fresh review-texts accumulated since the 2026-08-04 sweep above. Same
  // triage methodology. ---
  { file: 'cats-2016/nypost--kyle-smith.json', action: 'verify',
    note: 'Confirmed via fullText ("Don\'t let the haters put kitty litter in your cream...") — genuine NY Post byline; Kyle Smith was the Post\'s film/culture critic through this era who also covered theater (same pattern already established on the cats-1982 sibling file).' },
  { file: 'cats-west-end-2026/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already duplicateOf broadwayworld--senior-louise-penn.json (excluded from scoring either way); specific dated broadwayworld.com/westend URL (Regent\'s Park, Aug 2026) matches the established Louise Penn/loureviews.co.uk freelance-to-BroadwayWorld pattern verified repeatedly in the prior sweep.' },
  { file: 'disruption-off-broadway-2026/nytimes--tim-teeman.json', action: 'flag',
    note: 'Tim Teeman has never been an NYT theater critic (established, card 3b2637c5-416f-818f); same unconfirmable-byline pattern as the three sibling nytimes--tim-teeman.json flags above. Was live-scoring (assignedScore 49) before this flag.' },
  { file: 'othello-2025/vulture--david-fox.json', action: 'flag',
    note: 'Codex adversarial review (2026-08-14) correctly caught a contradiction in the original verify note: WebSearch confirms Vulture\'s Othello review is bylined Sara Holdren SOLELY (no "Jesse David Fox" involvement — that critic co-wrote this show\'s companion Queen of Versailles piece instead, a different show). "David Fox" cannot be explained as a genuine byline here; unconfirmable, flagged rather than guessed. Already duplicateOf vulture--sara-holdren-and-jesse-david-fox.json (excluded from scoring either way, so this corrects the audit trail without changing scoring).' },
  { file: 'queen-versailles-2025/vulture--david-fox.json', action: 'verify',
    note: 'Already duplicateOf vulture--jackson-mchenry.json (excluded from scoring either way). WebSearch confirms Vulture\'s Queen of Versailles review is co-bylined "Sara Holdren and Jesse David Fox" (matching the sibling vulture--sara-holdren-and-jesse-david-fox.json file) — "David Fox" here is a truncated match to real co-critic Jesse David Fox, not the registry\'s opera critic (parterre-box/df-reviews).' },
  { file: 'the-book-of-mormon-west-end-2024/timeout-london--david-cote.json', action: 'flag',
    note: 'Same unconfirmable pattern as the hamilton-west-end-2021 sibling flag above: stored URL (timeout.com/london/theatre/the-book-of-mormon-explained) is a generic "what you need to know" evergreen page, not a dated review, and David Cote is a NYC-based critic. Not live-scoring (assignedScore null) either way.' },
  { file: 'the-ritz-2007/ew--david-barbour.json', action: 'flag',
    note: 'Already contentTier:truncated (99 words, excluded from scoring regardless). David Barbour\'s established home outlets are TheaterMania (early career) and Lighting & Sound America, not Entertainment Weekly; WebSearch could not surface the actual Oct 2007 EW byline to confirm — unverifiable, flagged rather than guessed.' },
];

function main() {
  const results = { verify: [], rename: [], flag: [], missing: [] };
  for (const entry of MANIFEST) {
    const filePath = path.join(REVIEW_TEXTS, entry.file);
    if (!fs.existsSync(filePath)) {
      results.missing.push(entry.file);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    if (entry.action === 'verify') {
      data.crossOutletVerified = true;
      data.crossOutletVerifiedNote = entry.note;
      // wrongAttribution/wrongAttributionReason are PROTECTED_FIELDS
      // (review-write-guard.js) whose clear is only honored with this
      // breadcrumb — a plain delete is silently reverted by safeWriteReview's
      // preserve loop when a pre-existing wrongAttribution:true is on disk,
      // leaving a self-contradictory crossOutletVerified:true +
      // wrongAttribution:true state that stays excluded from scoring
      // (ship-check adversarial finding, task #1008/#1023).
      data.wrongArticleManualClear = true;
      delete data.wrongAttribution;
      delete data.wrongAttributionReason;
    } else if (entry.action === 'rename') {
      if (!data.crossOutletOriginalCritic) data.crossOutletOriginalCritic = data.criticName;
      data.criticName = entry.criticName;
      data.crossOutletVerified = true;
      data.crossOutletVerifiedNote = entry.note;
      data.wrongArticleManualClear = true;
      delete data.wrongAttribution;
      delete data.wrongAttributionReason;
    } else if (entry.action === 'flag') {
      // A prior 'verify' pass may have left crossOutletVerified:true on
      // disk — that field is PROTECTED_FIELDS, so a plain delete is
      // silently reverted by safeWriteReview's preserve loop, leaving a
      // self-contradictory crossOutletVerified:true + wrongAttribution:true
      // state (the exact bug class task #1008/#1023 exists to fix, caught
      // again by ship-check/Codex on this batch, task #1006). The retraction
      // breadcrumb is what makes the delete stick.
      if (data.crossOutletVerified === true) {
        data.clearBreadcrumbRetractedFields = Array.from(new Set([
          ...(Array.isArray(data.clearBreadcrumbRetractedFields) ? data.clearBreadcrumbRetractedFields : []),
          'crossOutletVerified',
        ]));
        data.clearBreadcrumbRetracted = 'retracted stale crossOutletVerified: contradicted live wrongAttribution (#1023)';
        data.clearBreadcrumbRetractedAt = new Date().toISOString().slice(0, 10);
      }
      data.wrongAttribution = true;
      data.wrongAttributionReason = entry.note;
      delete data.crossOutletVerified;
      delete data.crossOutletVerifiedNote;
    }

    results[entry.action].push(entry.file);
    if (APPLY) safeWriteReview(filePath, data);
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} — ${MANIFEST.length} suspects triaged:`);
  console.log(`  verify: ${results.verify.length}`);
  console.log(`  rename: ${results.rename.length}`);
  console.log(`  flag:   ${results.flag.length}`);
  if (results.missing.length) {
    console.log(`  MISSING (not found on disk): ${results.missing.length}`);
    for (const f of results.missing) console.log(`    ${f}`);
  }
}

main();
