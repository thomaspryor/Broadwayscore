#!/usr/bin/env node
/**
 * One-time audit: how many ALREADY-flagged wrong-production reviews are
 * sitting in the wrong sibling directory and could be rerouted?
 *
 * Unlike the rebuild guard which filters by `data.wrongProduction` BEFORE the
 * URL-year guard runs, this audit includes flagged files and asks: "would
 * pickRerouteTarget() move this to a sibling?" If yes, the review is hiding
 * in plain sight — it was flagged away from scoring but the correct production
 * is a known sibling.
 *
 * Non-destructive: reads only, writes nothing.
 */
const fs = require('fs');
const path = require('path');
const { pickRerouteTarget, buildShowKeywordSet, findShowKeywordInText } = require('./lib/review-guards');

const REPO_ROOT = '/Users/tompryor/Broadwayscore';
const reviewTextsDir = path.join(REPO_ROOT, 'data', 'review-texts');
const showsPath = path.join(REPO_ROOT, '.core-data-checkout', 'shows.json');
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

// Build multiProdYearGuard identically to rebuild-all-reviews.js
const multiProdYearGuard = {};
{
  const titleGroups = {};
  for (const s of showsData.shows) {
    const normTitle = s.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!titleGroups[normTitle]) titleGroups[normTitle] = [];
    titleGroups[normTitle].push(s);
  }
  for (const [, prods] of Object.entries(titleGroups)) {
    if (prods.length < 2) continue;
    for (const show of prods) {
      const showYear = show.openingDate ? parseInt(show.openingDate.slice(0, 4))
        : show.previewsStartDate ? parseInt(show.previewsStartDate.slice(0, 4)) : null;
      if (!showYear) continue;
      const showCat = show.category || 'broadway';
      const nycMarket = showCat === 'broadway' || showCat === 'off-broadway';
      const siblings = prods.filter(p => {
        if (p.id === show.id) return false;
        const pCat = p.category || 'broadway';
        if (nycMarket) return pCat === 'broadway' || pCat === 'off-broadway';
        return pCat === showCat;
      }).map(p => ({
        id: p.id,
        year: p.openingDate ? parseInt(p.openingDate.slice(0, 4)) : null,
      })).filter(p => p.year);
      if (siblings.length > 0) multiProdYearGuard[show.id] = { showYear, siblings };
    }
  }
}

const guardedShowIds = new Set(Object.keys(multiProdYearGuard));

const showById = new Map(showsData.shows.map(s => [s.id, s]));

const stats = {
  filesScannedTotal: 0,
  flaggedWrongProd: 0,
  flaggedAndRerouteable: 0,
  flaggedAndRerouteCollision: 0,
  flaggedAndKeep: 0,
  flaggedNoDetectedYear: 0,
  rerouteable_scored: 0,
  rerouteable_unscored: 0,
  // Safety classification
  safe_yearOnly: 0,       // flag note is year-based AND target keywords appear in text
  safe_yearOnly_scored: 0,
  unsafe_showNotMentioned: 0,
  unsafe_crossMarket: 0,
  unsafe_urlMentionsOtherTitle: 0,
  unsafe_keywordMismatch: 0,
  unsafe_otherNote: 0,
  unsafe_distanceTooFar: 0,
  unflaggedRerouteable: 0,
  unflaggedCollision: 0,
};

const reroutesByPair = new Map();
const samples = [];

const showDirs = fs.readdirSync(reviewTextsDir).filter(f => {
  const fp = path.join(reviewTextsDir, f);
  try {
    if (fs.lstatSync(fp).isSymbolicLink()) return false;
    return fs.statSync(fp).isDirectory() && guardedShowIds.has(f);
  } catch { return false; }
});

console.log(`Auditing ${showDirs.length} guarded show directories...\n`);

