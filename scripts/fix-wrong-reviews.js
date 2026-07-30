#!/usr/bin/env node
/**
 * fix-wrong-reviews.js — Flag wrong-production/wrong-show reviews and fix outlet misattributions
 * Part of the March 2026 WE & OB data integrity audit
 *
 * Actions:
 *   flagAll: set wrongProduction=true on ALL files in the show directory
 *   flagWrongProd: set wrongProduction=true on specific file
 *   flagWrongShow: set wrongShow=true on specific file
 *   fixOutlet: correct the outlet field
 *   unflag: clear wrongProduction (false positive)
 *   clearDuplicate: clear duplicateTextOf field
 *   fixIbdb: fix ibdbUrl field
 *   move: move file from one show directory to another (cross-revival recovery)
 */

const fs = require('fs');
const path = require('path');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `fix-wrong-reviews.js — Flag wrong-production/wrong-show reviews and fix outlet misattributions.

Usage:
  node scripts/fix-wrong-reviews.js [options]
  node scripts/fix-wrong-reviews.js --help, -h    print this usage and exit
`;
// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const BASE = path.join(__dirname, '..', 'data', 'review-texts');

// ============ MANIFEST ============

const manifest = [
  // === PREVIEW SHOWS: Flag ALL reviews as wrong production ===
  { showId: 'hamlet-off-broadway-2026', action: 'flagAll', reason: 'All reviews are from Eddie Izzard 2024 solo Hamlet at Greenwich House, not 2026 BAM production' },
  { showId: 'seagull-true-story-off-broadway-2026', action: 'flagAll', reason: 'All reviews are from "The Seagull/Woodstock NY" 2023 at Signature Theatre, not 2026 Public Theater production' },
  { showId: 'mexodus-off-broadway-2026', action: 'flagAll', reason: 'All reviews are from Sep 2025 Audible/Minetta Lane run, not 2026 Daryl Roth production' },
  { showId: 'encores-the-wild-party-off-broadway-2026', action: 'flagAll', reason: 'Reviews are from 2015 Encores! Off-Center (Lippa version), not 2026 LaChiusa version' },

  // Fix seagull ibdbUrl (currently points to Shrek)
  { showId: 'seagull-true-story-off-broadway-2026', action: 'fixIbdb', ibdbUrl: '', reason: 'ibdbUrl incorrectly pointed to Shrek the Musical' },

  // === KINKY BOOTS OB: Flag specific wrong reviews (unflagged but wrong) ===
  { showId: 'kinky-boots-off-broadway-2026', file: 'cititour--brian-scott-lipton.json', action: 'flagWrongProd', reason: 'URL says NYC_Broadway — original Broadway production' },
  { showId: 'kinky-boots-off-broadway-2026', file: 'hollywood-reporter--jordan-riefe.json', action: 'flagWrongProd', reason: 'Low URL ID (749085) — original Broadway era review' },
  { showId: 'kinky-boots-off-broadway-2026', file: 'latimes--charles-mcnulty.json', action: 'flagWrongProd', reason: 'URL says 2022-07-10/kinky-boots-hollywood-bowl — Hollywood Bowl concert, not OB' },
  { showId: 'kinky-boots-off-broadway-2026', file: 'thestage--unknown.json', action: 'flagWrongProd', reason: 'URL says royal-and-derngate-northampton — UK regional production' },

  // === PLAY THAT GOES WRONG OB: Flag specific wrong reviews ===
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'huffpost--michael-glitz.json', action: 'flagWrongShow', reason: 'URL says kevin-kline-soars-amelie — completely wrong show' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'out-magazine--michael-musto.json', action: 'flagWrongShow', reason: 'URL says freddie-mercury — completely wrong show' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'curtainup--simon-saltzman.json', action: 'flagWrongProd', reason: 'URL says playthatgoeswrong17.html — Broadway 2017' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'theatre-is-easy--gabriella-steinberg.json', action: 'flagWrongProd', reason: 'URL path says 2017 — Broadway era' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'theatre-reviews-limited--david-roberts.json', action: 'flagWrongProd', reason: 'URL says broadway-review...lyceum-theatre — Broadway production' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'frontmezzjunkies--steven-ross.json', action: 'flagWrongProd', reason: 'URL date 2017/04/02 — Broadway opening' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'rollingstone--unknown.json', action: 'flagWrongProd', reason: 'URL is travelingboy.com about ahmanson-theatre — LA tour' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'talkinbroadway--unknown.json', action: 'flagWrongProd', reason: 'URL says regional — touring production' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'nytimes--sopan-deb.json', action: 'flagWrongProd', reason: 'Article about Broadway closing, not a review of OB production' },
  { showId: 'the-play-that-goes-wrong-off-broadway-2019', file: 'thestage--erin-kahn.json', action: 'fixOutlet', newOutlet: 'stagebuddy', reason: 'URL is stagebuddy.com, not thestage.co.uk' },

  // === I'M SORRY PRIME MINISTER WE: Wrong show review ===
  { showId: 'im-sorry-prime-minister-west-end-2026', file: 'hollywood-reporter--frank-scheck.json', action: 'flagWrongShow', reason: 'URL says me-my-girl-1110707 — review of "Me & My Girl"' },
  { showId: 'im-sorry-prime-minister-west-end-2026', file: 'amny--matt-windman.json', action: 'flagWrongShow', reason: 'URL says me-and-my-girl-review — wrong show' },

  // === MJ THE MUSICAL WE: Non-review content ===
  { showId: 'mj-the-musical-west-end-2024', file: 'nydailynews--unknown.json', action: 'flagWrongShow', reason: 'URL is seatplan.com ticket sales page, not a review' },

  // === OH MARY WE: Non-review content ===
  { showId: 'oh-mary-west-end-2025', file: 'nydailynews--team-bww.json', action: 'flagWrongShow', reason: 'URL is BWW opening night photos page, not a review' },

  // === BOOK OF MORMON WE: Broadway reviews scored as WE ===
  { showId: 'the-book-of-mormon-west-end-2024', file: 'nyt-theater--jonathan-mandell.json', action: 'flagWrongProd', reason: 'URL says book-of-mormon-three-years-old — Broadway retrospective' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'nyt-theater--unknown.json', action: 'flagWrongShow', reason: 'URL is a church blog review, not a theater critic' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'variety--steven-suskin.json', action: 'flagWrongProd', reason: 'Variety 2011 Broadway opening review' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'ew--lisa-schwarzbaum.json', action: 'flagWrongProd', reason: 'EW 2011 Broadway review' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'rollingstone--peter-travers.json', action: 'flagWrongProd', reason: 'Rolling Stone 2011 Broadway review' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'philadelphia-inquirer--howard-shapiro.json', action: 'flagWrongProd', reason: 'Philly 2011 review — Broadway, not WE' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'stageandcinema--lawrence-bommer.json', action: 'flagWrongProd', reason: 'Chicago 2012 tour review' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'nytimes--ben-brantley.json', action: 'flagWrongProd', reason: 'NYT 2014 Broadway review' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'stu-on-broadway--stu-brown.json', action: 'flagWrongProd', reason: 'Blog from 2011 — Broadway' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'stagezine--scott-harrah.json', action: 'flagWrongProd', reason: 'Stagezine "will convert you" — Broadway era' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'hot-pepper-theater--koryna-flores.json', action: 'flagWrongProd', reason: 'No URL, unknown outlet — cannot verify as WE' },
  { showId: 'the-book-of-mormon-west-end-2024', file: 'broadway-voice--gregory-g-allen.json', action: 'flagWrongProd', reason: 'Broadway Voice — US Broadway outlet' },

  // === MOULIN ROUGE WE: US-only outlets with no URL ===
  { showId: 'moulin-rouge-the-musical-west-end-2021', file: 'chicagotribune--reviews-chris-jones.json', action: 'flagWrongProd', reason: 'No URL, Chicago Tribune — US-only outlet reviewing WE is implausible' },

  // === LION KING WE: US-only outlets with null URLs ===
  { showId: 'the-lion-king-west-end-2021', file: 'nysr--jesse-oxfeld.json', action: 'flagWrongProd', reason: 'Null URL, NY Stage Review — US-only outlet, cannot verify WE production' },
  { showId: 'the-lion-king-west-end-2021', file: 'nysr--steven-suskin.json', action: 'flagWrongProd', reason: 'Null URL, NY Stage Review — US-only outlet, cannot verify WE production' },

  // === SIX WE: US-only outlet with no URL ===
  { showId: 'six-the-musical-west-end-2021', file: 'chicagotribune--chris-jones.json', action: 'flagWrongProd', reason: 'No URL, Chicago Tribune — US-only outlet, implausible WE review' },

  // === ANTIGONE OB: London production review ===
  { showId: 'antigone-this-play-i-read-in-high-school-off-broadway-2026', file: 'thestage--unknown.json', action: 'flagWrongProd', reason: 'URL says new-diorama-theatre-london — London production, not OB' },

  // === DRUNK SHAKESPEARE OB: TripAdvisor, not a review ===
  { showId: 'drunk-shakespeare-off-broadway-2022', file: 'times-uk--unknown.json', action: 'flagWrongShow', reason: 'URL is TripAdvisor listing, not a theater review' },

  // === HATE RADIO OB: Fix outlet attribution ===
  { showId: 'hate-radio-off-broadway-2026', file: 'times-uk--unknown.json', action: 'fixOutlet', newOutlet: 'exeunt-nyc', reason: 'URL is exeuntnyc.com, not Times UK' },
  { showId: 'hate-radio-off-broadway-2026', file: 'guardian--ryan-gilbey.json', action: 'flagWrongProd', reason: 'URL says 2023/battersea-arts-centre-london — London production, not 2026 OB' },

  // === MAN AND BOY WE: Fix outlet attribution ===
  { showId: 'man-and-boy-west-end-2026', file: 'chicagotribune--unknown.json', action: 'fixOutlet', newOutlet: 'the-stage', reason: 'URL is thestage.co.uk, not Chicago Tribune' },

  // === ARCADIA WE: Unflag false positive ===
  { showId: 'arcadia-west-end-2026', file: 'guardian--arifa-akbar.json', action: 'unflag', reason: 'Confirmed 2026 Old Vic production — URL date 2026/feb, content mentions Carrie Cracknell director' },

  // === TOTORO WE: Fix circular duplicate exclusion ===
  { showId: 'my-neighbour-totoro-west-end-2025', file: 'timeout-london--andrzej-lukowski.json', action: 'clearDuplicate', reason: 'This 2025 copy is the correct one; the timeout copy has 2022 date and is wrongProduction' },
  { showId: 'my-neighbour-totoro-west-end-2025', file: 'timeout--andrzej-lukowski.json', action: 'flagWrongProd', reason: '2022 date — this is the Barbican production, not 2025 WE' },

  // ============ PHASE 2: Cross-revival moves (March 2026) ============

  // === BETRAYAL: 2013 review (Craig/Weisz/Nichols) filed under 2019 (Hiddleston/Lloyd) ===
  { showId: 'betrayal-2019', file: 'financialtimes--financial-times.json', action: 'move', targetShowId: 'betrayal-2013',
    reason: 'Text mentions Mike Nichols directing, Daniel Craig and Rachel Weisz — 2013 production at Ethel Barrymore' },

  // === OH MARY: Off-Broadway run (Feb 2024) reviews filed under Broadway (July 2024) ===
  { showId: 'oh-mary-2024', file: 'front-row-center--david-walters.json', action: 'move', targetShowId: 'oh-mary-off-broadway-2024',
    reason: 'Published 2024-02-08, URL path /2024/02/ — Lucille Lortel off-Broadway run, not Broadway' },
  { showId: 'oh-mary-2024', file: 'theater-life--barry-gordin.json', action: 'move', targetShowId: 'oh-mary-off-broadway-2024',
    reason: 'Published 2024-02-11, text says "February 11, 2024" — Lucille Lortel off-Broadway run' },

  // === MOTOWN: 2013 original review filed under 2016 return ===
  { showId: 'motown-the-musical-2016', file: 'backstage--unknown.json', action: 'move', targetShowId: 'motown-the-musical-2013',
    reason: 'Backstage review of original production (Berry Gordy, Lunt-Fontanne), filed under 2016 return' },
];

