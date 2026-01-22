/**
 * Verify review counts against external aggregators using ScrapingBee
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || 'TM5B2FK5G0BNFS2IL2T1OUGYJR7KP49UEYZ33KUUYWJ3NZC8ZJG6BMAXI83IQRD3017UTTNX5JISNDMW';

interface ShowToCheck {
  id: string;
  title: string;
  dtliSlug: string;
  showScoreSlug: string;
  bwwSearchTerm: string;
}

const SHOWS: ShowToCheck[] = [
  {
    id: 'mj-2022',
    title: 'MJ The Musical',
    dtliSlug: 'mj-the-musical',
    showScoreSlug: 'mj-the-musical',
    bwwSearchTerm: 'MJ The Musical'
  },
  {
    id: 'great-gatsby-2024',
    title: 'The Great Gatsby',
    dtliSlug: 'the-great-gatsby',
    showScoreSlug: 'the-great-gatsby',
    bwwSearchTerm: 'The Great Gatsby'
  },
  {
    id: 'six-2021',
    title: 'Six',
    dtliSlug: 'six',
    showScoreSlug: 'six',
    bwwSearchTerm: 'Six'
  },
  {
    id: 'and-juliet-2022',
    title: '& Juliet',
    dtliSlug: 'juliet',
    showScoreSlug: 'juliet',
    bwwSearchTerm: '& Juliet'
  },
  {
    id: 'oedipus-2025',
    title: 'Oedipus',
    dtliSlug: 'oedipus',
    showScoreSlug: 'oedipus',
    bwwSearchTerm: 'Oedipus'
  }
];

async function fetchWithScrapingBee(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(url)}&render_js=false`;

    https.get(apiUrl, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`ScrapingBee returned status ${res.statusCode}`));
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

function parseDTLI(html: string): { up: number; flat: number; down: number; total: number } | null {
  try {
    // Look for the review count pattern in DTLI HTML
    // Pattern: thumbs up/flat/down counts
    const upMatch = html.match(/(\d+)\s*thumbs?\s*up/i);
    const flatMatch = html.match(/(\d+)\s*thumbs?\s*sideways|(\d+)\s*flat/i);
    const downMatch = html.match(/(\d+)\s*thumbs?\s*down/i);

    // Also try to find the total review count
    const totalMatch = html.match(/(\d+)\s*reviews?/i);

    return {
      up: upMatch ? parseInt(upMatch[1]) : 0,
      flat: flatMatch ? parseInt(flatMatch[1] || flatMatch[2]) : 0,
      down: downMatch ? parseInt(downMatch[1]) : 0,
      total: totalMatch ? parseInt(totalMatch[1]) : 0
    };
  } catch (e) {
    console.error('Error parsing DTLI:', e);
    return null;
  }
}

function parseShowScore(html: string): { reviewCount: number; outlets: string[] } | null {
  try {
    // Look for review count in Show-Score HTML
    const countMatch = html.match(/(\d+)\s*critic\s*reviews?/i);

    // Try to extract outlet names (this will need refinement based on actual HTML structure)
    const outlets: string[] = [];

    return {
      reviewCount: countMatch ? parseInt(countMatch[1]) : 0,
      outlets
    };
  } catch (e) {
    console.error('Error parsing Show-Score:', e);
    return null;
  }
}

async function verifyShow(show: ShowToCheck) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Verifying: ${show.title} (${show.id})`);
  console.log('='.repeat(60));

  // Get our current review count
  const reviewsPath = path.join(__dirname, '..', 'data', 'reviews.json');
  const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf-8'));
  const reviews = reviewsData.reviews || reviewsData;
  const ourCount = reviews.filter((r: any) => r.showId === show.id).length;
  console.log(`\nOur database: ${ourCount} reviews`);

  // Fetch DTLI
  console.log('\n--- Did They Like It ---');
  try {
    const dtliUrl = `https://didtheylikeit.com/shows/${show.dtliSlug}/`;
    console.log(`Fetching: ${dtliUrl}`);
    const dtliHtml = await fetchWithScrapingBee(dtliUrl);
    const dtliData = parseDTLI(dtliHtml);

    if (dtliData) {
      console.log(`Up: ${dtliData.up} | Flat: ${dtliData.flat} | Down: ${dtliData.down}`);
      console.log(`Total: ${dtliData.total} reviews`);
    } else {
      console.log('Could not parse DTLI data');
    }

    // Save raw HTML for debugging
    const debugPath = path.join(__dirname, '..', 'debug-html', `${show.id}-dtli.html`);
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, dtliHtml);
    console.log(`Saved HTML to: ${debugPath}`);
  } catch (e) {
    console.error(`Error fetching DTLI: ${e}`);
  }

  // Fetch Show-Score
  console.log('\n--- Show-Score ---');
  try {
    const showScoreUrl = `https://www.show-score.com/broadway-shows/${show.showScoreSlug}`;
    console.log(`Fetching: ${showScoreUrl}`);
    const showScoreHtml = await fetchWithScrapingBee(showScoreUrl);
    const showScoreData = parseShowScore(showScoreHtml);

    if (showScoreData) {
      console.log(`Total: ${showScoreData.reviewCount} critic reviews`);
    } else {
      console.log('Could not parse Show-Score data');
    }

    // Save raw HTML for debugging
    const debugPath = path.join(__dirname, '..', 'debug-html', `${show.id}-showscore.html`);
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, showScoreHtml);
    console.log(`Saved HTML to: ${debugPath}`);
  } catch (e) {
    console.error(`Error fetching Show-Score: ${e}`);
  }

  console.log('');
}

async function main() {
  console.log('Review Verification Script');
  console.log('Using ScrapingBee API to verify review counts\n');

  for (const show of SHOWS) {
    await verifyShow(show);
    // Wait 2 seconds between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n✓ Verification complete');
  console.log('\nCheck the debug-html/ folder for saved HTML files');
}

main().catch(console.error);
