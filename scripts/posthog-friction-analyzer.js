#!/usr/bin/env node
/**
 * posthog-friction-analyzer.js — PostHog → Claude → Linear friction pipeline.
 *
 * Reads last-7-day PostHog friction signals, sends to Claude, files Linear
 * issues for novel issues. Deduplicates by content hash embedded in the issue
 * body as `fhash:XXXXXXXX` (Linear has no card-tag equivalent of the retired
 * Notion board's multi_select Tags property, so the hash lives in the body
 * text and dedup matches on that substring instead).
 *
 * Filing goes through scripts/lib/linear-issue-create.js's createLinearIssue()
 * — the one Linear creation chokepoint (CLAUDE.md §6, task #1310) — not a
 * direct @notionhq/client or hand-rolled Linear API call. See BRO-3430: this
 * script used to bypass notion-brain.js's create guard entirely and file
 * straight onto the retired Notion board every Monday.
 *
 * Env: POSTHOG_PERSONAL_API_KEY, ANTHROPIC_API_KEY, LINEAR_API_KEY
 * Usage:
 *   node scripts/posthog-friction-analyzer.js            # live run
 *   node scripts/posthog-friction-analyzer.js --dry-run  # print proposed cards, no writes
 */

const crypto = require('crypto');
const fs = require('fs');

// Load .env
require('./lib/load-env').loadEnv();

const Anthropic = require('@anthropic-ai/sdk');
const linearClient = require('./lib/linear-client');
const { createLinearIssue } = require('./lib/linear-issue-create');
const { CLAUDE_SONNET } = require('./lib/models');
const {
  authCheck, tracked,
  getRageClickDetails, getGateFunnel, getBtcFunnel,
  getTicketClicks, getClosedShowTicketClicks, getPromoClicks, getSearchStats, getTrafficSummary,
  getZeroResultsSearches,
} = require('./lib/posthog-query');

const DRY_RUN = process.argv.includes('--dry-run');
const CARDS_PER_RUN_CAP = 5;
const TOKEN_BUDGET_CHARS = 4500;
const FHASH_RE = /fhash:([0-9a-f]{8})/;

// ── Linear helpers ───────────────────────────────────────────────────────

async function getExistingFrictionIssues() {
  return linearClient.listOpenIssuesWithDescriptions();
}

function extractHashes(issues) {
  const hashes = new Set();
  for (const issue of issues) {
    for (const m of (issue.description || '').matchAll(new RegExp(FHASH_RE, 'g'))) hashes.add(m[1]);
  }
  return hashes;
}

function extractTitles(issues) {
  // Only include analyzer-generated issues (identified by the fhash: marker).
  // Manually filed issues would confuse Claude into thinking product friction
  // that isn't actually tracked yet is already covered.
  return issues
    .filter(i => FHASH_RE.test(i.description || ''))
    .map(i => i.title)
    .filter(Boolean);
}

function computeHash(evidenceKey) {
  return crypto.createHash('sha256').update(evidenceKey).digest('hex').slice(0, 8);
}

// Linear's raw priority ints: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low.
const PRIORITY_MAP = { 'P0 Now': 1, 'P1 Next': 2, 'P2 Later': 3, 'P3 Backlog': 4 };

async function createFrictionIssue(issue, hash) {
  const tags = ['friction', `fhash:${hash}`];
  if (issue.type) tags.push(issue.type.replace(/_/g, '-'));

  const notes = [
    `Tags: ${tags.join(', ')}`,
    ``,
    `## Problem`,
    issue.problem,
    ``,
    `## Suggested approach`,
    issue.suggested_approach,
    ``,
    `## Acceptance criteria`,
    issue.acceptance_criteria,
    ``,
    `## Evidence`,
    issue.evidence || '(see PostHog data)',
  ].join('\n');

  const priority = PRIORITY_MAP[issue.priority] ?? PRIORITY_MAP['P2 Later'];

  const result = await createLinearIssue({
    title: issue.title,
    description: notes.slice(0, 2000),
    priority,
    park: 'Weekly PostHog friction scan finding — needs human triage before work starts',
  });
  return result.issue.url;
}

