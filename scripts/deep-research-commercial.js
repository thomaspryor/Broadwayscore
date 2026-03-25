#!/usr/bin/env node
/**
 * deep-research-commercial.js
 *
 * Uses OpenAI Responses API with web_search_preview to research Broadway show
 * commercial/financial data. Outputs to commercial-pending-review.json for
 * auto-apply or human review.
 *
 * Usage:
 *   node scripts/deep-research-commercial.js [options]
 *
 * Options:
 *   --shows=SLUG,SLUG    Specific shows to research
 *   --all-tbd            Research all TBD + uncovered open Broadway shows
 *   --max-shows=N        Max shows per run (default 10)
 *   --budget=N           Max spend in dollars (default 15)
 *   --model=MODEL        o4-mini (default) or o3
 *   --dry-run            Preview without writing files
 *   --queue              Also consume data/commercial-research-queue.json
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, '..', 'data');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');
const GROSSES_PATH = path.join(DATA_DIR, 'grosses.json');
const PENDING_PATH = path.join(DATA_DIR, 'commercial-pending-review.json');
const COST_LOG_PATH = path.join(DATA_DIR, 'deep-research-cost-log.json');
const PROGRESS_PATH = path.join(DATA_DIR, 'deep-research-progress.json');
const SPEND_PATH = path.join(DATA_DIR, 'commercial-research-spend.json');
const QUEUE_PATH = path.join(DATA_DIR, 'commercial-research-queue.json');

// ---------------------------------------------------------------------------
// CLI Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flags = {};
for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val || true;
  }
}

const DRY_RUN = flags['dry-run'] === true;
const SHOW_LIST = flags['shows'] ? flags['shows'].split(',') : null;
const ALL_TBD = flags['all-tbd'] === true;
const MAX_SHOWS = parseInt(flags['max-shows']) || 10;
const BUDGET = parseFloat(flags['budget']) || 15;
const MODEL = flags['model'] || 'o4-mini';
const USE_QUEUE = flags['queue'] === true;
const WEEKLY_SPEND_CAP = 20; // dollars

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ---------------------------------------------------------------------------
// Guardian module
// ---------------------------------------------------------------------------
let guardian;
try {
  guardian = require('./lib/deep-research-guardian');
} catch (e) {
  // Guardian not available — allow all changes
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Plausibility checks for commercial data.
 */
function checkPlausibility(data, grossesData) {
  const issues = [];
  if (data.capitalization != null) {
    if (data.capitalization < 500000 || data.capitalization > 100000000) {
      issues.push(`Capitalization $${(data.capitalization / 1e6).toFixed(1)}M outside plausible range ($0.5M-$100M)`);
    }
  }
  if (data.weeklyRunningCost != null) {
    if (data.weeklyRunningCost < 100000 || data.weeklyRunningCost > 5000000) {
      issues.push(`Weekly running cost $${(data.weeklyRunningCost / 1000).toFixed(0)}K outside plausible range ($100K-$5M)`);
    }
  }
  if (data.recouped && data.capitalization && grossesData) {
    const allTimeGross = grossesData.allTime?.gross || 0;
    if (allTimeGross > 0 && data.capitalization > allTimeGross * 0.6) {
      issues.push(`Capitalization > 60% of all-time gross for recouped show`);
    }
  }
  return issues.length > 0
    ? { plausible: false, reason: issues.join('; ') }
    : { plausible: true };
}

// ---------------------------------------------------------------------------
// OpenAI Responses API with web search
// ---------------------------------------------------------------------------

// Cost estimates per 1M tokens (o4-mini)
const COST_TABLE = {
  'o4-mini': { input: 1.10, output: 4.40 },
  'o3': { input: 2.00, output: 8.00 },
};

function estimateCost(usage, model) {
  const rates = COST_TABLE[model] || COST_TABLE['o4-mini'];
  const inputCost = (usage.input_tokens || 0) / 1e6 * rates.input;
  const outputCost = (usage.output_tokens || 0) / 1e6 * rates.output;
  return inputCost + outputCost;
}

