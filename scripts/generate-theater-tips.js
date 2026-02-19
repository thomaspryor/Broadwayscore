#!/usr/bin/env node
/**
 * generate-theater-tips.js
 *
 * Takes scraped restaurant/parking data + our theater metadata,
 * and uses Gemini Flash to generate structured tips for each theater.
 *
 * The LLM's job is to:
 * 1. Organize scraped restaurants into pre-show/post-show/quick-bite categories
 * 2. Generate seating advice based on theater characteristics (capacity, type, age)
 * 3. Generate logistics info (nearest subway, entrance, exit strategy)
 * 4. Select the top 3-5 most relevant restaurants and garages
 *
 * The LLM does NOT invent restaurant/garage names — those come from scraped data.
 * It CAN generate subway/logistics info from address knowledge.
 *
 * Output: data/theater-tips-draft.json
 *
 * Usage:
 *   node scripts/generate-theater-tips.js [--limit N] [--theater "Booth"]
 *
 * Environment: GEMINI_API_KEY (required)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_KEY) {
  // Try loading from .env
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf8');
    const match = envContent.match(/GEMINI_API_KEY=(.+)/);
    if (match) process.env.GEMINI_API_KEY = match[1].trim();
  }
}

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('GEMINI_API_KEY not set');
  process.exit(1);
}

const SCRAPED_FILE = path.join(__dirname, '..', 'data', 'theater-tips-scraped.json');
const METADATA_FILE = path.join(__dirname, '..', 'data', 'theater-metadata.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'theater-tips-draft.json');
const RATE_LIMIT_MS = 1500; // Gemini Flash rate limit

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Gemini Flash API
// ============================================

async function callGemini(systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 3000,
        responseMimeType: 'application/json',
      },
    });

    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';
            resolve(text);
          } catch (e) {
            reject(new Error(`Gemini response parse error: ${e.message}`));
          }
        } else {
          reject(new Error(`Gemini ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================
// Prompt construction
// ============================================

const SYSTEM_PROMPT = `You are a helpful assistant that generates structured theater tips for Broadway theatergoers. You output valid JSON only.

RULES:
- For restaurants and garages: ONLY use names from the provided scraped data. Never invent restaurant or garage names.
- For seating, logistics, and subway info: use your knowledge of NYC theater locations.
- Keep all text concise (1-2 sentences max per field).
- walkMinutes should be estimated from the distance in miles (0.05 mi ≈ 1 min walk).
- For dining categories: "preShow" = within 0.15 mi and good for a sit-down meal, "quickBite" = casual/fast, "postShow" = good atmosphere for after the show.
- Select the top 3-5 most relevant options for each category (not all scraped results).
- For garages: select the 3 nearest.`;

function buildPrompt(theaterName, metadata, scraped) {
  const theaterInfo = [
    `Theater: ${theaterName}`,
    metadata.address ? `Address: ${metadata.address}` : null,
    metadata.capacity ? `Capacity: ${metadata.capacity} seats` : null,
    metadata.yearBuilt ? `Year built: ${metadata.yearBuilt}` : null,
    metadata.operator ? `Operator: ${metadata.operator}` : null,
    metadata.tips ? `Current tips: ${metadata.tips}` : null,
  ].filter(Boolean).join('\n');

  const diningData = scraped?.dining?.length > 0
    ? `Nearby restaurants (scraped from NYC Theatre Guide):\n${JSON.stringify(scraped.dining.slice(0, 20), null, 2)}`
    : 'No restaurant data available.';

  const parkingData = scraped?.parking?.length > 0
    ? `Nearby parking garages (scraped from NYC Theatre Guide):\n${JSON.stringify(scraped.parking.slice(0, 20), null, 2)}`
    : 'No parking data available.';

  return `Generate structured tips for this Broadway theater.

${theaterInfo}

${diningData}

${parkingData}

Return a JSON object with this exact structure:
{
  "seating": {
    "bestSeats": "string — where to sit for the best experience",
    "avoidSeats": "string — seats to avoid and why (or null if none)",
    "accessibility": "string — wheelchair access, elevator info (or null if unknown)"
  },
  "parking": {
    "nearestGarages": [
      { "name": "exact name from scraped data", "walkMinutes": number }
    ],
    "streetParking": "string — brief note on street parking near this theater",
    "tip": "string — one pro tip about parking near this theater"
  },
  "dining": {
    "preShow": [
      { "name": "exact name from scraped data", "cuisine": "type", "walkMinutes": number, "priceRange": "$-$$$$", "notes": "brief note" }
    ],
    "postShow": [
      { "name": "exact name from scraped data", "cuisine": "type", "walkMinutes": number, "priceRange": "$-$$$$", "notes": "brief note" }
    ],
    "quickBite": [
      { "name": "exact name from scraped data", "cuisine": "type", "walkMinutes": number, "priceRange": "$-$$$$", "notes": "brief note" }
    ]
  },
  "logistics": {
    "entrance": "string — which street/door to enter from",
    "nearestSubway": "string — nearest subway station and lines",
    "exitStrategy": "string — best way to leave after the show",
    "restrooms": "string — brief note about restroom situation (or null)"
  }
}

IMPORTANT: Use ONLY restaurant and garage names from the scraped data above. Do not invent names.`;
}

// ============================================
// Main
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 0;
  const theaterIdx = args.indexOf('--theater');
  const theaterFilter = theaterIdx >= 0 ? args[theaterIdx + 1] : null;

  // Load scraped data
  if (!fs.existsSync(SCRAPED_FILE)) {
    console.error(`Scraped data not found: ${SCRAPED_FILE}`);
    console.error('Run scripts/scrape-theater-tips.js first.');
    process.exit(1);
  }
  const scraped = JSON.parse(fs.readFileSync(SCRAPED_FILE, 'utf8'));
  console.log(`Loaded scraped data for ${Object.keys(scraped.theaters || {}).length} theaters`);

  // Load metadata
  const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));

  // Load existing draft for resume
  let existingDraft = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existingDraft = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(existingDraft.theaters || {}).length} existing drafts`);
    } catch (e) {
      console.log('Starting fresh');
    }
  }

  const drafts = existingDraft.theaters || {};
  let entries = Object.keys(metadata).filter(k => k !== '_meta');

  if (theaterFilter) {
    entries = entries.filter(name =>
      name.toLowerCase().includes(theaterFilter.toLowerCase())
    );
  }

  if (limit > 0) entries = entries.slice(0, limit);

  console.log(`\nGenerating tips for ${entries.length} theater(s)...\n`);

  let generated = 0, skipped = 0, errors = 0;

  for (const theaterName of entries) {
    // Skip if already generated (unless filtering)
    if (drafts[theaterName] && !theaterFilter) {
      skipped++;
      continue;
    }

    console.log(`[${generated + skipped + 1}/${entries.length}] ${theaterName}`);

    const meta = metadata[theaterName] || {};
    const scrapedData = scraped.theaters?.[theaterName] || null;

    try {
      const prompt = buildPrompt(theaterName, meta, scrapedData);
      const response = await callGemini(SYSTEM_PROMPT, prompt);

      // Parse JSON from response
      let tips;
      try {
        tips = JSON.parse(response);
      } catch (e) {
        // Try extracting JSON from markdown code block
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          tips = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Could not parse JSON: ${response.slice(0, 200)}`);
        }
      }

      // Validate: dining names must exist in scraped data
      if (scrapedData?.dining) {
        const scrapedNames = new Set(scrapedData.dining.map(r => r.name));
        for (const category of ['preShow', 'postShow', 'quickBite']) {
          if (tips.dining?.[category]) {
            tips.dining[category] = tips.dining[category].filter(r => {
              if (!scrapedNames.has(r.name)) {
                console.log(`  ⚠️  Dropped invented restaurant "${r.name}" from ${category}`);
                return false;
              }
              return true;
            });
          }
        }
      }

      // Validate: garage names must exist in scraped data
      if (scrapedData?.parking && tips.parking?.nearestGarages) {
        const scrapedGarages = new Set(scrapedData.parking.map(g => g.name));
        tips.parking.nearestGarages = tips.parking.nearestGarages.filter(g => {
          if (!scrapedGarages.has(g.name)) {
            console.log(`  ⚠️  Dropped invented garage "${g.name}"`);
            return false;
          }
          return true;
        });
      }

      drafts[theaterName] = {
        ...tips,
        lastUpdated: new Date().toISOString().split('T')[0],
        hasScrapedData: !!scrapedData,
      };

      generated++;
      console.log(`  ✅ Generated (${tips.dining?.preShow?.length || 0} pre-show, ${tips.dining?.quickBite?.length || 0} quick bite, ${tips.parking?.nearestGarages?.length || 0} garages)`);

    } catch (err) {
      console.log(`  ❌ FAILED — ${err.message}`);
      errors++;
    }

    // Checkpoint every 5
    if (generated % 5 === 0) {
      saveDraft(drafts);
      console.log(`  [Checkpoint: ${Object.keys(drafts).length} drafts saved]`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  saveDraft(drafts);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done! Generated: ${generated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Total: ${Object.keys(drafts).length} theater tips`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

function saveDraft(drafts) {
  const output = {
    _meta: {
      description: 'LLM-generated structured theater tips from scraped data',
      model: 'gemini-2.0-flash',
      lastUpdated: new Date().toISOString(),
    },
    theaters: drafts,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
