#!/usr/bin/env node
/**
 * Notion Action Queue Poller
 *
 * Polls the BWSC Roadmap database for cards with an Action set
 * (Investigate / Plan / Start). For each card found, spawns a
 * Claude CLI session with the card context as a prompt.
 *
 * After Claude finishes:
 *   1. Appends findings to the card's Outcome field
 *   2. Adds a Notion comment (triggers push notification)
 *   3. Clears the Action property LAST (prevents orphaned cards)
 *
 * Usage:
 *   node scripts/notion-action-poll.js [--dry-run]
 *
 * Env: NOTION_API_KEY (Internal Integration token with access to BWSC workspace)
 */

const { Client } = require('@notionhq/client');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env from project root (manual parse to avoid dotenv dependency)
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

const DRY_RUN = process.argv.includes('--dry-run');
const REPO_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(require('os').homedir(), 'Library', 'Logs');
const DATABASE_ID = 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function getRichTextValue(prop) {
  if (!prop || prop.type !== 'rich_text') return '';
  return prop.rich_text.map(t => t.plain_text).join('');
}

function getTitleValue(prop) {
  if (!prop || prop.type !== 'title') return '';
  return prop.title.map(t => t.plain_text).join('');
}

function getSelectValue(prop) {
  if (!prop || prop.type !== 'select' || !prop.select) return null;
  return prop.select.name;
}

function getMultiSelectValues(prop) {
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select.map(s => s.name);
}

// ── Query for actionable cards ───────────────────────────────────────

async function getActionableCards() {
  const response = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: {
      property: 'Action',
      select: { is_not_empty: true },
    },
  });

  return response.results.map(page => ({
    id: page.id,
    url: page.url,
    name: getTitleValue(page.properties.Name),
    action: getSelectValue(page.properties.Action),
    status: page.properties.Status?.status?.name || 'Unknown',
    priority: getSelectValue(page.properties.Priority),
    category: getSelectValue(page.properties.Category),
    tags: getMultiSelectValues(page.properties.Tags),
    notes: getRichTextValue(page.properties.Notes),
    outcome: getRichTextValue(page.properties.Outcome),
  }));
}

// ── Build Claude prompt for a card ───────────────────────────────────

function buildPrompt(card) {
  const actionInstructions = {
    Investigate: `INVESTIGATE this card. Search the codebase, git history, related files, and existing patterns. Write your findings as a structured summary. Do NOT make any code changes.`,
    Plan: `PLAN the implementation for this card. First investigate (codebase, git history, patterns), then write a detailed implementation plan with specific files, functions, and steps. Do NOT make any code changes.`,
    Start: `IMPLEMENT this card. First investigate and plan, then actually build it. Use a worktree for any src/ changes. Push code and trigger deploys as needed. This is a full implementation session.`,
  };

  const instruction = actionInstructions[card.action] || actionInstructions.Investigate;

  return `You are an automated Claude session triggered by the Notion Action Queue.

## Card Details
- **Name:** ${card.name}
- **Action:** ${card.action}
- **Status:** ${card.status}
- **Priority:** ${card.priority || 'None'}
- **Category:** ${card.category || 'None'}
- **Tags:** ${card.tags.join(', ') || 'None'}
- **Notion URL:** ${card.url}

## Notes
${card.notes || '(none)'}

## Existing Outcome
${card.outcome || '(none)'}

## Instructions
${instruction}

When done, output your findings in this exact format between markers:

===ACTION_RESULT_START===
[Your structured findings/plan/implementation summary here]
===ACTION_RESULT_END===

Be thorough but concise. Focus on actionable information.`;
}

// ── Run Claude CLI ───────────────────────────────────────────────────

