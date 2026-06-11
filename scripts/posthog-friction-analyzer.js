#!/usr/bin/env node
/**
 * posthog-friction-analyzer.js — PostHog → Claude → Notion friction pipeline.
 *
 * Reads last-7-day PostHog friction signals, sends to Claude, creates Notion cards
 * for novel issues. Deduplicates by content hash stored as card tag (fhash:XXXXXXXX).
 *
 * Env: POSTHOG_PERSONAL_API_KEY, ANTHROPIC_API_KEY, NOTION_API_KEY
 * Usage:
 *   node scripts/posthog-friction-analyzer.js            # live run
 *   node scripts/posthog-friction-analyzer.js --dry-run  # print proposed cards, no writes
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const Anthropic = require('@anthropic-ai/sdk');
const { Client: NotionClient } = require('@notionhq/client');
const { CLAUDE_SONNET } = require('./lib/models');
const {
  authCheck, tracked,
  getRageClickDetails, getGateFunnel, getBtcFunnel,
  getTicketClicks, getPromoClicks, getSearchStats, getTrafficSummary,
} = require('./lib/posthog-query');

const DRY_RUN = process.argv.includes('--dry-run');
const CARDS_PER_RUN_CAP = 5;
const NOTION_DATABASE_ID = 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6';
const TOKEN_BUDGET_CHARS = 3000;

// ── Notion helpers ───────────────────────────────────────────────────────

async function getExistingFrictionCards(notion) {
  const cards = [];
  let cursor;
  do {
    const res = await notion.dataSources.query({
      data_source_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 50,
      filter: {
        and: [
          { property: 'Tags', multi_select: { contains: 'friction' } },
          { property: 'Status', status: { does_not_equal: 'Done' } },
        ],
      },
    });
    cards.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return cards;
}

function extractHashes(cards) {
  const hashes = new Set();
  for (const card of cards) {
    const tags = card.properties?.Tags?.multi_select || [];
    for (const tag of tags) {
      if (tag.name.startsWith('fhash:')) hashes.add(tag.name.slice(6));
    }
  }
  return hashes;
}

function extractTitles(cards) {
  // Only include analyzer-generated cards (identified by fhash: tag).
  // Manually created cards (session tracking, project work) also get the 'friction'
  // tag and would confuse Claude into thinking product friction is already covered.
  return cards
    .filter(c => (c.properties?.Tags?.multi_select || []).some(t => t.name.startsWith('fhash:')))
    .map(c => c.properties?.Name?.title?.[0]?.plain_text)
    .filter(Boolean);
}

function computeHash(evidenceKey) {
  return crypto.createHash('sha256').update(evidenceKey).digest('hex').slice(0, 8);
}

async function createNotionCard(notion, issue, hash) {
  const tags = ['friction', `fhash:${hash}`];
  if (issue.type) tags.push(issue.type.replace(/_/g, '-'));

  const notes = [
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

  // Priority mapping to Notion select values
  const priorityMap = {
    'P0 Now': 'P0 Now',
    'P1 Next': 'P1 Next',
    'P2 Later': 'P2 Later',
    'P3 Backlog': 'P3 Backlog',
  };
  const priority = priorityMap[issue.priority] || 'P2 Later';

  const page = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: NOTION_DATABASE_ID },
    properties: {
      Name: { title: [{ text: { content: issue.title } }] },
      Status: { status: { name: 'Not started' } },
      Priority: { select: { name: priority } },
      Category: { select: { name: 'Product' } },
      Tags: { multi_select: tags.map(t => ({ name: t })) },
      Notes: { rich_text: [{ text: { content: notes.slice(0, 2000) } }] },
    },
  });
  return page.url;
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

function buildContext(data) {
  const { traffic, rageClicks, gateFunnel, btcFunnel, ticketClicks, promoClicks, searchStats } = data;

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
  const issues = toolUse.input.issues || [];
  console.log(`Claude tool call returned ${issues.length} issues (stop_reason: ${response.stop_reason})`);
  return issues;
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const missing = ['POSTHOG_PERSONAL_API_KEY', 'ANTHROPIC_API_KEY', 'NOTION_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (DRY_RUN) console.log('[dry-run] No Notion cards will be created.\n');

  await authCheck();
  console.log('PostHog auth OK');

  console.log('Querying PostHog...');
  const [traffic, rageClicks, gateFunnel, btcFunnel, ticketClicks, promoClicks, searchStats] =
    await Promise.all([
      tracked('Traffic', getTrafficSummary),
      tracked('Rage clicks', getRageClickDetails),
      tracked('Gate funnel', getGateFunnel),
      tracked('BTC funnel', getBtcFunnel),
      tracked('Ticket clicks', getTicketClicks),
      tracked('Promo clicks', getPromoClicks),
      tracked('Search stats', getSearchStats),
    ]);

  const context = buildContext({ traffic, rageClicks, gateFunnel, btcFunnel, ticketClicks, promoClicks, searchStats });

  console.log('\n--- PostHog context sent to Claude ---');
  console.log(context);
  console.log('--------------------------------------\n');

  // Fetch existing open friction cards for context + dedup
  const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
  console.log('Fetching existing friction cards from Notion...');
  const existingCards = await getExistingFrictionCards(notion);
  const existingHashes = extractHashes(existingCards);
  const existingTitles = extractTitles(existingCards);
  console.log(`Found ${existingCards.length} existing open friction cards`);

  console.log('Calling Claude for friction analysis...');
  const issues = await analyzeWithClaude(context, existingTitles);
  console.log(`Claude identified ${issues.length} issues\n`);

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
      const url = await createNotionCard(notion, issue, hash);
      created.push({ title: issue.title, url, hash });
      console.log(`  Created: ${url}`);
    } else {
      created.push({ title: issue.title, url: '(dry-run)', hash });
    }
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
      lines.push(`### Created ${created.length} Notion card(s)`);
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
    console.log('No new issues to create — Notion is up to date.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
