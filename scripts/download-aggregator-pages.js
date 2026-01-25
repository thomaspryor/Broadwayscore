#!/usr/bin/env node
/**
 * Download and Archive Aggregator Pages
 *
 * Downloads HTML from DTLI, BWW Review Roundups, and Show-Score
 * for local archival and faster access during review collection.
 *
 * Usage:
 *   node scripts/download-aggregator-pages.js
 *   node scripts/download-aggregator-pages.js --show "Hamilton"
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Output directories
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive');
const DTLI_DIR = path.join(ARCHIVE_DIR, 'dtli');
const BWW_DIR = path.join(ARCHIVE_DIR, 'bww-roundups');
const SHOWSCORE_DIR = path.join(ARCHIVE_DIR, 'show-score');

// Show data with aggregator URLs
const SHOWS = [
  {
    id: 'bug-2025',
    title: 'Bug',
    dtli: 'https://didtheylikeit.com/bug/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-BUG-Opens-On-Broadway-20260108',
    showScore: 'https://www.show-score.com/broadway-shows/bug'
  },
  {
    id: 'marjorie-prime-2025',
    title: 'Marjorie Prime',
    dtli: 'https://didtheylikeit.com/marjorie-prime/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-MARJORIE-PRIME-Opens-On-Broadway-Starring-Cynthia-Nixon-June-Squibb-Danny-Burstein-and-More-20251208',
    showScore: 'https://www.show-score.com/broadway-shows/marjorie-prime'
  },
  {
    id: 'two-strangers-bway-2025',
    title: 'Two Strangers',
    dtli: 'https://didtheylikeit.com/two-strangers-carry-a-cake-across-new-york/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-TWO-STRANGERS-Opens-On-Broadway',
    showScore: 'https://www.show-score.com/broadway-shows/two-strangers-carry-a-cake-across-new-york'
  },
  {
    id: 'operation-mincemeat-2025',
    title: 'Operation Mincemeat',
    dtli: 'https://didtheylikeit.com/operation-mincemeat/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-OPERATION-MINCEMEAT-Opens-On-Broadway-20250121',
    showScore: 'https://www.show-score.com/broadway-shows/operation-mincemeat'
  },
  {
    id: 'mj-2022',
    title: 'MJ The Musical',
    dtli: 'https://didtheylikeit.com/mj-the-musical/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-MJ-THE-MUSICAL-Opens-On-Broadway-20220201',
    showScore: 'https://www.show-score.com/broadway-shows/mj-the-musical'
  },
  {
    id: 'maybe-happy-ending-2024',
    title: 'Maybe Happy Ending',
    dtli: 'https://didtheylikeit.com/maybe-happy-ending/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-MAYBE-HAPPY-ENDING-Starring-Darren-Criss-and-Helen-J-Shen-20241112',
    showScore: 'https://www.show-score.com/broadway-shows/maybe-happy-ending'
  },
  {
    id: 'hells-kitchen-2024',
    title: "Hell's Kitchen",
    dtli: 'https://didtheylikeit.com/hells-kitchen/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-HELLS-KITCHEN-Opens-on-Broadway-20240420',
    showScore: 'https://www.show-score.com/broadway-shows/hell-s-kitchen'
  },
  {
    id: 'the-outsiders-2024',
    title: 'The Outsiders',
    dtli: 'https://didtheylikeit.com/the-outsiders/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-THE-OUTSIDERS-Opens-On-Broadway-20240411',
    showScore: 'https://www.show-score.com/broadway-shows/the-outsiders'
  },
  {
    id: 'oh-mary-2024',
    title: 'Oh, Mary!',
    dtli: 'https://didtheylikeit.com/oh-mary/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-OH-MARY-Opens-On-Broadway-20240619',
    showScore: 'https://www.show-score.com/broadway-shows/oh-mary'
  },
  {
    id: 'the-great-gatsby-2024',
    title: 'The Great Gatsby',
    dtli: 'https://didtheylikeit.com/the-great-gatsby/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-THE-GREAT-GATSBY-Opens-On-Broadway-20240425',
    showScore: 'https://www.show-score.com/broadway-shows/the-great-gatsby'
  },
  {
    id: 'stranger-things-2024',
    title: 'Stranger Things: The First Shadow',
    dtli: 'https://didtheylikeit.com/stranger-things-the-first-shadow/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-STRANGER-THINGS-THE-FIRST-SHADOW-Opens-On-Broadway',
    showScore: 'https://www.show-score.com/broadway-shows/stranger-things-the-first-shadow'
  },
  {
    id: 'and-juliet-2022',
    title: '& Juliet',
    dtli: 'https://didtheylikeit.com/shows/juliet/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-JULIET-Brings-To-Music-of-Max-Martin-To-Broadway-20221117',
    showScore: 'https://www.show-score.com/broadway-shows/and-juliet'
  },
  {
    id: 'six-2021',
    title: 'SIX',
    dtli: 'https://didtheylikeit.com/six/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-SIX-Opens-on-Broadway-20211003',
    showScore: 'https://www.show-score.com/broadway-shows/six'
  },
  {
    id: 'hadestown-2019',
    title: 'Hadestown',
    dtli: 'https://didtheylikeit.com/hadestown/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-HADESTOWN-Opens-On-Broadway--What-Did-The-Critics-Think-20190417',
    showScore: 'https://www.show-score.com/broadway-shows/hadestown'
  },
  {
    id: 'moulin-rouge-2019',
    title: 'Moulin Rouge!',
    dtli: 'https://didtheylikeit.com/moulin-rouge/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-MOULIN-ROUGE-Opens-On-Broadway-See-What-The-Critics-Think-20190725',
    showScore: 'https://www.show-score.com/broadway-shows/moulin-rouge'
  },
  {
    id: 'hamilton-2015',
    title: 'Hamilton',
    dtli: 'https://didtheylikeit.com/hamilton/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-HAMILTON-Opens-on-Broadway-Updating-LIVE-20150806',
    showScore: 'https://www.show-score.com/broadway-shows/hamilton'
  },
  {
    id: 'book-of-mormon-2011',
    title: 'The Book of Mormon',
    dtli: 'https://didtheylikeit.com/shows/the-book-of-mormon-reviews/',
    bww: 'https://www.broadwayworld.com/article/Broadway-Review-Roundup-THE-BOOK-OF-MORMON-20110324',
    showScore: 'https://www.show-score.com/broadway-shows/the-book-of-mormon'
  },
  {
    id: 'wicked-2003',
    title: 'Wicked',
    dtli: 'https://didtheylikeit.com/wicked/',
    bww: null, // BWW didn't exist in 2003
    showScore: 'https://www.show-score.com/broadway-shows/wicked'
  },
  {
    id: 'aladdin-2014',
    title: 'Aladdin',
    dtli: 'https://didtheylikeit.com/aladdin/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-ALADDIN-Opens-on-Broadway-Updating-LIVE-20140320',
    showScore: 'https://www.show-score.com/broadway-shows/aladdin'
  },
  {
    id: 'the-lion-king-1997',
    title: 'The Lion King',
    dtli: 'https://didtheylikeit.com/the-lion-king/',
    bww: null, // BWW didn't exist in 1997
    showScore: 'https://www.show-score.com/broadway-shows/the-lion-king'
  },
  {
    id: 'chicago-1996',
    title: 'Chicago',
    dtli: 'https://didtheylikeit.com/chicago/',
    bww: null, // BWW didn't exist in 1996
    showScore: 'https://www.show-score.com/broadway-shows/chicago'
  },
  {
    id: 'harry-potter-2021',
    title: 'Harry Potter and the Cursed Child',
    dtli: 'https://didtheylikeit.com/harry-potter-and-the-cursed-child/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-HARRY-POTTER-AND-THE-CURSED-CHILD-Reopens-on-Broadway-20211207',
    showScore: 'https://www.show-score.com/broadway-shows/harry-potter-and-the-cursed-child'
  },
  {
    id: 'mamma-mia-2025',
    title: 'Mamma Mia!',
    dtli: 'https://didtheylikeit.com/mamma-mia/',
    bww: 'https://www.broadwayworld.com/article/Review-Roundup-MAMMA-MIA-Returns-To-Broadway-20250814',
    showScore: 'https://www.show-score.com/broadway-shows/mamma-mia'
  }
];

// Create directories
function ensureDirectories() {
  [ARCHIVE_DIR, DTLI_DIR, BWW_DIR, SHOWSCORE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created directory: ${dir}`);
    }
  });
}

// Download a URL and save to file
function downloadPage(url, filepath) {
  return new Promise((resolve, reject) => {
    if (!url) {
      resolve({ skipped: true, reason: 'No URL' });
      return;
    }

    // Check if file already exists and is recent (less than 7 days old)
    if (fs.existsSync(filepath)) {
      const stats = fs.statSync(filepath);
      const ageInDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
      if (ageInDays < 7) {
        resolve({ skipped: true, reason: 'Recent file exists', age: Math.round(ageInDays) });
        return;
      }
    }

    const protocol = url.startsWith('https') ? https : http;

    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    };

    protocol.get(url, options, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        let redirectUrl = response.headers.location;
        // Handle relative redirects
        if (redirectUrl.startsWith('/')) {
          const urlObj = new URL(url);
          redirectUrl = `${urlObj.protocol}//${urlObj.host}${redirectUrl}`;
        }
        downloadPage(redirectUrl, filepath).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        resolve({ error: true, status: response.statusCode });
        return;
      }

      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        // Add metadata header
        const metadata = `<!--
  Archived: ${new Date().toISOString()}
  Source: ${url}
  Status: ${response.statusCode}
-->
`;
        fs.writeFileSync(filepath, metadata + data);
        resolve({ success: true, size: data.length });
      });
    }).on('error', (err) => {
      resolve({ error: true, message: err.message });
    });
  });
}

// Download all pages for a show
async function downloadShowPages(show) {
  console.log(`\n📥 ${show.title} (${show.id})`);

  const results = {};

  // DTLI
  if (show.dtli) {
    const dtliFile = path.join(DTLI_DIR, `${show.id}.html`);
    process.stdout.write(`   DTLI: `);
    const dtliResult = await downloadPage(show.dtli, dtliFile);
    if (dtliResult.success) {
      console.log(`✓ Downloaded (${Math.round(dtliResult.size / 1024)}KB)`);
    } else if (dtliResult.skipped) {
      console.log(`⏭ Skipped (${dtliResult.reason})`);
    } else {
      console.log(`✗ Error: ${dtliResult.status || dtliResult.message}`);
    }
    results.dtli = dtliResult;
  }

  // BWW Review Roundup
  if (show.bww) {
    const bwwFile = path.join(BWW_DIR, `${show.id}.html`);
    process.stdout.write(`   BWW:  `);
    const bwwResult = await downloadPage(show.bww, bwwFile);
    if (bwwResult.success) {
      console.log(`✓ Downloaded (${Math.round(bwwResult.size / 1024)}KB)`);
    } else if (bwwResult.skipped) {
      console.log(`⏭ Skipped (${bwwResult.reason})`);
    } else {
      console.log(`✗ Error: ${bwwResult.status || bwwResult.message}`);
    }
    results.bww = bwwResult;
  } else {
    console.log(`   BWW:  ⏭ No roundup available`);
  }

  // Show-Score
  if (show.showScore) {
    const ssFile = path.join(SHOWSCORE_DIR, `${show.id}.html`);
    process.stdout.write(`   SS:   `);
    const ssResult = await downloadPage(show.showScore, ssFile);
    if (ssResult.success) {
      console.log(`✓ Downloaded (${Math.round(ssResult.size / 1024)}KB)`);
    } else if (ssResult.skipped) {
      console.log(`⏭ Skipped (${ssResult.reason})`);
    } else {
      console.log(`✗ Error: ${ssResult.status || ssResult.message}`);
    }
    results.showScore = ssResult;
  }

  // Small delay between shows to be respectful
  await new Promise(r => setTimeout(r, 500));

  return results;
}

// Main function
async function main() {
  console.log('🎭 Broadway Aggregator Page Archiver');
  console.log('=====================================\n');

  ensureDirectories();

  const args = process.argv.slice(2);
  let showsToProcess = SHOWS;

  // Filter by show name if provided
  if (args.includes('--show')) {
    const showIndex = args.indexOf('--show');
    const showName = args[showIndex + 1];
    if (showName) {
      showsToProcess = SHOWS.filter(s =>
        s.title.toLowerCase().includes(showName.toLowerCase()) ||
        s.id.toLowerCase().includes(showName.toLowerCase())
      );
      if (showsToProcess.length === 0) {
        console.log(`No shows found matching "${showName}"`);
        process.exit(1);
      }
    }
  }

  // Force re-download if --force flag
  const forceDownload = args.includes('--force');
  if (forceDownload) {
    console.log('⚠️  Force mode: Re-downloading all pages\n');
  }

  console.log(`Processing ${showsToProcess.length} shows...\n`);

  const summary = { downloaded: 0, skipped: 0, errors: 0 };

  for (const show of showsToProcess) {
    const results = await downloadShowPages(show);
    Object.values(results).forEach(r => {
      if (r.success) summary.downloaded++;
      else if (r.skipped) summary.skipped++;
      else if (r.error) summary.errors++;
    });
  }

  console.log('\n=====================================');
  console.log('📊 Summary:');
  console.log(`   Downloaded: ${summary.downloaded}`);
  console.log(`   Skipped:    ${summary.skipped}`);
  console.log(`   Errors:     ${summary.errors}`);
  console.log(`\n📁 Archive location: ${ARCHIVE_DIR}`);
}

main().catch(console.error);
