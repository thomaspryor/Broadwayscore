#!/usr/bin/env node
/**
 * deep-research-commercial.js
 *
 * Uses OpenAI Deep Research models (o4-mini-deep-research) with background
 * polling to research Broadway show commercial/financial data. Outputs to
 * commercial-pending-review.json for auto-apply or human review.
 *
 * Lifecycle triggers: pre-opening, 6-month re-research, closing.
 * Max 3 successful research attempts per show (unless --force).
 *
 * Usage:
 *   node scripts/deep-research-commercial.js [options]
 *
 * Options:
 *   --shows=SLUG,SLUG    Specific shows to research
 *   --all-tbd            Research all TBD + uncovered open Broadway shows
 *   --max-shows=N        Max shows per run (default 10)
 *   --budget=N           Max spend in dollars (default 15)
 *   --model=MODEL        o4-mini-deep (default), o3-deep, o4-mini, o3
 *   --dry-run            Preview without writing files
 *   --queue              Also consume data/commercial-research-queue.json
 *   --force              Reset attempt counter and re-research
 *   --time-budget-min=N  Wall-clock budget in minutes (0 = unlimited). The
 *                        per-show progress checkpoint means an early exit
 *                        loses nothing; unfinished targets re-enter next run.
 */

const fs = require('fs');
const path = require('path');
const { normalizeSources } = require('./lib/commercial-sources');
const { createRunBudget } = require('./lib/run-budget');

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
const FORCE = flags['force'] === true;
const USE_QUEUE = flags['queue'] === true;
const WEEKLY_SPEND_CAP = 50; // dollars (upgraded for deep research models)
const MAX_RESEARCH_ATTEMPTS = 3;
const TIME_BUDGET_MIN = parseFloat(flags['time-budget-min']) > 0 ? parseFloat(flags['time-budget-min']) : 0;
const timeBudget = createRunBudget(TIME_BUDGET_MIN);
// A deep-research background job typically polls 5-10 min; don't start a show
// we can't reasonably finish inside the budget.
const MIN_REMAINING_MS_TO_START = 10 * 60_000;

// Model mapping: CLI shorthand -> actual API model name
const MODEL_MAP = {
  'o4-mini-deep': 'o4-mini-deep-research',
  'o3-deep': 'o3-deep-research',
  'o4-mini': 'o4-mini',
  'o3': 'o3',
};
const MODEL_INPUT = flags['model'] || 'o4-mini-deep';
const MODEL = MODEL_MAP[MODEL_INPUT] || MODEL_INPUT;
const IS_DEEP_RESEARCH = MODEL.includes('deep-research');

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
// Initialize metadata for existing commercial entries (idempotent)
// ---------------------------------------------------------------------------
function initializeMetadata() {
  let commercial;
  try {
    commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
  } catch (e) {
    return; // No commercial.json yet
  }
  const shows = commercial.shows || {};
  let changed = false;
  for (const [slug, entry] of Object.entries(shows)) {
    if (entry.researchAttempts === undefined) {
      entry.researchAttempts = 0;
      changed = true;
    }
    if (entry.lastResearchedAt === undefined) {
      entry.lastResearchedAt = null;
      changed = true;
    }
    if (entry.researchTrigger === undefined) {
      entry.researchTrigger = null;
      changed = true;
    }
  }
  if (changed && !DRY_RUN) {
    fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(commercial, null, 2) + '\n');
    console.log('Initialized research metadata for existing commercial entries');
  }
}

// ---------------------------------------------------------------------------
// OpenAI Responses API with web search + Deep Research background polling
// ---------------------------------------------------------------------------

// Cost estimates per 1M tokens
const COST_TABLE = {
  'o4-mini': { input: 1.10, output: 4.40 },
  'o3': { input: 2.00, output: 8.00 },
  'o4-mini-deep-research': { input: 2.00, output: 8.00 },
  'o3-deep-research': { input: 10.00, output: 40.00 },
};

function estimateCost(usage, model) {
  const rates = COST_TABLE[model] || COST_TABLE['o4-mini-deep-research'];
  const inputCost = (usage.input_tokens || 0) / 1e6 * rates.input;
  const outputCost = (usage.output_tokens || 0) / 1e6 * rates.output;
  return inputCost + outputCost;
}

