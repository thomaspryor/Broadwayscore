#!/usr/bin/env node

/**
 * Fetch review excerpts from BroadwayWorld review roundups
 * BWW publishes "Review Roundup" articles that quote from all major critics
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const DELAY_MS = 2000;

// Map show IDs to their BWW roundup URLs (verified URLs)
const BWW_ROUNDUPS = {
  'hamilton-2015': 'https://www.broadwayworld.com/article/Review-Roundup-HAMILTON-Opens-on-Broadway-20150806',
  'hadestown-2019': 'https://www.broadwayworld.com/article/Review-Roundup-HADESTOWN-Opens-On-Broadway-What-Did-The-Critics-Think-20190417',
  'moulin-rouge-2019': 'https://www.broadwayworld.com/article/Review-Roundup-MOULIN-ROUGE-Opens-On-Broadway-See-What-The-Critics-Think-20190725',
  'six-2021': 'https://www.broadwayworld.com/article/Review-Roundup-SIX-Opens-on-Broadway-20211004',
  'mj-2022': 'https://www.broadwayworld.com/article/Review-Roundup-MJ-Opens-on-Broadway-See-What-the-Critics-Are-Saying-20220201',
  'and-juliet-2022': 'https://www.broadwayworld.com/article/Review-Roundup-JULIET-Opens-On-Broadway-What-Did-The-Critics-Think-20221117',
  'book-of-mormon-2011': 'https://www.broadwayworld.com/article/Review-Roundup-THE-BOOK-OF-MORMON-Opens-on-Broadway-20110325',
  'aladdin-2014': 'https://www.broadwayworld.com/article/Review-Roundup-Disneys-ALADDIN-Opens-on-Broadway-20140320',
  'cabaret-2024': 'https://www.broadwayworld.com/article/Review-Roundup-CABARET-AT-THE-KIT-KAT-CLUB-Opens-On-Broadway-20240422',
  'stereophonic-2024': 'https://www.broadwayworld.com/article/Review-Roundup-STEREOPHONIC-Opens-On-Broadway-20240419',
  'the-outsiders-2024': 'https://www.broadwayworld.com/article/Review-Roundup-THE-OUTSIDERS-Opens-On-Broadway-20240411',
  'hells-kitchen-2024': 'https://www.broadwayworld.com/article/Review-Roundup-HELLS-KITCHEN-Opens-On-Broadway-20240421',
  'the-great-gatsby-2024': 'https://www.broadwayworld.com/article/Review-Roundup-THE-GREAT-GATSBY-Opens-On-Broadway-20240425',
  'maybe-happy-ending-2024': 'https://www.broadwayworld.com/article/Review-Roundup-MAYBE-HAPPY-ENDING-Opens-On-Broadway-20241112',
  'death-becomes-her-2024': 'https://www.broadwayworld.com/article/Review-Roundup-DEATH-BECOMES-HER-Opens-On-Broadway-20241121',
  'oh-mary-2024': 'https://www.broadwayworld.com/article/Review-Roundup-OH-MARY-Opens-On-Broadway-20240711',
  'stranger-things-2024': 'https://www.broadwayworld.com/article/Review-Roundup-STRANGER-THINGS-THE-FIRST-SHADOW-Opens-On-Broadway-20241120',
  'buena-vista-social-club-2025': 'https://www.broadwayworld.com/article/Review-Roundup-BUENA-VISTA-SOCIAL-CLUB-Opens-On-Broadway-20250319',
  'operation-mincemeat-2025': 'https://www.broadwayworld.com/article/Review-Roundup-OPERATION-MINCEMEAT-Opens-On-Broadway-20250320',
  'ragtime-2025': 'https://www.broadwayworld.com/article/Review-Roundup-RAGTIME-Returns-to-Broadway-20251016',
  'bug-2025': 'https://www.broadwayworld.com/article/Review-Roundup-BUG-Opens-On-Broadway-20250113',
  'chess-2025': 'https://www.broadwayworld.com/article/Review-Roundup-CHESS-Opens-On-Broadway-20250130',
  'marjorie-prime-2025': 'https://www.broadwayworld.com/article/Review-Roundup-MARJORIE-PRIME-Opens-On-Broadway-20250116',
  'oedipus-2025': 'https://www.broadwayworld.com/article/Review-Roundup-OEDIPUS-Opens-On-Broadway-20250109',
  'two-strangers-bway-2025': 'https://www.broadwayworld.com/article/Review-Roundup-TWO-STRANGERS-CARRY-A-CAKE-ACROSS-NEW-YORK-Opens-On-Broadway-20250109',
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetch(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, data }));
    }).on('error', reject);
  });
}

function extractReviewExcerpts(html) {
  const excerpts = [];

  // BWW typically formats reviews as outlet name followed by quote
  // Pattern: outlet name (often in bold or as link) followed by review text

  // Look for patterns like "The New York Times:" or "Variety:" followed by text
  const patterns = [
    /(?:The\s+)?New\s+York\s+Times[:\s]+[""]?([^""]+)[""]?/gi,
    /Variety[:\s]+[""]?([^""]+)[""]?/gi,
    /Hollywood\s+Reporter[:\s]+[""]?([^""]+)[""]?/gi,
    /Vulture[:\s]+[""]?([^""]+)[""]?/gi,
    /Time\s+Out[:\s]+[""]?([^""]+)[""]?/gi,
    /Daily\s+News[:\s]+[""]?([^""]+)[""]?/gi,
    /New\s+York\s+Post[:\s]+[""]?([^""]+)[""]?/gi,
    /Washington\s+Post[:\s]+[""]?([^""]+)[""]?/gi,
    /Entertainment\s+Weekly[:\s]+[""]?([^""]+)[""]?/gi,
    /Associated\s+Press[:\s]+[""]?([^""]+)[""]?/gi,
    /TheaterMania[:\s]+[""]?([^""]+)[""]?/gi,
    /The\s+Wrap[:\s]+[""]?([^""]+)[""]?/gi,
    /Deadline[:\s]+[""]?([^""]+)[""]?/gi,
  ];

  // Clean HTML first
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#8217;/g, "'");
  text = text.replace(/&#8220;/g, '"');
  text = text.replace(/&#8221;/g, '"');
  text = text.replace(/\s+/g, ' ');

  // Extract outlet mentions and nearby text
  const outletPatterns = {
    'NYT': /New York Times/i,
    'VARIETY': /Variety/i,
    'THR': /Hollywood Reporter/i,
    'VULT': /Vulture/i,
    'TIMEOUTNY': /Time Out/i,
    'NYDN': /Daily News/i,
    'NYP': /New York Post/i,
    'WASHPOST': /Washington Post/i,
    'EW': /Entertainment Weekly/i,
    'AP': /Associated Press/i,
    'TMAN': /TheaterMania/i,
    'WRAP': /The Wrap|TheWrap/i,
    'DEADLINE': /Deadline/i,
    'TDB': /Daily Beast/i,
    'GUARDIAN': /Guardian/i,
  };

  for (const [outletId, pattern] of Object.entries(outletPatterns)) {
    const match = text.match(new RegExp(pattern.source + '[^.]*\\.[^.]*\\.', 'i'));
    if (match) {
      excerpts.push({
        outletId,
        excerpt: match[0].trim()
      });
    }
  }

  return excerpts;
}

async function processShow(showId, roundupUrl) {
  console.log(`\nProcessing ${showId}...`);

  try {
    const response = await fetch(roundupUrl);
    if (response.statusCode !== 200) {
      console.log(`  ERROR: HTTP ${response.statusCode}`);
      return 0;
    }

    // For now, just save the full roundup text to each review file that needs it
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    if (!fs.existsSync(showDir)) {
      console.log(`  Show directory not found`);
      return 0;
    }

    // Clean the HTML to get text
    let text = response.data;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#\d+;/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();

    // Find reviews that need text
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    let updated = 0;

    for (const file of files) {
      const filePath = path.join(showDir, file);
      const review = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Skip if already has full text
      if (review.fullText && review.fullText.length > 200) continue;

      // Try to find this outlet's review in the roundup
      const outletId = review.outletId || file.split('--')[0].toUpperCase();
      const criticName = review.criticName || '';

      // Search for critic name or outlet in the text
      const searchTerms = [
        criticName,
        review.outlet,
        outletId.replace(/-/g, ' ')
      ].filter(Boolean);

      let excerpt = null;
      for (const term of searchTerms) {
        if (!term || term.length < 3) continue;
        const idx = text.toLowerCase().indexOf(term.toLowerCase());
        if (idx !== -1) {
          // Extract surrounding context (500 chars before and after)
          const start = Math.max(0, idx - 200);
          const end = Math.min(text.length, idx + 800);
          excerpt = text.substring(start, end).trim();
          break;
        }
      }

      if (excerpt && excerpt.length > 100) {
        review.fullText = excerpt;
        review.source = 'bww-roundup';
        review.sourceUrl = roundupUrl;
        review.needsFullText = false;
        fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
        console.log(`  Updated ${file} (${excerpt.length} chars)`);
        updated++;
      }
    }

    console.log(`  ${updated} reviews updated`);
    return updated;

  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    return 0;
  }
}

async function main() {
  console.log('Fetching review excerpts from BroadwayWorld roundups...\n');

  let totalUpdated = 0;

  for (const [showId, url] of Object.entries(BWW_ROUNDUPS)) {
    const updated = await processShow(showId, url);
    totalUpdated += updated;
    await sleep(DELAY_MS);
  }

  console.log(`\n========================================`);
  console.log(`Total reviews updated: ${totalUpdated}`);
}

main().catch(console.error);
