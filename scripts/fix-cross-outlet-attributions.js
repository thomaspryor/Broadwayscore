#!/usr/bin/env node
/**
 * fix-cross-outlet-attributions.js — triage the 47 Carmen-class suspects from
 * scripts/audit-cross-outlet-attributions.js (Notion card 3b2637c5-416f-818f,
 * 2026-08-03).
 *
 * Each suspect was checked against the live source page (WebFetch/curl byline,
 * or a targeted web search when the page was unreachable/paywalled). Three
 * outcomes:
 *   - verify: byline confirmed correct (or organizationally equivalent, e.g.
 *     SFGate/SF Chronicle share critic Lily Janiak) → crossOutletVerified:true
 *   - rename: page byline is a DIFFERENT named critic than stored → correct
 *     criticName (examples: Skin of Our Teeth/Observer is David Cote not Tim
 *     Teeman; Macbeth/Time Out is Adam Feldman not Naveen Kumar; In the
 *     Heights/WaPo is Naveen Kumar not Nelson Pressley — he left WaPo in 2019;
 *     Pretty Woman/BWW-RI is Jay Pateakos not Roy Berko; Waverly Gallery/
 *     Broadway News is Charles Isherwood not Matt Windman)
 *   - retag: criticName confirmed correct but outletId is wrong (URL domain
 *     doesn't match the stored outlet — Kevin Filipski's Sylvia review is on
 *     filmfestivaltraveler.com, not slashfilm.com)
 *   - flag: could not verify (no stored URL, dead/broken source link, or
 *     evidence pointing away from the stored critic) → wrongAttribution:true,
 *     which review-guards.js and rebuild-all-reviews.js already treat as an
 *     exclusion (same family as wrongProduction/wrongShow)
 *
 * Idempotent. Dry-run by default; pass --apply to write.
 * Run from the repo root that owns the canonical data/review-texts store.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv)) {
  console.log(`fix-cross-outlet-attributions.js — triage Carmen-class cross-outlet suspects.

Usage:
  node scripts/fix-cross-outlet-attributions.js           dry run (report only)
  node scripts/fix-cross-outlet-attributions.js --apply   write corrections

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

// action: 'verify' | 'rename' | 'retag' | 'flag'
const MANIFEST = [
  { file: '9-to-5-2009/access-atlanta--wendell-brock.json', action: 'verify',
    note: 'Access Atlanta was AJC\'s entertainment site; Wendell Brock is the AJC critic — same org.' },
  { file: 'a-beautiful-noise-the-neil-diamond-musical-2022/san-francisco-chronicle--lily-janiak.json', action: 'verify',
    note: 'Byline confirmed on sfchronicle.com article body.' },
  { file: 'a-time-to-kill-2013/abc-news--mark-kennedy.json', action: 'verify',
    note: 'AP wire "wireStory" URL; AP theater critic Mark Kennedy, confirmed via sibling Washington Times AP byline.' },
  { file: 'an-american-in-paris-2015/broadwayworld--roy-berko.json', action: 'flag',
    note: 'Roy Berko is a real Cleveland-based BWW critic in general, but search only turned up his 2017 PlayhouseSquare (touring) review, not a 2015 Broadway-specific piece — could not confirm this specific file. Already wrongShow:true (excluded from scoring either way).' },
  { file: 'beetlejuice-2022/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Byline content confirmed via search (Cleveland Connor Palace review); already wrongProduction:true (tour, excluded).' },
  { file: 'beetlejuice-2022/san-francisco-chronicle--lily-janiak.json', action: 'verify',
    note: 'Lily Janiak / SF Chronicle pattern confirmed; already wrongProduction:true (SF tour leg, excluded).' },
  { file: 'beetlejuice-2022/the-daily-gazette--bill-kellert.json', action: 'verify',
    note: 'Bill Kellert / Daily Gazette (Capital Region NY, nippertown-affiliated) confirmed; already wrongProduction:true.' },
  { file: 'beetlejuice-2025/dc-metro-theater-arts--deb-miller.json', action: 'verify',
    note: 'Deb Miller is a real dcmetrotheaterarts.com author; already wrongProduction:true (2019 Winter Garden review, excluded).' },
  { file: 'chinglish-2011/sfgate--mark-kennedy.json', action: 'verify',
    note: 'AP wire syndicated to SFGate under original AP byline — same pattern as other Mark Kennedy rows.' },
  { file: 'data-2026/nytimes--tim-teeman.json', action: 'verify',
    note: 'CORRECTION (task #1180, 2026-08-14): the "Tim Teeman has never been an NYT theater critic" premise was never checked against the live page. A direct fetch of the sibling disruption-off-broadway-2026 nytimes--tim-teeman.json URL returned NYT\'s own GraphQL byline block ("bylines":[{"creators":[{"displayName":"Tim Teeman", ... "__typename":"Person"}]}]) with a real nyt://person/ entity ID — not a scraper artifact. All 6 nytimes--tim-teeman.json siblings share this byline and are presumed genuine on the same evidence; this file remains excluded via wrongProduction regardless.' },
  { file: 'data-off-broadway-2026/nytimes--tim-teeman.json', action: 'verify',
    note: 'CORRECTION (task #1180, 2026-08-14): same live-page GraphQL byline evidence as the data-2026 sibling — genuine NYT byline, not fabricated. contentTier invalid keeps this excluded from scoring regardless.' },
  { file: 'death-of-a-salesman-2026/nytg--jonathan-mandell.json', action: 'flag',
    note: 'Jonathan Mandell writes "New York Theater" (newyorktheater.me), not "New York Theatre Guide" (nytg) — different outlets, no stored URL to confirm.' },
  { file: 'fool-for-love-2015/the-record-theater--bob-goepfert.json', action: 'retag',
    outletId: 'troy-record',
    note: 'URL is troyrecord.com; troy-record is Bob Goepfert\'s registered home. "the-record-theater" is a stray duplicate outletId.' },
  { file: 'hadestown-west-end-2024/dc-metro-theater-arts--deb-miller.json', action: 'verify',
    note: 'Deb Miller confirmed dcmetrotheaterarts.com author; already wrongProduction:true (2019 Walter Kerr review, excluded).' },
  { file: 'hairspray-2002/broadwayworld--louise-penn.json', action: 'verify',
    note: 'Already wrongProduction:true (West End Coliseum revival, excluded); Louise Penn class tracked separately under card #988.' },
  { file: 'hamilton-2015/washington-times--mark-kennedy.json', action: 'verify',
    note: 'Confirmed: "Mark Kennedy" + "Associated Press" both present in article body.' },
  { file: 'hand-to-god-2015/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Roy Berko confirmed real critic for this show via search; already wrongShow:true (excluded).' },
  { file: 'heisenberg-2016/abc-news--mark-kennedy.json', action: 'verify',
    note: 'AP wire "wireStory" URL, same pattern as confirmed Mark Kennedy rows.' },
  { file: 'in-the-heights-2008/washpost--nelson-pressley.json', action: 'rename',
    criticName: 'Naveen Kumar',
    note: 'Nelson Pressley left the Post in 2019 and could not have written this Feb 2025 review. Real byline is Naveen Kumar (confirmed via search).' },
  { file: 'kinky-boots-off-broadway-2026/broadwayworld--roy-berko.json', action: 'flag',
    note: 'Stored URL is a royberkinfo.blogspot.com search-results page, not an article; search found no Roy Berko review of this 2026 revival. Already wrongProduction:true (excluded from scoring either way).' },
  { file: 'life-of-pi-2023/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Byline "Roy Berko" confirmed present on the stored broadwayworld.com/cleveland URL; already wrongProduction:true.' },
  { file: 'macbeth-off-broadway-2026/timeout--naveen-kumar.json', action: 'rename',
    criticName: 'Adam Feldman',
    note: 'WebFetch confirmed the Time Out byline is Adam Feldman ("Theater review by Adam Feldman"), not Naveen Kumar. Already wrongProduction:true.' },
  { file: 'misery-2015/abc-news--mark-kennedy.json', action: 'verify',
    note: 'AP wire "wireStory" URL, same pattern as confirmed Mark Kennedy rows.' },
  { file: 'miss-saigon-2017/san-francisco-chronicle--lily-janiak.json', action: 'verify',
    note: 'Byline confirmed on sfchronicle.com article body; already wrongProduction:true.' },
  { file: 'moulin-rouge-the-musical-west-end-2021/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Review content (Austin Durant "scene-stealer" quote) confirmed as Roy Berko\'s via search; already wrongProduction:true.' },
  { file: 'moulin-rouge-the-musical-west-end-2021/san-francisco-chronicle--lily-janiak.json', action: 'verify',
    note: 'Lily Janiak / SF Chronicle (datebook subdomain) pattern; already wrongProduction:true.' },
  { file: 'parade-2023/broadwayworld--roy-berko.json', action: 'verify',
    note: 'Byline "Roy Berko" confirmed present on the stored broadwayworld.com/cleveland URL; already wrongProduction:true.' },
  { file: 'patriots-2024/dtli--frank-scheck.json', action: 'flag',
    note: 'Stored URL is a didtheylikeit.com wp-admin post-editor link, not a public page — unverifiable and outletId "dtli" is the aggregator itself, not a real outlet. Frank Scheck is a real critic and DID review Patriots (confirmed via search — for New York Stage Review, nystagereview.com), but with no stored URL/fullText there is no way to confirm this specific file is that piece rather than a different mismatch. Was live-scoring (assignedScore 81) before this flag.' },
  { file: 'pretty-woman-the-musical-2018/broadwayworld--roy-berko.json', action: 'rename',
    criticName: 'Jay Pateakos',
    note: 'WebFetch confirmed the BWW Rhode Island byline is Jay Pateakos ("BWW Rhode Island since fall 2021"), not Roy Berko. Already wrongProduction:true.' },
  { file: 'pretty-woman-the-musical-2018/the-austin-chronicle--bob-abelman.json', action: 'verify',
    note: 'Bob Abelman confirmed real Austin Chronicle author (author archive page + matching review quote); already wrongProduction:true.' },
  { file: 'shucked-2023/san-francisco-chronicle--lily-janiak.json', action: 'verify',
    note: 'Lily Janiak / SF Chronicle pattern; already wrongProduction:true.' },
  { file: 'six-the-musical-west-end-2021/patriot-ledger--iris-fanger.json', action: 'verify',
    note: 'Iris Fanger is a real Boston-area freelance critic (edge-boston home); already wrongProduction:true (excluded either way).' },
  { file: 'sweat-2017/artsfuse--iris-fanger.json', action: 'verify',
    note: 'Iris Fanger confirmed regular ArtsFuse contributor; already wrongProduction:true (excluded either way).' },
  { file: 'sylvia-2015/slash-film--kevin-filipski.json', action: 'retag',
    outletId: 'film-festival-traveler',
    note: 'WebFetch confirmed byline "Kevin Filipski"; URL is filmfestivaltraveler.com, not slashfilm.com — outletId was wrong, critic was right.' },
  { file: 'the-children-2017/this-week-in-new-york--william-wolf.json', action: 'flag',
    note: 'No stored URL; could not corroborate William Wolf as the author. Not currently excluded — not live-scored (no assignedScore) so low impact.' },
  { file: 'the-humans-2016/whatsonstage--scott-mitchell.json', action: 'flag',
    note: 'Search found no Scott Mitchell byline for this review; stored URL (whatsonoffbroadway.com) doesn\'t match his registered home (reviewsoffbroadway.com). Already wrongProduction:true.' },
  { file: 'the-iceman-cometh-2018/dailybeast--william-wolf.json', action: 'rename',
    criticName: 'Tim Teeman',
    note: 'The Daily Beast Iceman Cometh review was by Tim Teeman, not William Wolf (confirmed via search — his review is archived on timteeman.com, originally Daily Beast). No stored URL to attach, but the correct byline is known.' },
  { file: 'the-importance-of-being-earnest-1977/theater-news-online--matt-windman.json', action: 'flag',
    note: 'Shares the exact same URL (COMEDYOFMANNERS.cfm) as the unrelated -2011 sibling file — stale/generic placeholder URL, unverifiable. Already wrongProduction:true.' },
  { file: 'the-importance-of-being-earnest-2011/theater-news-online--matt-windman.json', action: 'flag',
    note: 'Shares the exact same URL (COMEDYOFMANNERS.cfm) as the unrelated -1977 sibling file — stale/generic placeholder URL, unverifiable. Already wrongProduction:true.' },
  { file: 'the-nap-2018/blogcritics--william-wolf.json', action: 'flag',
    note: 'No stored URL; could not corroborate. Not live-scored.' },
  { file: 'the-other-place-2026/minneapolis-star-tribune--mark-kennedy.json', action: 'verify',
    note: 'Real Mark Kennedy AP content; already wrongShow:true (cross-show URL collision with the-other-place-2013, excluded from scoring).' },
  { file: 'the-peewee-herman-show-2010/canadian-press--mark-kennedy.json', action: 'verify',
    note: 'Confirmed via search: "Mark Kennedy wrote for the Associated Press on November 11, 2010, covering Paul Reubens\' Broadway debut" — matches this file\'s show/date exactly. Canadian Press syndicates AP wire content under the original byline; stored googlehostednews.com link is dead (Google retired hosted news ~2013) but the AP-wire pattern is independently confirmed by two other Mark Kennedy rows via direct page-body grep (Washington Times, Hamilton).' },
  { file: 'the-play-that-goes-wrong-off-broadway-2019/paste-magazine--robert-massimi.json', action: 'verify',
    note: 'Search confirmed Robert Massimi published a review of this exact show (Geeks.media, his registered home); outletId/URL point to a legit cross-post, not a different critic.' },
  { file: 'the-skin-of-our-teeth-2022/observer--tim-teeman.json', action: 'rename',
    criticName: 'David Cote',
    note: 'Observer article:author meta tag confirms David Cote. Tim Teeman\'s own review of this show ran on his personal site, not Observer. Already wrongProduction:true.' },
  { file: 'the-waverly-gallery-2018/broadwaynews--matt-windman.json', action: 'rename',
    criticName: 'Charles Isherwood',
    note: 'Search confirmed Broadway News\'s Waverly Gallery review was by Charles Isherwood; Matt Windman\'s own review ran on amNY.' },
  { file: 'the-waverly-gallery-2018/theater-news-online--matt-windman.json', action: 'flag',
    note: 'Stored URL (INTOTHEABYSS.cfm) is a generic theaternewsonline.com page unrelated in name to this show — unverifiable.' },
  { file: 'travesties-2018/dailybeast--william-wolf.json', action: 'flag',
    note: 'No stored URL; could not corroborate. Not live-scored.' },

  // --- recheck batch (task #1006, 2026-08-14): 4 new suspects surfaced by
  // fresh review-texts accumulated since the 2026-08-03 sweep above. None
  // live-scoring (assignedScore null on all four). ---
  { file: 'cats-2016/huffpost--jonathan-mandell.json', action: 'verify',
    note: 'Jonathan Mandell is a widely cross-posting freelance theater critic (former Newsday staff critic; also freelanced for Playbill, American Theatre Magazine, NYT, Backstage, NPR, CNN, DNAinfo, Patch, BroadwayWorld) — HuffPost\'s open contributor platform is a plausible extension of that pattern. Not live-scored (assignedScore null).' },
  { file: 'cats-2016/stagezine--lauren-yarger.json', action: 'verify',
    note: 'Lauren Yarger (editor of Reflections in the Light, registry defaultCritic) is also a confirmed contributing editor for BroadwayWorld, reviewer for the Manchester Journal-Inquirer, CT theater editor for CurtainUp.com, and CT/NY reviewer for American Theater Web — an established prolific-freelancer cross-posting pattern. Not live-scored (assignedScore null).' },
  { file: 'cats-west-end-2026/nypost--kyle-smith.json', action: 'verify',
    note: 'Already wrongProduction:true (shares the exact 2016 NY Post URL/byline as the cats-2016/nypost--kyle-smith.json sibling, misattached to this 2026 West End revival, excluded from scoring either way); Kyle Smith is a genuine NY Post critic (see sibling file note).' },
  { file: 'galileo-2026/san-francisco-chronicle--lily-janiak.json', action: 'verify',
    note: 'SFGate/SF Chronicle share critic Lily Janiak (SF Chronicle\'s own lead theater critic; her work runs on both properties, the same organizationally-equivalent pattern already documented in this file\'s own header). Not live-scored (assignedScore null).' },
];

function main() {
  const results = { verify: [], rename: [], retag: [], flag: [], missing: [] };
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
      // preserve loop when a pre-existing wrongAttribution:true is on disk
      // (same bug class found and fixed in fix-cross-outlet-attributions-
      // fulltext.js and fix-playbill-bleed-attributions.js, task #1008/#1023).
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
    } else if (entry.action === 'retag') {
      if (!data.crossOutletOriginalOutletId) data.crossOutletOriginalOutletId = data.outletId;
      data.outletId = entry.outletId;
      data.crossOutletVerified = true;
      data.crossOutletVerifiedNote = entry.note;
      data.wrongArticleManualClear = true;
      delete data.wrongAttribution;
      delete data.wrongAttributionReason;
    } else if (entry.action === 'flag') {
      // Same fix as fix-cross-outlet-attributions-fulltext.js (task #1006):
      // a prior 'verify' pass may have left crossOutletVerified:true on
      // disk, which is PROTECTED_FIELDS — a plain delete is silently
      // reverted without this retraction breadcrumb (task #1008/#1023).
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
  console.log(`  retag:  ${results.retag.length}`);
  console.log(`  flag:   ${results.flag.length}`);
  if (results.missing.length) {
    console.log(`  MISSING (not found on disk): ${results.missing.length}`);
    for (const f of results.missing) console.log(`    ${f}`);
  }
}

main();
