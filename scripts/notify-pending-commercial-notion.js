#!/usr/bin/env node
/**
 * Notion sweep — surface recouped-claim pending entries for human review.
 *
 * Consumes the report JSON written by scripts/sweep-pending-commercial.js
 * (--report-json), then for each entry calls notion-brain.js to:
 *   - search for an existing card whose title contains the stable token
 *     `commercial-pending-{slug}` (idempotent key);
 *   - if found, update the card with the latest state;
 *   - else create a new card.
 *
 * Uses notion-brain.js as a subprocess (per feedback_notion_cli_only.md). We do
 * not duplicate Notion-API logic.
 *
 * Usage:
 *   node scripts/notify-pending-commercial-notion.js \
 *     --report-json=/tmp/sweep-report.json
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const flags = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v === undefined ? true : v;
  }
}

const REPORT_JSON = flags['report-json'];
const DRY_RUN = flags['dry-run'] === true;
const CAP = parseInt(flags['cap'], 10) || 25;
const NOTION_BRAIN = path.join(__dirname, 'notion-brain.js');

if (!REPORT_JSON) {
  console.error('FATAL: --report-json=PATH required');
  process.exit(1);
}

function runNotionBrain(subargs) {
  const res = spawnSync('node', [NOTION_BRAIN, ...subargs], {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

function extractCardId(searchOutput) {
  // notion-brain.js search prints formatted cards; each begins with a header
  // line containing the page id. Find a line matching commercial-pending-{slug}
  // (caller passed --text=commercial-pending-{slug}).
  // Card id format in Notion is 32 hex chars with dashes — match liberally and
  // let the update verb validate.
  const idMatch = searchOutput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return idMatch ? idMatch[0] : null;
}

function buildNotes(item) {
  const lines = [
    '## Pending recoupment claim — needs human verification',
    '',
    `**Show slug:** ${item.slug}`,
    `**Confidence:** ${item.confidence || 'unknown'}`,
    `**Detected by:** ${item.detectedBy || 'unknown'}`,
    `**Source host:** ${item.sourceHost || 'unknown'}`,
    `**Recouped date claim:** ${item.recoupedDate || 'unknown'}`,
    `**Source URL:** ${item.recoupedSource || 'n/a'}`,
    '',
    '### Evidence quote',
    item.evidence ? `> ${item.evidence}` : '_(none captured)_',
    '',
    '### How to apply manually',
    '```bash',
    `node scripts/apply-commercial-pending.js --show=${item.slug}`,
    '```',
    '',
    '### How to reject',
    'Move the entry from `commercial-pending-review.json` to `commercial-pending-archive.json` with `archivedReason: "rejected-recouped-claim"`. The Friday scraper reads the archive before writing, so the same article won\'t re-surface.',
    '',
    `_First researched: ${item.researchedAt || 'unknown'}_`,
  ];
  return lines.join('\n');
}

function buildTitle(slug) {
  return `commercial-pending-${slug} — recoupment claim needs review`;
}

function notifyOne(item) {
  const stableKey = `commercial-pending-${item.slug}`;
  const title = buildTitle(item.slug);
  const notes = buildNotes(item);

  if (DRY_RUN) {
    console.log(`[dry-run] ${stableKey} — would search + upsert`);
    return { slug: item.slug, action: 'dry-run' };
  }

  // 1. Search for existing card
  const search = runNotionBrain(['search', `--text=${stableKey}`]);
  if (search.status !== 0) {
    console.error(`  ✗ ${item.slug}: search failed — ${search.stderr.slice(0, 200)}`);
    return { slug: item.slug, action: 'error', error: 'search-failed' };
  }
  // search prints "No matches" / "Found N matches" — if the stable key appears
  // in output, the card exists.
  const found = search.stdout.includes(stableKey);
  const cardId = found ? extractCardId(search.stdout) : null;

  if (cardId) {
    const update = runNotionBrain([
      'update', cardId,
      '--notes', notes,
      '--status', 'In progress',
    ]);
    if (update.status !== 0) {
      console.error(`  ✗ ${item.slug}: update failed — ${update.stderr.slice(0, 200)}`);
      return { slug: item.slug, action: 'error', error: 'update-failed' };
    }
    console.log(`  ↻ ${item.slug}: updated existing card ${cardId.slice(0, 8)}…`);
    return { slug: item.slug, action: 'updated', cardId };
  }

  const create = runNotionBrain([
    'create', title,
    '--status', 'Not started',
    '--priority', 'P2',
    '--category', 'Pipeline',
    '--tags', `commercial,pending-review,${stableKey}`,
    '--notes', notes,
  ]);
  if (create.status !== 0) {
    console.error(`  ✗ ${item.slug}: create failed — ${create.stderr.slice(0, 200)}`);
    return { slug: item.slug, action: 'error', error: 'create-failed' };
  }
  console.log(`  + ${item.slug}: created`);
  return { slug: item.slug, action: 'created' };
}

function main() {
  if (!fs.existsSync(REPORT_JSON)) {
    console.error(`FATAL: report file not found: ${REPORT_JSON}`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8'));
  const allClaims = report.recoupedClaims || [];
  const claims = allClaims.slice(0, CAP);
  const overflow = allClaims.length - claims.length;
  console.log(`Notion sweep — ${claims.length} recouped-claim entries (cap ${CAP}, dry-run=${DRY_RUN})`);
  if (overflow > 0) {
    // Loud warning so the overflow doesn't disappear silently — the Saturday
    // CI log + GitHub step summary surface this. Ship-check P1 finding: with
    // 80 claims and cap=25, the other 55 would have rotted invisibly.
    console.log(`::warning::Notion cap=${CAP} hit — ${overflow} recouped-claim entries deferred to next run`);
  }
  if (claims.length === 0) return;

  const results = { created: 0, updated: 0, error: 0, 'dry-run': 0 };
  for (const item of claims) {
    const { action } = notifyOne(item);
    results[action] = (results[action] || 0) + 1;
  }
  console.log(`\nSweep summary: created=${results.created} updated=${results.updated} errors=${results.error}` +
              (overflow > 0 ? ` overflow=${overflow}` : ''));
}

main();
