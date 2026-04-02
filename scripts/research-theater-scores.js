#!/usr/bin/env node
/**
 * Research Theater Venue Scores
 *
 * For each Broadway theater, fetches reviews from SeatPlan, A View From My Seat,
 * and Reddit, then uses GPT-4o to synthesize 1-5 venue quality scores.
 *
 * Usage:
 *   node scripts/research-theater-scores.js              # all theaters
 *   node scripts/research-theater-scores.js --limit 3    # first 3 only
 *   node scripts/research-theater-scores.js --theater al-hirschfeld-theatre
 *
 * Environment:
 *   OPENAI_API_KEY - Required for GPT-4o synthesis
 *   BRIGHTDATA_TOKEN / SCRAPINGBEE_API_KEY - For web scraping (via scraper.js)
 *
 * Output:
 *   data/theater-research/{slug}.json - Per-theater research + scores
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');

const RESEARCH_DIR = path.join(__dirname, '..', 'data', 'theater-research');
const METADATA_PATH = path.join(__dirname, '..', 'data', 'theater-metadata.json');

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const limitArg = getArg('limit');
const theaterArg = getArg('theater');
const LIMIT = limitArg ? parseInt(limitArg, 10) : Infinity;

// --- Slugify (matches data-core.ts) ---
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- GPT-4o synthesis ---
const SYSTEM_PROMPT = `You are an expert Broadway theater reviewer. You will be given text scraped from review sites about a specific Broadway theater venue (not the shows — the physical theater itself).

Analyze the text and produce venue quality ratings on a 1-5 integer scale for these dimensions:
- **sightlines**: View quality from most seats, rake/slope, obstructions, how well side seats and rear mezzanine work
- **sound**: Acoustics, amplification quality, dead spots, consistency across sections
- **comfort**: Legroom, seat width, cushioning, temperature control
- **ambiance**: Interior beauty, architectural character, lobby spaciousness, overall atmosphere and "wow factor"
- **facilities**: Restroom capacity/lines at intermission, concessions, staff helpfulness, organization of entry/exit

Also provide:
- **summary**: A 1-2 sentence summary of the theater's strengths and weaknesses as a venue (not about any specific show). Be specific and useful to ticket buyers.

If the source text doesn't contain enough information about a dimension, make your best judgment based on:
- Theater age and renovation history (older unrenovated = likely lower comfort)
- Theater size (smaller = generally better sightlines, larger = potentially better sound systems)
- Known reputation of the theater operator

IMPORTANT: Do NOT rate accessibility features (wheelchair, elevator, hearing loop). Those will be sourced separately from official theater websites.

Respond with ONLY valid JSON in this exact format:
{
  "sightlines": 4,
  "sound": 4,
  "comfort": 3,
  "ambiance": 5,
  "facilities": 3,
  "summary": "One to two sentences about the venue."
}`;

async function callGPT4o(theaterName, sourceText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const userPrompt = `Theater: ${theaterName}\n\nSource material:\n${sourceText.slice(0, 12000)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          temperature: 0.3,
          max_tokens: 500,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
        }),
      });

      if (response.status === 429) {
        const wait = Math.pow(2, attempt + 1) * 5000;
        console.log(`    Rate limited, waiting ${wait / 1000}s...`);
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';

      // Extract JSON from response (may be wrapped in markdown fences)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in GPT-4o response');

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate scores are 1-5 integers
      for (const dim of ['sightlines', 'sound', 'comfort', 'ambiance', 'facilities']) {
        const val = parsed[dim];
        if (typeof val !== 'number' || val < 1 || val > 5 || !Number.isInteger(val)) {
          throw new Error(`Invalid score for ${dim}: ${val}`);
        }
      }

      return parsed;
    } catch (err) {
      if (attempt < 2) {
        console.log(`    Attempt ${attempt + 1} failed: ${err.message}, retrying...`);
        await sleep(3000);
      } else {
        throw err;
      }
    }
  }
}

// --- Source fetchers ---

async function fetchSeatPlan(theaterName) {
  const slug = slugify(theaterName);
  const url = `https://seatplan.com/new-york/${slug}/`;
  try {
    const result = await fetchPage(url);
    if (result && result.content && result.content.length > 200) {
      return { url, content: extractText(result.content, 3000) };
    }
  } catch (err) {
    console.log(`    SeatPlan failed: ${err.message}`);
  }
  return null;
}

async function fetchAVFMS(theaterName) {
  const encoded = theaterName.replace(/ /g, '+');
  const url = `https://aviewfrommyseat.com/venue/${encoded}/tips/`;
  try {
    const result = await fetchPage(url);
    if (result && result.content && result.content.length > 200) {
      return { url, content: extractText(result.content, 3000) };
    }
  } catch (err) {
    console.log(`    AVFMS failed: ${err.message}`);
  }
  return null;
}

async function fetchReddit(theaterName) {
  // Use old.reddit.com search which is more scrapable
  const query = encodeURIComponent(`"${theaterName}" seats OR sightlines OR legroom OR sound`);
  const url = `https://old.reddit.com/r/Broadway/search?q=${query}&restrict_sr=on&sort=relevance&t=all`;
  try {
    const result = await fetchPage(url, { preferPlaywright: true });
    if (result && result.content && result.content.length > 200) {
      return { url, content: extractText(result.content, 3000) };
    }
  } catch (err) {
    console.log(`    Reddit failed: ${err.message}`);
  }
  return null;
}

/**
 * Extract visible text from HTML, removing scripts/styles/tags
 */
