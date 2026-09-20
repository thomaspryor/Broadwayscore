#!/usr/bin/env node
/**
 * sync-pending-review-to-linear.js — surface data/commercial-pending-review.json
 * to the owner as a single, always-current Linear issue (BRO-3431).
 *
 * Replaces scripts/sync-pending-review-to-notion.js, which filed this same
 * digest onto the retired Notion board (CLAUDE.md §6: "Linear is the source
 * of truth — do NOT create Notion cards"). commercial-pending-review-
 * notify.yml ran that script daily via the 0 7 * * * cron with zero Linear
 * awareness (grep -ic linear on it was 0) — the card it filed (Notion id
 * 1966, "Commercial data: 33 show(s) awaiting your review") sat on a board
 * nobody opens.
 *
 * Entry-loading logic (loadEntries/normalizeEntries/coerceEntry/buildNotes)
 * is carried over verbatim from the Notion version — that half was never
 * Notion-specific, only the card-management half was.
 *
 * linear-brain.js has no --description update, unlike notion-brain.js's
 * --notes (task #1802 era CLI) — so unlike the Notion version, this does NOT
 * try to keep one issue's body in sync across runs. Instead: file once
 * (--park, this is a standing status digest, never auto-dispatched), then
 * POST A COMMENT with the current digest on every subsequent run while
 * entries remain non-empty. That is arguably better than the old rewrite-in-
 * place behavior — it leaves an audit trail of how the pending list changed
 * over time instead of overwriting it.
 *
 * Branching (file empty == missing == [] == {}):
 *   empty   + no issue     -> no-op
 *   empty   + issue exists -> move to Done (--force: informational, no PR),
 *                             comment "cleared"
 *   non-empty + no issue   -> create issue (--park)
 *   non-empty + issue exists -> post a comment with the current digest
 *
 * Usage:
 *   node scripts/sync-pending-review-to-linear.js [--dry-run] [--file=PATH]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `sync-pending-review-to-linear.js — surface data/commercial-pending-review.json as a Linear issue.

Usage:
  node scripts/sync-pending-review-to-linear.js [--dry-run] [--file=PATH]
  node scripts/sync-pending-review-to-linear.js --help
`;

const LINEAR_BRAIN = path.join(__dirname, 'linear-brain.js');
const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'commercial-pending-review.json');

const TITLE = 'Commercial data: pending review'; // stable — no count in the title, so find() by marker stays a single-hit lookup across runs
const MARKER = '[commercial-pending-review]'; // embedded in the body, this run's find() anchor
const ENTRY_REASON_CAP = 300;

// ── Args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dryRun: false, file: DEFAULT_FILE };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
  }
  return args;
}

// ── Load + normalize the pending-review file (unchanged from the Notion
// version — this half was never Notion-specific) ──────────────────────────

function warn(msg) {
  console.error(`[sync-pending-review-to-linear] WARNING: ${msg}`);
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

function normalizeEntries(raw) {
  if (raw === null || raw === undefined) return { list: [], fallbackSince: null };

  if (Array.isArray(raw)) {
    return { list: raw, fallbackSince: null };
  }

  if (typeof raw === 'object') {
    const keys = Object.keys(raw);
    if (keys.length === 0) return { list: [], fallbackSince: null };

    const fallbackSince = typeof raw.generatedAt === 'string' ? raw.generatedAt : null;

    for (const key of ['entries', 'pending', 'items']) {
      if (Array.isArray(raw[key])) {
        return { list: raw[key], fallbackSince };
      }
    }

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

function truncate(s, cap) {
  const str = String(s || '');
  if (str.length <= cap) return str;
  return str.slice(0, cap).trim() + '…';
}

function buildDigest(entries) {
  const lines = [];
  lines.push(MARKER);
  lines.push('');
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
  lines.push(`_Synced: ${new Date().toISOString()}_`);

  return lines.join('\n');
}

// ── linear-brain.js subprocess wrapper ─────────────────────────────────

function runLinearBrain(subargs) {
  const res = spawnSync('node', [LINEAR_BRAIN, ...subargs], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

// find() default mode substring-matches title/body of OPEN issues only — a
// Done issue from a prior "cleared" run naturally falls out of scope, same
// empty-cycle behavior the Notion version had via its own `--status "In
// progress"` search filter.
function findExistingIssue() {
  const res = runLinearBrain(['find', MARKER]);
  if (res.status !== 0) {
    throw new Error(`linear-brain find failed (exit ${res.status}): ${res.stderr.slice(0, 500)}`);
  }
  const out = res.stdout.trim();
  if (!out || out === 'null') return null;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`linear-brain find returned non-JSON stdout: ${out.slice(0, 300)}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const args = parseArgs(process.argv.slice(2));

  const entries = loadEntries(args.file);
  const empty = entries.length === 0;

  console.log(
    `[sync-pending-review-to-linear] file=${args.file} entries=${entries.length} dry-run=${args.dryRun}`
  );

  let issue;
  try {
    issue = findExistingIssue();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  if (empty && !issue) {
    console.log('nothing pending, no issue — no-op');
    process.exit(0);
  }

  if (empty && issue) {
    if (args.dryRun) {
      console.log(`[dry-run] would UPDATE ${issue.identifier} (${issue.url}) -> state Done, comment cleared`);
      process.exit(0);
    }
    const update = runLinearBrain([
      'update', issue.identifier,
      '--state', 'Done',
      '--comment', `${MARKER} All pending commercial-data entries cleared.`,
      // Informational digest card, never a PR — the done-evidence gate has
      // nothing to check here.
      '--force', 'informational status digest, no PR — pending-review file is empty',
    ]);
    if (update.status !== 0) {
      console.error(`FATAL: failed to mark ${issue.identifier} Done: ${update.stderr.slice(0, 500)}`);
      process.exit(1);
    }
    console.log(`Marked ${issue.identifier} Done: ${issue.url}`);
    process.exit(0);
  }

  const digest = buildDigest(entries);

  if (!empty && !issue) {
    if (args.dryRun) {
      console.log('[dry-run] would CREATE issue');
      console.log(`  title: ${TITLE}`);
      console.log(`  notes (${digest.length} chars):`);
      console.log(digest);
      process.exit(0);
    }
    const create = runLinearBrain([
      'create', TITLE,
      '--priority', '3', // Medium — visible, never auto-dispatched (--park below)
      '--notes', digest,
      '--park', 'standing owner-review-status digest, never auto-dispatched by the drain',
    ]);
    if (create.status !== 0) {
      console.error(`FATAL: failed to create issue: ${create.stderr.slice(0, 500)}`);
      process.exit(1);
    }
    const m = create.stdout.match(/"identifier":\s*"([A-Z]+-\d+)"/);
    console.log(`Created issue: ${m ? m[1] : '(see linear-brain output above)'}`);
    process.exit(0);
  }

  // non-empty + issue exists -> comment with the current digest
  if (args.dryRun) {
    console.log(`[dry-run] would COMMENT on ${issue.identifier} (${issue.url})`);
    console.log(`  comment (${digest.length} chars):`);
    console.log(digest);
    process.exit(0);
  }
  const update = runLinearBrain(['update', issue.identifier, '--comment', digest]);
  if (update.status !== 0) {
    console.error(`FATAL: failed to comment on ${issue.identifier}: ${update.stderr.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`Commented on ${issue.identifier}: ${issue.url}`);
  process.exit(0);
}

main();
