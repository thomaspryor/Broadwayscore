#!/usr/bin/env node
/**
 * fetch-synopses-wikipedia.js
 *
 * Fetches show synopses from Wikipedia's free API for shows missing synopsis data.
 * Uses the Wikipedia TextExtracts API to get the opening paragraph.
 *
 * Usage:
 *   node scripts/fetch-synopses-wikipedia.js [--dry-run] [--limit=N] [--show=SLUG]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 0;
const showArg = args.find(a => a.startsWith('--show='));
const showFilter = showArg ? showArg.split('=')[1] : null;

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'BroadwayScorecard/1.0 (educational project)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

/**
 * Search Wikipedia for a Broadway show and get the opening extract.
 */
async function fetchWikipediaSynopsis(show) {
  const title = show.title;
  const year = show.openingDate ? show.openingDate.substring(0, 4) : '';
  const type = show.type === 'musical' ? 'musical' : 'play';

  // Try multiple search queries in order of specificity
  const queries = [
    `${title} (${type})`,
    `${title} (musical)`,
    `${title} Broadway`,
    title,
  ];

  for (const query of queries) {
    try {
      // Step 1: Search for the page
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json`;
      const searchResult = await httpGet(searchUrl);

      if (!searchResult || !searchResult.query || !searchResult.query.search || searchResult.query.search.length === 0) {
        continue;
      }

      // Find the best match - score each result
      const titleLower = title.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      let bestPage = null;
      let bestScore = -1;

      for (const page of searchResult.query.search) {
        const pageTitle = page.title.toLowerCase();
        const pageTitleClean = pageTitle.replace(/[^a-z0-9 ]/g, '');
        let score = 0;

        // Reject generic pages
        if (pageTitle === 'broadway theatre' || pageTitle === 'musical theatre' ||
            pageTitle === 'list of musicals' || pageTitle.startsWith('list of')) {
          continue;
        }

        // Strong boost for title match
        if (pageTitleClean.includes(titleLower) || titleLower.includes(pageTitleClean)) score += 10;

        // Boost for show-type pages
        if (pageTitle.includes('musical') || pageTitle.includes('play')) score += 5;
        if (pageTitle.includes('broadway')) score += 3;

        // Penalize disambiguation
        if (pageTitle.includes('disambiguation')) score -= 20;

        if (score > bestScore) {
          bestScore = score;
          bestPage = page;
        }
      }

      if (!bestPage) continue;

      // Step 2: Get the extract (opening paragraph)
      const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&pageids=${bestPage.pageid}&prop=extracts&exintro=true&explaintext=true&exsectionformat=plain&format=json`;
      const extractResult = await httpGet(extractUrl);

      if (!extractResult || !extractResult.query || !extractResult.query.pages) continue;

      const page = Object.values(extractResult.query.pages)[0];
      if (!page || !page.extract) continue;

      const extract = page.extract.trim();

      // Validate: must mention something relevant
      const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const extractLower = extract.toLowerCase();
      const mentions = titleWords.filter(w => extractLower.includes(w)).length;

      if (mentions === 0 && !extractLower.includes('broadway') && !extractLower.includes('musical') && !extractLower.includes('play')) {
        continue; // Not about this show
      }

      // Take first 1-2 sentences, targeting ~200-400 chars
      let synopsis = extract;

      // Split into sentences
      const sentences = extract.match(/[^.!?]+[.!?]+/g) || [extract];

      if (sentences.length >= 2) {
        // Take first 2 sentences
        synopsis = sentences.slice(0, 2).join('').trim();

        // If too short, take 3
        if (synopsis.length < 150 && sentences.length >= 3) {
          synopsis = sentences.slice(0, 3).join('').trim();
        }

        // If too long, take just 1
        if (synopsis.length > 500) {
          synopsis = sentences[0].trim();
        }
      }

      // Skip if it's just a disambiguation or too short
      if (synopsis.length < 50) continue;
      if (synopsis.includes('may refer to') || synopsis.includes('disambiguation')) continue;

      return { synopsis, source: `Wikipedia: ${bestPage.title}` };
    } catch (e) {
      // Try next query
    }
  }

  return null;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const showList = showsData.shows || showsData;

  let missing = showList.filter(s => !s.synopsis || s.synopsis.trim().length < 50);

  if (showFilter) {
    missing = missing.filter(s => s.slug === showFilter || s.id === showFilter);
  }

  if (limit > 0) {
    missing = missing.slice(0, limit);
  }

  console.log(`=== Wikipedia Synopsis Fetcher ===`);
  console.log(`Shows missing synopsis: ${missing.length}`);
  console.log(`Dry run: ${dryRun}\n`);

  let fetched = 0, failed = 0;

  for (const show of missing) {
    process.stdout.write(`  ${show.id}... `);

    const result = await fetchWikipediaSynopsis(show);

    if (result) {
      console.log(`OK (${result.source}, ${result.synopsis.length} chars)`);
      if (!dryRun) {
        show.synopsis = result.synopsis;
      }
      fetched++;
    } else {
      console.log('not found');
      failed++;
    }

    // Rate limit: 200ms between requests
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n=== Results ===`);
  console.log(`Fetched: ${fetched}`);
  console.log(`Not found: ${failed}`);

  if (!dryRun && fetched > 0) {
    // Write back — preserve original format
    if (showsData.shows) {
      showsData.shows = showList;
    }
    fs.writeFileSync(SHOWS_FILE, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nWrote ${fetched} synopses to shows.json`);
  }
}

main().catch(console.error);
