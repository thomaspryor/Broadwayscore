#!/usr/bin/env node
/**
 * Comprehensive Review Dedup Cleanup
 *
 * Handles 4 categories of duplicate review files:
 * 1. Outlet alias duplicates (e.g., nytheatre vs nytheatrecom)
 * 2. Critic name typo duplicates (e.g., chris-jone vs chris-jones)
 * 3. Cross-show URL duplicates (reviews filed under wrong production)
 * 4. Same-show URL duplicates (multiple files with identical URLs)
 *
 * Usage:
 *   node scripts/cleanup-dedup-comprehensive.js [--dry-run] [--category=N]
 */

const fs = require('fs');
const path = require('path');
const { normalizeUrl } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const categoryArg = args.find(a => a.startsWith('--category='));
const CATEGORY = categoryArg ? parseInt(categoryArg.split('=')[1]) : 0;

if (DRY_RUN) console.log('*** DRY RUN MODE — no files will be modified ***\n');

// Outlet alias map: variant → canonical
const OUTLET_ALIAS_MAP = {
  'nytheatrecom': 'nytheatre', 'nytheatrereviewcom': 'nytheatre',
  'newyorkmagazine': 'vulture',
  'bloomberg-news': 'bloomberg', 'bloomberg-jason-zinoman': 'bloomberg',
  'bloomberg-chris-rovzar': 'bloomberg', 'bloomberg-mark-leydorf': 'bloomberg',
  'bloombeg-news': 'bloomberg', 'bloomgberg-news': 'bloomberg',
  'the-guardian-uk': 'guardian', 'uk-guardian': 'guardian', 'the-gaurdian': 'guardian',
  'the-faster-times': 'faster-times',
  'ny-post': 'nypost',
  'philadelpia-inquirer': 'philadelphia-inquirer',
  'usa-today': 'usatoday',
  'theatre-news-online': 'theater-news-online',
  'theater-news-online-david-cote': 'theater-news-online',
  'theater-news-online-jeremy-gerard': 'theater-news-online',
  'theater-news-online-joe-dziemianowicz': 'theater-news-online',
  'theatre-news-online-jeremy-gerard': 'theater-news-online',
  'theatre-news-online-joe-dziemianowicz': 'theater-news-online',
  'am-ny-matt-windman': 'amny', 'amnycom': 'amny', 'amnew-york': 'amny', 'am-newyork': 'amny',
  'ny-daily-news': 'nydailynews',
  'associated-press': 'ap',
  'star-ledger': 'njcom', 'the-star-ledger': 'njcom',
  'entertainment-weekly': 'ew', 'enertainment-weekly': 'ew',
  'financial-times-uk': 'financialtimes',
  'the-record-bergen': 'bergen-record', 'the-record': 'bergen-record',
  'newyorktheatreguide': 'nytg', 'new-york-theatre': 'nytg',
  'newyorktheater': 'nyt-theater',
  'nystagereview': 'nysr',
  'varietycom': 'variety', 'vartiey': 'variety',
  'washingtion-post': 'washpost',
  'haineshiswaycom': 'haineshisway', 'perezhiltoncom': 'perezhilton',
  '1minutecritic': 'oneminutecritic', '1-minute-critic-matthew-wexler': 'oneminutecritic',
  'one-minute-critic': 'oneminutecritic',
  '4-columns-david-cote': '4columns', 'cititourcom': 'cititour',
  'talkin-boradway': 'talkinbroadway',
  'new-jersey-news-room': 'new-jersey-newsroom',
  'ny-observer': 'observer',
  'the-telegraph-uk': 'telegraph', 'the-telegraphy': 'telegraph', 'the-telegrap': 'telegraph',
  'huffingtion-post': 'huffpost',
  'blogcriticsorg': 'blogcritics',
  'times-square-chronicles-suzanna-bowling': 'times-square-chronicles',
  'towleroad-naveen-kumar': 'towleroad',
  'showbiz411-roger-friedman': 'showbiz411', 'showbiz-411-roger-friedman': 'showbiz411',
  'dctheatrescene': 'dcmetro',
  'broadway-journal-philip-boroff': 'broadway-journal',
  'new-york-times': 'nytimes', 'chicago-tribune': 'chicagotribune',
  'hollywoodwood-reporter': 'hollywood-reporter',
  'villiage-voice': 'village-voice',
  'thedaily-beast': 'dailybeast',
  'mbc-new-york': 'nbcny',
  'mashable-erin-strecker': 'mashable',
  'the-stage-uk': 'thestage',
  'the-times-uk-jesse-oxfeld': 'the-times',
  'broadstreetreviewcom': 'broadstreetreview', 'newportricom': 'newportri',
  'ny-newsday': 'newsday', 'wall-street-jounal': 'wsj',
};

