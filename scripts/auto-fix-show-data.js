#!/usr/bin/env node
/**
 * auto-fix-show-data.js
 *
 * Automatically fixes show data issues - TRUE automation:
 * - Missing images → triggers image fetch
 * - Missing synopsis → fetches from TodayTix or generates via LLM
 * - Missing/broken ticket links → hides them (not an error)
 * - Creative team → only thing that might need humans
 *
 * Philosophy: Fix everything automatically. Only flag creative team if missing.
 * Cast is NOT tracked (changes too frequently).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const TODAYTIX_IDS_PATH = path.join(__dirname, '..', 'data', 'todaytix-ids.json');
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Results tracking
const results = {
  timestamp: new Date().toISOString(),
  fixed: [],
  needsHumanAttention: [],
  triggeredWorkflows: [],
  errors: []
};

function loadShows() {
  return JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
}

function saveShows(data) {
  fs.writeFileSync(SHOWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function loadTodayTixIds() {
  try {
    return JSON.parse(fs.readFileSync(TODAYTIX_IDS_PATH, 'utf8'));
  } catch {
    return { shows: {} };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch via ScrapingBee
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_API_KEY) {
      reject(new Error('No SCRAPINGBEE_API_KEY'));
      return;
    }

    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_API_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=2000`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// Extract synopsis from TodayTix page HTML
function extractSynopsisFromHtml(html) {
  // Try to find synopsis in meta description
  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  if (metaMatch && metaMatch[1].length > 50) {
    return metaMatch[1].trim();
  }

  // Try to find in JSON-LD
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const jsonLd = JSON.parse(jsonLdMatch[1]);
      if (jsonLd.description && jsonLd.description.length > 50) {
        return jsonLd.description.trim();
      }
    } catch {}
  }

  // Try to find in page content (common patterns)
  const aboutMatch = html.match(/about[^>]*>[\s\S]*?<p[^>]*>([^<]{100,500})/i);
  if (aboutMatch) {
    return aboutMatch[1].trim();
  }

  return null;
}

// Fetch synopsis from TodayTix
async function fetchSynopsisFromTodayTix(show, todayTixInfo) {
  if (!todayTixInfo?.id) return null;

  const slug = todayTixInfo.slug || show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const url = `https://www.todaytix.com/nyc/shows/${todayTixInfo.id}-${slug}`;

  try {
    const html = await fetchUrl(url);
    return extractSynopsisFromHtml(html);
  } catch {
    return null;
  }
}

// Generate synopsis via Claude API (fallback)
async function generateSynopsisWithLLM(show) {
  if (!ANTHROPIC_API_KEY) return null;

  const prompt = `Write a brief, engaging synopsis (2-3 sentences, ~100 words) for the Broadway show "${show.title}".
It's a ${show.type || 'musical'} playing at ${show.venue || 'a Broadway theater'}.
Write in present tense, focus on the story/premise, and make it sound exciting for potential theatergoers.
Do not include any marketing language or ticket information.
Just return the synopsis text, nothing else.`;

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const text = response.content?.[0]?.text;
          resolve(text || null);
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

// Fix synopsis - fetch from TodayTix or generate
async function fixSynopsis(show, todayTixIds) {
  if (show.synopsis && show.synopsis.length >= 50) {
    return null; // Already has synopsis
  }

  console.log(`  📝 Missing synopsis, attempting to fetch...`);

  // Try TodayTix first
  const todayTixInfo = todayTixIds.shows[show.id] || todayTixIds.shows[show.slug];
  let synopsis = await fetchSynopsisFromTodayTix(show, todayTixInfo);

  if (synopsis) {
    show.synopsis = synopsis;
    return `Fetched synopsis from TodayTix for ${show.title}`;
  }

  // Try LLM generation
  if (ANTHROPIC_API_KEY) {
    console.log(`    Generating via Claude...`);
    synopsis = await generateSynopsisWithLLM(show);
    if (synopsis) {
      show.synopsis = synopsis;
      return `Generated synopsis via Claude for ${show.title}`;
    }
  }

  return null;
}

// Fix ticket links - just ensure valid ones exist, hide broken ones
function fixTicketLinks(show) {
  if (show.status === 'closed') return null;

  // Remove any links marked as broken
  if (show.ticketLinks) {
    const validLinks = show.ticketLinks.filter(link => !link.broken && link.url);
    if (validLinks.length !== show.ticketLinks.length) {
      show.ticketLinks = validLinks;
      return `Removed ${show.ticketLinks.length - validLinks.length} broken ticket links for ${show.title}`;
    }
  }

  // If no ticket links at all for an open show, that's OK - we just won't show any
  // Don't flag it as an error - the show page will gracefully hide the ticket section

  return null;
}

function checkMissingImages(show) {
  const missing = [];
  if (!show.images?.poster) missing.push('poster');
  if (!show.images?.thumbnail) missing.push('thumbnail');
  if (!show.images?.hero) missing.push('hero');
  return missing;
}

function checkMissingMetadata(show) {
  const issues = [];

  // Only check open/preview shows
  if (show.status !== 'open' && show.status !== 'previews') {
    return issues;
  }

  // Creative team - stable, worth tracking
  // (We're NOT tracking cast - it changes too frequently)
  if (!show.creativeTeam || show.creativeTeam.length === 0) {
    issues.push({
      type: 'missing_creative',
      message: `${show.title} needs creative team information`,
      severity: 'low'
    });
  }

  return issues;
}

async function main() {
  console.log('='.repeat(60));
  console.log('AUTO-FIX SHOW DATA');
  console.log('='.repeat(60));
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Synopsis fetching: ${SCRAPINGBEE_API_KEY ? '✓ enabled' : '✗ disabled (no SCRAPINGBEE_API_KEY)'}`);
  console.log(`Synopsis generation: ${ANTHROPIC_API_KEY ? '✓ enabled' : '✗ disabled (no ANTHROPIC_API_KEY)'}\n`);

  const data = loadShows();
  const todayTixIds = loadTodayTixIds();
  const openShows = data.shows.filter(s => s.status === 'open' || s.status === 'previews');

  console.log(`Checking ${openShows.length} open/preview shows...\n`);

  let showsWithMissingImages = [];
  let changesMade = false;

  for (const show of openShows) {
    console.log(`Checking: ${show.title}`);

    // 1. Fix synopsis
    const synopsisFix = await fixSynopsis(show, todayTixIds);
    if (synopsisFix) {
      results.fixed.push(synopsisFix);
      console.log(`    ✓ ${synopsisFix}`);
      changesMade = true;
      await sleep(1000); // Rate limit
    }

    // 2. Fix ticket links (just clean up, don't flag)
    const ticketFix = fixTicketLinks(show);
    if (ticketFix) {
      results.fixed.push(ticketFix);
      console.log(`    ✓ ${ticketFix}`);
      changesMade = true;
    }

    // 3. Check for missing images (will trigger workflow)
    const missingImages = checkMissingImages(show);
    if (missingImages.length > 0) {
      showsWithMissingImages.push({
        id: show.id,
        title: show.title,
        missing: missingImages
      });
      console.log(`    ⚠ Missing images: ${missingImages.join(', ')}`);
    }

    // 4. Check for creative team (only thing that might need humans)
    const metadataIssues = checkMissingMetadata(show);
    if (metadataIssues.length > 0) {
      results.needsHumanAttention.push({
        showId: show.id,
        showTitle: show.title,
        issues: metadataIssues
      });
      metadataIssues.forEach(i => console.log(`    📋 ${i.message}`));
    }
  }

  // Save updated shows data
  if (changesMade) {
    saveShows(data);
    console.log(`\n✅ Saved changes to shows.json`);
  }

  // Flag shows needing images
  if (showsWithMissingImages.length > 0) {
    results.triggeredWorkflows.push('fetch-show-images-auto');
    console.log(`\n🖼️  ${showsWithMissingImages.length} shows need images - will trigger fetch workflow`);

    fs.writeFileSync(
      path.join(__dirname, '..', 'data', 'shows-needing-images.json'),
      JSON.stringify(showsWithMissingImages, null, 2)
    );
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Auto-fixed: ${results.fixed.length} issues`);
  console.log(`Needs images: ${showsWithMissingImages.length} shows`);
  console.log(`Needs human attention: ${results.needsHumanAttention.length} shows (creative team only)`);
  console.log(`Workflows to trigger: ${results.triggeredWorkflows.join(', ') || 'none'}`);

  // Write results
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'auto-fix-results.json'),
    JSON.stringify(results, null, 2)
  );

  // GitHub Actions outputs
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `fixed_count=${results.fixed.length}\n`);
    fs.appendFileSync(outputFile, `needs_images=${showsWithMissingImages.length > 0}\n`);
    fs.appendFileSync(outputFile, `needs_human=${results.needsHumanAttention.length}\n`);
    fs.appendFileSync(outputFile, `shows_needing_attention=${results.needsHumanAttention.map(s => s.showTitle).join(',')}\n`);
  }

  return results;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
