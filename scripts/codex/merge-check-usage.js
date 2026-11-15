#!/usr/bin/env node
/**
 * BRO-7522: fold the Codex runner's scratch file of Claude-check cost rows into the usage ledger
 * (data/audit/gemini-usage-ledger.jsonl). Runs in a separate job from the runner, because the runner
 * job executes Codex-authored code and so keeps `contents: read`. The scratch file crossed an artifact
 * boundary, so every row is rebuilt from an allowlist of fields and anything else is dropped.
 *
 * Usage: node scripts/codex/merge-check-usage.js <scratch.jsonl> [ledger.jsonl]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('../lib/gemini-usage-ledger.js');

const MAX_ROWS = 500;
const MAX_ROW_USD = 25; // above any real check (the runner caps one at --check-max-usd)

/** One scratch line -> a clean ledger row, or null. Pure. */
function sanitizeRow(line) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || typeof r !== 'object' || r.provider !== 'anthropic') return null;
  const ts = new Date(r.ts);
  if (Number.isNaN(ts.getTime())) return null;
  const costUsd = r.costUsd === null ? null : Number(r.costUsd);
  if (costUsd !== null && !(Number.isFinite(costUsd) && costUsd >= 0 && costUsd <= MAX_ROW_USD)) return null;
  const str = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
  const model = str(r.model, /^[A-Za-z0-9._-]{1,40}$/);
  if (!model) return null;
  return L.buildClaudeCheckRow({
    model, costUsd, now: ts,
    auth: r.auth === 'oauth' ? 'oauth' : 'api-key',
    card: str(r.card, /^[A-Z]{2,6}-\d{1,6}$/),
    error: str(r.error, /^[A-Za-z0-9_ .:-]{1,60}$/),
    workflow: str(r.workflow, /^[A-Za-z0-9 ._-]{1,60}$/) || 'Codex card runner',
    runId: str(r.runId, /^\d{1,20}$/),
  });
}

function sanitizeFile(text) {
  return String(text).split('\n').filter(Boolean).slice(0, MAX_ROWS).map(sanitizeRow).filter(Boolean);
}

if (require.main === module) {
  const [scratch, ledger = L.LEDGER_PATH] = process.argv.slice(2);
  if (!scratch || !fs.existsSync(scratch)) { console.log('merge-check-usage: no scratch file, nothing to merge'); process.exit(0); }
  const rows = sanitizeFile(fs.readFileSync(scratch, 'utf8'));
  if (rows.length) {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const usd = rows.reduce((a, r) => a + (r.costUsd || 0), 0);
  console.log(`merge-check-usage: ${rows.length} row(s), $${usd.toFixed(2)} into ${ledger}`);
}

module.exports = { sanitizeRow, sanitizeFile };