// Critic name typo map
const CRITIC_TYPO_MAP = {
  'leah-greenblat': 'leah-greenblatt',
  'chris-jone': 'chris-jones',
  'jonathan-mandel': 'jonathan-mandell',
};
const CRITIC_FILENAME_VARIANTS = {
  'elizabeth-vincentelli': 'elisabeth-vincentelli',
};
const CRITIC_PARTIAL_NAMES = { 'chris': 'chris-jones' };

const stats = { outletAliasFixed: 0, criticTypoFixed: 0, crossShowFlagged: 0, sameShowUrlFixed: 0, filesMerged: 0, errors: [] };

function readJsonFile(fp) { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch(e) { return null; } }
function writeJsonFile(fp, d) { if (DRY_RUN) return; fs.writeFileSync(fp, JSON.stringify(d, null, 2) + '\n'); }

function mergeReviewData(target, source) {
  if (source.fullText && (!target.fullText || source.fullText.length > target.fullText.length)) target.fullText = source.fullText;
  if (source.llmScore != null && target.llmScore == null) target.llmScore = source.llmScore;
  if (source.llmConfidence && !target.llmConfidence) target.llmConfidence = source.llmConfidence;
  if (source.scoreSource && !target.scoreSource) target.scoreSource = source.scoreSource;
  if (source.assignedScore != null && target.assignedScore == null) target.assignedScore = source.assignedScore;
  if (source.url && !target.url) target.url = source.url;
  for (const f of ['bwwExcerpt','dtliExcerpt','showScoreExcerpt','nycTheatreExcerpt','playbillExcerpt']) {
    if (source[f] && !target[f]) target[f] = source[f];
  }
  for (const f of ['bwwThumb','dtliThumb','showScoreThumb','publishDate','originalRating']) {
    if (source[f] && !target[f]) target[f] = source[f];
  }
  return target;
}

function getShowDirs() {
  return fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory()).sort();
}
function getReviewFiles(showId) {
  try { return fs.readdirSync(path.join(REVIEW_TEXTS_DIR, showId)).filter(f => f.endsWith('.json')).sort(); } catch(e) { return []; }
}
function parseFilename(f) {
  const b = f.replace('.json',''); const i = b.indexOf('--');
  return i === -1 ? { outlet: b, critic: '' } : { outlet: b.substring(0,i), critic: b.substring(i+2) };
}
// normalizeUrl imported from ./lib/review-normalization
function getBaseTitle(showId) { return showId.replace(/-\d{4}$/, ''); }
function areRelatedShows(a, b) {
  const ba = getBaseTitle(a), bb = getBaseTitle(b);
  return ba === bb || ba.startsWith(bb) || bb.startsWith(ba);
}
function isGarbageUrl(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  if (/^\/people\//.test(u)) return true;
  if (/\/(entertainment|theater|theatre|arts|culture)\/?(\?.*)?$/.test(u)) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,4}\/?$/.test(u)) return true;
  const pp = u.replace(/^[a-z0-9.-]+\.[a-z]{2,4}/, '');
  if (pp.length < 5) return true;
  return false;
}