/**
 * Poll a background response until completed or timeout.
 * Returns the completed response object.
 */
async function pollForCompletion(responseId, maxWaitMs = 1800000) {
  const pollInterval = 15000; // 15 seconds
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await sleep(pollInterval);

    const resp = await fetch(`https://api.openai.com/v1/responses/${responseId}`, {
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI poll ${resp.status}: ${err.slice(0, 300)}`);
    }

    const result = await resp.json();
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    if (result.status === 'completed') {
      console.log(`    Completed after ${elapsed}s`);
      return result;
    } else if (result.status === 'failed' || result.status === 'cancelled') {
      throw new Error(`Deep research ${result.status} after ${elapsed}s`);
    }
    // Still in_progress or queued — keep polling
    process.stdout.write(`    Polling... ${elapsed}s\r`);
  }

  // Timeout — return null (don't throw, don't count as attempt)
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`    Poll timeout after ${elapsed}s — will NOT count as research attempt`);
  return null;
}

async function researchShowWithOpenAI(show, model, maxPollMs = 1800000) {
  if (!OPENAI_KEY) {
    throw new Error('OPENAI_API_KEY required');
  }

  const title = show.title;
  const venue = show.venue || '';
  const openingDate = show.openingDate || '';
  const status = show.status || '';
  const type = show.type || 'musical';

  const prompt = `Find financial data for the Broadway ${type} "${title}"${venue ? ` at ${venue}` : ''}${openingDate ? ` (opened ${openingDate})` : ''}${show.closingDate ? ` (closed ${show.closingDate})` : ''}. Status: ${status}.

## IMPORTANT: Be efficient. Stop searching once you have what you need. Use at most 40 web searches total. If you haven't found data after 30 searches, conclude with what you have — the data probably isn't public.

## Target data (in priority order — stop early if found)
1. **Capitalization / production budget** (most important)
2. **Weekly running cost / weekly nut**
3. **Recoupment status** (did it recoup? when?)

## Where to search
Try these in order. Move to the next source only if the previous didn't have what you need:

1. **NYC tax credits** — check https://www.investmentbroadway.com/post/so-who-received-the-new-york-city-musical-and-theatrical-production-tax-credit for the show or its production company. The 25% credit ÷ 0.25 = production costs.
2. **Reddit** — search site:reddit.com/r/Broadway "${title}" capitalization OR budget OR "weekly nut"
3. **BroadwayWorld forums** — search site:forum.broadwayworld.com "${title}" capitalization OR budget
4. **SEC EDGAR** — search site:sec.gov "${title}" for Form D filings
5. **Trade press** — "${title}" broadway capitalization OR budget OR recouped

## Rules
- Only report verified data. Null for anything you can't confirm.
- ${venue && /samuel j\. friedman|helen hayes|todd haimes|vivian beaumont/i.test(venue) ? 'This venue is a nonprofit theater — use "Nonprofit" designation.' : ''}
- If this is a revival, only report data about THIS production, not prior ones.
- Capitalization in dollars (15000000 not 15). Weekly costs in dollars (650000 not 650).
- Designation: Miracle, Windfall, Easy Winner, Trickle, Fizzle, Flop, Nonprofit, or TBD.

## Output format
Write a BRIEF summary (3-5 sentences max) of what you found, then a JSON block:

\`\`\`json
{
  "capitalization": <number in dollars or null>,
  "capitalizationSource": "<source description>",
  "weeklyRunningCost": <number in dollars or null>,
  "costMethodology": "<sec-filing|trade-reported|industry-estimate|null>",
  "recouped": <true|false|null>,
  "recoupedDate": "<YYYY-MM or null>",
  "recoupedSource": "<source description or null>",
  "estimatedRecoupmentPct": <[low, high] or null>,
  "designation": "<designation>",
  "notes": "<brief summary>",
  "confidence": "<high|medium|low>",
  "sources": [{"type": "<sec|trade|reddit|manual>", "url": "<url>", "date": "<YYYY-MM-DD or null>"}]
}
\`\`\``;

  const isDeep = model.includes('deep-research');

  const body = {
    model,
    input: prompt,
    max_output_tokens: 16000,
  };

  if (isDeep) {
    // Deep Research models use web_search tool and background mode
    body.tools = [{ type: 'web_search' }];
    body.background = true;
  } else {
    // Standard models use web_search_preview
    body.tools = [{ type: 'web_search_preview', search_context_size: 'low' }];
    body.reasoning = { effort: 'high' };
  }

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(isDeep ? 60000 : 300000), // 60s for deep research initial, 5min for standard
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API ${resp.status}: ${err.slice(0, 300)}`);
  }

  let result = await resp.json();

  // For background/deep research, poll until completion
  if (isDeep && result.status !== 'completed') {
    console.log(`    Background research started (ID: ${result.id})`);
    result = await pollForCompletion(result.id, maxPollMs);
    if (!result) {
      // Timeout — return special status so caller knows not to count this attempt
      return { analysis: null, usage: {}, cost: 0, searchCount: 0, status: 'timeout' };
    }
  }

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
  const searchCount = (result.output || []).filter(i =>
    i.type === 'web_search_call' || i.type === 'web_search'
  ).length;

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
      console.warn(`    Failed to parse JSON output: ${e2.message}`);
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
// 6-month re-research eligibility
// ---------------------------------------------------------------------------
function isSixMonthEligible(entry) {
  if (!entry || !entry.lastResearchedAt) return false;
  if ((entry.researchAttempts || 0) >= MAX_RESEARCH_ATTEMPTS) return false;
  if (entry.designation && entry.designation !== 'TBD') return false;

  const lastResearched = new Date(entry.lastResearchedAt);
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return lastResearched < sixMonthsAgo;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Deep Research Commercial ===`);
  console.log(`Model: ${MODEL} (${IS_DEEP_RESEARCH ? 'deep research' : 'standard'})`);
  console.log(`Budget: $${BUDGET} (weekly cap: $${WEEKLY_SPEND_CAP})`);
  console.log(`Max shows: ${MAX_SHOWS}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${FORCE ? ' [FORCE]' : ''}\n`);

  if (!OPENAI_KEY) {
    console.error('ERROR: OPENAI_API_KEY is required');
    process.exit(1);
  }

  // Step 1: Initialize metadata for existing entries (idempotent)
  initializeMetadata();

  // Load data fresh
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const allShows = showsData.shows || [];
  let grossesShows = {};
  try {
    const grossesRaw = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf8'));
    grossesShows = grossesRaw.shows || {};
  } catch (e) {
    console.warn('Could not load grosses.json — plausibility cross-checks will be skipped');
  }

  // Build show lookup (by both slug and id)
  const showBySlug = {};
  for (const s of allShows) {
    if (s && typeof s === 'object') {
      if (s.slug) showBySlug[s.slug] = s;
      if (s.id && s.id !== s.slug) showBySlug[s.id] = s;
    }
  }

  // Check weekly spend cap
  const currentWeeklySpend = getWeeklySpend();
  if (currentWeeklySpend >= WEEKLY_SPEND_CAP) {
    console.log(`Weekly spend cap reached ($${currentWeeklySpend.toFixed(2)} >= $${WEEKLY_SPEND_CAP}). Exiting.`);
    process.exit(0);
  }

  // Load commercial data for attempt tracking
  let commercial;
  try {
    commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
  } catch (e) {
    commercial = { shows: {} };
  }
  const commShows = commercial.shows || {};

  // Determine which shows to research
  let targetSlugs = [];
  let queuedSlugs = [];
  let sixMonthSlugs = [];

  // Consume queue file if requested (highest priority)
  if (USE_QUEUE) {
    try {
      const queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
      queuedSlugs = (queue.shows || []).filter(slug => {
        const entry = commShows[slug];
        if (!FORCE && entry && (entry.researchAttempts || 0) >= MAX_RESEARCH_ATTEMPTS) {
          console.log(`  Skipping queued ${slug} — max attempts (${entry.researchAttempts}) reached`);
          return false;
        }
        return true;
      });
      if (queuedSlugs.length > 0) {
        console.log(`Queue: ${queuedSlugs.length} shows`);
      }
      // Clear queue
      if (!DRY_RUN) {
        fs.writeFileSync(QUEUE_PATH, JSON.stringify({ shows: [], updatedAt: new Date().toISOString() }, null, 2) + '\n');
      }
    } catch (e) {
      // No queue file
    }
  }

  if (SHOW_LIST) {
    targetSlugs = SHOW_LIST;
  } else if (ALL_TBD) {
    // Shows with TBD designation (Broadway only, not maxed out)
    const tbdSlugs = Object.entries(commShows)
      .filter(([slug, v]) => {
        if (!v || v.designation !== 'TBD') return false;
        if (!FORCE && (v.researchAttempts || 0) >= MAX_RESEARCH_ATTEMPTS) return false;
        const show = showBySlug[slug];
        if (show && show.category && show.category !== 'broadway') return false;
        return true;
      })
      .map(([k]) => k);

    // Open Broadway shows without any commercial data
    const uncoveredSlugs = allShows
      .filter(s => s && s.status && ['open', 'previews'].includes(s.status)
        && (s.market || 'broadway') === 'broadway'
        && !commShows[s.slug])
      .map(s => s.slug);

    // 6-month eligible shows (TBD, Broadway only, researched 6+ months ago, still open)
    sixMonthSlugs = Object.entries(commShows)
      .filter(([slug, entry]) => {
        const show = showBySlug[slug];
        if (!show || show.status !== 'open') return false;
        if (show.category && show.category !== 'broadway') return false;
        return isSixMonthEligible(entry);
      })
      .map(([k]) => k);

    if (sixMonthSlugs.length > 0) {
      console.log(`6-month re-research eligible: ${sixMonthSlugs.length} shows`);
    }

    // Tier 3 boost — recoupment window. Shows that opened 56-182 days ago
    // (the 8-26 week recoupment window for most plays/musicals) get
    // prioritized ahead of the shuffled tail. Hamilton + Giant both recouped
    // at week 10 — well inside this window. Closes the gap where deep-research
    // never gets to the shows whose recoupment news is most newsletter-worthy.
    // Skips shows already covered by queue / six-month tiers.
    const now = Date.now();
    const daysSinceOpened = (show) => {
      const dateStr = show?.openingDate || show?.previewsStartDate;
      if (!dateStr) return null;
      const t = new Date(dateStr).getTime();
      if (Number.isNaN(t)) return null;
      return (now - t) / 86_400_000;
    };
    const recoupWindowSlugs = tbdSlugs.filter(slug => {
      const show = showBySlug[slug];
      if (!show) return false;
      const d = daysSinceOpened(show);
      if (d === null) return false;
      return d >= 56 && d <= 182;
    });
    if (recoupWindowSlugs.length > 0) {
      console.log(`Recoupment-window boost: ${recoupWindowSlugs.length} shows (opened 8-26 weeks ago)`);
    }

    // Priority order: queued > 6-month re-research > recoupment-window boost >
    // remaining TBDs (shuffled). Skip rules respect explicit --shows.
    const remaining = [...new Set([...tbdSlugs, ...uncoveredSlugs])];
    targetSlugs = [
      ...queuedSlugs,
      ...sixMonthSlugs.filter(s => !queuedSlugs.includes(s)),
      ...recoupWindowSlugs.filter(s => !queuedSlugs.includes(s) && !sixMonthSlugs.includes(s)),
      ...shuffle(remaining.filter(s =>
        !queuedSlugs.includes(s) &&
        !sixMonthSlugs.includes(s) &&
        !recoupWindowSlugs.includes(s)
      )),
    ];
    // Deduplicate
    targetSlugs = [...new Set(targetSlugs)];
  } else if (queuedSlugs.length > 0) {
    // Queue-only mode (no --all-tbd, no --shows)
    targetSlugs = queuedSlugs;
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
      console.log(`  ${slug} — already completed this batch`);
      continue;
    }

    // Budget checks
    if (runBudgetRemaining <= 0) {
      console.log(`\nRun budget exhausted ($${BUDGET}). Stopping.`);
      break;
    }
    if (weeklySpend >= WEEKLY_SPEND_CAP) {
      console.log(`\nWeekly spend cap reached ($${weeklySpend.toFixed(2)}). Stopping.`);
      break;
    }
    if (timeBudget.enabled && timeBudget.remainingMs() < MIN_REMAINING_MS_TO_START) {
      const unprocessed = targetSlugs.filter(s => !progress.completed.includes(s)).length;
      console.log(`\n⏱ Time budget (${TIME_BUDGET_MIN} min) reached after ${timeBudget.elapsedMin()} min — stopping cleanly. ${unprocessed} targets deferred to next run. If this recurs every week while the TBD backlog grows, throughput is degrading; investigate before raising the budget.`);
      break;
    }

    const show = showBySlug[slug];
    if (!show) {
      console.log(`  ${slug} — not found in shows.json`);
      continue;
    }

    // Check attempt limit (unless --force)
    const existingEntry = commShows[slug];
    if (!FORCE && existingEntry && (existingEntry.researchAttempts || 0) >= MAX_RESEARCH_ATTEMPTS) {
      console.log(`  ${slug} — max research attempts (${existingEntry.researchAttempts}) reached, skipping`);
      continue;
    }

    // Determine trigger reason
    let trigger = 'manual';
    if (queuedSlugs.includes(slug)) {
      // Read trigger from queue if present
      try {
        const queueData = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
        trigger = (queueData.triggers || {})[slug] || 'queued';
      } catch (e) {
        trigger = 'queued';
      }
    } else if (sixMonthSlugs.includes(slug)) {
      trigger = '6-month';
    } else if (ALL_TBD) {
      trigger = 'backlog';
    }

    console.log(`${show.title} (${slug}) [${trigger}]`);

    try {
      // Cap polling at the remaining time budget (floor of 5 min so a nearly-
      // spent budget still gives an in-flight job a chance to land).
      const maxPollMs = timeBudget.enabled
        ? Math.min(1800000, Math.max(300000, timeBudget.remainingMs()))
        : 1800000;
      const { analysis, usage, cost, searchCount, status } = await researchShowWithOpenAI(show, MODEL, maxPollMs);

      // Handle timeout — don't count as attempt, don't record cost
      if (status === 'timeout') {
        console.log(`    Timeout — not counted as research attempt`);
        costLog.push({ slug, status: 'timeout', timestamp: new Date().toISOString() });
        continue;
      }

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

      console.log(`    ${searchCount} web searches, $${cost.toFixed(4)}, status: ${status}`);

      if (!analysis) {
        console.log(`    No structured data returned`);
        continue;
      }

      // Normalize capitalization if AI returned in millions
      if (analysis.capitalization != null && analysis.capitalization > 0 && analysis.capitalization < 5000) {
        console.log(`    Normalizing capitalization: ${analysis.capitalization} -> ${analysis.capitalization * 1e6}`);
        analysis.capitalization = analysis.capitalization * 1e6;
      }
      if (analysis.weeklyRunningCost != null && analysis.weeklyRunningCost > 0 && analysis.weeklyRunningCost < 10000) {
        analysis.weeklyRunningCost = analysis.weeklyRunningCost * 1000;
      }

      // Normalize sources — LLMs routinely emit `type: "other"` and malformed dates
      // even when the prompt specifies allowed values. Normalize before storing in
      // pending so downstream apply steps receive valid data.
      if (Array.isArray(analysis.sources)) {
        analysis.sources = normalizeSources(analysis.sources);
      }

      // SAFETY: Never auto-set recouped:true — always flag for review
      if (analysis.recouped === true) {
        analysis._recoupedClaim = true;
        analysis._recoupedNote = 'AI claimed recouped — requires human verification with citation before applying';
      }

      // Plausibility check
      const plausibility = checkPlausibility(analysis, grossesShows[slug]);
      if (!plausibility.plausible) {
        console.log(`    Plausibility: ${plausibility.reason}`);
        analysis.notes = `[PLAUSIBILITY WARNING: ${plausibility.reason}] ${analysis.notes || ''}`;
        if (analysis.confidence === 'high') analysis.confidence = 'medium';
      }

      // Guardian check — respect protected data
      if (guardian) {
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
                console.log(`    Guardian blocked ${field}: ${guardian.calculateDiscrepancy?.(field, conflict.verifiedValue, analysis[field]) || 'conflict'}`);
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
      analysis.researchTrigger = trigger;

      console.log(`    ${analysis.designation || 'TBD'} | cap: ${analysis.capitalization ? '$' + (analysis.capitalization / 1e6).toFixed(1) + 'M' : '?'} | confidence: ${analysis.confidence}`);

      // Merge into pending (don't overwrite existing entries from other research runs)
      pending.shows[slug] = analysis;
      pending.generatedAt = new Date().toISOString();

      // Update research tracking in commercial.json AFTER successful write
      // Only increment after confirmed file write (per plan: increment after success AND confirmed write)
      if (!DRY_RUN) {
        fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n');

        // Now increment attempt counter in commercial.json
        const freshComm = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
        if (!freshComm.shows[slug]) {
          freshComm.shows[slug] = { designation: 'TBD' };
        }
        const entry = freshComm.shows[slug];
        if (FORCE) {
          entry.researchAttempts = 1; // Reset on force
        } else {
          entry.researchAttempts = (entry.researchAttempts || 0) + 1;
        }
        entry.lastResearchedAt = new Date().toISOString();
        entry.researchTrigger = trigger;
        fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(freshComm, null, 2) + '\n');
      }

      // Checkpoint progress
      progress.completed.push(slug);
      if (!DRY_RUN) {
        fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2) + '\n');
      }

    } catch (e) {
      console.error(`    Error: ${e.message}`);
      costLog.push({ slug, error: e.message, timestamp: new Date().toISOString() });
    }

    // Rate limit between shows (longer for deep research)
    if (targetSlugs.indexOf(slug) < targetSlugs.length - 1) {
      await sleep(IS_DEEP_RESEARCH ? 5000 : 2000);
    }
  }

  // Append to cost log (preserve history from previous runs)
  if (!DRY_RUN && costLog.length > 0) {
    let existingLog = [];
    try { existingLog = JSON.parse(fs.readFileSync(COST_LOG_PATH, 'utf8')); } catch (e) { /* first run */ }
    fs.writeFileSync(COST_LOG_PATH, JSON.stringify([...existingLog, ...costLog], null, 2) + '\n');
  }

  // Preserve which shows were researched this run (don't wipe progress)
  if (!DRY_RUN && researchedCount > 0) {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
      completed: progress.completed,
      lastRunAt: new Date().toISOString(),
      lastRunShows: researchedCount,
    }, null, 2) + '\n');
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Shows researched: ${researchedCount}`);
  console.log(`Total cost: $${totalCost.toFixed(4)}`);
  console.log(`Weekly spend: $${weeklySpend.toFixed(2)} / $${WEEKLY_SPEND_CAP}`);
  if (TIME_BUDGET_MIN) {
    const unprocessed = targetSlugs.filter(s => !progress.completed.includes(s)).length;
    console.log(`Time budget: ${timeBudget.elapsedMin()}/${TIME_BUDGET_MIN} min used, ${unprocessed} targets unprocessed`);
  }
  if (!DRY_RUN) {
    console.log(`Pending results: ${Object.keys(pending.shows).length} shows in ${PENDING_PATH}`);
  }

  // Auto-commit results so they aren't lost
  if (!DRY_RUN && researchedCount > 0) {
    console.log('\nAuto-committing results...');
    try {
      const { execSync } = require('child_process');
      const cwd = path.join(__dirname, '..');
      const gitOpts = { cwd, stdio: 'pipe', timeout: 30000 };

      // Set git identity for unattended runs
      try { execSync('git config user.name', gitOpts); } catch {
        execSync('git config user.name "Deep Research Bot"', gitOpts);
        execSync('git config user.email "noreply@broadwayscorecard.com"', gitOpts);
      }

      // Stage data files only
      execSync('git add data/commercial-pending-review.json data/deep-research-progress.json data/deep-research-cost-log.json data/commercial-research-spend.json', gitOpts);

      const msg = `data: Deep research batch — ${researchedCount} shows, $${totalCost.toFixed(2)} spent`;
      execSync(`git commit -m "${msg}" --allow-empty`, gitOpts);

      // Push with rebase to handle concurrent pushes
      try {
        execSync('git pull --rebase origin main', gitOpts);
      } catch (e) {
        console.warn('    Pull-rebase warning:', e.message?.slice(0, 100));
      }
      execSync('git push origin main', gitOpts);
      console.log('    Committed and pushed.');
    } catch (e) {
      console.warn(`    Auto-commit failed: ${e.message?.slice(0, 200) || 'unknown error'}`);
      console.warn('    Results are still saved locally in pending-review.json');
    }
  }
}

main().catch(e => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
