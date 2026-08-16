#!/usr/bin/env node
/**
 * sync-pending-review-to-notion.js — surface data/commercial-pending-review.json
 * to the owner as a single, always-current Notion card.
 *
 * Problem: the commercial-data pipeline (batch-commercial-research.js,
 * deep-research-commercial.js) writes low-confidence / unsourced findings to
 * data/commercial-pending-review.json instead of applying them, but nothing
 * ever surfaces that file to a human. Holds sit invisible forever ("I don't
 * think I've ever been asked to confirm anything here" — owner, 2026-07).
 *
 * This is a DIGEST mechanism, not a per-entry one: one Notion card, kept in
 * sync with the current contents of the pending-review file. Contrast with
 * scripts/notify-pending-commercial-notion.js, which creates one card PER
 * recouped-claim entry from a sweep report — different data source, different
 * shape, does not overlap with this script.
 *
 * Uses notion-brain.js as a subprocess (per memory/feedback_notion_cli_only.md
 * — never duplicate Notion-API/env-var/database-id logic; notion-brain.js
 * is a CLI, not a requireable module, so we spawn it).
 *
 * Branching (file empty == missing == [] == {}):
 *   empty   + no card     -> no-op
 *   empty   + card exists -> mark card Done, append outcome
 *   non-empty + no card   -> create card
 *   non-empty + card exists -> update card notes (idempotent, no duplicate)
 *
 * Usage:
 *   node scripts/sync-pending-review-to-notion.js [--dry-run] [--file=PATH]
 *
 * Env: NOTION_API_KEY (read by notion-brain.js, not by this script directly)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const NOTION_BRAIN = path.join(__dirname, 'notion-brain.js');
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'commercial-pending-review.json');

const TITLE_PREFIX = 'Commercial data:';
const TAG = 'commercial-pending-review';
const ENTRY_REASON_CAP = 300; // per-entry reason/notes preview cap (full detail stays in the source file)

// ── Args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, file: DEFAULT_FILE };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
  }
  return args;
}

// ── Load + normalize the pending-review file ──────────────────────────────
// Expected (per spec): array of {slug, heldSince, reason, attemptedQueries}.
// Actual observed shape in this repo: { generatedAt, shows: { <id>: {slug,
// notes, sources, researchedAt, ...} } } — a slug-keyed map, not an array.
// Be defensive about both, plus anything else, per the task's instruction to
// treat unparseable/unexpected shapes best-effort rather than crashing.

function warn(msg) {
  console.error(`[sync-pending-review-to-notion] WARNING: ${msg}`);
}

function loadRaw(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    warn(`could not read ${filePath}: ${err.message} — treating as missing`);
    return null;
  }
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    warn(`${filePath} is not valid JSON (${err.message}) — treating as empty`);
    return null;
  }
}

// Normalize any parsed shape into a flat list of raw entry objects, plus a
// best-effort top-level fallback timestamp (e.g. a top-level `generatedAt`)
// entries can use when they have no per-entry timestamp of their own.
function normalizeEntries(raw) {
  if (raw === null || raw === undefined) return { list: [], fallbackSince: null };

  if (Array.isArray(raw)) {
    return { list: raw, fallbackSince: null };
  }

  if (typeof raw === 'object') {
    const keys = Object.keys(raw);
    if (keys.length === 0) return { list: [], fallbackSince: null };

    const fallbackSince = typeof raw.generatedAt === 'string' ? raw.generatedAt : null;

    // Common nested-array shapes.
    for (const key of ['entries', 'pending', 'items']) {
      if (Array.isArray(raw[key])) {
        return { list: raw[key], fallbackSince };
      }
    }

    // Observed real shape: raw.shows is a slug-keyed MAP, not an array.
    if (raw.shows && typeof raw.shows === 'object' && !Array.isArray(raw.shows)) {
      const list = Object.entries(raw.shows).map(([id, v]) => {
        if (v && typeof v === 'object') return { _id: id, ...v };
        return { _id: id, slug: id };
      });
      return { list, fallbackSince };
    }
    if (Array.isArray(raw.shows)) {
      return { list: raw.shows, fallbackSince };
    }

    // Last resort: treat the whole object as a slug-keyed map itself.
    warn(
      `${DEFAULT_FILE} has an unexpected shape (object with keys: ${keys.slice(0, 6).join(', ')}` +
      `${keys.length > 6 ? '…' : ''}) — no array of entries found, treating top-level keys as a slug-keyed map, best-effort`
    );
    const list = keys.map((k) => {
      const v = raw[k];
      if (v && typeof v === 'object') return { _id: k, ...v };
      return { _id: k, slug: k };
    });
    return { list, fallbackSince };
  }

  warn(`${DEFAULT_FILE} has an unexpected top-level type "${typeof raw}" — treating as empty`);
  return { list: [], fallbackSince: null };
}

function extractQueryString(q) {
  if (typeof q === 'string') return q;
  if (q && typeof q === 'object') {
    const parts = [];
    if (q.url) parts.push(q.url);
    else if (q.query) parts.push(q.query);
    if (q.type) parts.push(`(${q.type}${q.date ? `, ${q.date}` : ''})`);
    if (parts.length) return parts.join(' ');
    try {
      return JSON.stringify(q);
    } catch {
      return String(q);
    }
  }
  return String(q);
}

// Coerce one raw entry (of unknown/defensive shape) into the canonical
// {slug, title, heldSince, reason, attemptedQueries} shape the notes builder
// expects. Falls back across field-name variants seen in the wild.
function coerceEntry(raw, idx, fallbackSince) {
  if (!raw || typeof raw !== 'object') {
    return {
      slug: `(unparseable-entry-${idx})`,
      title: null,
      heldSince: fallbackSince || 'unknown',
      reason: 'unspecified (malformed entry — could not parse)',
      attemptedQueries: [],
    };
  }

  const slug = raw.slug || raw._id || raw.showSlug || raw.id || `(entry-${idx})`;
  const title = raw.title || null;

  const heldSince =
    raw.heldSince || raw.since || raw.researchedAt || raw.createdAt || fallbackSince || 'unknown';

  const reason = raw.reason || raw.notes || raw.designation || 'unspecified';

  let attemptedQueries = [];
  if (Array.isArray(raw.attemptedQueries)) {
    attemptedQueries = raw.attemptedQueries.map(extractQueryString);
  } else if (Array.isArray(raw.sources)) {
    attemptedQueries = raw.sources.map(extractQueryString);
  } else if (Array.isArray(raw.queries)) {
    attemptedQueries = raw.queries.map(extractQueryString);
  }

  return { slug, title, heldSince, reason, attemptedQueries };
}

function loadEntries(filePath) {
  const raw = loadRaw(filePath);
  const { list, fallbackSince } = normalizeEntries(raw);
  return list.map((e, i) => coerceEntry(e, i, fallbackSince));
}

// ── Notes builder ───────────────────────────────────────────────────────

function truncate(s, cap) {
  const str = String(s || '');
  if (str.length <= cap) return str;
  return str.slice(0, cap).trim() + '…';
}

function buildTitle(n) {
  return `${TITLE_PREFIX} ${n} show(s) awaiting your review`;
}

function buildNotes(entries) {
  const lines = [];
  lines.push(`## Pending commercial-data entries (${entries.length})`);
  lines.push('');
  lines.push(
    'Findings from the commercial-data pipeline (batch/deep research) that were ' +
    'held back from `commercial.json` because they lack a confident source. ' +
    'Source file: `data/commercial-pending-review.json`.'
  );
  lines.push('');
  lines.push('**For each entry below, respond with one of:**');
  lines.push('1. Supply a citation URL — sources the claim so it can be applied');
  lines.push('2. Confirm demote — mark as unconfirmed, clears the pending hold');
  lines.push('3. Leave held — no action; stays pending and resurfaces on the next sync');
  lines.push('');

  for (const e of entries) {
    lines.push('---');
    lines.push('');
    lines.push(`### ${e.slug}${e.title ? ` (${e.title})` : ''}`);
    lines.push(`- Held since: ${e.heldSince}`);
    lines.push(`- Reason: ${truncate(e.reason, ENTRY_REASON_CAP)}`);
    if (e.attemptedQueries.length) {
      lines.push('- Attempted queries:');
      for (const q of e.attemptedQueries) {
        lines.push(`  - ${truncate(q, 200)}`);
      }
    } else {
      lines.push('- Attempted queries: (none logged)');
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`_Last synced: ${new Date().toISOString()}_`);

  return lines.join('\n');
}

// ── notion-brain.js subprocess wrapper ─────────────────────────────────

function runNotionBrain(subargs) {
  const res = spawnSync('node', [NOTION_BRAIN, ...subargs], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

function findExistingCard() {
  const res = runNotionBrain(['search', '--status', 'In progress', '--text', TITLE_PREFIX]);
  if (res.status !== 0) {
    throw new Error(`notion-brain search failed (exit ${res.status}): ${res.stderr.slice(0, 500)}`);
  }
  let results;
  try {
    results = JSON.parse(res.stdout);
  } catch {
    throw new Error(`notion-brain search returned non-JSON stdout: ${res.stdout.slice(0, 300)}`);
  }
  if (!Array.isArray(results)) return null;

  const matches = results.filter(
    (c) => c && Array.isArray(c.tags) && c.tags.includes(TAG) && c.name && c.name.startsWith(TITLE_PREFIX)
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.error(
      `[sync-pending-review-to-notion] WARNING: found ${matches.length} matching cards ` +
      `(expected 1) — using the most recently edited. Consider manually merging: ` +
      matches.map((c) => c.id).join(', ')
    );
    matches.sort((a, b) => new Date(b.lastEditedAt) - new Date(a.lastEditedAt));
  }
  return matches[0];
}

function todayLocal() {
  return new Date().toISOString().slice(0, 10);
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  const entries = loadEntries(args.file);
  const empty = entries.length === 0;

  console.log(
    `[sync-pending-review-to-notion] file=${args.file} entries=${entries.length} dry-run=${args.dryRun}`
  );

  let card;
  try {
    card = findExistingCard();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // ── a. empty + no card ────────────────────────────────────────────────
  if (empty && !card) {
    console.log('nothing pending, no card — no-op');
    process.exit(0);
  }

  // ── b. empty + card exists ──────────────────────────────────────────
  if (empty && card) {
    if (args.dryRun) {
      console.log(`[dry-run] would UPDATE card ${card.id} (${card.url}) -> status Done, append outcome`);
      process.exit(0);
    }
    const update = runNotionBrain([
      'update', card.id,
      '--status', 'Done',
      '--outcome', 'All pending commercial-data entries cleared.',
      '--completed-date', todayLocal(),
    ]);
    if (update.status !== 0) {
      console.error(`FATAL: failed to mark card Done: ${update.stderr.slice(0, 500)}`);
      process.exit(1);
    }
    console.log(`Marked card Done: ${card.url}`);
    process.exit(0);
  }

  const title = buildTitle(entries.length);
  const notes = buildNotes(entries);

  // ── c. non-empty + no card ──────────────────────────────────────────
  if (!empty && !card) {
    if (args.dryRun) {
      console.log('[dry-run] would CREATE card');
      console.log(`  title: ${title}`);
      console.log('  status: In progress');
      console.log('  priority: P1 Next');
      console.log('  category: Product');
      console.log('  type: Data Quality');
      console.log(`  tags: commercial,${TAG}`);
      console.log(`  notes (${notes.length} chars):`);
      console.log(notes);
      process.exit(0);
    }
    const create = runNotionBrain([
      'create', title,
      '--status', 'In progress',
      '--priority', 'P1 Next',
      '--category', 'Product',
      '--type', 'Data Quality',
      '--tags', `commercial,${TAG}`,
      '--notes', notes,
      // task #1310: this is a standing owner-review-status card (N shows
      // awaiting manual commercial review), never autonomously worked by a
      // bsc-next session — --no-spawn keeps the explicit 'In progress'
      // status without triggering a redundant/nonsensical dispatch. task
      // #1691: --no-spawn now requires a reason, written to Notes as a
      // NO-DISPATCH marker that excludes this card from the task mirror
      // entirely (isMirrorableCard) — it never occupies a claimed queue
      // slot, regardless of the 'In progress' status this caller wants
      // visible on the Notion board.
      '--dispatch', '--no-spawn',
      'standing owner-review-status card, never auto-dispatched by bsc-next',
    ]);
    if (create.status !== 0) {
      console.error(`FATAL: failed to create card: ${create.stderr.slice(0, 500)}`);
      process.exit(1);
    }
    let created;
    try {
      created = JSON.parse(create.stdout);
    } catch {
      created = null;
    }
    console.log(`Created card: ${created ? created.url : '(see notion-brain output above)'}`);
    process.exit(0);
  }

  // ── d. non-empty + card exists ──────────────────────────────────────
  if (args.dryRun) {
    console.log(`[dry-run] would UPDATE card ${card.id} (${card.url}) notes`);
    console.log(`  title (unchanged — notion-brain has no --title on update): ${card.name}`);
    console.log(`  new notes (${notes.length} chars):`);
    console.log(notes);
    process.exit(0);
  }
  const update = runNotionBrain([
    'update', card.id,
    '--notes', notes,
    '--status', 'In progress',
  ]);
  if (update.status !== 0) {
    console.error(`FATAL: failed to update card notes: ${update.stderr.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`Updated card: ${card.url}`);
  process.exit(0);
}

main();
