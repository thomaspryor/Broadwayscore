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
 *   node scripts/notion-brain.js create "Card title" [--status "In progress"] [--priority "P1 Next"] [--category Product] [--type "New Feature"] [--tags scoring,scraping] [--action Investigate] --notes "## Problem\n...\n## Suggested approach\n...\n## Acceptance criteria\n..."
 *     (--action sets the Action Queue property — Investigate/Plan/Review/Start/Fix/Plan+Review — so notion-action-poll.js dispatches it automatically.)
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

const { BRAIN_DATABASE_ID: DATABASE_ID } = require('./lib/notion-constants');

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
      const raw = argv[i].slice(2);
      const eq = raw.indexOf('=');
      if (eq !== -1) {
        args[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[raw] = next;
        i++;
      } else {
        args[raw] = true;
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

// Canonical Notion Priority select options. Bare "P0"/"P1"/"P2" silently create
// a NEW select option that notion-tasks-sync's "P0 Now,P1 Next" filter ignores
// (2026-07-25: a P1 card never mirrored to the task list, so auto-dispatch
// missed it). Normalize aliases everywhere priority is written or filtered.
function normalizePriority(value) {
  const ALIASES = { p0: 'P0 Now', p1: 'P1 Next', p2: 'P2 Later' };
  if (!value) return value;
  return value.split(',').map(v => ALIASES[v.trim().toLowerCase()] || v.trim()).join(',');
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

// Local-timezone YYYY-MM-DD. Notion `date` properties without a time are
// timezone-agnostic strings — "today" means the user's local today, not UTC.
function todayLocal(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Accept YYYY-MM-DD or keywords: today, tomorrow, +Nd (N days from today).
function normalizeDueDate(raw) {
  const v = String(raw).trim();
  if (v === 'today') return todayLocal(0);
  if (v === 'tomorrow') return todayLocal(1);
  const rel = v.match(/^\+(\d+)d$/);
  if (rel) return todayLocal(parseInt(rel[1], 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(`Invalid --due-date "${raw}" — use YYYY-MM-DD, today, tomorrow, or +Nd`);
  }
  return v;
}

// Build a Notion filter from --due keyword/date. Returns null for no filter.
function buildDueFilter(raw) {
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  const today = todayLocal(0);
  if (v === 'today') {
    return { property: 'Due Date', date: { equals: today } };
  }
  if (v === 'overdue') {
    return {
      and: [
        { property: 'Due Date', date: { before: today } },
        { property: 'Status', status: { does_not_equal: 'Done' } },
      ],
    };
  }
  if (v === 'this-week' || v === 'week') {
    return {
      and: [
        { property: 'Due Date', date: { on_or_after: today } },
        { property: 'Due Date', date: { on_or_before: todayLocal(7) } },
      ],
    };
  }
  if (v === 'upcoming') {
    return { property: 'Due Date', date: { on_or_after: today } };
  }
  if (v === 'none' || v === 'empty') {
    return { property: 'Due Date', date: { is_empty: true } };
  }
  if (v === 'any' || v === 'set') {
    return { property: 'Due Date', date: { is_not_empty: true } };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return { property: 'Due Date', date: { equals: v } };
  }
  throw new Error(`Invalid --due "${raw}" — use today, tomorrow, overdue, this-week, upcoming, none, any, or YYYY-MM-DD`);
}

function formatCard(page) {
  const p = page.properties;
  const lastEditedAt = page.last_edited_time || null;
  const ageDays = lastEditedAt
    ? Math.round((Date.now() - new Date(lastEditedAt).getTime()) / 86400000 * 10) / 10
    : null;
  return {
    id: page.id,
    url: page.url,
    name: getTitleValue(p.Name),
    status: getStatusValue(p.Status),
    priority: getSelectValue(p.Priority),
    category: getSelectValue(p.Category),
    type: getSelectValue(p.Type),
    auto: getSelectValue(p.Auto),
    tags: getMultiSelectValues(p.Tags),
    notes: getRichTextValue(p.Notes),
    outcome: getRichTextValue(p.Outcome),
    keyFiles: getRichTextValue(p['Key Files']),
    completedDate: getDateValue(p['Completed Date']),
    dueDate: getDateValue(p['Due Date']),
    createdAt: page.created_time || null,
    lastEditedAt,
    ageDays,
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
    // In-progress cards get the arming warning too (Codex P1 2026-07-26:
    // create defaults to In progress, so the warning previously never fired
    // on the most common create path — cards then hard-failed at dispatch
    // with no earlier signal).
    return { ok: true, warning: armingWarning(notesStr) };
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

  return { ok: true, warning: armingWarning(notesStr) };
}

// The acceptance criteria must ARM the verification chain. bsc-next captures
// ONE backticked command at dispatch (scripts/lib/autonomous-verify-cmd.js)
// and the nightly acceptance recheck re-runs it after the card is marked Done
// — prose criteria dispatch unarmed, "Done" stays an unverifiable claim
// (owner escalation 2026-07-26: every launch in the dispatch ledger had
// verifyCmd: null). WARN, don't reject: automated card creators
// (owner-alert-router.js, ux-walkthrough.mjs, notify-pending-commercial-
// notion.js) file cards with generated prose — a hard reject here would
// silently break the alert→card chain (#374's canary class). The HARD stop
// lives at dispatch (bsc-next refuses unarmed cards). Returns null when armed
// or explicitly owner-judgment.
function armingWarning(notesStr) {
  const armed = (() => {
    try {
      const { evaluateVerifiability } = require('./lib/verify-gate.js');
      return evaluateVerifiability(notesStr);
    } catch (e) {
      // Validator module unavailable (partial checkout): don't block card
      // creation on our own tooling being missing.
      return { armed: true, cmd: 'validator-unavailable', reason: null, ownerJudgment: false };
    }
  })();
  if (armed.armed) return null;
  return (
    `Acceptance criteria name no runnable command (${armed.reason}).\n\n` +
    `The nightly recheck can only verify a Done card by RE-RUNNING a command captured at dispatch. ` +
    `Put at least one backticked command in "## Acceptance criteria" whose exit code proves the work. ` +
    `Allowed safe forms (scripts/lib/autonomous-triage-core.js SAFE_CHECK_FORMS):\n` +
    `  - \`node --test scripts/lib/thing.test.mjs\` (a test file the work adds or extends)\n` +
    `  - \`npx tsc --noEmit\` / \`npx next lint\`\n` +
    `  - \`test -f scripts/new-file.js\`\n\n` +
    `If this card's outcome truly cannot be machine-checked (a decision, an email, a design), add the line:\n` +
    `  VERIFY: owner-judgment\n` +
    `so the unverifiability is declared instead of accidental.\n` +
    `NOTE: the card was still saved — but bsc-next will REFUSE to dispatch it until the criteria are armed.`
  );
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
  if (validation.warning) {
    console.error(`\n⚠️  UNVERIFIABLE_ACCEPTANCE — "${title}"\n`);
    console.error(validation.warning);
    console.error('');
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
    properties.Priority = { select: { name: normalizePriority(args.priority) } };
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

  if (args.action) {
    // Sets the Action Queue select property (Investigate/Plan/Review/Start/Fix/
    // Plan+Review) — notion-action-poll.js polls for this being non-empty and
    // dispatches a headless Claude session for the card. Used by
    // scripts/lib/owner-alert-router.js to auto-file machine-actionable alerts.
    properties.Action = { select: { name: args.action } };
  }

  if (args['due-date']) {
    properties['Due Date'] = { date: { start: normalizeDueDate(args['due-date']) } };
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
    console.error('Usage: notion-brain update <page-id> [--name ...] [--status ...] [--outcome ...] ...');
    process.exit(1);
  }

  // Rewriting notes can silently UN-arm a card (drop its backticked verify
  // command) — surface the same arming warning create shows (Opus QA P2,
  // 2026-07-26). Warning only: update paths are used by automation.
  if (args.notes) {
    const w = armingWarning(String(args.notes));
    if (w) console.error(`\n⚠️  UNVERIFIABLE_ACCEPTANCE (update)\n\n${w}\n`);
  }

  const properties = {};

  // Rename. Needed when a card's scope is narrowed and the old title now
  // misdescribes the work — the nightly triage LLM reads the TITLE first, so a
  // stale "+ add lint guard" suffix on a card whose lint half moved to a
  // sibling steers triage straight back to the out-of-scope verdict (card #529).
  // Validate before writing: parseArgs turns a valueless `--name` (e.g.
  // `--name --status Done`) into boolean true, which would have renamed the
  // card to the literal string "true" — an unrecoverable title clobber the
  // ship-check Codex pass caught. Refuse rather than guess.
  if (args.name !== undefined) {
    if (typeof args.name !== 'string' || !args.name.trim()) {
      console.error('--name requires a non-empty title (got no value — did you write `--name --other-flag`?)');
      process.exit(1);
    }
    properties.Name = { title: [{ text: { content: args.name.trim() } }] };
  }

  if (args.status) {
    properties.Status = { status: { name: args.status } };
  }

  if (args.priority) {
    properties.Priority = { select: { name: normalizePriority(args.priority) } };
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

  if (args.auto !== undefined) {
    // Autonomous-loop state lives in its own `Auto` select so the loop never
    // touches domain Tags. Values are the autonomous-state machine's states;
    // "clear"/"none"/"" unsets (back to untriaged).
    if (args.auto === '' || args.auto === 'none' || args.auto === 'clear') {
      properties.Auto = { select: null };
    } else {
      const { STATES } = require('./lib/autonomous-state.js');
      if (!STATES.includes(args.auto) || args.auto === '') {
        console.error(`Error: --auto must be one of ${STATES.filter(s => s).join(', ')} (or "clear"), got ${JSON.stringify(args.auto)}`);
        process.exit(1);
      }
      properties.Auto = { select: { name: args.auto } };
    }
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

  if (args['due-date'] !== undefined) {
    // Pass --due-date="" or --due-date=none to clear an existing due date.
    if (args['due-date'] === '' || args['due-date'] === 'none' || args['due-date'] === 'clear') {
      properties['Due Date'] = { date: null };
    } else {
      properties['Due Date'] = { date: { start: normalizeDueDate(args['due-date']) } };
    }
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
      select: { equals: normalizePriority(args.priority) },
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
    const priorities = normalizePriority(args.priority).split(',').map(p => p.trim());
    if (priorities.length === 1) {
      filters.push({ property: 'Priority', select: { equals: priorities[0] } });
    } else {
      filters.push({
        or: priorities.map(p => ({ property: 'Priority', select: { equals: p } })),
      });
    }
  }

  if (args.due !== undefined) {
    const dueFilter = buildDueFilter(args.due);
    if (dueFilter) filters.push(dueFilter);
  }

  // Autonomous-loop queries: --auto <state> filters on the Auto select
  // ("any" = any non-empty Auto). Used by the executor's crash recovery and
  // the morning email to enumerate queued/attempted/needs-approval cards.
  if (args.auto !== undefined) {
    if (args.auto === 'any') {
      filters.push({ property: 'Auto', select: { is_not_empty: true } });
    } else {
      const states = String(args.auto).split(',').map(s => s.trim()).filter(Boolean);
      filters.push(states.length === 1
        ? { property: 'Auto', select: { equals: states[0] } }
        : { or: states.map(s => ({ property: 'Auto', select: { equals: s } })) });
    }
  }

  const filter = filters.length === 1
    ? filters[0]
    : filters.length > 1
      ? { and: filters }
      : undefined;

  // Validate numeric flags: `parseInt("0") || 20` silently turned --limit=0
  // into 20, and parseFloat("foo") returned NaN which then matched no cards
  // (filter `c.ageDays >= NaN` is always false → empty result with no error).
  // Fail loudly on bad input instead.
  let limit;
  if (args.limit === undefined) {
    limit = 20;
  } else {
    const parsed = parseInt(args.limit, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`Error: --limit must be a non-negative integer, got ${JSON.stringify(args.limit)}`);
      process.exit(1);
    }
    limit = parsed;
  }

  function parseAgeFlag(name) {
    const raw = args[name];
    if (raw === undefined) return null;
    const parsed = parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`Error: --${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
      process.exit(1);
    }
    return parsed;
  }
  const staleDays = parseAgeFlag('stale-days');
  const freshDays = parseAgeFlag('fresh-days');
  // Notion caps page_size at 100. If --stale-days/--fresh-days is set we
  // paginate so the age filter sees the full result set instead of silently
  // hitting the page boundary.
  const wantsAllPages = staleDays !== null || freshDays !== null;
  const targetPageSize = Math.min(100, Math.max(limit, 50));

  // When filtering by --due, sort by Due Date asc (then Priority); otherwise
  // keep the long-standing Priority-asc default. --sort edited returns
  // most-recently-edited first — the acceptance recheck depends on this: a
  // Priority-sorted Done listing hands back the 50 highest-priority Done cards
  // EVER, so freshly-completed work never appears and the recheck starves
  // (2026-07-26 incident: 0 targets every night since it shipped).
  // A typo'd --sort value silently falling back to Priority-asc would restore
  // the exact starvation this flag exists to fix — fail loudly instead.
  if (args.sort !== undefined && args.sort !== 'edited') {
    console.error(`Error: --sort accepts only "edited", got ${JSON.stringify(args.sort)}`);
    process.exit(1);
  }
  if (args.sort === 'edited' && args.due !== undefined) {
    console.error('Error: --sort edited and --due are mutually exclusive (each dictates the sort).');
    process.exit(1);
  }
  const sorts = args.sort === 'edited'
    ? [{ timestamp: 'last_edited_time', direction: 'descending' }]
    : args.due !== undefined
    ? [
        { property: 'Due Date', direction: 'ascending' },
        { property: 'Priority', direction: 'ascending' },
      ]
    : [{ property: 'Priority', direction: 'ascending' }];

  let allResults = [];
  let cursor = undefined;
  do {
    const response = await notion.dataSources.query({
      data_source_id: DATABASE_ID,
      filter,
      sorts,
      page_size: targetPageSize,
      start_cursor: cursor,
    });
    allResults = allResults.concat(response.results.map(formatCard));
    cursor = response.has_more ? response.next_cursor : undefined;
    if (!wantsAllPages && allResults.length >= limit) break;
  } while (cursor);

  let results = allResults;
  if (staleDays !== null) {
    results = results.filter(c => c.ageDays !== null && c.ageDays >= staleDays);
  }
  if (freshDays !== null) {
    results = results.filter(c => c.ageDays !== null && c.ageDays <= freshDays);
  }
  results = results.slice(0, limit);

  // Compact table output for quick scanning. completedDate/lastEditedAt ride
  // along because the acceptance recheck keys "Done recently" on explicit
  // completion stamps rather than the derived ageDays proxy (which is also
  // last_edited_time-based, but survives less scrutiny — 2026-07-26).
  // --include-notes (task #695): the widened acceptance recheck reads
  // RECHECK-AFTER stamps and fallback acceptance commands out of card.notes,
  // which this compact table omits by default — without this flag every
  // list-based caller silently sees notes: undefined and the stamp can never
  // be detected (ship-check adversarial finding: this was the exact gap that
  // made the whole widening a no-op end-to-end despite passing unit tests
  // that inject notes directly). Opt-in because notes can be large and most
  // callers of `list` don't need them.
  const includeNotes = !!args['include-notes'];
  const table = results.map(c => ({
    name: c.name,
    status: c.status,
    priority: c.priority,
    dueDate: c.dueDate,
    ageDays: c.ageDays,
    completedDate: c.completedDate ?? null,
    lastEditedAt: c.lastEditedAt ?? null,
    tags: c.tags.join(', '),
    id: c.id,
    ...(includeNotes ? { notes: c.notes } : {}),
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

// Archives (soft-deletes) a card — for cleaning up synthetic/test cards, e.g.
// the E2E canary (scripts/e2e-canary-alert-chain.js). Uses the Notion API's
// `archived: true`, same as trashing a page from the Notion UI.
async function archiveCard(args) {
  const pageId = args._positional[1];
  if (!pageId) {
    console.error('Usage: notion-brain archive <page-id>');
    process.exit(1);
  }

  const page = await notion.pages.update({ page_id: pageId, archived: true });
  const result = { id: page.id, archived: true };
  console.log(JSON.stringify(result, null, 2));
  return result;
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
  archive <id>         Archive (soft-delete) a card — for test/synthetic cards

Options (create/update):
  --status "In progress"    Status: Not started, In progress, Paused, Done
  --priority "P1 Next"      Priority: P0 Now, P1 Next, P2 Later
  --category Product        Category: Product, Marketing, Partnerships, Admin
  --type "New Feature"      Type: New Feature, Fix, Data Quality, Market Expansion
  --tags scoring,scraping   Tags (comma-separated)
  --notes "## Problem..."   Notes field — REQUIRED on create, validated for quality
  --outcome "## Summary"    Outcome (prepends to existing by default)
  --key-files "file.js"     Key Files field
  --auto STATE              (update only) Autonomous-loop state select: queued,
                            attempted, needs-approval, approved, merged,
                            rejected, failed, split-proposed. "clear" unsets.
  --completed-date DATE     Completed Date (YYYY-MM-DD)
  --due-date DATE           Due Date — YYYY-MM-DD, today, tomorrow, or +Nd
                            On update: "", "none", or "clear" removes the due date
  --overwrite-outcome       Overwrite outcome instead of prepending
  --force "<reason>"        Bypass notes validation (reason must be ≥10 chars, e.g. "session marker, will fill on wrap-up")

Notes quality enforcement (2026-04-11):
  - In-progress cards need ≥80 chars of notes
  - Backlog cards (Not started, Paused) need ≥300 chars AND sections for Problem,
    Suggested approach, and Acceptance criteria
  - Sparse cards are rejected with exit 2. See memory/feedback_notion_card_context.md

Options (search/list):
  --status "In progress"    Filter by status (also: --status="In progress")
  --priority "P0 Now"       Filter by priority (comma-separated for list)
  --text "keyword"          Text search in name/notes (search only).
                            Aliased as --query. Paginates when set.
  --limit 10                Max results (default: 20)
  --stale-days N            (list only) Only cards not edited in N+ days.
                            Paginates through all results so the age filter
                            sees the full DB, not just the first page.
  --fresh-days N            (list only) Only cards edited within last N days.
  --sort edited             (list only) Most-recently-edited first instead of
                            the Priority-asc default. Use for "what changed
                            lately" queries — e.g. recently-completed cards.
  --due WHEN                (list only) Filter by Due Date. WHEN is one of:
                            today, tomorrow, overdue, this-week, upcoming,
                            none, any, or an explicit YYYY-MM-DD.
                            Sorts results by Due Date ascending when set.`);
    process.exit(1);
  }

  try {
    switch (command) {
      case 'create': await createCard(args); break;
      case 'update': await updateCard(args); break;
      case 'search': await searchCards(args); break;
      case 'list':   await listCards(args); break;
      case 'get':    await getCard(args); break;
      case 'archive': await archiveCard(args); break;
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
