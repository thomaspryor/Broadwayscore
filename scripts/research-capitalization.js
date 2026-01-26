#!/usr/bin/env node
/**
 * Research Capitalization Data
 *
 * Searches for Broadway show capitalization and recoupment information from:
 * - Reddit r/Broadway discussions
 * - SEC filings (SEC EDGAR)
 * - Trade press (Broadway Journal, Broadway News, Deadline, Variety)
 *
 * Usage: node scripts/research-capitalization.js [show-name]
 *
 * Examples:
 *   node scripts/research-capitalization.js "Hamilton"
 *   node scripts/research-capitalization.js "Death Becomes Her"
 *   node scripts/research-capitalization.js  # Research all shows missing data
 */

const fs = require('fs');
const path = require('path');

// Load existing data
const showsPath = path.join(__dirname, '../data/shows.json');
const commercialPath = path.join(__dirname, '../data/commercial.json');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
const commercialData = JSON.parse(fs.readFileSync(commercialPath, 'utf-8'));

// Extract show name from args
const targetShow = process.argv[2];

// Find shows missing capitalization data
function findMissingData() {
  const missing = [];

  for (const [showId, showInfo] of Object.entries(showsData.shows)) {
    // Use the slug as the key for commercial data lookup
    const slug = showInfo.slug;
    const commercial = commercialData.shows[slug];

    if (!commercial) {
      missing.push({
        showId,
        slug,
        title: showInfo.title,
        status: showInfo.status,
        missingAll: true
      });
    } else if (!commercial.capitalization) {
      missing.push({
        showId,
        slug,
        title: showInfo.title,
        status: showInfo.status,
        hasEntry: true,
        missingCap: true
      });
    }
  }

  return missing;
}

// Generate search queries for a show
function generateSearchQueries(title) {
  const cleanTitle = title.replace(/[!?:]/g, '');
  return [
    `"${title}" Broadway capitalization budget million`,
    `"${title}" Broadway recouped investment`,
    `"${cleanTitle}" SEC filing Broadway`,
    `site:reddit.com/r/Broadway "${title}" budget OR capitalization OR recoup`,
    `site:broadwaynews.com "${title}" capitalization OR recoup`,
    `site:broadwayjournal.com "${title}" capitalization`,
  ];
}

// Format search results for manual review
function formatResearchGuide(shows) {
  let output = `
# Broadway Capitalization Research Guide
Generated: ${new Date().toISOString()}

## Shows Missing Data

`;

  for (const show of shows) {
    output += `### ${show.title}\n`;
    output += `- Show ID: ${show.showId}\n`;
    output += `- Status: ${show.status}\n`;
    output += `- Missing: ${show.missingAll ? 'All commercial data' : 'Capitalization amount'}\n\n`;

    output += `**Search Queries:**\n`;
    const queries = generateSearchQueries(show.title);
    queries.forEach((q, i) => {
      output += `${i + 1}. ${q}\n`;
    });

    output += `\n**SEC EDGAR Search:**\n`;
    output += `https://www.sec.gov/cgi-bin/srch-ia?text=${encodeURIComponent(show.title + ' Broadway')}&first=1&last=40\n\n`;

    output += `---\n\n`;
  }

  return output;
}

// Main execution
async function main() {
  console.log('Broadway Capitalization Research Tool\n');

  if (targetShow) {
    console.log(`Generating research queries for: ${targetShow}\n`);
    const queries = generateSearchQueries(targetShow);
    console.log('Search queries:');
    queries.forEach((q, i) => {
      console.log(`  ${i + 1}. ${q}`);
    });
    console.log('\nSEC EDGAR search:');
    console.log(`  https://www.sec.gov/cgi-bin/srch-ia?text=${encodeURIComponent(targetShow + ' Broadway')}&first=1&last=40`);
  } else {
    const missing = findMissingData();

    console.log(`Found ${missing.length} shows missing capitalization data:\n`);

    // Prioritize open shows
    const openShows = missing.filter(s => s.status === 'open');
    const closedShows = missing.filter(s => s.status === 'closed');
    const previewShows = missing.filter(s => s.status === 'previews');

    console.log(`Open shows missing data: ${openShows.length}`);
    openShows.forEach(s => console.log(`  - ${s.title}`));

    console.log(`\nClosed shows missing data: ${closedShows.length}`);
    closedShows.forEach(s => console.log(`  - ${s.title}`));

    if (previewShows.length > 0) {
      console.log(`\nUpcoming shows (previews): ${previewShows.length}`);
      previewShows.forEach(s => console.log(`  - ${s.title}`));
    }

    // Generate research guide
    const guide = formatResearchGuide(missing);
    const guidePath = path.join(__dirname, '../data/capitalization-research-guide.md');
    fs.writeFileSync(guidePath, guide);
    console.log(`\nResearch guide saved to: ${guidePath}`);
  }
}

main().catch(console.error);
