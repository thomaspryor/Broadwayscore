#!/usr/bin/env node
/**
 * Find reviews that have URLs but no text/score — candidates for scraping
 * Also find reviews with text but no LLM score — candidates for scoring
 */

const fs = require('fs');
const path = require('path');

const textsDir = path.join(__dirname, '../data/review-texts');
const shows = fs.readdirSync(textsDir).filter(d =>
  fs.statSync(path.join(textsDir, d)).isDirectory()
);

let totalFiles = 0;
let withUrl = 0;
let noText = 0;
let noLlm = 0;
let noScore = 0;
let scrapable = []; // has URL, no fullText
let needsScoring = []; // has text, no LLM score
let completeStubs = []; // no URL, no text, no score

const showsNeedingScrape = new Map(); // showId → count

for (const showId of shows) {
  const showDir = path.join(textsDir, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));

  for (const f of files) {
    totalFiles++;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf-8'));
      const hasUrl = data.url && data.url.length > 10;
      const hasFullText = data.fullText && data.fullText.length > 50;
      const hasExcerpt = (data.dtliExcerpt && data.dtliExcerpt.length > 30) ||
                         (data.bwwExcerpt && data.bwwExcerpt.length > 30) ||
                         (data.showScoreExcerpt && data.showScoreExcerpt.length > 30);
      const hasLlm = data.llmScore && data.llmScore.score;
      const hasScore = data.assignedScore || hasLlm;

      if (hasUrl) withUrl++;
      if (!hasFullText) noText++;
      if (!hasLlm) noLlm++;
      if (!hasScore) noScore++;

      if (hasUrl && !hasFullText && !data.isMultiShowReview && !data.wrongShow && !data.wrongProduction) {
        scrapable.push({ showId, file: f, url: data.url, hasExcerpt, outlet: data.outlet || data.outletId });
        showsNeedingScrape.set(showId, (showsNeedingScrape.get(showId) || 0) + 1);
      }

      if ((hasFullText || hasExcerpt) && !hasLlm && !data.isMultiShowReview && !data.wrongShow) {
        needsScoring.push({ showId, file: f, textLen: hasFullText ? data.fullText.length : 0, hasExcerpt });
      }

      if (!hasUrl && !hasFullText && !hasScore && !hasExcerpt) {
        completeStubs.push({ showId, file: f, outlet: data.outlet || data.outletId });
      }
    } catch (e) { /* skip */ }
  }
}

console.log('=== REVIEW DATA COVERAGE ===\n');
console.log(`Total review files: ${totalFiles}`);
console.log(`With URL: ${withUrl}`);
console.log(`Without full text: ${noText}`);
console.log(`Without LLM score: ${noLlm}`);
console.log(`Without any score: ${noScore}`);

console.log(`\n=== SCRAPABLE (has URL, no fullText): ${scrapable.length} ===`);
// Group by show
const byShow = new Map();
for (const r of scrapable) {
  if (!byShow.has(r.showId)) byShow.set(r.showId, []);
  byShow.get(r.showId).push(r);
}
for (const [showId, reviews] of [...byShow.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
  console.log(`  ${showId}: ${reviews.length} reviews`);
  for (const r of reviews.slice(0, 3)) {
    console.log(`    ${r.outlet}: ${r.url?.substring(0, 60)}...`);
  }
}

console.log(`\n=== NEEDS SCORING (has text, no LLM): ${needsScoring.length} ===`);
for (const r of needsScoring.slice(0, 15)) {
  console.log(`  ${r.showId}/${r.file} — ${r.textLen} chars${r.hasExcerpt ? ' (has excerpt)' : ''}`);
}

console.log(`\n=== COMPLETE STUBS (no URL, no text, no score): ${completeStubs.length} ===`);
// Group by show
const stubsByShow = new Map();
for (const r of completeStubs) {
  if (!stubsByShow.has(r.showId)) stubsByShow.set(r.showId, []);
  stubsByShow.get(r.showId).push(r);
}
for (const [showId, stubs] of [...stubsByShow.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  console.log(`  ${showId}: ${stubs.length} stubs — ${stubs.map(s => s.outlet).join(', ')}`);
}

// Write show list for batch scraping
const showsToScrape = [...byShow.keys()].sort();
fs.writeFileSync(
  path.join(__dirname, '../data/audit/shows-needing-scrape.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), showCount: showsToScrape.length, reviewCount: scrapable.length, shows: showsToScrape }, null, 2)
);
console.log(`\nWrote ${showsToScrape.length} shows needing scrape to data/audit/shows-needing-scrape.json`);