function extractText(html, maxLen = 5000) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

// --- Main ---

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processTheater(name, meta) {
  const slug = slugify(name);
  const outPath = path.join(RESEARCH_DIR, `${slug}.json`);

  // Checkpoint: skip if already researched
  if (fs.existsSync(outPath)) {
    console.log(`  Skipping ${name} (already researched)`);
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }

  console.log(`\n📍 Researching: ${name}`);

  // Fetch from sources
  const sources = [];
  const sourceNames = [];

  console.log('  Fetching SeatPlan...');
  const sp = await fetchSeatPlan(name);
  if (sp) { sources.push(`[SeatPlan]\n${sp.content}`); sourceNames.push('seatplan'); }

  console.log('  Fetching AVFMS...');
  const avfms = await fetchAVFMS(name);
  if (avfms) { sources.push(`[A View From My Seat]\n${avfms.content}`); sourceNames.push('avfms'); }

  console.log('  Fetching Reddit...');
  const reddit = await fetchReddit(name);
  if (reddit) { sources.push(`[Reddit r/Broadway]\n${reddit.content}`); sourceNames.push('reddit'); }

  if (sources.length === 0) {
    console.log(`  ⚠️  No sources found for ${name}, using basic info only`);
    sources.push(`[Basic Info]\nTheater: ${name}. Capacity: ${meta.capacity || 'unknown'}. Year built: ${meta.yearBuilt || 'unknown'}. Tips: ${meta.tips || 'none'}.`);
    sourceNames.push('basic');
  }

  const sourceText = sources.join('\n\n---\n\n');

  // GPT-4o synthesis
  console.log(`  Synthesizing scores (${sourceNames.join(', ')})...`);
  const scores = await callGPT4o(name, sourceText);

  const result = {
    theater: name,
    slug,
    scores,
    sources: sourceNames,
    externalLinks: {
      seatplan: sp ? sp.url : null,
      aviewfrommyseat: avfms ? avfms.url.replace('/tips/', '/') : null,
    },
    researchedAt: new Date().toISOString(),
  };

  // Save checkpoint
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`  ✅ ${name}: sightlines=${scores.sightlines} sound=${scores.sound} comfort=${scores.comfort} ambiance=${scores.ambiance} facilities=${scores.facilities}`);
  console.log(`     "${scores.summary}"`);

  return result;
}

async function main() {
  // Ensure output directory exists
  if (!fs.existsSync(RESEARCH_DIR)) {
    fs.mkdirSync(RESEARCH_DIR, { recursive: true });
  }

  // Load theater list
  const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
  let theaters = Object.entries(metadata)
    .filter(([key]) => key !== '_meta')
    .map(([name, meta]) => ({ name, meta }));

  // Filter by --theater flag
  if (theaterArg) {
    theaters = theaters.filter(t => slugify(t.name) === theaterArg);
    if (theaters.length === 0) {
      console.error(`Theater not found: ${theaterArg}`);
      console.error('Available slugs:', Object.keys(metadata).filter(k => k !== '_meta').map(slugify).join(', '));
      process.exit(1);
    }
  }

  // Apply limit
  if (LIMIT < theaters.length) {
    theaters = theaters.slice(0, LIMIT);
  }

  console.log(`\n🎭 Researching ${theaters.length} theater(s)...\n`);

  const results = [];
  for (let i = 0; i < theaters.length; i++) {
    const { name, meta } = theaters[i];
    try {
      const result = await processTheater(name, meta);
      results.push(result);
    } catch (err) {
      console.error(`  ❌ Failed: ${name}: ${err.message}`);
      // Continue to next theater
    }

    // Rate limit between theaters (skip for last one)
    if (i < theaters.length - 1) {
      console.log('  ⏳ Waiting 10s before next theater...');
      await sleep(10000);
    }
  }

  await cleanup();

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Research complete: ${results.length}/${theaters.length} theaters`);
  const failed = theaters.length - results.length;
  if (failed > 0) console.log(`⚠️  ${failed} theater(s) failed — re-run to retry (checkpoints preserved)`);
  console.log(`Output: ${RESEARCH_DIR}/`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  cleanup().then(() => process.exit(1));
});