// Missing-show issue: a real production users searched for but the site doesn't
// cover. NOT auto-committed — CLAUDE.md Rule 3 requires validate-show-venue.js
// to confirm venue/date before any shows.json entry.
async function createMissingShowIssue(show, hash) {
  const tags = ['friction', 'missing-show', `fhash:${hash}`];

  const notes = [
    `Tags: ${tags.join(', ')}`,
    ``,
    `## Missing production (from zero-results search)`,
    `Users searched for **"${show.search_term}"** ${show.search_count}x in the last 7 days and got zero results.`,
    `Likely production: **${show.canonical_title}** (${show.market}).`,
    ``,
    `## Why flagged`,
    show.reasoning || '(LLM-classified as a real missing production)',
    ``,
    `## Next step (manual — do NOT auto-add)`,
    `1. Confirm the production exists and its venue/opening date via Playbill.`,
    `2. Run \`node scripts/validate-show-venue.js\` before adding any shows.json entry (CLAUDE.md Rule 3).`,
    `3. If valid, add the show and let discovery/scraping pick up reviews.`,
    ``,
    `## Evidence`,
    `PostHog search_performed, has_results=false, query="${show.search_term}", ${show.search_count} searches (7d).`,
  ].join('\n');

  const result = await createLinearIssue({
    title: `Missing show: ${show.canonical_title}`.slice(0, 100),
    description: notes.slice(0, 2000),
    priority: PRIORITY_MAP['P1 Next'],
    park: 'Candidate missing production from zero-results search — needs manual venue/date validation before any shows.json entry (CLAUDE.md Rule 3)',
  });
  return result.issue.url;
}

// ── Data compilation ─────────────────────────────────────────────────────

function summarizeGateFunnel(rows) {
  const map = {};
  for (const [event, n, users] of rows) map[event] = { n: Number(n), users: Number(users) };
  const shown = map['gate_modal_shown']?.users || 0;
  const dismissed = map['gate_modal_dismissed']?.users || 0;
  const captured = map['email_captured']?.n || 0;
  const convRate = shown > 0 ? ((captured / shown) * 100).toFixed(1) : 0;
  const dismissRate = shown > 0 ? ((dismissed / shown) * 100).toFixed(0) : 0;
  return `Gate modal: shown to ${shown} users, ${dismissRate}% dismissed, ${captured} emails captured (${convRate}% conversion)`;
}

function summarizeBtcFunnel(rows) {
  const map = {};
  for (const [event, n, users] of rows) map[event] = { n: Number(n), users: Number(users) };
  const started = map['btc_started']?.users || 0;
  const reached = map['btc_results_reached']?.users || 0;
  const submitted = map['btc_email_submitted']?.users || 0;
  const completion = started > 0 ? Math.round(reached / started * 100) : 0;
  return `Beat-the-Critics: ${started} started → ${reached} reached results (${completion}% completion) → ${submitted} submitted email`;
}

function summarizeRageClicks(rows) {
  return rows
    .filter(([, elText, n]) => Number(n) >= 2)
    .map(([page, elText, n]) => `  ${page}: ${Number(n)}x${elText ? ` on "${elText}"` : ''}`)
    .join('\n');
}

function summarizeTicketClicks(rows) {
  const top = rows.slice(0, 8);
  return top.map(([show, platform, n]) => `  ${show} (${platform}): ${n}`).join('\n');
}

function summarizePromoClicks(rows) {
  if (!rows.length) return '  (no promo clicks with placement data)';
  return rows.slice(0, 8).map(([placement, variant, n]) =>
    `  ${placement || '(unknown)'}${variant ? ` [${variant}]` : ''}: ${n}`
  ).join('\n');
}

function summarizeClosedShowTicketClicks(rows) {
  if (!rows.length) return null;
  return rows.map(([show, platform, n]) => `  ${show} (${platform}): ${n} click(s)`).join('\n');
}

function summarizeZeroResultsSearches(rows) {
  if (!rows.length) return null;
  return rows
    .slice(0, 30)
    .map(([query, cnt]) => `  "${query}" — ${Number(cnt)} search(es)`)
    .join('\n');
}

