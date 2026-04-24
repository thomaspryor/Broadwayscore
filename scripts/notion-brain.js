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

// ── Page-body overflow ──────────────────────────────────────────────────
// Notion's rich_text property cap is ~2000 chars and cannot be bypassed via
// multiple rich_text objects (Notion silently drops all but the first ~2000
// chars). To preserve long content, we store a preview + marker in the
// property and write the full text to the page body (block children), which
// has no total cap. Each field gets its own auto-managed heading section
// keyed by `[auto:<field>] full content`; rewrites are idempotent (find and
// delete the old section, append the new one).

const PROP_CHUNK = 1800;       // safe under Notion's 2000-char property cap
const BODY_CHUNK = 1900;       // safe under Notion's 2000-char rich_text object cap
const OVERFLOW_NOTE = '\n\n[Full content in page body below ↓]';
const OVERFLOW_MARKER_SUBSTR = '[Full content in page body below';
const BODY_HEADING_PREFIX = '[auto:';
const BODY_HEADING_SUFFIX = '] full content';

function bodyHeadingText(field) {
  return `${BODY_HEADING_PREFIX}${field}${BODY_HEADING_SUFFIX}`;
}

function getHeadingText(block) {
  if (!block || block.type !== 'heading_2') return null;
  const rt = block.heading_2?.rich_text || [];
  return rt.map(t => t.plain_text).join('');
}

function isAutoHeading(block) {
  const t = getHeadingText(block);
  return !!(t && t.startsWith(BODY_HEADING_PREFIX) && t.endsWith(BODY_HEADING_SUFFIX));
}

// Break text into chunks <= size, preferring newline boundaries.
function chunkText(text, size) {
  const chunks = [];
  let remaining = String(text || '');
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;  // no good break — hard-cut
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.length || chunks.length === 0) chunks.push(remaining);
  return chunks;
}

// Build a rich_text property value for a field. If content is short, returns
// the property with the full value and bodyText=null. If long, returns a
// preview-plus-marker property value and the full text as bodyText for the
// caller to write via writeBodySection().
function buildRichTextWithOverflow(text) {
  const s = String(text || '');
  if (s.length <= PROP_CHUNK) {
    return {
      propertyValue: { rich_text: [{ text: { content: s } }] },
      bodyText: null,
    };
  }
  const maxPreview = PROP_CHUNK - OVERFLOW_NOTE.length - 10;
  let cut = s.lastIndexOf('\n\n', maxPreview);
  if (cut < maxPreview * 0.5) cut = s.lastIndexOf('\n', maxPreview);
  if (cut < maxPreview * 0.5) cut = maxPreview;
  const preview = s.slice(0, cut) + OVERFLOW_NOTE;
  return {
    propertyValue: { rich_text: [{ text: { content: preview } }] },
    bodyText: s,
  };
}

async function listAllChildren(pageId) {
  const all = [];
  let cursor;
  do {
    const resp = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    all.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return all;
}

// Write or replace the `[auto:<field>] full content` section in the page body.
// Idempotent: if a section for this field already exists, delete it and every
// block up to (but not including) the next auto heading, then append the new
// heading + paragraph chunks at the end.
async function writeBodySection(pageId, field, text, opts = {}) {
  const targetHeading = bodyHeadingText(field);
  const children = opts.children || await listAllChildren(pageId);

  const startIdx = children.findIndex(b => getHeadingText(b) === targetHeading);
  if (startIdx !== -1) {
    let endIdx = children.length;
    for (let i = startIdx + 1; i < children.length; i++) {
      if (isAutoHeading(children[i])) { endIdx = i; break; }
    }
    for (const block of children.slice(startIdx, endIdx)) {
      try {
        await notion.blocks.delete({ block_id: block.id });
      } catch (err) {
        console.error(`Warning: failed to delete block ${block.id}: ${err.message}`);
      }
    }
  }

  const blocks = [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: targetHeading } }],
      },
    },
  ];
  for (const chunk of chunkText(text, BODY_CHUNK)) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: chunk } }],
      },
    });
  }

  // Notion caps append at 100 blocks per call.
  const BATCH = 100;
  for (let i = 0; i < blocks.length; i += BATCH) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + BATCH),
    });
  }
}

