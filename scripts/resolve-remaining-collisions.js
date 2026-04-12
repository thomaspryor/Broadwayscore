#!/usr/bin/env node
/**
 * resolve-remaining-collisions.js — Manual resolution of the 27 cross-show URL
 * collisions that couldn't be auto-resolved by audit-cross-show-url-collisions.js.
 *
 * Three resolution strategies:
 *   1. isCombinedReview: true — URL is a multi-show review article, both copies valid
 *   2. wrongShow: true — review belongs to a different show
 *   3. url: null — URL is unreliable (same URL, different actual content)
 *
 * Run: node scripts/resolve-remaining-collisions.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

// Use main repo for review-texts (gitignored, not present in worktrees)
const MAIN_REPO = process.env.MAIN_REPO || path.resolve(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(MAIN_REPO, 'data', 'review-texts');
const DRY_RUN = process.argv.includes('--dry-run');

function atomicWriteJSON(filePath, data) {
  if (DRY_RUN) return;
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function readJSON(showId, file) {
  const filePath = path.join(REVIEW_TEXTS_DIR, showId, file);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeFix(showId, file, data) {
  const filePath = path.join(REVIEW_TEXTS_DIR, showId, file);
  atomicWriteJSON(filePath, data);
}

let combinedCount = 0, wrongShowCount = 0, nullUrlCount = 0, skippedCount = 0;

// ============================================================
// 1. COMBINED REVIEWS — both copies are valid multi-show articles
// ============================================================
const combinedReviews = [
  // New Yorker combined review of Anastasia + Charlie and the Chocolate Factory
  ['anastasia-2017', 'newyorker--michael-schulman.json'],
  ['charlie-and-the-chocolate-factory-2017', 'newyorker--michael-schulman.json'],
  // Artsfuse combined review of Art + Waiting for Godot
  ['art-2025', 'artsfuse--martin-copenhaver.json'],
  ['waiting-for-godot-2025', 'artsfuse--christopher-caggiano.json'],
  // Bloomberg combined review of Born Yesterday + House of Blue Leaves
  ['born-yesterday-2011', 'bloomberg--jeremy-gerard.json'],
  ['the-house-of-blue-leaves-2011', 'bloomberg--jeremy-gerard.json'],
  // Artsfuse combined review of Buena Vista + Operation Mincemeat
  ['buena-vista-social-club-2025', 'artsfuse--christopher-caggiano.json'],
  ['operation-mincemeat-2025', 'artsfuse--christopher-caggiano.json'],
  // WashPost combined review of Buena Vista + Operation Mincemeat
  ['buena-vista-social-club-2025', 'washpost--naveen-kumar.json'],
  ['operation-mincemeat-2025', 'washpost--naveen-kumar.json'],
  // WashPost combined review of Dead Outlaw + Floyd Collins
  ['dead-outlaw-2025', 'washpost--naveen-kumar.json'],
  ['floyd-collins-2025', 'washpost--naveen-kumar.json'],
  // Deadline combined review of Fool for Love + Gin Game
  ['fool-for-love-2015', 'deadline--jeremy-gerard.json'],
  ['the-gin-game-2015', 'deadline--jeremy-gerard.json'],
  // WSJ combined review of Head Over Heels + Straight White Men
  ['head-over-heels-2018', 'wsj--terry-teachout.json'],
  ['straight-white-men-2018', 'wsj--terry-teachout.json'],
  // New Yorker combined review of Lend Me a Tenor + Red
  ['lend-me-a-tenor-2010', 'newyorker--john-lahr.json'],
  ['red-2010', 'newyorker--john-lahr.json'],
  // NY Daily News combined review of No Man's Land + Waiting for Godot (in rep)
  ['no-mans-land-2013', 'nydailynews--joe-dziemianowicz.json'],
  ['waiting-for-godot-2013', 'nydailynews--joe-dziemianowicz.json'],
  // USA Today combined review of No Man's Land + Waiting for Godot
  ['no-mans-land-2013', 'usatoday--elysa-gardner.json'],
  ['waiting-for-godot-2013', 'usatoday--elysa-gardner.json'],
];

console.log('=== COMBINED REVIEWS ===');
for (const [showId, file] of combinedReviews) {
  try {
    const data = readJSON(showId, file);
    if (data.isCombinedReview) { skippedCount++; continue; }
    data.isCombinedReview = true;
    data.isCombinedReviewNote = 'Multi-show review article — URL legitimately covers this show and others';
    writeFix(showId, file, data);
    combinedCount++;
    console.log(`  [COMBINED] ${showId}/${file}`);
  } catch (e) {
    console.error(`  ERROR: ${showId}/${file}: ${e.message}`);
  }
}

// ============================================================
// 2. WRONG SHOW — review belongs to a different show entirely
// ============================================================
const wrongShowFixes = [
  // Aladdin revisit review (2018) — belongs to aladdin-2014, not generic aladdin/
  ['aladdin', 'nysr--elysa-gardner.json', 'aladdin-2014'],
  // Cats Jellicle Ball reviews misattributed to WE (Guardian + NYTG skipped by London guard)
  ['cats-west-end-2026', 'guardian--richard-lawson.json', 'cats-the-jellicle-ball-2026'],
  ['cats-west-end-2026', 'nytg--kyle-turner.json', 'cats-the-jellicle-ball-2026'],
  // WSJ Pretty Woman review misattributed to Gettin the Band Back Together
  ['gettin-the-band-back-together-2018', 'wsj--terry-teachout.json', 'pretty-woman-the-musical-2018'],
  // Harry Potter (old generic ID) — belongs to harry-potter-2021
  ['harry-potter-and-the-cursed-child', 'dtli--ana-zambrana.json', 'harry-potter-2021'],
  ['harry-potter-and-the-cursed-child', 'nytimes--alexis-soloski.json', 'harry-potter-2021'],
  ['harry-potter-and-the-cursed-child', 'timeout--adam-feldman.json', 'harry-potter-2021'],
  // Kinky Boots 2017 review (during original run), misattributed to 2026 revival
  ['kinky-boots-2026', 'stage-left--robert-russo.json', 'kinky-boots-2013'],
  // Pen Pals — belongs to off-broadway version
  ['pen-pals-2025', 'off-off-online--marc-miller.json', 'pen-pals-off-broadway-2025'],
  // Perfect Crime — belongs to off-broadway version (longest running play, OB venue)
  ['perfect-crime-1987', 'nytimes--jason-zinoman.json', 'perfect-crime-off-broadway-1987'],
  ['perfect-crime-1987', 'woman-around-town--quan-lam.json', 'perfect-crime-off-broadway-1987'],
  // Present Laughter review misattributed to Play That Goes Wrong
  ['the-play-that-goes-wrong-2019', 'towleroad--naveen-kumar.json', 'present-laughter-2017'],
  // The Lion King (generic ID) — belongs to the-lion-king-1997
  ['the-lion-king', 'nysr--jesse-oxfeld.json', 'the-lion-king-1997'],
  ['the-lion-king', 'nysr--steven-suskin.json', 'the-lion-king-1997'],
  // This Is My Favorite Song — belongs to off-broadway version
  ['this-is-my-favorite-song-2024', 'theater-scene--tony-marinelli.json', 'this-is-my-favorite-song-off-broadway-2024'],
];

console.log('\n=== WRONG SHOW FLAGS ===');
for (const [showId, file, belongsTo] of wrongShowFixes) {
  try {
    const data = readJSON(showId, file);
    if (data.wrongShow || data.wrongProduction) { skippedCount++; continue; }
    data.wrongShow = true;
    data.wrongShowReason = `Cross-show URL collision (manual resolution): review belongs to ${belongsTo}`;
    writeFix(showId, file, data);
    wrongShowCount++;
    console.log(`  [WRONGSHOW] ${showId}/${file} → belongs to ${belongsTo}`);
  } catch (e) {
    console.error(`  ERROR: ${showId}/${file}: ${e.message}`);
  }
}

// ============================================================
// 3. NULL URLs — URL is unreliable (FT URL reuse across years)
// ============================================================
const nullUrlFixes = [
  // FT reuses same URL for different year's reviews (ITW 2025 vs DWP 2024)
  ['into-the-woods-west-end-2025', 'financialtimes--sarah-hemming.json'],
  ['the-devil-wears-prada-west-end-2024', 'financialtimes--sarah-hemming.json'],
];

console.log('\n=== NULL URLs ===');
for (const [showId, file] of nullUrlFixes) {
  try {
    const data = readJSON(showId, file);
    if (!data.url) { skippedCount++; continue; }
    data.url = null;
    data.urlNulledReason = 'URL shared across different reviews from different years (FT URL reuse)';
    writeFix(showId, file, data);
    nullUrlCount++;
    console.log(`  [NULL-URL] ${showId}/${file}`);
  } catch (e) {
    console.error(`  ERROR: ${showId}/${file}: ${e.message}`);
  }
}

console.log(`\n=== SUMMARY ===`);
console.log(`Combined reviews: ${combinedCount}`);
console.log(`Wrong show flags: ${wrongShowCount}`);
console.log(`Null URLs:        ${nullUrlCount}`);
console.log(`Already fixed:    ${skippedCount}`);
console.log(`Total changes:    ${combinedCount + wrongShowCount + nullUrlCount}`);
if (DRY_RUN) console.log('\n(DRY RUN — no files modified)');
