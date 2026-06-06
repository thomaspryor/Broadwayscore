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
const {
  detectBannedClaims,
  validateSubwayFacts,
  validateEntranceAddress,
  auditCrossTheaterDiversity,
} = require('./lib/theater-tips-validators');
const { GEMINI_FLASH } = require('./lib/models');

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
// Output path is overridable via TIPS_OUTPUT so eval iterations don't
// disturb the production draft. Defaults to data/theater-tips-draft.json.
const OUTPUT_FILE = process.env.TIPS_OUTPUT
  ? path.resolve(process.env.TIPS_OUTPUT)
  : path.join(__dirname, '..', 'data', 'theater-tips-draft.json');
const RATE_LIMIT_MS = 1500; // Gemini Flash rate limit

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// Gemini Flash API
// ============================================

async function callGemini(systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${API_KEY}`;

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

GROUNDING RULES (strictly enforced):
- For restaurants and garages: ONLY use names that appear EXACTLY in the "scraped data" section below. Never invent, guess, or recall restaurant or garage names from memory.
- Use scraped distance values to estimate walkMinutes (0.05 mi ≈ 1 min walk). If the scraped data includes a distance, use that — do not estimate from memory.
- For seating and logistics: use your knowledge of NYC theater locations ONLY for subway info, entrance info, and exit strategy.

ACCESSIBILITY: Do NOT generate accessibility information. The "accessibility" field will be injected from verified data. Omit it entirely from your response.

SUBWAY FACTS (strictly enforced — no exceptions):
Use ONLY this MTA truth table when writing nearestSubway. Never list a line not in the table for a station. Write as a natural-language sentence ("The nearest station is X, served by the A and B trains") — do NOT copy the table format verbatim into the output.
- 42 St-Times Sq: 1, 2, 3, 7, N, Q, R, W, S
- 42 St-Port Authority: A, C, E
- 49 St: N, R, W   ← Q does NOT stop here
- 50 St (Broadway-7 Av): 1 only   ← 2, 3 express skip this station
- 50 St (8 Av): C, E   ← different physical station from the 1 stop
- 47-50 Sts-Rockefeller Ctr: B, D, F, M
- 42 St-Bryant Pk: B, D, F, M, 7
- 34 St-Herald Sq: B, D, F, M, N, Q, R, W
- 59 St-Columbus Circle: 1, A, B, C, D
Never combine the two different 50 St stations into one list. If you cite "50 St", name either the Broadway line (1) or the 8 Av line (C, E), not both.
If you are not confident about which lines serve the station, name the station only and omit the line list — incomplete is better than wrong.

DIVERSITY RULES (critical — prevents lazy padding):
- Prioritize restaurants that are CLOSEST to this specific theater (lowest distance in scraped data).
- Avoid generic Times Square restaurants unless they are genuinely among the 5 closest to THIS theater.
- Each dining category (preShow, postShow, quickBite) should have 3-5 restaurants, preferring variety in cuisine types.
- For garages: select the 3 nearest by distance.

CONCISENESS: Keep all text to 1-2 sentences max per field.
DINING CATEGORIES: "preShow" = sit-down meal nearby, "quickBite" = casual/fast/grab-and-go, "postShow" = good atmosphere for after the show.`;

function buildPrompt(theaterName, metadata, scraped) {
  const theaterInfo = [
    `Theater: ${theaterName}`,
    metadata.address ? `Address: ${metadata.address}` : null,
    metadata.capacity ? `Capacity: ${metadata.capacity} seats` : null,
    metadata.yearBuilt ? `Year built: ${metadata.yearBuilt}` : null,
    metadata.operator ? `Operator: ${metadata.operator}` : null,
    metadata.tips ? `Current tips: ${metadata.tips}` : null,
  ].filter(Boolean).join('\n');

  // Sort dining by distance so LLM sees closest first
  const sortedDining = (scraped?.dining || [])
    .slice(0, 20)
    .sort((a, b) => parseFloat(a.distance || '99') - parseFloat(b.distance || '99'));

  const diningData = sortedDining.length > 0
    ? `Nearby restaurants (scraped from NYC Theatre Guide, sorted by distance from this theater):\n${JSON.stringify(sortedDining, null, 2)}`
    : 'No restaurant data available.';

  // Sort parking by distance
  const sortedParking = (scraped?.parking || [])
    .slice(0, 20)
    .sort((a, b) => parseFloat(a.distance || '99') - parseFloat(b.distance || '99'));

  const parkingData = sortedParking.length > 0
    ? `Nearby parking garages (scraped from NYC Theatre Guide, sorted by distance):\n${JSON.stringify(sortedParking, null, 2)}`
    : 'No parking data available.';

  return `Generate structured tips for this Broadway theater.

${theaterInfo}

${diningData}

${parkingData}

Return a JSON object with this exact structure (do NOT include an "accessibility" field — it will be injected separately from verified data):
{
  "seating": {
    "bestSeats": "string — where to sit for the best experience",
    "avoidSeats": "string — seats to avoid and why (or null if none)"
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

IMPORTANT:
- Use ONLY restaurant and garage names from the scraped data above. Do not invent names.
- Prefer restaurants with SMALL distances — those are closest to THIS specific theater.
- Vary cuisine types across categories. Do not repeat the same restaurant in multiple categories.`;
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
  const crossTheaterRestaurantCounts = {};

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

      // Validate: no restaurant should appear in multiple categories
      if (tips.dining) {
        const usedNames = new Set();
        for (const category of ['preShow', 'postShow', 'quickBite']) {
          if (tips.dining[category]) {
            tips.dining[category] = tips.dining[category].filter(r => {
              if (usedNames.has(r.name)) {
                console.log(`  ⚠️  Dropped duplicate "${r.name}" from ${category}`);
                return false;
              }
              usedNames.add(r.name);
              return true;
            });
          }
        }
      }

      // Strip any LLM-generated accessibility (we inject from verified data)
      if (tips.seating?.accessibility) {
        console.log(`  ⚠️  Stripped LLM-generated accessibility text`);
        delete tips.seating.accessibility;
      }

      // Banned-claim guard — accessibility/safety/medical hallucinations.
      // Uses the same validator as scripts/evals/theater-tips-eval.js, so the
      // eval cannot pass while the generator ships a regression.
      const banned = detectBannedClaims(tips);
      if (banned.length > 0) {
        console.log(`  🚫 SKIPPED — ${banned.length} banned claim(s) in LLM output:`);
        for (const f of banned) {
          console.log(`     ${f.path}: "${f.match}" (${f.category})`);
        }
        errors++;
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      // Subway-fact guard — cross-check claimed lines against MTA truth.
      // Empirical (iter1): 3/10 theaters had wrong subway lines (Q at 49 St,
      // 2 at 50 St, C/E conflated with 50 St). Strip the field rather than
      // drop the whole entry so the rest of the (verified) tips still ship.
      const subwayWrong = validateSubwayFacts(tips);
      if (subwayWrong.length > 0) {
        for (const f of subwayWrong) {
          console.log(`  ⚠️  Stripped hallucinated subway claim at ${f.station}: ${f.wrongLines.join(',')} (actual: ${f.truthLines.join(',')})`);
        }
        tips.logistics.nearestSubway = null;
      }

      // Entrance-address guard — cross-check against hardcoded truth table.
      // Empirical (2026-04-15): Todd Haimes draft claimed 43rd St (actual 42).
      const entranceWrong = validateEntranceAddress(tips, theaterName);
      if (entranceWrong.length > 0) {
        for (const f of entranceWrong) {
          console.log(`  ⚠️  Stripped hallucinated entrance: claimed ${f.wrongStreets.join(',')} (valid: ${f.validStreets.join(',')})`);
        }
        tips.logistics.entrance = null;
      }

      // Track restaurant usage for cross-theater dedup audit
      if (tips.dining) {
        for (const category of ['preShow', 'postShow', 'quickBite']) {
          for (const r of (tips.dining[category] || [])) {
            crossTheaterRestaurantCounts[r.name] = (crossTheaterRestaurantCounts[r.name] || 0) + 1;
          }
        }
      }

      drafts[theaterName] = {
        ...tips,
        lastUpdated: new Date().toISOString(),
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

  // Cross-theater restaurant diversity audit (shared with eval harness).
  const totalTheaters = Object.keys(drafts).length;
  const overused = auditCrossTheaterDiversity(drafts, 0.5);

  if (overused.length > 0) {
    console.log(`\n⚠️  DIVERSITY WARNING: ${overused.length} restaurant(s) appear in >50% of ${totalTheaters} theaters:`);
    for (const o of overused) {
      console.log(`  ${o.count}x ${o.name}`);
    }
    console.log('These may indicate lazy LLM padding. Review before merging.');
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done! Generated: ${generated}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Total: ${totalTheaters} theater tips`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

function saveDraft(drafts) {
  const output = {
    _meta: {
      description: 'LLM-generated structured theater tips from scraped data',
      model: GEMINI_FLASH,
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