async function researchShowWithOpenAI(show, model) {
  if (!OPENAI_KEY) {
    throw new Error('OPENAI_API_KEY required');
  }

  const title = show.title;
  const venue = show.venue || '';
  const openingDate = show.openingDate || '';
  const status = show.status || '';
  const type = show.type || 'musical';

  const prompt = `Research the Broadway ${type} "${title}"${venue ? ` at ${venue}` : ''}${openingDate ? ` (opened ${openingDate})` : ''}. It is currently ${status}.

Find and report the following financial information. Use web search to find real sources. Only report data you can verify from actual sources — do not estimate or guess.

1. **Capitalization (budget):** How much money was raised to produce the show? Look for SEC Form D filings, trade press reports (Deadline, Variety, Broadway Journal, Broadway News, Playbill), or producer interviews mentioning the budget.

2. **Weekly running cost:** How much does the show cost per week to operate? Look for trade articles mentioning "weekly nut" or operating costs.

3. **Recoupment status:** Has the show recouped its investment? Look for announcements of recoupment, trade press reports. If not recouped, any estimates of how close?

4. **Commercial designation:** Based on the evidence, classify as one of: Miracle (mega-hit, 10+ year run), Windfall (solid hit, recouped well), Easy Winner (limited run, recouped quickly), Trickle (barely broke even), Fizzle (closed without recouping, recovered 30%+), Flop (closed without recouping, <30% back), TBD (insufficient data).

5. **Key sources:** List the specific URLs where you found this information.

Report ONLY what you can verify. If you cannot find information for a field, say so explicitly. Do not fabricate data.

Respond with a JSON object (no markdown fences):
{
  "capitalization": <number in dollars or null>,
  "capitalizationSource": "<description of source>",
  "weeklyRunningCost": <number in dollars or null>,
  "costMethodology": "<sec-filing|trade-reported|industry-estimate|null>",
  "recouped": <true|false|null>,
  "recoupedDate": "<YYYY-MM or YYYY or null>",
  "recoupedSource": "<description or null>",
  "estimatedRecoupmentPct": <[low, high] range 0-100 or null>,
  "designation": "<designation>",
  "notes": "<brief summary of findings>",
  "confidence": "<high|medium|low>",
  "sources": [{"type": "<sec|trade|reddit|other>", "url": "<url>", "date": "<YYYY-MM-DD or null>"}]
}`;

  const body = {
    model,
    tools: [{ type: 'web_search_preview', search_context_size: 'low' }],
    input: prompt,
    max_output_tokens: 16000,
  };

  if (model === 'o4-mini' || model === 'o3') {
    body.reasoning = { effort: 'high' };
  }

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${err.slice(0, 300)}`);
  }

  const result = await resp.json();
  const usage = result.usage || {};
  const cost = estimateCost(usage, model);

  // Extract text output
  let outputText = '';
  for (const item of result.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') {
          outputText += c.text;
        }
      }
    }
  }

  // Count web searches performed
  const searchCount = (result.output || []).filter(i => i.type === 'web_search_call').length;

  // Parse JSON from output — try direct parse first, then extract from markdown
  let analysis = null;
  try {
    const trimmed = outputText.trim();
    // Strip markdown fences if present
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    analysis = JSON.parse(stripped);
  } catch (e) {
    // Fallback: find balanced JSON object using brace counting
    try {
      const start = outputText.indexOf('{');
      if (start >= 0) {
        let depth = 0;
        let end = -1;
        for (let i = start; i < outputText.length; i++) {
          if (outputText[i] === '{') depth++;
          else if (outputText[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end > start) {
          analysis = JSON.parse(outputText.slice(start, end + 1));
        }
      }
    } catch (e2) {
      console.warn(`    ⚠️  Failed to parse JSON output: ${e2.message}`);
    }
  }

  return { analysis, usage, cost, searchCount, status: result.status };
}

// ---------------------------------------------------------------------------
// Spend tracking
// ---------------------------------------------------------------------------
function getWeeklySpend() {
  try {
    const data = JSON.parse(fs.readFileSync(SPEND_PATH, 'utf8'));
    const weekStart = getWeekStart();
    if (data.weekStart === weekStart) {
      return data.totalSpend || 0;
    }
  } catch (e) {
    // No spend file
  }
  return 0;
}

function recordSpend(amount) {
  const weekStart = getWeekStart();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SPEND_PATH, 'utf8'));
    if (data.weekStart !== weekStart) {
      data = { weekStart, totalSpend: 0, queries: 0 };
    }
  } catch (e) {
    data = { weekStart, totalSpend: 0, queries: 0 };
  }
  data.totalSpend += amount;
  data.queries += 1;
  data.lastUpdated = new Date().toISOString();
  if (!DRY_RUN) {
    fs.writeFileSync(SPEND_PATH, JSON.stringify(data, null, 2) + '\n');
  }
  return data.totalSpend;
}

function getWeekStart() {
  const now = new Date();
  const day = now.getDay(); // 0=Sunday
  const start = new Date(now);
  start.setDate(now.getDate() - day);
  return start.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Deep Research Commercial ===`);
  console.log(`Model: ${MODEL}`);
  console.log(`Budget: $${BUDGET} (weekly cap: $${WEEKLY_SPEND_CAP})`);
  console.log(`Max shows: ${MAX_SHOWS}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  if (!OPENAI_KEY) {
    console.error('ERROR: OPENAI_API_KEY is required');
    process.exit(1);
  }

  // Load data fresh
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const allShows = showsData.shows || [];
  let grossesShows = {};
  try {
    const grossesRaw = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf8'));
    grossesShows = grossesRaw.shows || {};
  } catch (e) {
    console.warn('⚠️  Could not load grosses.json — plausibility cross-checks will be skipped');
  }

  // Build show lookup
  const showBySlug = {};
  for (const s of allShows) {
    if (s && typeof s === 'object' && s.slug) {
      showBySlug[s.slug] = s;
    }
  }

  // Check weekly spend cap
  const currentWeeklySpend = getWeeklySpend();
  if (currentWeeklySpend >= WEEKLY_SPEND_CAP) {
    console.log(`Weekly spend cap reached ($${currentWeeklySpend.toFixed(2)} >= $${WEEKLY_SPEND_CAP}). Exiting.`);
    process.exit(0);
  }

  // Determine which shows to research
  let targetSlugs = [];

  if (SHOW_LIST) {
    targetSlugs = SHOW_LIST;
  } else if (ALL_TBD) {
    // Read commercial.json fresh at decision time
    const commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
    const commShows = commercial.shows || {};

    // Shows with TBD designation
    const tbdSlugs = Object.entries(commShows)
      .filter(([, v]) => v && v.designation === 'TBD')
      .map(([k]) => k);

    // Open Broadway shows without any commercial data
    const uncoveredSlugs = allShows
      .filter(s => s && s.status && ['open', 'previews'].includes(s.status)
        && (s.market || 'broadway') === 'broadway'
        && !commShows[s.slug])
      .map(s => s.slug);

    targetSlugs = [...new Set([...tbdSlugs, ...uncoveredSlugs])];
    // Shuffle for rotation so we don't always research the same shows
    targetSlugs = shuffle(targetSlugs);
  }

  // Consume queue file if requested
  if (USE_QUEUE) {
    try {
      const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
      const queuedSlugs = queue.shows || [];
      if (queuedSlugs.length > 0) {
        console.log(`📋 Queue: ${queuedSlugs.length} shows`);
        targetSlugs = [...new Set([...queuedSlugs, ...targetSlugs])];
        // Clear queue
        if (!DRY_RUN) {
          fs.writeFileSync(QUEUE_PATH, JSON.stringify({ shows: [], updatedAt: new Date().toISOString() }, null, 2) + '\n');
        }
      }
    } catch (e) {
      // No queue file
    }
  }

  // Limit to max shows
  targetSlugs = targetSlugs.slice(0, MAX_SHOWS);

  if (targetSlugs.length === 0) {
    console.log('No shows to research. Exiting.');
    process.exit(0);
  }

  console.log(`Researching ${targetSlugs.length} shows: ${targetSlugs.join(', ')}\n`);

  // Load or create pending results (merge, not overwrite)
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
    if (!pending.shows) pending.shows = {};
  } catch (e) {
    pending = { generatedAt: new Date().toISOString(), shows: {} };
  }

  const costLog = [];
  let totalCost = 0;
  let runBudgetRemaining = BUDGET;
  let weeklySpend = currentWeeklySpend;
  let researchedCount = 0;

  // Load progress for resume capability
  let progress;
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
  } catch (e) {
    progress = { completed: [], startedAt: new Date().toISOString() };
  }

  for (const slug of targetSlugs) {
    // Skip if already completed in this batch
    if (progress.completed.includes(slug)) {
      console.log(`  ⏭️  ${slug} — already completed this batch`);
      continue;
    }

    // Budget checks
    if (runBudgetRemaining <= 0) {
      console.log(`\n💰 Run budget exhausted ($${BUDGET}). Stopping.`);
      break;
    }
    if (weeklySpend >= WEEKLY_SPEND_CAP) {
      console.log(`\n💰 Weekly spend cap reached ($${weeklySpend.toFixed(2)}). Stopping.`);
      break;
    }

    const show = showBySlug[slug];
    if (!show) {
      console.log(`  ❌ ${slug} — not found in shows.json`);
      continue;
    }

    console.log(`📊 ${show.title} (${slug})`);

    try {
      const { analysis, usage, cost, searchCount, status } = await researchShowWithOpenAI(show, MODEL);

      totalCost += cost;
      runBudgetRemaining -= cost;
      weeklySpend = recordSpend(cost);
      researchedCount++;

      costLog.push({
        slug,
        model: MODEL,
        cost,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        searches: searchCount,
        status,
        timestamp: new Date().toISOString(),
      });

      console.log(`    🔍 ${searchCount} web searches, $${cost.toFixed(4)}, status: ${status}`);

      if (!analysis) {
        console.log(`    ❌ No structured data returned`);
        continue;
      }

      // Normalize capitalization if AI returned in millions
      if (analysis.capitalization != null && analysis.capitalization > 0 && analysis.capitalization < 5000) {
        console.log(`    ℹ️  Normalizing capitalization: ${analysis.capitalization} -> ${analysis.capitalization * 1e6}`);
        analysis.capitalization = analysis.capitalization * 1e6;
      }
      if (analysis.weeklyRunningCost != null && analysis.weeklyRunningCost > 0 && analysis.weeklyRunningCost < 10000) {
        analysis.weeklyRunningCost = analysis.weeklyRunningCost * 1000;
      }

      // SAFETY: Never auto-set recouped:true — always flag for review
      if (analysis.recouped === true) {
        analysis._recoupedClaim = true;
        analysis._recoupedNote = 'AI claimed recouped — requires human verification with citation before applying';
        // Don't delete the field — leave it for the pending review, but mark it
      }

      // Plausibility check
      const plausibility = checkPlausibility(analysis, grossesShows[slug]);
      if (!plausibility.plausible) {
        console.log(`    ⚠️  Plausibility: ${plausibility.reason}`);
        analysis.notes = `[PLAUSIBILITY WARNING: ${plausibility.reason}] ${analysis.notes || ''}`;
        if (analysis.confidence === 'high') analysis.confidence = 'medium';
      }

      // Guardian check — respect protected data
      if (guardian) {
        // Read commercial.json fresh for guardian check
        const freshCommercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
        const existingShow = (freshCommercial.shows || {})[slug];
        if (existingShow) {
          const fieldsToCheck = ['capitalization', 'weeklyRunningCost', 'recouped', 'designation'];
          for (const field of fieldsToCheck) {
            if (analysis[field] != null && existingShow[field] != null) {
              const conflict = guardian.detectConflict(
                { slug, field, newValue: analysis[field], oldValue: existingShow[field], source: 'deep-research-openai' },
                existingShow
              );
              if (conflict && guardian.shouldBlockChange(conflict)) {
                console.log(`    🛡️  Guardian blocked ${field}: ${guardian.calculateDiscrepancy?.(field, conflict.verifiedValue, analysis[field]) || 'conflict'}`);
                delete analysis[field];
              }
            }
          }
        }
      }

      // Add metadata
      analysis.title = show.title;
      analysis.slug = slug;
      analysis.openingDate = show.openingDate;
      analysis.status = show.status;
      analysis.researchedAt = new Date().toISOString();
      analysis.model = MODEL;

      console.log(`    ✅ ${analysis.designation || 'TBD'} | cap: ${analysis.capitalization ? '$' + (analysis.capitalization / 1e6).toFixed(1) + 'M' : '?'} | confidence: ${analysis.confidence}`);

      // Merge into pending (don't overwrite existing entries from other research runs)
      pending.shows[slug] = analysis;
      pending.generatedAt = new Date().toISOString();

      // Checkpoint progress
      progress.completed.push(slug);
      if (!DRY_RUN) {
        fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');
        fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2) + '\n');
      }

    } catch (e) {
      console.error(`    ❌ Error: ${e.message}`);
      costLog.push({ slug, error: e.message, timestamp: new Date().toISOString() });
    }

    // Rate limit between shows
    if (targetSlugs.indexOf(slug) < targetSlugs.length - 1) {
      await sleep(2000);
    }
  }

  // Append to cost log (preserve history from previous runs)
  if (!DRY_RUN && costLog.length > 0) {
    let existingLog = [];
    try { existingLog = JSON.parse(fs.readFileSync(COST_LOG_PATH, 'utf8')); } catch (e) { /* first run */ }
    fs.writeFileSync(COST_LOG_PATH, JSON.stringify([...existingLog, ...costLog], null, 2) + '\n');
  }

  // Clean up progress file after successful complete run
  if (!DRY_RUN && researchedCount > 0) {
    // Reset progress for next run
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
      completed: [],
      lastRunAt: new Date().toISOString(),
      lastRunShows: researchedCount,
    }, null, 2) + '\n');
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Shows researched: ${researchedCount}`);
  console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Weekly spend: $${weeklySpend.toFixed(2)} / $${WEEKLY_SPEND_CAP}`);
  if (!DRY_RUN) {
    console.log(`Pending results: ${Object.keys(pending.shows).length} shows in ${PENDING_PATH}`);
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
