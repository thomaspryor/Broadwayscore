#!/usr/bin/env node
/**
 * notion-brain.js — Direct Notion API CLI for Claude Code sessions.
 *
 * Replaces MCP Notion tools with direct API calls for the 4 operations
 * every session needs: create, update, search, list.
 *
 * Why: MCP adds ~2-3s latency per call, 14 tool schemas to context,
 * and disconnects randomly. This script is ~200ms per call via curl-equivalent.
 *
 * Usage:
 *   node scripts/notion-brain.js create "Card title" [--status "In progress"] [--priority "P1 Next"] [--category Product] [--type "New Feature"] [--tags scoring,scraping] --notes "## Problem\n...\n## Suggested approach\n...\n## Acceptance criteria\n..."
 *     (notes are REQUIRED and validated — sparse cards are rejected. Backlog cards must have Problem + Suggested approach + Acceptance criteria. Use --force "<reason ≥10 chars>" to bypass in the rare case you need a skeleton card.)
 *   node scripts/notion-brain.js update <page-id> [--status Done] [--outcome "## What changed\n..."] [--tags scoring] [--notes "..."] [--completed-date 2026-03-31] [--key-files "..."]
 *   node scripts/notion-brain.js search [--status "In progress"] [--priority "P0 Now"] [--text "keyword"]
 *   node scripts/notion-brain.js list [--priority "P0 Now,P1 Next"] [--status "Not started"] [--limit 10]
 *   node scripts/notion-brain.js get <page-id>
 *
 * Env: NOTION_API_KEY in .env or environment
 *
 * Output: JSON to stdout (parseable by Claude), logs to stderr.
 */

const { Client } = require('@notionhq/client');
const path = require('path');
const fs = require('fs');

// ── Load .env ───────────────────────────────────────────────────────────
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

const DATABASE_ID = 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6';

if (!process.env.NOTION_API_KEY) {
  console.error('Error: NOTION_API_KEY not set. Add it to .env or environment.');
  process.exit(1);
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ── Helpers ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._positional.push(argv[i]);
    }
  }
  return args;
}

function getTitleValue(prop) {
  if (!prop || prop.type !== 'title') return '';
  return prop.title.map(t => t.plain_text).join('');
}

function getRichTextValue(prop) {
  if (!prop || prop.type !== 'rich_text') return '';
  return prop.rich_text.map(t => t.plain_text).join('');
}

function getSelectValue(prop) {
  if (!prop || prop.type !== 'select' || !prop.select) return null;
  return prop.select.name;
}

function getMultiSelectValues(prop) {
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select.map(s => s.name);
}

function getStatusValue(prop) {
  if (!prop || prop.type !== 'status' || !prop.status) return null;
  return prop.status.name;
}

function getDateValue(prop) {
  if (!prop || prop.type !== 'date' || !prop.date) return null;
  return prop.date.start;
}

function formatCard(page) {
  const p = page.properties;
  return {
    id: page.id,
    url: page.url,
    name: getTitleValue(p.Name),
    status: getStatusValue(p.Status),
    priority: getSelectValue(p.Priority),
    category: getSelectValue(p.Category),
    type: getSelectValue(p.Type),
    tags: getMultiSelectValues(p.Tags),
    notes: getRichTextValue(p.Notes),
    outcome: getRichTextValue(p.Outcome),
    keyFiles: getRichTextValue(p['Key Files']),
    completedDate: getDateValue(p['Completed Date']),
  };
}

// Truncate to Notion's 2000-char rich_text limit
// ── Card quality validation ─────────────────────────────────────────────
// Added 2026-04-11 after audit showed 3 of 5 active cards had 0 notes.
// The rule in memory/feedback_notion_card_context.md was aspirational only.
// Now enforced at the CLI level so sparse cards physically cannot be created.

const CARD_TEMPLATE = `## Problem
[What's wrong or needed — specific, not a label. A new session reading this
should understand what needs to happen without needing to ask questions.]

## Evidence
[Show IDs, error counts, log snippets, URLs, command output — whatever proves
the problem exists or the work is real. If you're creating this card after
investigating something, paste the output you were looking at.]

## Suggested approach
[File paths to modify, commands to run, gotchas discovered during investigation.
If you already know how to fix it, write down the fix recipe. If you don't, say
what you'd try first.]

## What was already tried
[Anything the creating session attempted that didn't work — so the next session
doesn't repeat failed paths. Skip if N/A.]

## Acceptance criteria
[Specific way to verify the fix/feature is done. "Works" is not acceptance
criteria. "grep -c X returns 0" or "http://.../foo loads cleanly in mobile
Safari" is.]`;

