/**
 * routine-log-ledger.js — dated routine logs ("Opening-night watch 2026-10-22",
 * "Opening-night audit <date>", "Week in Review ... <date>") are records, not work.
 * Filed as Linear cards they were ~30 of 1,135 cards in 14 days, all closed or left
 * parked, and they inflated the digest's Added/Closed (BRO-6130). They go to an
 * append-only ledger file instead; `linear-brain.js create` diverts them here.
 *
 * Pure matching + a small append. The title rule is the one board-numbers.js
 * ceremonyKind already uses, so a card that still reaches Linear is still counted
 * as a record there.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER_REL = 'data/audit/routine-logs.jsonl';

const ROUTINE_LOG_TITLE_RES = [
  /^Opening-night (?:watch|audit) \d{4}-\d{2}-\d{2}$/i,
  /^Week in Review(?:\s*[,—:-]\s*|\s+)\d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?$/i,
];

function isRoutineLogTitle(title) {
  const t = String(title || '').trim();
  return ROUTINE_LOG_TITLE_RES.some((re) => re.test(t));
}

function appendRoutineLog({ title, notes, source, root = path.join(__dirname, '..', '..'), now = new Date() }) {
  const file = path.join(root, LEDGER_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { ts: now.toISOString(), title: String(title).trim(), source: source || 'session', notes: String(notes || '') };
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return { file, row };
}

module.exports = { isRoutineLogTitle, appendRoutineLog, ROUTINE_LOG_TITLE_RES, LEDGER_REL };