// Category 1: Outlet Alias Duplicates
function cleanupOutletAliases() {
  console.log('=== Category 1: Outlet Alias Duplicates ===\n');
  const showDirs = getShowDirs(); let total = 0;
  for (const showId of showDirs) {
    const files = getReviewFiles(showId); const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const groups = {};
    for (const file of files) {
      const { outlet, critic } = parseFilename(file);
      const canonical = OUTLET_ALIAS_MAP[outlet] || outlet;
      const key = canonical + '--' + critic;
      if (!groups[key]) groups[key] = [];
      groups[key].push({ file, outlet, critic, canonicalOutlet: canonical });
    }
    for (const [, group] of Object.entries(groups)) {
      if (group.length <= 1) continue;
      const canonical = group.find(g => g.outlet === g.canonicalOutlet) || group[0];
      for (const dupe of group.filter(g => g !== canonical)) {
        const cPath = path.join(showDir, canonical.file), dPath = path.join(showDir, dupe.file);
        const cData = readJsonFile(cPath), dData = readJsonFile(dPath);
        if (!cData || !dData || dData.duplicateOf || dData.wrongProduction || dData.wrongShow) continue;
        console.log(`  ${showId}: ${dupe.file} → merge into ${canonical.file}`);
        mergeReviewData(cData, dData); writeJsonFile(cPath, cData);
        dData.duplicateOf = canonical.file; dData._mergedInto = canonical.file; dData._mergeReason = 'outlet-alias-cleanup';
        writeJsonFile(dPath, dData); total++; stats.outletAliasFixed++; stats.filesMerged++;
      }
    }
  }
  console.log(`\n  Total outlet alias duplicates merged: ${total}\n`);
}

// Category 2: Critic Name Typos
function cleanupCriticTypos() {
  console.log('=== Category 2: Critic Name Typo Duplicates ===\n');
  const showDirs = getShowDirs(); let total = 0;
  for (const showId of showDirs) {
    const files = getReviewFiles(showId); const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    for (const file of files) {
      const { outlet, critic } = parseFilename(file);
      const canonical = CRITIC_TYPO_MAP[critic] || CRITIC_FILENAME_VARIANTS[critic];
      if (canonical && canonical !== critic) {
        const cFile = `${outlet}--${canonical}.json`;
        const cPath = path.join(showDir, cFile), dPath = path.join(showDir, file);
        if (!fs.existsSync(cPath)) {
          console.log(`  ${showId}: ${file} → rename to ${cFile}`);
          const data = readJsonFile(dPath);
          if (data && !DRY_RUN) { writeJsonFile(cPath, data); fs.unlinkSync(dPath); }
          total++; stats.criticTypoFixed++;
        } else {
          console.log(`  ${showId}: ${file} → merge into ${cFile}`);
          const cData = readJsonFile(cPath), dData = readJsonFile(dPath);
          if (cData && dData) {
            mergeReviewData(cData, dData); writeJsonFile(cPath, cData);
            dData.duplicateOf = cFile; dData._mergedInto = cFile; dData._mergeReason = 'critic-typo-cleanup';
            writeJsonFile(dPath, dData); total++; stats.criticTypoFixed++; stats.filesMerged++;
          }
        }
        continue;
      }
      const partial = CRITIC_PARTIAL_NAMES[critic];
      if (partial) {
        const cFile = `${outlet}--${partial}.json`;
        const cPath = path.join(showDir, cFile), dPath = path.join(showDir, file);
        if (fs.existsSync(cPath)) {
          console.log(`  ${showId}: ${file} → merge into ${cFile} (partial name)`);
          const cData = readJsonFile(cPath), dData = readJsonFile(dPath);
          if (cData && dData) {
            mergeReviewData(cData, dData); writeJsonFile(cPath, cData);
            dData.duplicateOf = cFile; dData._mergedInto = cFile; dData._mergeReason = 'critic-partial-name-cleanup';
            writeJsonFile(dPath, dData); total++; stats.criticTypoFixed++; stats.filesMerged++;
          }
        }
      }
    }
  }
  console.log(`\n  Total critic typo duplicates fixed: ${total}\n`);
}

