#!/usr/bin/env node
/**
 * Backfill Commercial Data via o4-mini with web_search_preview
 *
 * Researches commercial/financial data for closed Broadway shows missing
 * from commercial-pending-review.json. Uses OpenAI o4-mini with web search
 * to find capitalization, recoupment, and designation data.
 *
 * Usage:
 *   node scripts/backfill-commercial-o4mini.js [options]
 *
 * Options:
 *   --dry-run          Preview without writing
 *   --limit=N          Process only first N shows
 *   --shows=ID,ID      Specific shows by ID
 *   --resume           Skip shows already in pending review
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
const PROGRESS_PATH = path.join(DATA_DIR, 'commercial-backfill-progress.json');

const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const LIMIT = parseInt(flags['limit']) || 0;
const SHOW_LIST = flags['shows'] ? flags['shows'].split(',') : null;
const RESUME = flags['resume'] === true;

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('Error: OPENAI_API_KEY required');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Reddit data we already have from u/Boring_Waltz_9545 post-mortems
const REDDIT_SEED = {
  'once-upon-a-mattress-2024': {
    capitalization: null,
    recouped: false,
    recoupedSource: 'Reddit post-mortem: did not come close to making initial capitalization back',
    designation: 'Fizzle',
    notes: '$760k avg gross, 92% capacity, $110 ATP. Sutton Foster led revival, 128 performances. Estimated operating loss $285K-$1M.',
    confidence: 'medium',
    sources: [{ type: 'reddit', url: 'https://www.reddit.com/r/u_Boring_Waltz_9545/comments/1h9rxeo/broadway_20242025_season_shows_postmortems/', date: '2024-12-08' }],
  },
  'tammy-faye-2024': {
    capitalization: 25000000,
    capitalizationSource: 'Reddit post-mortem: $25 million initial capitalization',
    weeklyRunningCost: 825000,
    costMethodology: 'industry-estimate',
    recouped: false,
    recoupedSource: 'Reddit: estimated total loss ~$25 million',
    designation: 'Flop',
    notes: '$367k avg gross, 60% capacity, $74 ATP. One of largest flops in recent memory. Only 29 official performances. Estimated operating loss ~$4M, total loss ~$25M.',
    confidence: 'medium',
    sources: [{ type: 'reddit', url: 'https://www.reddit.com/r/u_Boring_Waltz_9545/comments/1h9rxeo/broadway_20242025_season_shows_postmortems/', date: '2024-12-08' }],
  },
  'swept-away-2024': {
    capitalization: 14500000,
    capitalizationSource: 'Reddit post-mortem: $14.5 million initial capitalization',
    recouped: false,
    designation: 'Flop',
    notes: 'Placeholder data in Reddit post-mortem. $14.5M capitalization, closed after short run.',
    confidence: 'low',
    sources: [{ type: 'reddit', url: 'https://www.reddit.com/r/u_Boring_Waltz_9545/comments/1h9rxeo/broadway_20242025_season_shows_postmortems/', date: '2024-12-08' }],
  },
};

/**
 * Call o4-mini with web_search_preview to research a show's commercial data
 */
