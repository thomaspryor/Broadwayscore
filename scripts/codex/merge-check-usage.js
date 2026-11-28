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

const MAX_ROWS = 200;
const MAX_TOTAL_USD = 40; // a run's whole check budget is far below this
const WINDOW_MS = 8 * 3600_000; // a run lasts at most ~5h
const MAX_ROW_USD = 25; // above any real check (the runner caps one at --check-max-usd)

/** One scratch line -> a clean ledger row, or null. Pure. */
function sanitizeRow(line, { nowMs = Date.now(), runId = process.env.GITHUB_RUN_ID || null } = {}) {
  let r;
  try { r = JSON.parse(line); } catch { return null; }
  if (!r || typeof r !== 'object' || r.provider !== 'anthropic') return null;
  if (typeof r.ts !== 'string' || !(r.costUsd === null || typeof r.costUsd === 'number')) return null;
  const ts = new Date(r.ts);
  if (Number.isNaN(ts.getTime()) || ts.getTime() > nowMs + 600_000 || ts.getTime() < nowMs - WINDOW_MS) return null;
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
    runId, // the merging run's own id: a row cannot claim another run
  });
}

function sanitizeFile(text, opts = {}) {
  const rows = String(text).split('\n').filter(Boolean).slice(0, MAX_ROWS).map((l) => { try { return sanitizeRow(l, opts); } catch { return null; } }).filter(Boolean);
  let total = 0;
  return rows.filter((r) => (total += r.costUsd || 0) <= MAX_TOTAL_USD);
}

/** A re-run of the same workflow run must not count twice. */
function alreadyMerged(ledgerText, runId) {
  return Boolean(runId) && String(ledgerText).split('\n').some((l) => l.includes('"provider":"anthropic"') && l.includes(`"runId":"${runId}"`));
}

if (require.main === module) {
  const [scratch, ledger = L.LEDGER_PATH] = process.argv.slice(2);
  if (!scratch || !fs.existsSync(scratch)) { console.log('merge-check-usage: no scratch file, nothing to merge'); process.exit(0); }
  const runId = process.env.GITHUB_RUN_ID || null;
  let existing = '';
  try { existing = fs.readFileSync(ledger, 'utf8'); } catch { /* new ledger */ }
  const rows = alreadyMerged(existing, runId) ? [] : sanitizeFile(fs.readFileSync(scratch, 'utf8'), { runId });
  if (rows.length) {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  const usd = rows.reduce((a, r) => a + (r.costUsd || 0), 0);
  console.log(`merge-check-usage: ${rows.length} row(s), $${usd.toFixed(2)} into ${ledger}`);
}

module.exports = { sanitizeRow, sanitizeFile, alreadyMerged };