function buildContext(data) {
  const { traffic, rageClicks, gateFunnel, btcFunnel, ticketClicks, closedShowTicketClicks, promoClicks, searchStats, zeroResultsSearches } = data;

  const parts = [];

  if (traffic.length > 0) {
    const [users, pageviews] = traffic[0];
    parts.push(`TRAFFIC (last 7 days): ${Number(users).toLocaleString()} unique users, ${Number(pageviews).toLocaleString()} pageviews`);
  }

  if (gateFunnel.length > 0) {
    parts.push(`\nEMAIL GATE FUNNEL:\n${summarizeGateFunnel(gateFunnel)}`);
  }

  if (btcFunnel.length > 0) {
    parts.push(`\nBEAT-THE-CRITICS FUNNEL:\n${summarizeBtcFunnel(btcFunnel)}`);
  }

  const rageDetail = summarizeRageClicks(rageClicks);
  if (rageDetail) {
    parts.push(`\nRAGE CLICKS (frustrated interactions, ≥2 occurrences):\n${rageDetail}`);
  }

  if (ticketClicks.length > 0) {
    parts.push(`\nTICKET CLICKS (top shows):\n${summarizeTicketClicks(ticketClicks)}`);
  }

  const closedTicketSummary = summarizeClosedShowTicketClicks(closedShowTicketClicks || []);
  if (closedTicketSummary) {
    parts.push(`\nTICKET CLICKS ON CLOSED SHOWS (should be zero — indicates badge shown on closed show):\n${closedTicketSummary}`);
  }

  if (promoClicks.length > 0) {
    parts.push(`\nPROMO CLICK PERFORMANCE:\n${summarizePromoClicks(promoClicks)}`);
  }

  if (searchStats.length > 0) {
    const [total, zeroResults, uniqueSearchers] = searchStats[0];
    if (Number(total) > 0) {
      const zeroRate = Math.round(Number(zeroResults) / Number(total) * 100);
      parts.push(`\nSEARCH: ${Number(total)} searches by ${Number(uniqueSearchers)} users, ${zeroRate}% returned zero results`);
    }
  }

  const zeroResultsSummary = summarizeZeroResultsSearches(zeroResultsSearches || []);
  if (zeroResultsSummary) {
    parts.push(`\nZERO-RESULTS SEARCH TERMS (queries that returned nothing — candidate missing shows):\n${zeroResultsSummary}`);
  }

  const full = parts.join('\n');
  // Truncate to budget
  if (full.length > TOKEN_BUDGET_CHARS) {
    console.warn(`[analyzer] PostHog context truncated (${full.length} → ${TOKEN_BUDGET_CHARS} chars)`);
    return full.slice(0, TOKEN_BUDGET_CHARS) + '\n... (truncated)';
  }
  return full;
}

// ── Claude analysis ──────────────────────────────────────────────────────

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'priority', 'evidence_key', 'problem', 'suggested_approach', 'acceptance_criteria', 'evidence'],
        properties: {
          title: { type: 'string', description: 'Short (≤60 chars) issue title' },
          priority: { type: 'string', enum: ['P0 Now', 'P1 Next', 'P2 Later', 'P3 Backlog'] },
          evidence_key: { type: 'string', description: 'Canonical dedup key. Format: TYPE:PAGE:FEATURE where TYPE is one of "rage_click|funnel_drop|promo_gap|ticket_gap|ux_gap". PAGE is the URL path slug (e.g. "beat-the-critics", "homepage", "show-page"). FEATURE is the UI component or metric name, lowercase with hyphens, no show-specific names (e.g. "lock-in-buttons" not "lock-in-death-of-a-salesman"). Examples: "rage_click:beat-the-critics:lock-in-buttons", "funnel_drop:email-gate:conversion", "promo_gap:homepage:mid-page-placement". One card should cover all rage clicks on the same PAGE:FEATURE combo.' },
          problem: { type: 'string', description: 'What is wrong and what data shows it (2-4 sentences)' },
          suggested_approach: { type: 'string', description: 'Concrete steps to investigate and fix' },
          acceptance_criteria: { type: 'string', description: 'How to verify the issue is resolved' },
          evidence: { type: 'string', description: 'The specific metric or data point from PostHog' },
        },
      },
    },
    missing_shows: {
      type: 'array',
      description: 'Zero-results search terms that you are confident refer to a REAL Broadway/West End/Off-Broadway production the site is likely missing. EXCLUDE typos, partial/duplicate spellings of shows we probably already have, generic words, non-theatre queries, performer-only names, and anything you are unsure about. Empty array if none qualify.',
      items: {
        type: 'object',
        required: ['search_term', 'canonical_title', 'market', 'search_count', 'reasoning'],
        properties: {
          search_term: { type: 'string', description: 'The raw zero-results query as typed by users' },
          canonical_title: { type: 'string', description: 'The production\'s proper title, corrected for spelling/casing' },
          market: { type: 'string', enum: ['broadway', 'west-end', 'off-broadway', 'unknown'] },
          search_count: { type: 'integer', description: 'Number of zero-results searches for this term in the window' },
          reasoning: { type: 'string', description: 'Why you are confident this is a real production we are missing (1-2 sentences)' },
        },
      },
    },
  },
  required: ['issues'],
};

