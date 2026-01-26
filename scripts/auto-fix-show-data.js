#!/usr/bin/env node
/**
 * auto-fix-show-data.js
 *
 * Automatically fixes show data issues - FULL automation:
 * - Missing images → triggers image fetch workflow
 * - Missing synopsis → fetches from TodayTix or generates via Claude
 * - Missing creative team → fetches from TodayTix or generates via Claude
 * - Missing/broken ticket links → hides them (not an error)
 *
 * Philosophy: Fix EVERYTHING automatically. Zero human intervention needed.
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

// Extract creative team from TodayTix page HTML
function extractCreativeTeamFromHtml(html) {
  const creativeTeam = [];

  // Try JSON-LD first (most reliable)
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const content = match.match(/>([\s\S]*?)<\/script>/i)[1];
        const jsonLd = JSON.parse(content);

        // Check for director
        if (jsonLd.director) {
          const directors = Array.isArray(jsonLd.director) ? jsonLd.director : [jsonLd.director];
          for (const d of directors) {
            const name = typeof d === 'string' ? d : d.name;
            if (name) creativeTeam.push({ name, role: 'Director' });
          }
        }

        // Check for author/writer
        if (jsonLd.author) {
          const authors = Array.isArray(jsonLd.author) ? jsonLd.author : [jsonLd.author];
          for (const a of authors) {
            const name = typeof a === 'string' ? a : a.name;
            if (name) creativeTeam.push({ name, role: 'Book' });
          }
        }
      } catch {}
    }
  }

  // Try common HTML patterns for creative team sections
  const creativePatterns = [
    /(?:directed by|director)[:\s]*([A-Z][a-z]+ [A-Z][a-z]+)/gi,
    /(?:book by|written by)[:\s]*([A-Z][a-z]+ [A-Z][a-z]+)/gi,
    /(?:music by|composer)[:\s]*([A-Z][a-z]+ [A-Z][a-z]+)/gi,
    /(?:lyrics by|lyricist)[:\s]*([A-Z][a-z]+ [A-Z][a-z]+)/gi,
    /(?:choreography by|choreographer)[:\s]*([A-Z][a-z]+ [A-Z][a-z]+)/gi,
  ];

  const roleMap = {
    'directed by': 'Director',
    'director': 'Director',
    'book by': 'Book',
    'written by': 'Book',
    'music by': 'Music',
    'composer': 'Music',
    'lyrics by': 'Lyrics',
    'lyricist': 'Lyrics',
    'choreography by': 'Choreographer',
    'choreographer': 'Choreographer',
  };

  for (const [key, role] of Object.entries(roleMap)) {
    const regex = new RegExp(`${key}[:\\s]*([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)+)`, 'gi');
    let match;
    while ((match = regex.exec(html)) !== null) {
      const name = match[1].trim();
      if (name && !creativeTeam.some(c => c.name === name && c.role === role)) {
        creativeTeam.push({ name, role });
      }
    }
  }

  return creativeTeam.length > 0 ? creativeTeam : null;
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

// Fetch creative team from TodayTix
async function fetchCreativeTeamFromTodayTix(show, todayTixInfo) {
  if (!todayTixInfo?.id) return null;

  const slug = todayTixInfo.slug || show.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const url = `https://www.todaytix.com/nyc/shows/${todayTixInfo.id}-${slug}`;

  try {
    const html = await fetchUrl(url);
    return extractCreativeTeamFromHtml(html);
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

  return callClaudeAPI(prompt, 200);
}

// Generate creative team via Claude API (fallback)
async function generateCreativeTeamWithLLM(show) {
  if (!ANTHROPIC_API_KEY) return null;

  const prompt = `List the main creative team for the Broadway show "${show.title}" (${show.type || 'musical'}).
Return ONLY a JSON array with objects containing "name" and "role" fields.
Include: Director, Book writer, Composer, Lyricist, Choreographer (if applicable).
Only include people you are confident about - better to have fewer accurate entries than guesses.
Example format: [{"name": "Lin-Manuel Miranda", "role": "Music & Lyrics"}, {"name": "Thomas Kail", "role": "Director"}]
Return ONLY the JSON array, no other text.`;

  const response = await callClaudeAPI(prompt, 300);
  if (!response) return null;

  try {
    // Extract JSON from response (in case there's extra text)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const team = JSON.parse(jsonMatch[0]);
      if (Array.isArray(team) && team.length > 0) {
        return team.filter(t => t.name && t.role);
      }
    }
  } catch {}

  return null;
}

// Helper function to call Claude API
function callClaudeAPI(prompt, maxTokens) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: maxTokens,
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

// Fix creative team - fetch from TodayTix or generate
async function fixCreativeTeam(show, todayTixIds) {
  if (show.creativeTeam && show.creativeTeam.length >= 2) {
    return null; // Already has creative team
  }

  console.log(`  🎬 Missing creative team, attempting to fetch...`);

  // Try TodayTix first
  const todayTixInfo = todayTixIds.shows[show.id] || todayTixIds.shows[show.slug];
  let creativeTeam = await fetchCreativeTeamFromTodayTix(show, todayTixInfo);

  if (creativeTeam && creativeTeam.length >= 2) {
    show.creativeTeam = creativeTeam;
    return `Fetched creative team from TodayTix for ${show.title} (${creativeTeam.length} members)`;
  }

  // Try LLM generation
  if (ANTHROPIC_API_KEY) {
    console.log(`    Generating via Claude...`);
    creativeTeam = await generateCreativeTeamWithLLM(show);
    if (creativeTeam && creativeTeam.length >= 1) {
      show.creativeTeam = creativeTeam;
      return `Generated creative team via Claude for ${show.title} (${creativeTeam.length} members)`;
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

    // 2. Fix creative team (auto-fetched or LLM-generated)
    const creativeFix = await fixCreativeTeam(show, todayTixIds);
    if (creativeFix) {
      results.fixed.push(creativeFix);
      console.log(`    ✓ ${creativeFix}`);
      changesMade = true;
      await sleep(1000); // Rate limit
    }

    // 3. Fix ticket links (just clean up, don't flag)
    const ticketFix = fixTicketLinks(show);
    if (ticketFix) {
      results.fixed.push(ticketFix);
      console.log(`    ✓ ${ticketFix}`);
      changesMade = true;
    }

    // 4. Check for missing images (will trigger workflow)
    const missingImages = checkMissingImages(show);
    if (missingImages.length > 0) {
      showsWithMissingImages.push({
        id: show.id,
        title: show.title,
        missing: missingImages
      });
      console.log(`    ⚠ Missing images: ${missingImages.join(', ')}`);
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
    fs.appendFileSync(outputFile, `needs_human=0\n`);
    fs.appendFileSync(outputFile, `shows_needing_attention=\n`);
  }

  return results;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