for (const showId of showDirs) {
  const showDir = path.join(reviewTextsDir, showId);
  const guard = multiProdYearGuard[showId];
  let files;
  try { files = fs.readdirSync(showDir).filter(f => f.endsWith('.json')); }
  catch { continue; }

  for (const file of files) {
    stats.filesScannedTotal++;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); }
    catch { continue; }

    // Bypass flags still honored
    if (data.wrongProductionManualClear || data.wrongProductionOverride
        || data.allowEarlyDate || data.allowLateDate) continue;

    const isFlagged = !!(data.wrongProduction || data.wrongShow);
    if (isFlagged) stats.flaggedWrongProd++;

    let detectedYear = null;
    let yearSource = null;
    if (data.publishDate) {
      const m = data.publishDate.match(/(20\d\d|19\d\d)/);
      if (m) { detectedYear = parseInt(m[0]); yearSource = 'publishDate'; }
    }
    if (!detectedYear && data.url) {
      const m = data.url.match(/\/(20\d\d|19\d\d)\//);
      if (m) { detectedYear = parseInt(m[1]); yearSource = 'urlYear'; }
    }
    if (!detectedYear) {
      if (isFlagged) stats.flaggedNoDetectedYear++;
      continue;
    }

    const decision = pickRerouteTarget(guard.showYear, guard.siblings, detectedYear);
    if (decision.action === 'keep') {
      if (isFlagged) stats.flaggedAndKeep++;
      continue;
    }

    // Reroute candidate — check collision
    const targetPath = path.join(reviewTextsDir, decision.targetShowId, file);
    const collision = fs.existsSync(targetPath);

    if (isFlagged) {
      if (collision) { stats.flaggedAndRerouteCollision++; continue; }
      stats.flaggedAndRerouteable++;
      if (data.assignedScore >= 1 && data.assignedScore <= 100) stats.rerouteable_scored++;
      else stats.rerouteable_unscored++;

      // Classify safety
      const note = (data.wrongProductionNote || '').toLowerCase();
      const isYearBased = /date guard|url year|publishdate|url contains year|closer to sibling|-year/.test(note)
        || /date/.test(note);
      const isCrossMarket = /cross-market|cross market/.test(note);
      const url = (data.url || '').toLowerCase();
      const trUrl = (data.theatreRecordUrl || '').toLowerCase();

      // The most important safety check: does the review's URL path hint at a
      // *different* show (e.g. ...a-doll-s-house-part-2 suggesting Hnath,
      // not Ibsen)? Compare URL slug words against target show's base title.
      const targetShow = showById.get(decision.targetShowId);
      const targetTitleSlug = targetShow ? targetShow.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
      const targetTitleWords = targetTitleSlug.split('-').filter(w => w.length >= 3);

      // Look for OTHER show title tokens in the URL that aren't in the target title.
      // E.g., URL contains 'part-2' but target doesn't → unsafe.
      const allOtherSlugs = new Set();
      for (const s of showsData.shows) {
        if (s.id === decision.targetShowId || s.id === showId) continue;
        const slug = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        for (const w of slug.split('-')) if (w.length >= 4) allOtherSlugs.add(w);
      }
      // Remove words that are in target title (we don't want to flag target-word matches)
      for (const w of targetTitleWords) allOtherSlugs.delete(w);
      const urlHasOtherTitleTokens =
        [...allOtherSlugs].some(w => url.includes(`-${w}-`) || url.includes(`/${w}/`) || url.includes(`-${w}.`) || trUrl.includes(`-${w}-`));

      // Build target keyword set and verify against review text
      const targetKeywords = targetShow ? buildShowKeywordSet(targetShow) : new Set();
      const reviewText = (data.fullText || data.wrongFullText || '')
        + ' ' + (data.bwwExcerpt || '')
        + ' ' + (data.dtliExcerpt || '')
        + ' ' + (data.showScoreExcerpt || '')
        + ' ' + (data.llmPullQuote || '');
      const matchedKeyword = targetKeywords.size > 0 && reviewText.trim().length > 0
        ? findShowKeywordInText(reviewText, targetKeywords)
        : null;

      let safetyBucket;
      if (data.showNotMentioned === true) safetyBucket = 'unsafe_showNotMentioned';
      else if (isCrossMarket) safetyBucket = 'unsafe_crossMarket';
      else if (urlHasOtherTitleTokens) safetyBucket = 'unsafe_urlMentionsOtherTitle';
      else if (!matchedKeyword && reviewText.trim().length > 100) safetyBucket = 'unsafe_keywordMismatch';
      else if (!isYearBased) safetyBucket = 'unsafe_otherNote';
      // The target year must be CLOSE to the detected year. If a 1995 review
      // is 14 years from its closest sibling (2009), the real target is
      // likely a production not in our DB — don't guess.
      else if (decision.distance > 2) safetyBucket = 'unsafe_distanceTooFar';
      else safetyBucket = 'safe_yearOnly';

      stats[safetyBucket] = (stats[safetyBucket] || 0) + 1;
      if (safetyBucket === 'safe_yearOnly' && data.assignedScore >= 1 && data.assignedScore <= 100) {
        stats.safe_yearOnly_scored++;
      }

      const pair = `${showId} → ${decision.targetShowId}`;
      reroutesByPair.set(pair, (reroutesByPair.get(pair) || 0) + 1);
      if (samples.length < 20 && safetyBucket === 'safe_yearOnly') {
        samples.push({
          from: showId, to: decision.targetShowId, file,
          detectedYear, yearSource, currentYear: guard.showYear,
          targetYear: decision.targetYear,
          wrongProductionNote: data.wrongProductionNote,
          assignedScore: data.assignedScore,
          contentTier: data.contentTier,
          matchedKeyword,
          publishDate: data.publishDate,
          url: data.url ? data.url.slice(0, 120) : null,
        });
      }
    } else {
      // Unflagged and would reroute — these are live-guard candidates
      if (collision) stats.unflaggedCollision++;
      else stats.unflaggedRerouteable++;
    }
  }
}