// Read a field's full content. If the property value contains the overflow
// marker, fetch the page body and stitch together the matching auto section.
// `propertyText` is the already-joined rich_text string for the field.
async function readFieldWithOverflow(pageId, propertyText, field, opts = {}) {
  const s = String(propertyText || '');
  if (!s.includes(OVERFLOW_MARKER_SUBSTR)) return s;
  const children = opts.children || await listAllChildren(pageId);
  const targetHeading = bodyHeadingText(field);
  const startIdx = children.findIndex(b => getHeadingText(b) === targetHeading);
  if (startIdx === -1) return s;
  const parts = [];
  for (let i = startIdx + 1; i < children.length; i++) {
    const b = children[i];
    if (isAutoHeading(b)) break;
    if (b.type === 'paragraph') {
      parts.push((b.paragraph.rich_text || []).map(t => t.plain_text).join(''));
    }
  }
  return parts.length ? parts.join('\n') : s;
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

  // Collect per-field overflow so we can write body sections after create.
  const overflow = {};
  if (args.notes) {
    const { propertyValue, bodyText } = buildRichTextWithOverflow(args.notes);
    properties.Notes = propertyValue;
    if (bodyText) overflow.notes = bodyText;
  }

  const page = await notion.pages.create({
    parent: { type: 'data_source_id', data_source_id: DATABASE_ID },
    properties,
  });

  for (const [field, text] of Object.entries(overflow)) {
    await writeBodySection(page.id, field, text);
  }

  const card = formatCard(page);
  // If anything overflowed, expand the in-memory card so stdout shows the
  // full value (not the property preview).
  for (const field of Object.keys(overflow)) {
    card[field] = overflow[field];
  }

  console.log(JSON.stringify(card, null, 2));

  // Print a tagged marker line AFTER the JSON so the PostToolUse verify hook
  // can reliably extract the card ID even when stdout is piped through
  // `| tail`, `| jq`, etc. The verify hook greps for __NOTION_CARD_ID__=
  // instead of blindly matching any UUID in the output. Without this, piping
  // truncates the JSON and the UUID-fallback grep picks up session IDs,
  // debug-log UUIDs, or other non-card UUIDs mixed into the combined stdout.
  // Discovered 2026-04-15: the old approach was writing a sentinel keyed by
  // CLAUDE_SESSION_ID env var, which is a DIFFERENT UUID from the hook
  // stdin's session_id — so the sentinel existed but under the wrong name.
  console.error(`__NOTION_CARD_ID__=${page.id}`);

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

  // Collect per-field overflow so we can write body sections after update.
  const overflow = {};

  if (args.notes) {
    const { propertyValue, bodyText } = buildRichTextWithOverflow(args.notes);
    properties.Notes = propertyValue;
    if (bodyText) overflow.notes = bodyText;
  }

  if (args.outcome) {
    // Read existing outcome first, prepend new content. Use the full value
    // (including any page-body overflow) so prepends don't clobber history.
    let outcomeText = args.outcome;

    if (args['append-outcome'] !== undefined || !args['overwrite-outcome']) {
      try {
        const existing = await notion.pages.retrieve({ page_id: pageId });
        const existingPropText = getRichTextValue(existing.properties.Outcome);
        const existingOutcome = await readFieldWithOverflow(
          pageId,
          existingPropText,
          'outcome'
        );
        if (existingOutcome) {
          outcomeText = outcomeText + '\n\n---\n\n' + existingOutcome;
        }
      } catch {
        // If we can't read existing, just use new content
      }
    }

    const { propertyValue, bodyText } = buildRichTextWithOverflow(outcomeText);
    properties.Outcome = propertyValue;
    if (bodyText) overflow.outcome = bodyText;
  }

  if (args['key-files']) {
    const { propertyValue, bodyText } = buildRichTextWithOverflow(args['key-files']);
    properties['Key Files'] = propertyValue;
    if (bodyText) overflow['key-files'] = bodyText;
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

  for (const [field, text] of Object.entries(overflow)) {
    await writeBodySection(page.id, field, text);
  }

  const card = formatCard(page);
  // Expand the in-memory card so stdout shows the full value for any field
  // that overflowed (keyed to the formatCard field names).
  const fieldToCardKey = { notes: 'notes', outcome: 'outcome', 'key-files': 'keyFiles' };
  for (const [field, text] of Object.entries(overflow)) {
    card[fieldToCardKey[field]] = text;
  }
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

  // Alias --query to --text. A prior session's notes claimed --query works;
  // it didn't (the flag was silently ignored), and sessions searching for
  // real cards would get generic priority-sorted results back and conclude
  // "no such card exists". Treat --query as synonymous with --text so that
  // advice at least produces correct behavior now.
  if (!args.text && args.query) {
    args.text = args.query;
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

  // Pre-pagination fix, notion-brain did a single un-paginated call and relied
  // on a client-side text filter. Notion's default page size is 100, so any
  // card past the first 100 priority-asc results was invisible to `--text`.
  // A P1-Next-Not-started card was missed this way on 2026-04-24 because the
  // first 100 were all P0-Now. DB size that day was 1350 cards.
  //
  // Two-tier fix:
  //   (1) When --text is given, AND a server-side Name `contains` filter with
  //       status/priority filters. One round-trip covers the common case
  //       (finding a card by its title) regardless of DB size.
  //   (2) If (1) returns no hits, fall back to a paginated scan so we still
  //       catch text matches that live only in the notes body. Capped to
  //       prevent runaway calls — bump PAGE_CAP if the DB grows substantially.
  const PAGE_CAP = 20;
  const needle = args.text ? args.text.toLowerCase() : null;

  let allResults = [];

  if (needle) {
    // Tier 1: server-side title filter. The base filter (status/priority)
    // is AND'd with a name.contains so Notion returns only matching cards.
    const titleFilter = { property: 'Name', title: { contains: args.text } };
    const combined = filter ? { and: [filter, titleFilter] } : titleFilter;
    const titleResponse = await notion.dataSources.query({
      data_source_id: DATABASE_ID,
      filter: combined,
      sorts: [{ property: 'Priority', direction: 'ascending' }],
    });
    allResults = titleResponse.results.map(formatCard);
  }

  if (!needle || allResults.length === 0) {
    // Tier 2 (or non-text-filter path): paginate the base filter and let
    // the optional client-side needle match against notes as well.
    let cursor;
    let pages = 0;
    allResults = [];
    do {
      const response = await notion.dataSources.query({
        data_source_id: DATABASE_ID,
        filter,
        sorts: [{ property: 'Priority', direction: 'ascending' }],
        start_cursor: cursor,
      });
      allResults = allResults.concat(response.results.map(formatCard));
      cursor = response.has_more ? response.next_cursor : null;
      pages++;
      if (!needle) break;
      if (pages >= PAGE_CAP) {
        console.error(`[notion-brain] warning: hit ${PAGE_CAP}-page cap (${allResults.length} cards scanned); bump PAGE_CAP if the DB has grown`);
        break;
      }
    } while (cursor);
  }

  let results = allResults;
  if (needle) {
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

  // If any of the long-text fields contain the overflow marker, fetch the
  // page body once and stitch the full content back in.
  const needsBody =
    (card.notes && card.notes.includes(OVERFLOW_MARKER_SUBSTR)) ||
    (card.outcome && card.outcome.includes(OVERFLOW_MARKER_SUBSTR)) ||
    (card.keyFiles && card.keyFiles.includes(OVERFLOW_MARKER_SUBSTR));

  if (needsBody) {
    const children = await listAllChildren(pageId);
    card.notes = await readFieldWithOverflow(pageId, card.notes, 'notes', { children });
    card.outcome = await readFieldWithOverflow(pageId, card.outcome, 'outcome', { children });
    card.keyFiles = await readFieldWithOverflow(pageId, card.keyFiles, 'key-files', { children });
  }

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
  --text "keyword"          Text search in name/notes (search only).
                            Aliased as --query. Paginates when set.
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