function runClaude(prompt, card) {
  const logFile = path.join(LOG_DIR, `action-dispatcher-${card.id.slice(0, 8)}.log`);
  log(`Spawning Claude for "${card.name}" (${card.action}). Log: ${logFile}`);

  // Write prompt to temp file to avoid shell escaping issues
  const tmpPrompt = path.join(require('os').tmpdir(), `action-prompt-${card.id.slice(0, 8)}.txt`);

  try {
    fs.writeFileSync(tmpPrompt, prompt);

    // Pipe prompt via stdin; --print for non-interactive, --verbose for logging
    // --dangerously-skip-permissions so automated session can operate freely
    const result = execSync(
      `cat "${tmpPrompt}" | claude --print --dangerously-skip-permissions --verbose`,
      {
        cwd: REPO_DIR,
        timeout: 30 * 60 * 1000, // 30 min max
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: require('os').homedir(),
          PATH: process.env.PATH,
        },
      }
    );

    // Write full output to log
    fs.writeFileSync(logFile, result);

    // Extract result between markers
    const match = result.match(/===ACTION_RESULT_START===([\s\S]*?)===ACTION_RESULT_END===/);
    return match ? match[1].trim() : result.slice(-3000); // fallback: last 3000 chars
  } catch (err) {
    const errMsg = `Claude session failed: ${err.message}`;
    log(errMsg);
    fs.appendFileSync(logFile, `\n\nERROR: ${errMsg}`);
    return `[Automated session error] ${err.message.slice(0, 500)}`;
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch {}
  }
}

// ── Update card after processing ─────────────────────────────────────

async function updateCardOutcome(card, result) {
  const date = new Date().toISOString().slice(0, 10);
  const header = `## ${date} — Automated ${card.action}`;
  const newOutcome = card.outcome
    ? `${header}\n\n${result}\n\n---\n\n${card.outcome}`
    : `${header}\n\n${result}`;

  // 1. Update Outcome (prepend new result)
  await notion.pages.update({
    page_id: card.id,
    properties: {
      Outcome: {
        rich_text: [{ type: 'text', text: { content: newOutcome.slice(0, 2000) } }],
      },
    },
  });
  log(`Updated Outcome for "${card.name}"`);
}

async function addComment(card, result) {
  // 2. Add comment (triggers push notification)
  const summary = result.length > 300 ? result.slice(0, 297) + '...' : result;
  await notion.comments.create({
    parent: { page_id: card.id },
    rich_text: [
      {
        type: 'text',
        text: {
          content: `Action Dispatcher completed "${card.action}" for this card.\n\n${summary}`,
        },
      },
    ],
  });
  log(`Added comment to "${card.name}"`);
}

async function clearAction(card) {
  // 3. Clear Action LAST (prevents orphaned cards)
  await notion.pages.update({
    page_id: card.id,
    properties: {
      Action: { select: null },
    },
  });
  log(`Cleared Action for "${card.name}"`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.NOTION_API_KEY) {
    console.error('NOTION_API_KEY not set in .env');
    process.exit(1);
  }

  log('Polling Notion Action Queue...');
  const cards = await getActionableCards();

  if (cards.length === 0) {
    log('No actionable cards. Exiting.');
    return;
  }

  log(`Found ${cards.length} actionable card(s):`);
  for (const card of cards) {
    log(`  - "${card.name}" [${card.action}] (${card.priority || 'no priority'})`);
  }

  for (const card of cards) {
    log(`\n${'='.repeat(60)}`);
    log(`Processing: "${card.name}" [${card.action}]`);
    log(`${'='.repeat(60)}`);

    if (DRY_RUN) {
      log('[DRY RUN] Would spawn Claude with prompt:');
      log(buildPrompt(card).slice(0, 500) + '...');
      continue;
    }

    const prompt = buildPrompt(card);
    const result = runClaude(prompt, card);

    try {
      await updateCardOutcome(card, result);
      await addComment(card, result);
      await clearAction(card);
      log(`Done processing "${card.name}"`);
    } catch (err) {
      log(`ERROR updating Notion for "${card.name}": ${err.message}`);
      // Don't clear Action on error — card stays in queue for retry
    }
  }

  log('\nAction Queue processing complete.');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
