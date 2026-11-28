'use strict';
/**
 * Pure helpers for the verify-schema failure card (BRO-6666).
 *
 * verify-schema.yml failed on 2026-10-28 and twice on 2026-10-30 and nobody
 * acted for two days, because its notify-failure step is severity low (morning
 * digest only). scripts/file-schema-drift-card.js uses these to turn the
 * verify log into one START-NOW card that names the unapplied migrations and
 * the exact apply command.
 *
 * Auto-apply decision (documented, NOT built): a worker that takes this card
 * applies the migration after an intent check (BRO-6664 was handled that way),
 * so the apply stays a reviewed act. classifyMigration() labels a file
 * additive-only when its SQL has no destructive statement and no function,
 * policy or view change. Even those are not applied by the workflow itself:
 * apply-migration.yml is manual on purpose, a "harmless" column can still break
 * a live INSERT that omits it, and diary_photo_limits needed an intent check.
 * The label tells the worker which files are low risk and which to read closely.
 * The card is filed only for scheduled or manual runs, never a push run: a
 * push run fails in the normal gap between merging a migration and applying it.
 */

const MISSING_RE = /^(?:::error::)?missing in prod: (\S+) (.+?) \(declared by ([^)\s]+)\)/;
const DRIFT_RE = /^(?:::error::)?function body drift: (\S+) in prod differs from the latest definition in (\S+)/;
const APPLY_RE = /apply-migration\.yml -f migration=supabase\/migrations\/([\w.\-]+\.sql)/;

function parseVerifyLog(text) {
  const byFile = new Map();
  const touch = (file) => {
    if (!byFile.has(file)) byFile.set(file, { file, missing: [], drifted: [] });
    return byFile.get(file);
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    let m = line.match(MISSING_RE);
    if (m) { touch(m[3]).missing.push(`${m[1]} ${m[2]}`); continue; }
    m = line.match(DRIFT_RE);
    if (m) { touch(m[2]).drifted.push(m[1]); continue; }
    m = line.match(APPLY_RE);
    if (m) touch(m[1]);
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

function applyCommand(file) {
  // "Apply with:" prefix keeps this a hint string; audit-workflow-concurrency
  // treats a bare leading `gh workflow run` in a script as a real dispatch.
  return `Apply with: gh workflow run apply-migration.yml -f migration=supabase/migrations/${file} -f confirm=APPLY`;
}

const RISKY = /\b(drop\s+(table|column|policy|function|view|index|trigger|constraint|type)|alter\s+column|rename\s+(to|column)|delete\s+from|truncate|update\s+[\w."]+\s+set|insert\s+into|enable\s+row\s+level\s+security|disable\s+row\s+level\s+security|add\s+constraint)\b/i;
const FN_OR_POLICY = /\b(create\s+(or\s+replace\s+)?(function|trigger|view)|create\s+policy|alter\s+policy|revoke|grant)\b/i;

function classifyMigration(sql) {
  const body = String(sql || '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (RISKY.test(body)) return 'needs review: destructive or data-changing statement';
  if (FN_OR_POLICY.test(body)) return 'needs review: changes a function, policy or view that live code relies on';
  return 'additive-only: new tables, columns or indexes';
}

const KEY_LINE = 'schema-drift-key: verify-supabase-schema';

function buildCard({ entries, runUrl, readSql }) {
  const files = entries.map((e) => e.file);
  const lines = [
    'START-NOW: a committed Supabase migration is not applied to prod. Any worker may take it once the Mac drain has not claimed it.',
    KEY_LINE,
    '',
    `verify-schema.yml found ${files.length} migration file(s) not applied to the prod database. App features that need them fail until they are applied (2026-08-09 and 2026-10-28 incidents).`,
    runUrl ? `Run: ${runUrl}` : '',
    '',
  ];
  for (const e of entries) {
    const sql = readSql ? readSql(e.file) : '';
    lines.push(`Migration: supabase/migrations/${e.file}${sql ? ` [${classifyMigration(sql)}]` : ''}`);
    for (const m of e.missing.slice(0, 8)) lines.push(`  missing: ${m}`);
    for (const d of e.drifted.slice(0, 4)) lines.push(`  function body differs: ${d}`);
    lines.push(`  ${applyCommand(e.file)}`);
  }
  lines.push(
    '',
    'What to do: read each migration file and confirm the intent still holds (the commit that added it names the feature). If it is wanted, run the apply command above for each file, oldest first (apply-migration.yml writes to production and is manual on purpose). If the migration was superseded or is wrong, say so in a comment and fix the migration or its expectations instead.',
    'Then re-run verify-schema.yml and quote that it passes before closing. The live result is only known after the workflow runs.',
    'The owner is not emailed for this; the card is the alert.',
    'VERIFY: node --test tests/unit/schema-drift-card.test.mjs',
  );
  return {
    title: `Prod is missing ${files.length === 1 ? 'migration ' + files[0] : files.length + ' migrations'}: apply via apply-migration workflow`,
    description: lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n'),
  };
}

// The verify run failed but its log names no migration: API outage, expired
// token, or a verifier output change that parseVerifyLog no longer matches.
function buildUnparsedCard({ tail, runUrl }) {
  return {
    title: 'verify-schema failed without naming a migration: find the cause',
    description: [
      'START-NOW: the scheduled prod schema check failed and its log names no unapplied migration. Any worker may take it once the Mac drain has not claimed it.',
      KEY_LINE,
      '',
      runUrl ? `Run: ${runUrl}` : '',
      'Last log lines:',
      String(tail || '(empty log)'),
      '',
      'What to do: read the run log. An HTTP or token error means SUPABASE_ACCESS_TOKEN or the Management API needs attention (tell the owner on this card if a new token is needed). If the log lists missing objects in a new wording, update parseVerifyLog in scripts/lib/schema-drift-card.js and its test, then apply the named migrations.',
      'Re-run verify-schema.yml and quote that it passes before closing.',
      'VERIFY: node --test tests/unit/schema-drift-card.test.mjs',
    ].filter((l) => l !== '').join('\n'),
  };
}

module.exports = { parseVerifyLog, buildCard, buildUnparsedCard, classifyMigration, applyCommand, KEY_LINE };
