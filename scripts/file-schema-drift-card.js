'use strict';
/**
 * Files (or reuses) the START-NOW card for a failed verify-schema run (BRO-6666).
 *
 *   node scripts/file-schema-drift-card.js <verify-log-file> [--dry-run]
 *
 * verify-schema.yml tees scripts/verify-supabase-schema.js output to the log.
 * One open card carries the key line, so repeated failures reuse it instead of
 * filing a new card each run. --dry-run prints the card and files nothing.
 * Prints `card=BRO-N` to $GITHUB_OUTPUT. Env: LINEAR_API_KEY, RUN_URL.
 */
const fs = require('fs');
const path = require('path');
const { parseVerifyLog, buildCard, buildUnparsedCard, KEY_LINE } = require('./lib/schema-drift-card.js');

const DAY_MS = 24 * 3600000;
const MIGRATIONS = path.join(__dirname, '..', 'supabase', 'migrations');

function readSql(file) {
  try { return fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'); } catch { return ''; }
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const logPath = args.find((a) => !a.startsWith('--'));
  if (!logPath) { console.error('Usage: node scripts/file-schema-drift-card.js <verify-log-file> [--dry-run]'); process.exit(2); }
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const entries = parseVerifyLog(log);
  // No migration lines (API outage, bad token, or a changed log format) is still
  // a failed run nobody would act on, so it files the same card, with the log tail.
  const card = entries.length
    ? buildCard({ entries, runUrl: process.env.RUN_URL, readSql })
    : buildUnparsedCard({ tail: log.trim().split('\n').slice(-8).join('\n'), runUrl: process.env.RUN_URL });
  if (dry) {
    console.log(`[dry-run] would file (or reuse the open card carrying "${KEY_LINE}"):\n\nTITLE: ${card.title}\n\n${card.description}`);
    return;
  }
  const linear = require('./lib/linear-client.js');
  const { isTerminalStateType } = require('./lib/linear-state-types.js');
  const unpickable = require('./lib/cloud-worker-pick.js').startNowUnpickableReason({ ...card, priority: 2, mode: 'dispatch' });
  if (unpickable) throw new Error(`card would never be picked (${unpickable.reason})`);
  const since = new Date(Date.now() - 90 * DAY_MS).toISOString();
  const found = await linear.listIssuesByProvenance({ since, descriptionMarkers: [KEY_LINE] });
  const open = found.find((i) => !isTerminalStateType(i.state && i.state.type));
  let id = open && open.identifier;
  if (open) {
    // Keeps the card's list current and its updatedAt fresh, so the 14-day lookup still finds it.
    await linear.createComment(open.id, `Still failing${process.env.RUN_URL ? ` (${process.env.RUN_URL})` : ''}. Unapplied now:\n${card.description.split('\n').filter((l) => /^(Migration:|  (missing|function body differs|apply):)/.test(l)).join('\n')}`);
  }
  if (!id) {
    const { createLinearIssue } = require('./lib/linear-issue-create.js');
    try {
      const { issue } = await createLinearIssue({ ...card, priority: 2, dispatch: true, source: 'verify-schema' });
      id = issue.identifier;
    } catch (e) {
      if (e && e.code === 'NEAR_DUPLICATE_OPEN' && e.twin && e.twin.identifier) id = e.twin.identifier;
      else throw e;
    }
  }
  if (!/^BRO-\d+$/.test(String(id))) throw new Error(`unexpected card id: ${id}`);
  console.log(`schema drift card: ${id}${open ? ' (already open)' : ' (filed)'}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `card=${id}\n`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`::warning::could not file the schema drift card: ${e.message}`); });
}