async function analyzeWithClaude(context, existingTitles) {
  const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  const titlesToShow = existingTitles.slice(0, 30);
  const existingSection = titlesToShow.length > 0
    ? `\n\nEXISTING OPEN FRICTION ISSUES (do not recreate these):\n${titlesToShow.map(t => `- ${t}`).join('\n')}`
    : '';

  const prompt = `You are a product analyst for Broadway Scorecard (broadwayscorecard.com), a Broadway/West End show review aggregator with ~4k weekly users.

Analyze this week's PostHog analytics data and identify the most actionable friction issues — bugs, UX problems, or significant drop-offs that a developer should address.

Only surface issues that are:
1. Backed by concrete data from the analytics
2. Not already in the existing open issues list
3. Actionable (something a developer can investigate and fix)

Return 3-5 issues maximum, ordered by priority.${existingSection}

SEPARATELY, examine the ZERO-RESULTS SEARCH TERMS section (if present). These are queries that returned no results — each is a candidate for a show we don't yet cover. Classify them: most will be typos, partial spellings of shows we likely already have, generic words, performer names, or non-theatre noise. Only a few (if any) will be REAL productions (Broadway, West End, or Off-Broadway) that we are genuinely missing. Return ONLY the confident real-missing-production matches in the "missing_shows" array — when in doubt, leave it out. Do NOT propose adding shows yourself; a human must validate the venue/date before any show is created.

ANALYTICS DATA:
${context}`;

  const response = await anthropic.messages.create({
    model: CLAUDE_SONNET,
    max_tokens: 4000,
    temperature: 0,
    tools: [{
      name: 'report_friction_issues',
      description: 'Report friction issues found in the analytics data',
      input_schema: ISSUE_SCHEMA,
    }],
    tool_choice: { type: 'tool', name: 'report_friction_issues' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call report_friction_issues tool');
  // Harden against malformed tool output: models can violate the schema and
  // return a non-array (object/string) — Array.isArray avoids iterating a string
  // char-by-char or crashing the for...of below.
  const issues = Array.isArray(toolUse.input.issues) ? toolUse.input.issues : [];
  const missingShows = Array.isArray(toolUse.input.missing_shows) ? toolUse.input.missing_shows : [];
  console.log(`Claude tool call returned ${issues.length} issues, ${missingShows.length} missing shows (stop_reason: ${response.stop_reason})`);
  return { issues, missingShows };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const missing = ['POSTHOG_PERSONAL_API_KEY', 'ANTHROPIC_API_KEY', 'LINEAR_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (DRY_RUN) console.log('[dry-run] No Linear issues will be created.\n');

  await authCheck();
  console.log('PostHog auth OK');

  console.log('Querying PostHog...');
  const [traffic, rageClicks, gateFunnel, btcFunnel, ticketClicks, closedShowTicketClicks, promoClicks, searchStats, zeroResultsSearches] =
    await Promise.all([
      tracked('Traffic', getTrafficSummary),
      tracked('Rage clicks', getRageClickDetails),
      tracked('Gate funnel', getGateFunnel),
      tracked('BTC funnel', getBtcFunnel),
      tracked('Ticket clicks', getTicketClicks),
      tracked('Closed-show ticket clicks', getClosedShowTicketClicks),
      tracked('Promo clicks', getPromoClicks),
      tracked('Search stats', getSearchStats),
      tracked('Zero-results searches', getZeroResultsSearches),
    ]);

  const context = buildContext({ traffic, rageClicks, gateFunnel, btcFunnel, ticketClicks, closedShowTicketClicks, promoClicks, searchStats, zeroResultsSearches });

  console.log('\n--- PostHog context sent to Claude ---');
  console.log(context);
  console.log('--------------------------------------\n');

  // Fetch existing open friction issues for context + dedup
  console.log('Fetching existing friction issues from Linear...');
  const existingIssues = await getExistingFrictionIssues();
  // listOpenIssuesWithDescriptions() turns a malformed GraphQL response into
  // an empty list by design (linear-client.js), so "board has zero open
  // issues" and "the read failed" are the same value. The BRO board carries
  // 1,000+ open issues and has never legitimately been empty (same guard
  // scripts/ux-walkthrough.mjs applies to its own dedup read) — treat a zero
  // read as a failed read and refuse to file rather than dedup against a
  // false-empty set and spam duplicate issues every week.
  if (existingIssues.length === 0) {
    throw new Error('getExistingFrictionIssues: Linear returned ZERO open issues — treating as a failed read, not an empty board. Refusing to file without real dedup coverage.');
  }
  const existingHashes = extractHashes(existingIssues);
  const existingTitles = extractTitles(existingIssues);
  console.log(`Found ${existingIssues.length} existing open friction issues`);

  console.log('Calling Claude for friction analysis...');
  const { issues, missingShows } = await analyzeWithClaude(context, existingTitles);
  console.log(`Claude identified ${issues.length} issues, ${missingShows.length} missing shows\n`);

  const created = [];
  const skipped = [];

  for (const issue of issues) {
    if (created.length >= CARDS_PER_RUN_CAP) {
      skipped.push(`[cap] ${issue.title}`);
      continue;
    }

    const hash = computeHash(issue.evidence_key);

    if (existingHashes.has(hash)) {
      skipped.push(`[duplicate hash ${hash}] ${issue.title}`);
      continue;
    }

    console.log(`\n${DRY_RUN ? '[dry-run] Would create' : 'Creating'}: ${issue.title}`);
    console.log(`  Priority: ${issue.priority}`);
    console.log(`  Hash: ${hash}`);
    console.log(`  Problem: ${issue.problem.slice(0, 100)}...`);

    if (!DRY_RUN) {
      const url = await createFrictionIssue(issue, hash);
      created.push({ title: issue.title, url, hash });
      console.log(`  Created: ${url}`);
    } else {
      created.push({ title: issue.title, url: '(dry-run)', hash });
    }
  }

  // Missing-show cards from zero-results searches (separate cap so they don't
  // crowd out friction issues). Deduped by the same fhash mechanism.
  const MISSING_SHOW_CAP = 3;
  let missingCreated = 0;
  for (const show of missingShows) {
    if (missingCreated >= MISSING_SHOW_CAP) {
      skipped.push(`[cap] missing show: ${show.canonical_title}`);
      continue;
    }
    // Include market in the dedup key so same-title productions in different
    // markets (e.g. Othello Broadway vs West End) don't collapse to one card.
    const titleKey = (show.canonical_title || show.search_term || '').toLowerCase().trim();
    const marketKey = (show.market || 'unknown').toLowerCase().trim();
    const evidenceKey = `missing_show:search:${titleKey}|${marketKey}`;
    const hash = computeHash(evidenceKey);
    if (existingHashes.has(hash)) {
      skipped.push(`[duplicate hash ${hash}] missing show: ${show.canonical_title}`);
      continue;
    }
    // Add to the live set immediately so duplicate missingShows entries in THIS
    // run (the LLM can repeat a term) don't create two cards.
    existingHashes.add(hash);
    console.log(`\n${DRY_RUN ? '[dry-run] Would create' : 'Creating'} missing-show card: ${show.canonical_title} (${show.market}, "${show.search_term}" ×${show.search_count})`);
    console.log(`  Hash: ${hash}`);
    if (!DRY_RUN) {
      const url = await createMissingShowIssue(show, hash);
      created.push({ title: `Missing show: ${show.canonical_title}`, url, hash });
      console.log(`  Created: ${url}`);
    } else {
      created.push({ title: `Missing show: ${show.canonical_title}`, url: '(dry-run)', hash });
    }
    missingCreated++;
  }

  console.log(`\n=== Summary ===`);
  console.log(`Created: ${created.length} cards`);
  console.log(`Skipped: ${skipped.length} (${skipped.map(s => s.split(']')[0].slice(1)).join(', ')})`);

  if (created.length > 0) {
    console.log('\nCreated cards:');
    for (const { title, url } of created) console.log(`  - ${title}\n    ${url}`);
  }

  // Write to GitHub Actions step summary if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['## PostHog Friction Analyzer', ''];
    if (created.length > 0) {
      lines.push(`### Created ${created.length} Linear issue(s)`);
      for (const { title, url } of created) lines.push(`- [${title}](${url})`);
      lines.push('');
    }
    if (skipped.length > 0) {
      lines.push(`### Skipped ${skipped.length} issue(s)`);
      for (const s of skipped) lines.push(`- ${s}`);
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }

  if (created.length === 0 && !DRY_RUN) {
    console.log('No new issues to create — Linear is up to date.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