async function researchShowWithO4Mini(show) {
  const openingYear = show.openingDate ? show.openingDate.split('-')[0] : 'unknown';
  const type = show.type || 'show';
  const isPlay = type === 'play' || type === 'solo' || type === 'play-revival';
  const isRevival = type?.includes('revival') || false;
  const isNonprofit = /roundabout|lincoln center|manhattan theatre club|second stage|lct/i.test(show.venue || '');

  const prompt = `Research the Broadway ${isPlay ? 'play' : 'musical'} "${show.title}" which opened ${show.openingDate || 'unknown'} at ${show.venue || 'unknown venue'} and closed ${show.closingDate || 'unknown'}.${isRevival ? ' This was a REVIVAL — only report data about THIS production, not any prior production.' : ''}${isNonprofit ? ' This was produced by a nonprofit theater company.' : ''}

## Search strategy — use site: searches for precision

1. **Reddit:** Search \`site:reddit.com/r/Broadway "${show.title}" capitalization\`, then \`site:reddit.com/r/Broadway "${show.title}" recouped\`, then \`site:reddit.com/r/Broadway "${show.title}" budget\`. Also try \`site:reddit.com/r/Broadway "${show.title}" "weekly nut"\`. Look for weekly grosses analysis posts and season post-mortem threads with financial breakdowns.

2. **BroadwayWorld forums:** Search \`site:forum.broadwayworld.com "${show.title}" capitalization\`, then \`site:forum.broadwayworld.com "${show.title}" budget\`. Forums have investor discussions, offering paper details, and weekly nut estimates.

3. **SEC EDGAR:** Search \`site:sec.gov "${show.title}"\` and try the producing LLC name. Broadway shows file Form D when raising capital.

4. **Trade press:** Search \`"${show.title}" broadway ${openingYear} capitalization OR budget OR recouped\` on Variety, Deadline, Broadway News, The Broadway Journal, Playbill, TheaterMania, BroadwayWorld.

5. **NYC tax credits:** Check this specific page for the show's production company: https://www.investmentbroadway.com/post/so-who-received-the-new-york-city-musical-and-theatrical-production-tax-credit — The NYC 25% tax credit implies capitalization (credit amount ÷ 0.25 = eligible costs). Search for the show title or a related production company name on that page.

## What to find
1. Initial capitalization / production budget
2. Weekly running costs / weekly nut
3. Whether it recouped its investment, and when
4. Overall commercial outcome

## Nonprofit check
If venue is Samuel J. Friedman (MTC), Helen Hayes (Second Stage), Todd Haimes (Roundabout), or Vivian Beaumont (LCT) — verify if this was a nonprofit production.

## Rules
- Only report data explicitly stated in sources. Never guess or estimate.
- ${isNonprofit ? 'This is a NONPROFIT production — use "Nonprofit" designation unless there is clear evidence of commercial structure.' : ''}
- Capitalization in dollars (e.g., 15000000 not 15). Weekly costs in dollars (e.g., 650000 not 650).
- For designation, use EXACTLY one of: Miracle, Windfall, Easy Winner, Trickle, TBD, Fizzle, Flop, Nonprofit

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "capitalization": <number in dollars or null>,
  "capitalizationSource": "<source description>" or null,
  "weeklyRunningCost": <number in dollars or null>,
  "costMethodology": "sec-filing" | "trade-reported" | "industry-estimate",
  "recouped": <true/false/null>,
  "recoupedDate": "<YYYY-MM>" or null,
  "recoupedSource": "<source description>" or null,
  "designation": "<one of the designations above>",
  "notes": "<brief financial summary, 1-3 sentences>",
  "sources": [{"type": "trade"|"sec"|"reddit"|"manual", "url": "<actual URL found>", "date": "<YYYY-MM-DD or null>"}],
  "confidence": "high" | "medium" | "low"
}`;

  const body = JSON.stringify({
    model: 'o4-mini',
    input: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_preview' }],
    reasoning: { effort: 'high' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.error) {
            reject(new Error(`o4-mini error: ${response.error.message}`));
            return;
          }
          // Extract text from response
          const outputItems = response.output || [];
          let text = '';
          for (const item of outputItems) {
            if (item.type === 'message') {
              for (const c of (item.content || [])) {
                if (c.type === 'output_text') text += c.text;
              }
            }
          }
          if (!text) {
            reject(new Error('No text in o4-mini response'));
            return;
          }
          // Parse JSON from response
          let jsonStr = text;
          const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenceMatch) jsonStr = fenceMatch[1];
          const objMatch = jsonStr.match(/\{[\s\S]*\}/);
          if (objMatch) jsonStr = objMatch[0];
          const result = JSON.parse(jsonStr);

          // Log token usage
          const usage = response.usage;
          if (usage) {
            console.log(`    Tokens: ${usage.input_tokens || 0} in, ${usage.output_tokens || 0} out`);
          }

          resolve(result);
        } catch (err) {
          reject(new Error(`Parse error: ${err.message}\nRaw: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Normalize capitalization/cost values (AI often returns in millions)
 */
function normalizeValues(data) {
  if (data.capitalization != null && data.capitalization > 0 && data.capitalization < 5000) {
    data.capitalization = data.capitalization * 1e6;
  }
  if (data.weeklyRunningCost != null && data.weeklyRunningCost > 0 && data.weeklyRunningCost < 10000) {
    data.weeklyRunningCost = data.weeklyRunningCost * 1000;
  }
  return data;
}

/**
 * Plausibility check
 */
function checkPlausibility(data) {
  const issues = [];
  if (data.capitalization != null) {
    if (data.capitalization < 500000 || data.capitalization > 100000000) {
      issues.push(`Capitalization $${(data.capitalization / 1e6).toFixed(1)}M outside range ($0.5M-$100M)`);
    }
  }
  if (data.weeklyRunningCost != null) {
    if (data.weeklyRunningCost < 100000 || data.weeklyRunningCost > 3000000) {
      issues.push(`Weekly cost $${(data.weeklyRunningCost / 1000).toFixed(0)}K outside range ($100K-$3M)`);
    }
  }
  return issues;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const allShows = Object.values(showsData.shows);
  const pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));

  // Load progress for resume
  let progress = { completed: [], failed: [] };
  if (RESUME && fs.existsSync(PROGRESS_PATH)) {
    progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  }

  // Find target shows: closed Broadway, target seasons, missing from pending
  let targets;
  if (SHOW_LIST) {
    targets = allShows.filter(s => SHOW_LIST.includes(s.id));
  } else {
    targets = allShows.filter(s =>
      s.status === 'closed' &&
      !s.id.includes('off-broadway') && !s.id.includes('west-end') && !s.id.includes('off-west-end') &&
      ['2022-2023', '2024-2025'].includes(s.season) &&
      !pending.shows[s.id]
    );
  }

  if (RESUME) {
    targets = targets.filter(s => !progress.completed.includes(s.id));
  }

  targets.sort((a, b) => (a.season || '').localeCompare(b.season || '') || (a.title || '').localeCompare(b.title || ''));

  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  console.log(`\n📊 Commercial Backfill: ${targets.length} shows to research`);
  if (DRY_RUN) console.log('   (DRY RUN — no files will be written)\n');

  let researched = 0;
  let redditSeeded = 0;
  let apiResearched = 0;
  let failed = 0;

  for (const show of targets) {
    const idx = targets.indexOf(show) + 1;
    console.log(`\n[${idx}/${targets.length}] ${show.title} (${show.id})`);

    let result;

    // Check Reddit seed data first
    if (REDDIT_SEED[show.id]) {
      console.log('  📖 Using Reddit post-mortem data (u/Boring_Waltz_9545)');
      result = { ...REDDIT_SEED[show.id] };
      redditSeeded++;
    } else {
      // Research via o4-mini
      console.log('  🔍 Researching via o4-mini web search...');
      try {
        result = await researchShowWithO4Mini(show);
        if (result) {
          result = normalizeValues(result);
          const issues = checkPlausibility(result);
          if (issues.length > 0) {
            console.log(`  ⚠️  Plausibility: ${issues.join('; ')}`);
            result.notes = `[PLAUSIBILITY WARNING: ${issues.join('; ')}] ${result.notes || ''}`;
            result.confidence = 'low';
          }
          apiResearched++;
        }
      } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        failed++;
        progress.failed.push({ id: show.id, error: err.message });
        // Save progress
        if (!DRY_RUN) {
          fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
        }
        await sleep(2000);
        continue;
      }
    }

    if (!result) {
      console.log('  ❌ No data found');
      failed++;
      continue;
    }

    // Log summary
    const cap = result.capitalization ? `$${(result.capitalization / 1e6).toFixed(1)}M` : 'unknown';
    const rec = result.recouped === true ? '✅ Recouped' : result.recouped === false ? '❌ Not recouped' : '❓ Unknown';
    console.log(`  💰 Cap: ${cap} | ${rec} | ${result.designation} | Confidence: ${result.confidence}`);

    // Add to pending
    if (!DRY_RUN) {
      // Use slug as key (not id) — commercial.json is keyed by slug
      const pendingKey = show.slug || show.id;
      pending.shows[pendingKey] = {
        title: show.title,
        slug: show.slug,
        openingDate: show.openingDate,
        status: show.status,
        ...result,
        researchedAt: new Date().toISOString(),
      };
      pending.generatedAt = new Date().toISOString();
      fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));

      progress.completed.push(show.id);
      fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
    }

    researched++;

    // Rate limit: 2s between API calls
    if (!REDDIT_SEED[show.id]) {
      await sleep(2000);
    }
  }

  console.log(`\n✅ Done! Researched: ${researched} | Reddit-seeded: ${redditSeeded} | API: ${apiResearched} | Failed: ${failed}`);
  if (!DRY_RUN) {
    console.log(`   Results written to ${PENDING_PATH}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
