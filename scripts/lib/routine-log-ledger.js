/**
 * routine-log-ledger.js — dated routine logs ("Opening-night watch 2026-10-22",
 * "Opening-night audit <date>", "Week in Review ... <date>") are records, not work.
 * Filed as Linear cards they were ~30 of 1,135 cards in 14 days, all closed or left
 * parked, and they inflated the digest's Added/Closed (BRO-6130). They go to a
 * ledger instead; `linear-brain.js create` diverts them here. BRO-6151: the
 * local JSONL is only a cache. Each entry is also a comment on BRO-6130,
 * the existing routine-log parent, so cloud disposal cannot lose the record.
 *
 * Matching, a local append and durable comments. The title rule is the one board-numbers.js
 * ceremonyKind already uses, so a card that still reaches Linear is still counted
 * as a record there.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LEDGER_REL = 'data/audit/routine-logs.jsonl';
const LEDGER_ISSUE = 'BRO-6130';

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

// Only return a card-check id after Linear confirms the durable write. On any
// failure the caller files a normal card instead of reporting a lost log as saved.
async function recordRoutineLog(options, client = require('./linear-client')) {
  const entry = appendRoutineLog(options);
  const issue = await client.getIssue(LEDGER_ISSUE);
  if (!issue || !issue.id) throw new Error(`Routine ledger card ${LEDGER_ISSUE} not found`);
  const { row } = entry;
  const body = `## Routine log: ${row.title}\n\nRecorded: ${row.ts}\nSource: ${row.source}\n\n${row.notes}`;
  const comment = await client.createComment(issue.id, body);
  if (!comment || comment.success !== true) throw new Error(`Routine ledger comment on ${LEDGER_ISSUE} failed`);
  return { ...entry, identifier: LEDGER_ISSUE };
}

module.exports = { isRoutineLogTitle, appendRoutineLog, recordRoutineLog, ROUTINE_LOG_TITLE_RES, LEDGER_REL, LEDGER_ISSUE };
