'use strict';

/**
 * claude-session-cost-writer.js (BRO-5671): the only writer of data/audit/claude-session-cost.jsonl,
 * used by scripts/record-claude-session-cost.js. Kept out of claude-session-cost.js so the readers
 * (validate-data.js, board-numbers.js) carry no write path into data/audit.
 */

const fs = require('fs');
const path = require('path');
const { validateRow, ledgerPath } = require('./claude-session-cost.js');

/**
 * Append rows (validated). One row per (date, session): a re-run the same day replaces that
 * day's row for the session instead of adding a second one. -> { written, replaced }.
 */
function appendRows(newRows, { file = ledgerPath(), fsImpl = fs } = {}) {
  for (const r of newRows) {
    const problems = validateRow(r);
    if (problems.length) throw new Error(`refusing invalid ledger row for ${r && r.session}: ${problems.join('; ')}`);
  }
  let existing = '';
  try { existing = fsImpl.readFileSync(file, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  const keyOf = (r) => `${r.date}\u0000${r.session}`;
  const incoming = new Map(newRows.map((r) => [keyOf(r), r]));
  let replaced = 0;
  const kept = [];
  for (const raw of existing.split('\n')) {
    if (!raw.trim()) continue;
    let row = null;
    try { row = JSON.parse(raw); } catch { /* keep unparseable lines as-is so validate-data reports them */ }
    if (row && incoming.has(keyOf(row))) { replaced += 1; continue; }
    kept.push(raw);
  }
  const lines = [...kept, ...[...incoming.values()].map((r) => JSON.stringify(r))];
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, `${lines.join('\n')}\n`);
  return { written: incoming.size, replaced };
}

module.exports = { appendRows };
