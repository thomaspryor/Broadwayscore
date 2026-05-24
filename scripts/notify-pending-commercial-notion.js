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
  // notion-brain.js validateCardNotes (notion-brain.js:381) rejects "Not started"
  // cards that lack Problem / Suggested approach / Acceptance criteria sections,
  // requiring ≥300 chars. The pipeline isn't a "session marker" — it's
  // generating real backlog items, so the canonical handoff format is correct.
  const lines = [
    '## Problem',
    '',
    `The commercial-data pipeline flagged a recouped-claim entry for **${item.slug}** that needs human verification before \`commercial.json\` is updated. The Friday scraper or deep-research pass found evidence that this show recouped, but the auto-apply gate (\`commercial-apply-gate.js\`) refused to promote it because the gate's combination of (confidence, sourceHost, detectedBy) didn't qualify for the trusted-publisher fast path. Without manual review, the show stays at TBD and the Sunday newsletter under-reports.`,
    '',
    '## Claim details',
    '',
    `- **Show slug:** \`${item.slug}\``,
    `- **Confidence:** ${item.confidence || 'unknown'}`,
    `- **Detected by:** ${item.detectedBy || 'unknown'}`,
    `- **Source host:** ${item.sourceHost || 'unknown'}`,
    `- **Recouped date claim:** ${item.recoupedDate || 'unknown'}`,
    `- **Source URL:** ${item.recoupedSource || 'n/a'}`,
    `- **First researched:** ${item.researchedAt || 'unknown'}`,
    '',
    '### Evidence quote',
    item.evidence ? `> ${item.evidence}` : '_(none captured — verify against source URL above before promoting)_',
    '',
    '## Suggested approach',
    '',
    '1. Open the source URL and confirm the article actually states recoupment for THIS production (not a prior revival, not a different show by the same title).',
    '2. If valid → apply the pending entry:',
    '   ```bash',
    `   node scripts/apply-commercial-pending.js --show=${item.slug}`,
    '   ```',
    '3. If the article is real but additional citations would help, queue a deep-research pass:',
    '   ```bash',
    `   node scripts/deep-research-commercial.js --shows=${item.slug} --max-shows=1`,
    '   ```',
    '4. If invalid (wrong production, SEO republish of an old article, misread by the LLM classifier) → reject by moving the entry from `data/commercial-pending-review.json` to `data/commercial-pending-archive.json` with `archivedReason: "rejected-recouped-claim"`. The Friday scraper reads the archive (via `isRejectedInArchive` in `scripts/scrape-recoupment-announcements.js`) so the same URL won\'t resurface.',
    '5. Optional belt-and-braces: set `humanReviewedDesignation: true` on the `commercial.json` entry so future auto-applies skip it (the merge layer preserves this flag across rebases).',
    '',
    '## Acceptance criteria',
    '',
    `- \`commercial.json\` entry for \`${item.slug}\` reflects the verified state (recouped applied OR archived with reason), OR the entry has \`humanReviewedDesignation: true\` set.`,
    '- Notion card moved from "Not started" to "Done" with one-line outcome (e.g. "Verified + applied" or "Rejected — SEO republish").',
    '- Next Friday/Saturday run does NOT re-surface the same entry (verified by checking the archive for the rejected URL, or by the apply removing the pending entry).',
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