// Category 3: Cross-Show URL Duplicates (only between related shows/revivals)
function cleanupCrossShowUrlDupes() {
  console.log('=== Category 3: Cross-Show URL Duplicates ===\n');
  const showsData = readJsonFile(SHOWS_PATH);
  if (!showsData) { console.log('  ERROR: Could not load shows.json'); return; }
  const showDates = {};
  const showsList = showsData.shows || Object.values(showsData);
  for (const show of showsList) {
    const id = show.id || show.slug; if (!id) continue;
    showDates[id] = { openingDate: show.openingDate, previewsDate: show.previewsDate, closingDate: show.closingDate };
  }
  console.log('  Building global URL index...');
  const urlIndex = {}; const showDirs = getShowDirs(); let totalFiles = 0;
  for (const showId of showDirs) {
    const files = getReviewFiles(showId); const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    for (const file of files) {
      const data = readJsonFile(path.join(showDir, file));
      if (!data || !data.url || data.duplicateOf || data.wrongProduction || data.wrongShow || data.isSyndicatedDuplicate) continue;
      const normUrl = normalizeUrl(data.url);
      if (!normUrl || normUrl.length < 10 || isGarbageUrl(normUrl)) continue;
      if (!urlIndex[normUrl]) urlIndex[normUrl] = [];
      urlIndex[normUrl].push({ showId, file, data, dir: showDir }); totalFiles++;
    }
  }
  console.log(`  Indexed ${totalFiles} files with URLs`);
  const crossShowGroups = {};
  for (const [normUrl, entries] of Object.entries(urlIndex)) {
    const showIds = [...new Set(entries.map(e => e.showId))];
    if (showIds.length <= 1) continue;
    crossShowGroups[normUrl] = entries;
  }
  console.log(`  Found ${Object.keys(crossShowGroups).length} cross-show URL duplicate groups`);
  let totalFlagged = 0, skippedUnrelated = 0, skippedNoYear = 0;
  for (const [normUrl, entries] of Object.entries(crossShowGroups)) {
    const showIds = [...new Set(entries.map(e => e.showId))];
    if (!showIds.every((a,i) => showIds.every((b,j) => i===j || areRelatedShows(a,b)))) { skippedUnrelated++; continue; }
    let bestShow = null, bestScore = -1;
    for (const entry of entries) {
      let score = 0; const dates = showDates[entry.showId]; if (!dates) continue;
      const oy = dates.openingDate ? parseInt(dates.openingDate.substring(0,4)) : null;
      const py = dates.previewsDate ? parseInt(dates.previewsDate.substring(0,4)) : null;
      let ry = null;
      if (entry.data.publishDate) { const m = entry.data.publishDate.match(/\b(19|20)\d{2}\b/); if (m) ry = parseInt(m[0]); }
      let uy = null; const um = normUrl.match(/\/(19|20)(\d{2})\//); if (um) uy = parseInt(um[1]+um[2]);
      const refY = ry || uy, showY = oy || py;
      if (refY && showY) {
        if (refY === showY) score += 100; else if (Math.abs(refY-showY)===1) score += 50;
        else if (Math.abs(refY-showY)<=2) score += 20; else score -= 50;
      }
      if (entry.data.fullText && entry.data.fullText.length > 100) score += 10;
      const { critic } = parseFilename(entry.file); if (critic && critic !== 'unknown') score += 5;
      if (score > bestScore) { bestScore = score; bestShow = entry.showId; }
    }
    if (!bestShow || bestScore <= 0) { skippedNoYear++; continue; }
    for (const entry of entries) {
      if (entry.showId === bestShow) continue;
      const fp = path.join(entry.dir, entry.file); const data = readJsonFile(fp);
      if (!data || data.wrongProduction) continue;
      console.log(`  ${entry.showId}/${entry.file} → wrongProduction (belongs to ${bestShow})`);
      data.wrongProduction = true; data._wrongProductionReason = `URL matches ${bestShow} (year-based)`;
      data._wrongProductionDetectedBy = 'cleanup-dedup-comprehensive';
      writeJsonFile(fp, data); totalFlagged++; stats.crossShowFlagged++;
    }
  }
  console.log(`\n  Total cross-show files flagged: ${totalFlagged}`);
  console.log(`  Skipped (unrelated shows): ${skippedUnrelated}`);
  console.log(`  Skipped (no year data): ${skippedNoYear}\n`);
}

// Category 4: Same-Show URL Duplicates
function cleanupSameShowUrlDupes() {
  console.log('=== Category 4: Same-Show URL Duplicates ===\n');
  const showDirs = getShowDirs(); let total = 0;
  for (const showId of showDirs) {
    const files = getReviewFiles(showId); const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const urlGroups = {};
    for (const file of files) {
      const data = readJsonFile(path.join(showDir, file));
      if (!data || !data.url || data.duplicateOf || data.wrongProduction || data.wrongShow || data.isSyndicatedDuplicate) continue;
      const normUrl = normalizeUrl(data.url);
      if (!normUrl || normUrl.length < 10) continue;
      if (!urlGroups[normUrl]) urlGroups[normUrl] = [];
      urlGroups[normUrl].push({ file, data });
    }
    for (const [, group] of Object.entries(urlGroups)) {
      if (group.length <= 1) continue;
      const scored = group.map(e => {
        let s = 0; const { outlet, critic } = parseFilename(e.file);
        if (e.data.fullText) s += e.data.fullText.length;
        if (e.data.assignedScore != null) s += 200;
        if (e.data.llmScore != null) s += 150;
        if (critic && critic !== 'unknown') s += 100;
        if (!OUTLET_ALIAS_MAP[outlet]) s += 50;
        return { ...e, score: s, outlet, critic };
      }).sort((a,b) => b.score - a.score);
      const best = scored[0];
      for (const dupe of scored.slice(1)) {
        const bPath = path.join(showDir, best.file), dPath = path.join(showDir, dupe.file);
        const bData = readJsonFile(bPath), dData = readJsonFile(dPath);
        if (!bData || !dData || dData.duplicateOf) continue;
        console.log(`  ${showId}: ${dupe.file} → duplicate URL of ${best.file}`);
        mergeReviewData(bData, dData); writeJsonFile(bPath, bData);
        dData.duplicateOf = best.file; dData._mergedInto = best.file; dData._mergeReason = 'same-show-url-dedup';
        writeJsonFile(dPath, dData); total++; stats.sameShowUrlFixed++; stats.filesMerged++;
      }
    }
  }
  console.log(`\n  Total same-show URL duplicates flagged: ${total}\n`);
}

function main() {
  console.log('========================================');
  console.log('  Comprehensive Review Dedup Cleanup');
  console.log('========================================\n');
  if (CATEGORY === 0 || CATEGORY === 1) cleanupOutletAliases();
  if (CATEGORY === 0 || CATEGORY === 2) cleanupCriticTypos();
  if (CATEGORY === 0 || CATEGORY === 3) cleanupCrossShowUrlDupes();
  if (CATEGORY === 0 || CATEGORY === 4) cleanupSameShowUrlDupes();
  console.log('========================================');
  console.log('  SUMMARY');
  console.log('========================================');
  console.log(`  Outlet alias duplicates merged:    ${stats.outletAliasFixed}`);
  console.log(`  Critic typo duplicates fixed:      ${stats.criticTypoFixed}`);
  console.log(`  Cross-show files flagged:           ${stats.crossShowFlagged}`);
  console.log(`  Same-show URL dupes flagged:        ${stats.sameShowUrlFixed}`);
  console.log(`  Total files merged/flagged:         ${stats.filesMerged}`);
  console.log(`  Errors:                             ${stats.errors.length}`);
  if (DRY_RUN) console.log('\n*** DRY RUN — no changes were made ***');
}

main();
