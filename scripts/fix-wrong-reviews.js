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
 */

const fs = require('fs');
const path = require('path');

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
];

// ============ EXECUTION ============

let flagged = 0, unflagged = 0, outletFixed = 0, errors = 0;

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

  if (entry.action === 'fixIbdb') {
    // Fix ibdbUrl on the show — but that's in shows.json, not review-texts
    // Handle this separately
    const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
    const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const show = showsData.shows.find(s => s.id === entry.showId);
    if (show) {
      show.ibdbUrl = entry.ibdbUrl;
      fs.writeFileSync(showsPath, JSON.stringify(showsData, null, 2) + '\n');
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
      delete data.wrongProduction;
      delete data.wrongShow;
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
console.log(`Flagged: ${flagged} | Unflagged: ${unflagged} | Outlet fixes: ${outletFixed} | Errors: ${errors}`);