// ============ EXECUTION ============

let flagged = 0, unflagged = 0, outletFixed = 0, moved = 0, errors = 0;

for (const entry of manifest) {
  const dir = path.join(BASE, entry.showId);

  if (!fs.existsSync(dir)) {
    console.error(`❌ Directory not found: ${entry.showId}`);
    errors++;
    continue;
  }

  if (entry.action === 'flagAll') {
    // Flag ALL json files in directory
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const filePath = path.join(dir, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!data.wrongProduction) {
        data.wrongProduction = true;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        flagged++;
      }
    }
    console.log(`✓ flagAll ${entry.showId}: ${files.length} files | ${entry.reason}`);
    continue;
  }

  if (entry.action === 'move') {
    // Move a review file from one show directory to another
    const filePath = path.join(dir, entry.file);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${entry.showId}/${entry.file}`);
      errors++;
      continue;
    }
    const targetDir = path.join(BASE, entry.targetShowId);
    if (!fs.existsSync(targetDir)) {
      console.error(`❌ Target directory not found: ${entry.targetShowId}`);
      errors++;
      continue;
    }
    const targetPath = path.join(targetDir, entry.file);
    if (fs.existsSync(targetPath)) {
      console.error(`❌ Target file already exists: ${entry.targetShowId}/${entry.file} — skipping to avoid collision`);
      errors++;
      continue;
    }

    // Read, update, move
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    clearWrongProductionFlags(data, { source: 'fix-wrong-reviews.js:move', reason: entry.reason });
    data.showId = entry.targetShowId; // Update internal showId to match new directory
    data.movedFrom = entry.showId;
    data.movedReason = entry.reason;
    data.movedAt = new Date().toISOString().split('T')[0];

    fs.writeFileSync(targetPath, JSON.stringify(data, null, 2) + '\n');
    fs.unlinkSync(filePath);
    moved++;
    console.log(`✓ move ${entry.showId}/${entry.file} → ${entry.targetShowId}/${entry.file} | ${entry.reason}`);
    continue;
  }

  if (entry.action === 'fixIbdb') {
    // Fix ibdbUrl on the show — but that's in shows.json, not review-texts
    // Handle this separately
    const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
    const showsData = loadShows();
    const show = showsData.shows.find(s => s.id === entry.showId);
    if (show) {
      show.ibdbUrl = entry.ibdbUrl;
      saveShows(showsData);
      console.log(`✓ fixIbdb ${entry.showId}: cleared ibdbUrl | ${entry.reason}`);
    }
    continue;
  }

  // Single file operations
  const filePath = path.join(dir, entry.file);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${entry.showId}/${entry.file}`);
    errors++;
    continue;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  switch (entry.action) {
    case 'flagWrongProd':
      data.wrongProduction = true;
      flagged++;
      console.log(`✓ flagWrongProd ${entry.showId}/${entry.file} | ${entry.reason}`);
      break;

    case 'flagWrongShow':
      data.wrongShow = true;
      flagged++;
      console.log(`✓ flagWrongShow ${entry.showId}/${entry.file} | ${entry.reason}`);
      break;

    case 'fixOutlet':
      const oldOutlet = data.outlet;
      data.outlet = entry.newOutlet;
      outletFixed++;
      console.log(`✓ fixOutlet ${entry.showId}/${entry.file}: ${oldOutlet} → ${entry.newOutlet} | ${entry.reason}`);
      break;

    case 'unflag':
      clearWrongProductionFlags(data, { source: 'fix-wrong-reviews.js:unflag', reason: entry.reason });
      unflagged++;
      console.log(`✓ unflag ${entry.showId}/${entry.file} | ${entry.reason}`);
      break;

    case 'clearDuplicate':
      delete data.duplicateTextOf;
      unflagged++;
      console.log(`✓ clearDuplicate ${entry.showId}/${entry.file} | ${entry.reason}`);
      break;
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

console.log(`\n=== SUMMARY ===`);
console.log(`Flagged: ${flagged} | Unflagged: ${unflagged} | Moved: ${moved} | Outlet fixes: ${outletFixed} | Errors: ${errors}`);