function validateCardNotes({ notes, status, force, context }) {
  // Allow explicit bypass with justification — accepts only non-empty strings
  if (force && typeof force === 'string' && force.length >= 10) {
    return { ok: true, bypassed: force };
  }

  const notesStr = (notes || '').trim();
  const effectiveStatus = status || 'In progress';
  const isBacklog = effectiveStatus === 'Not started' || effectiveStatus === 'Paused';

  // Rule 1: cards cannot be completely empty
  if (notesStr.length === 0) {
    return {
      ok: false,
      reason: 'EMPTY_NOTES',
      message:
        `Card notes cannot be empty. At minimum, describe the Problem — what is this card actually about?\n\n` +
        `Pass --notes "## Problem\\n<description>..." or --force "<reason at least 10 chars>" to bypass.\n\n` +
        `Full template:\n${CARD_TEMPLATE}`,
    };
  }

  // Rule 2: in-progress/done cards need at least a Problem section (minimum viable context)
  if (!isBacklog) {
    if (notesStr.length < 80) {
      return {
        ok: false,
        reason: 'TOO_SHORT',
        message:
          `Card notes are too short (${notesStr.length} chars). Even in-progress cards need at least one paragraph describing what you're working on.\n\n` +
          `Write 2-3 sentences minimum. If the session is trivial, pass --force "<reason>".`,
      };
    }
    return { ok: true };
  }

  // Rule 3: backlog cards (Not started / Paused) must be self-contained handoffs
  // Require at least Problem + Suggested approach + Acceptance criteria
  const lower = notesStr.toLowerCase();
  const hasProblem = /(^|\n)##?\s*problem/i.test(notesStr) || (lower.includes('problem') && notesStr.length > 200);
  const hasSuggested = /(^|\n)##?\s*(suggested|approach|how to|proposed|plan)/i.test(notesStr);
  const hasAcceptance = /(^|\n)##?\s*(acceptance|verify|verification|done when|success|criteria)/i.test(notesStr);

  const missing = [];
  if (!hasProblem) missing.push('Problem');
  if (!hasSuggested) missing.push('Suggested approach');
  if (!hasAcceptance) missing.push('Acceptance criteria');

  if (missing.length > 0 || notesStr.length < 300) {
    return {
      ok: false,
      reason: 'INCOMPLETE_HANDOFF',
      message:
        `Backlog card (status="${effectiveStatus}") is not a self-contained handoff.\n` +
        `Missing required sections: ${missing.length ? missing.join(', ') : '(length check)'}\n` +
        `Notes length: ${notesStr.length} chars (need ≥300 for backlog cards)\n\n` +
        `A fresh session with zero context must be able to start work on this card in under 2 minutes. ` +
        `See memory/feedback_notion_card_context.md for the rule.\n\n` +
        `Template:\n${CARD_TEMPLATE}\n\n` +
        `To bypass (rare — e.g., session marker that will be filled in later), pass --force "<reason ≥10 chars>".`,
    };
  }

  return { ok: true };
}

// Notion rich_text property values have a hard total cap of ~2000 characters.
// Empirically verified 2026-04-11: splitting across multiple rich_text objects
// does NOT work — Notion accepts the API call but silently keeps only ~2000
// chars of the first object. For genuinely long content, use page children
// (block body) instead of the property — that's a backlog card, not shipped yet.
//
// When truncation happens here, we print a LOUD stderr warning so sessions
// know they're losing data instead of silently shipping incomplete cards.
function truncateRichText(text, limit = 2000, fieldName = 'content') {
  const s = String(text || '');
  if (s.length <= limit) return s;
  const lost = s.length - limit + 20;
  console.error(
    `⚠️  TRUNCATION WARNING: ${fieldName} was ${s.length} chars; Notion caps ` +
    `rich_text at ~${limit}. Truncated; ~${lost} chars LOST. ` +
    `To preserve full content, split across multiple fields or write to a file ` +
    `referenced in the card. (See backlog: "Overflow long notes/outcome to page children".)`
  );
  return s.slice(0, limit - 20) + '\n\n[...truncated]';
}

// ── Commands ────────────────────────────────────────────────────────────