console.log('=== BACKLOG STATS ===');
console.log(`Total files scanned: ${stats.filesScannedTotal}`);
console.log(`Files flagged wrongProduction/wrongShow: ${stats.flaggedWrongProd}`);
console.log(``);
console.log(`Flagged with no detectable year: ${stats.flaggedNoDetectedYear}`);
console.log(`Flagged AND decision=keep (mismatch not explainable by sibling): ${stats.flaggedAndKeep}`);
console.log(`Flagged AND reroutable collision (target has same slug): ${stats.flaggedAndRerouteCollision}`);
console.log(`Flagged AND RESCUABLE to sibling (raw): ${stats.flaggedAndRerouteable}`);
console.log(`  ├─ with a valid assignedScore (scored-then-hidden): ${stats.rerouteable_scored}`);
console.log(`  └─ unscored: ${stats.rerouteable_unscored}`);
console.log(``);
console.log(`Safety classification:`);
console.log(`  SAFE year-only mismatch (target title keywords in text, URL clean): ${stats.safe_yearOnly}`);
console.log(`     └─ of which already scored: ${stats.safe_yearOnly_scored}`);
console.log(`  UNSAFE showNotMentioned (title itself suspect): ${stats.unsafe_showNotMentioned}`);
console.log(`  UNSAFE cross-market (outlet/market mismatch): ${stats.unsafe_crossMarket}`);
console.log(`  UNSAFE URL contains other show's title tokens: ${stats.unsafe_urlMentionsOtherTitle}`);
console.log(`  UNSAFE target title keywords not in review text: ${stats.unsafe_keywordMismatch}`);
console.log(`  UNSAFE other (non-year-based flag): ${stats.unsafe_otherNote}`);
console.log(`  UNSAFE closest sibling >2 years from detected year: ${stats.unsafe_distanceTooFar}`);
console.log(``);
console.log(`(sanity check) Unflagged reroutable no-collision: ${stats.unflaggedRerouteable}`);
console.log(`(sanity check) Unflagged reroutable collision: ${stats.unflaggedCollision}`);

console.log('\n=== TOP BACKLOG REROUTE PAIRS (flagged→sibling) ===');
const pairsSorted = [...reroutesByPair.entries()].sort((a, b) => b[1] - a[1]);
for (const [pair, count] of pairsSorted.slice(0, 25)) {
  console.log(`  ${count.toString().padStart(4)}  ${pair}`);
}
if (pairsSorted.length > 25) console.log(`  ...and ${pairsSorted.length - 25} more pairs`);

console.log('\n=== SAMPLE FLAGGED-BUT-RESCUABLE REVIEWS ===');
for (const s of samples) {
  console.log(`  ${s.from} (${s.currentYear}) → ${s.to} (${s.targetYear})`);
  console.log(`    file: ${s.file}`);
  console.log(`    ${s.yearSource}=${s.detectedYear}  score=${s.assignedScore || 'none'}  tier=${s.contentTier || '?'}`);
  if (s.wrongProductionNote) console.log(`    note: ${s.wrongProductionNote}`);
  if (s.url) console.log(`    url: ${s.url}`);
}
