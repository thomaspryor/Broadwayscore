#!/usr/bin/env node
// scripts/lib/import-ledger.js — the Notion→Linear import ledger, re-keyed to
// Notion pageId and append-only (S3-T2 of sprint-plan-notion-linear-cutover.md).
//
// WHY RE-KEY. The existing data/linear-import-mapping.json is a JSON object
// keyed by LOCAL MIRROR TASK ID. The mirror only ever held a subset of the
// board — it syncs P0/P1 and in-progress cards — so the ~1,700 cards Sprint 3
// has to migrate have no key in it at all, and 50 of the 255 rows that DO exist
// now point at mirror files that have since been pruned. A ledger that cannot
// name most of the things it is supposed to track cannot answer the one
// question Sprint 3's anti-join asks: "is every un-Done Notion page accounted
// for?"
//
// WHY APPEND-ONLY. The old file is rewritten whole on every create
// (saveMapping: write tmp, rename). A 1,831-card import runs for hours while CI
// commits to this repo every ~30 minutes and other sessions run their own
// tooling. Read-modify-write over that window loses entries — and it loses them
// silently, because the file stays valid JSON. One line appended per issue in
// O_APPEND mode is the fix: concurrent writers interleave lines instead of
// clobbering each other's snapshot.
//
// READ SEMANTICS: last row wins per pageId. That is what makes an append-only
// log usable as a mutable map — a correction is a new row, never an edit, so
// the history of what this migration did stays intact and `--rollback` (S3-T7b)
// has something real to roll back to.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LEDGER = 'data/linear-import-mapping.jsonl';
const LEGACY_LEDGER = 'data/linear-import-mapping.json';

/**
 * One row. `pageId` is the key; `taskId` is kept for provenance only — it is
 * the old key, and rows migrated from the legacy file may have one where new
 * rows do not.
 *
 * `pageId` may be null ONLY for legacy rows whose page could not be recovered.
 * Those rows still have to survive the migration (they name a real Linear
 * issue that really exists), but they are excluded from the anti-join by
 * definition, so they are counted and reported rather than dropped.
 */
function makeRow({ pageId, taskId = null, linearId, identifier, title, project = null, retiredReason = null, source = 'import', at = null }) {
  return {
    pageId: pageId || null,
    taskId: taskId === null || taskId === undefined ? null : String(taskId),
    linearId: linearId || null,
    identifier: identifier || null,
    title: title || null,
    project,
    retiredReason: retiredReason || null,
    source,
    at: at || new Date().toISOString(),
  };
}

function readRows(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(ledgerPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A torn line from a kill mid-append. Skipped, and surfaced by
      // ledgerStats().malformed rather than silently swallowed — a ledger that
      // quietly drops rows is worse than one that admits it.
    }
  }
  return rows;
}

/** pageId -> most recent row. Rows with no pageId are not addressable here. */
function indexByPageId(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r && r.pageId) map.set(r.pageId, r);
  }
  return map;
}

/** identifier -> most recent row. Used to prove nothing was lost in migration. */
function indexByIdentifier(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r && r.identifier) map.set(r.identifier, r);
  }
  return map;
}

function ledgerStats(ledgerPath) {
  const raw = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '';
  const lines = raw.split('\n').filter((l) => l.trim());
  const rows = readRows(ledgerPath);
  return {
    lines: lines.length,
    rows: rows.length,
    malformed: lines.length - rows.length,
    withPageId: rows.filter((r) => r.pageId).length,
    withoutPageId: rows.filter((r) => !r.pageId).length,
    distinctPageIds: indexByPageId(rows).size,
    distinctIdentifiers: indexByIdentifier(rows).size,
  };
}

/**
 * Append one row. Deliberately ONE appendFileSync of a single line: on macOS
 * and Linux an O_APPEND write smaller than PIPE_BUF is atomic with respect to
 * other appenders, so two processes writing concurrently interleave whole lines
 * rather than corrupting each other. Building the string first and writing once
 * is what preserves that — two writes (payload, then '\n') would not.
 */
function appendRow(ledgerPath, row) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
  return row;
}

/**
 * Convert the legacy task-id-keyed object into append-only rows.
 *
 * `resolvePageId(taskId, entry)` is injected — the CLI resolves via the local
 * mirror's `[notion:<id>]` marker and, for rows whose mirror file has been
 * pruned, via an unambiguous title match against the Sprint 2 corpus. Kept out
 * of here so the migration itself is a pure, testable transform.
 *
 * EVERY legacy entry produces a row, including ones whose page could not be
 * resolved. The acceptance criterion is that all 255 survive, checked by BRO
 * identifier — dropping the unresolvable ones would satisfy a pageId-shaped
 * ledger while losing real issues.
 */
function migrateLegacy(legacyMapping, resolvePageId) {
  const rows = [];
  const unresolved = [];
  for (const [taskId, entry] of Object.entries(legacyMapping || {})) {
    if (!entry) continue;
    const pageId = resolvePageId(taskId, entry) || null;
    if (!pageId) unresolved.push({ taskId, identifier: entry.identifier || null, title: entry.title || null });
    rows.push(
      makeRow({
        pageId,
        taskId,
        linearId: entry.linearId,
        identifier: entry.identifier,
        title: entry.title,
        project: entry.project || null,
        retiredReason: entry.retiredReason || null,
        source: 'legacy-migration',
        // Fixed timestamp for migrated rows: they all describe work that
        // happened before this migration, and stamping them with "now" would
        // make the ledger's own history a lie.
        at: '1970-01-01T00:00:00.000Z',
      })
    );
  }
  return { rows, unresolved };
}

/**
 * The Sprint 3 anti-join: which un-Done Notion pages have no ledger row?
 * `sourcePageIds` comes from the Sprint 2 CORPUS, not a live query — the point
 * is to prove completeness against the frozen archive, and a live query moves
 * under the check.
 */
function unaccountedPageIds(sourcePageIds, rows) {
  const have = indexByPageId(rows);
  return sourcePageIds.filter((id) => !have.has(id));
}

module.exports = {
  DEFAULT_LEDGER,
  LEGACY_LEDGER,
  makeRow,
  readRows,
  indexByPageId,
  indexByIdentifier,
  ledgerStats,
  appendRow,
  migrateLegacy,
  unaccountedPageIds,
};