async function createCard(args) {
  const title = args._positional[1];
  if (!title) {
    console.error('Usage: notion-brain create "Card title" [--status ...] [--priority ...] ...');
    process.exit(1);
  }

  // Enforce card context quality — reject sparse cards at the CLI level.
  // See memory/feedback_notion_card_context.md for the rule rationale.
  const validation = validateCardNotes({
    notes: args.notes,
    status: args.status,
    force: args.force,
    context: 'create',
  });
  if (!validation.ok) {
    console.error(`\n❌ REJECTED (${validation.reason}) — "${title}"\n`);
    console.error(validation.message);
    console.error('');
    process.exit(2);
  }
  if (validation.bypassed) {
    console.error(`⚠️  Card context validation bypassed: ${validation.bypassed}`);
  }

  const properties = {
    Name: { title: [{ text: { content: title } }] },
  };

  if (args.status) {
    properties.Status = { status: { name: args.status } };
  } else {
    properties.Status = { status: { name: 'In progress' } };
  }

  if (args.priority) {
    properties.Priority = { select: { name: args.priority } };
  }

  if (args.category) {
    properties.Category = { select: { name: args.category } };
  }

  if (args.type) {
    properties.Type = { select: { name: args.type } };
  }

  if (args.tags) {
    properties.Tags = {
      multi_select: args.tags.split(',').map(t => ({ name: t.trim() })),
    };
  }

  if (args.notes) {
    properties.Notes = {
      rich_text: [{ text: { content: truncateRichText(args.notes, 2000, 'notes') } }],
    };
  }

  const page = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: DATABASE_ID },
    properties,
  });

  const card = formatCard(page);
  console.log(JSON.stringify(card, null, 2));
  return card;
}

async function updateCard(args) {
  const pageId = args._positional[1];
  if (!pageId) {
    console.error('Usage: notion-brain update <page-id> [--status ...] [--outcome ...] ...');
    process.exit(1);
  }

  const properties = {};

  if (args.status) {
    properties.Status = { status: { name: args.status } };
  }

  if (args.priority) {
    properties.Priority = { select: { name: args.priority } };
  }

  if (args.category) {
    properties.Category = { select: { name: args.category } };
  }

  if (args.type) {
    properties.Type = { select: { name: args.type } };
  }

  if (args.tags) {
    properties.Tags = {
      multi_select: args.tags.split(',').map(t => ({ name: t.trim() })),
    };
  }

  if (args.notes) {
    properties.Notes = {
      rich_text: [{ text: { content: truncateRichText(args.notes, 2000, 'notes') } }],
    };
  }

  if (args.outcome) {
    // Read existing outcome first, prepend new content
    let outcomeText = args.outcome;

    if (args['append-outcome'] !== undefined || !args['overwrite-outcome']) {
      try {
        const existing = await notion.pages.retrieve({ page_id: pageId });
        const existingOutcome = getRichTextValue(existing.properties.Outcome);
        if (existingOutcome) {
          outcomeText = outcomeText + '\n\n---\n\n' + existingOutcome;
        }
      } catch {
        // If we can't read existing, just use new content
      }
    }

    properties.Outcome = {
      rich_text: [{ text: { content: truncateRichText(outcomeText, 2000, 'outcome') } }],
    };
  }

  if (args['key-files']) {
    properties['Key Files'] = {
      rich_text: [{ text: { content: truncateRichText(args['key-files'], 2000, 'key-files') } }],
    };
  }

  if (args['completed-date']) {
    properties['Completed Date'] = {
      date: { start: args['completed-date'] },
    };
  }

  if (Object.keys(properties).length === 0) {
    console.error('No properties to update. Pass --status, --outcome, --tags, etc.');
    process.exit(1);
  }

  const page = await notion.pages.update({
    page_id: pageId,
    properties,
  });

  const card = formatCard(page);
  console.log(JSON.stringify(card, null, 2));
  return card;
}

async function searchCards(args) {
  const filters = [];

  // Treat the positional arg as a text query if no --text was provided.
  // Previously `notion-brain search "Hook:"` silently returned all cards
  // because the positional argument was ignored. Now it's auto-mapped to
  // --text. Explicit --text still wins if both are given.
  if (!args.text && args._positional[1]) {
    args.text = args._positional[1];
  }

  if (args.status) {
    filters.push({
      property: 'Status',
      status: { equals: args.status },
    });
  }

  if (args.priority) {
    filters.push({
      property: 'Priority',
      select: { equals: args.priority },
    });
  }

  const filter = filters.length === 1
    ? filters[0]
    : filters.length > 1
      ? { and: filters }
      : undefined;

  const response = await notion.dataSources.query({
    data_source_id: DATABASE_ID,
    filter,
    sorts: [{ property: 'Priority', direction: 'ascending' }],
  });

  let results = response.results.map(formatCard);

  // Client-side text filter
  if (args.text) {
    const needle = args.text.toLowerCase();
    results = results.filter(c =>
      c.name.toLowerCase().includes(needle) ||
      c.notes.toLowerCase().includes(needle)
    );
  }

  const limit = parseInt(args.limit) || 20;
  results = results.slice(0, limit);

  console.log(JSON.stringify(results, null, 2));
  return results;
}

async function listCards(args) {
  const filters = [];

  if (args.status) {
    const statuses = args.status.split(',').map(s => s.trim());
    if (statuses.length === 1) {
      filters.push({ property: 'Status', status: { equals: statuses[0] } });
    } else {
      filters.push({
        or: statuses.map(s => ({ property: 'Status', status: { equals: s } })),
      });
    }
  }

  if (args.priority) {
    const priorities = args.priority.split(',').map(p => p.trim());
    if (priorities.length === 1) {
      filters.push({ property: 'Priority', select: { equals: priorities[0] } });
    } else {
      filters.push({
        or: priorities.map(p => ({ property: 'Priority', select: { equals: p } })),
      });
    }
  }

  const filter = filters.length === 1
    ? filters[0]
    : filters.length > 1
      ? { and: filters }
      : undefined;

  const response = await notion.dataSources.query({
    data_source_id: DATABASE_ID,
    filter,
    sorts: [{ property: 'Priority', direction: 'ascending' }],
  });

  let results = response.results.map(formatCard);
  const limit = parseInt(args.limit) || 20;
  results = results.slice(0, limit);

  // Compact table output for quick scanning
  const table = results.map(c => ({
    name: c.name,
    status: c.status,
    priority: c.priority,
    tags: c.tags.join(', '),
    id: c.id,
  }));

  console.log(JSON.stringify(table, null, 2));
  return table;
}

async function getCard(args) {
  const pageId = args._positional[1];
  if (!pageId) {
    console.error('Usage: notion-brain get <page-id>');
    process.exit(1);
  }

  const page = await notion.pages.retrieve({ page_id: pageId });
  const card = formatCard(page);
  console.log(JSON.stringify(card, null, 2));
  return card;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._positional[0];

  if (!command) {
    console.error(`notion-brain — Direct Notion API for Claude Code sessions

Commands:
  create "Title"       Create a new card (default: In progress)
  update <id>          Update card properties
  search               Search cards by status/priority/text
  list                 List cards (compact table)
  get <id>             Get full card details

Options (create/update):
  --status "In progress"    Status: Not started, In progress, Paused, Done
  --priority "P1 Next"      Priority: P0 Now, P1 Next, P2 Later
  --category Product        Category: Product, Marketing, Partnerships, Admin
  --type "New Feature"      Type: New Feature, Fix, Data Quality, Market Expansion
  --tags scoring,scraping   Tags (comma-separated)
  --notes "## Problem..."   Notes field — REQUIRED on create, validated for quality
  --outcome "## Summary"    Outcome (prepends to existing by default)
  --key-files "file.js"     Key Files field
  --completed-date DATE     Completed Date (YYYY-MM-DD)
  --overwrite-outcome       Overwrite outcome instead of prepending
  --force "<reason>"        Bypass notes validation (reason must be ≥10 chars, e.g. "session marker, will fill on wrap-up")

Notes quality enforcement (2026-04-11):
  - In-progress cards need ≥80 chars of notes
  - Backlog cards (Not started, Paused) need ≥300 chars AND sections for Problem,
    Suggested approach, and Acceptance criteria
  - Sparse cards are rejected with exit 2. See memory/feedback_notion_card_context.md

Options (search/list):
  --status "In progress"    Filter by status
  --priority "P0 Now"       Filter by priority (comma-separated for list)
  --text "keyword"          Text search in name/notes (search only)
  --limit 10                Max results (default: 20)`);
    process.exit(1);
  }

  try {
    switch (command) {
      case 'create': await createCard(args); break;
      case 'update': await updateCard(args); break;
      case 'search': await searchCards(args); break;
      case 'list':   await listCards(args); break;
      case 'get':    await getCard(args); break;
      default:
        console.error(`Unknown command: ${command}. Run without args for help.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (err.body) console.error(JSON.stringify(err.body, null, 2));
    process.exit(1);
  }
}

main();
