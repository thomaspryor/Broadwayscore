#!/usr/bin/env node
// scripts/lib/notion-outcome-history.js — pure extraction of the Outcome
// knowledge on cards BRO-376's import does NOT create as a live Linear issue
// (ADDED 2026-08-17 to the BRO-376 issue description).
//
// WHY THIS EXISTS. classifyCorpusRecord (scripts/lib/linear-import-rules.js)
// decides which ~1,700 cards become a live Linear issue. Everything else —
// Done cards, low-priority "archive" cards, self-referential fleet noise — is
// left off the board. That is correct for TRIAGE (a stale digest alert is not
// backlog work) but every Done card also carries a written Outcome: what a
// session did, why, and what bit them. Discarding that when Notion is retired
// is not curation, it is losing a decade of accumulated project knowledge in
// one import run — so it is extracted to a committed, greppable file BEFORE
// any archiving happens, exactly like cloud-memory/ already is.
//
// No fetch, no fs: takes already-exported corpus records (the same shape
// notion-corpus.js's buildRecord produces) and returns plain data, so this is
// testable against a fixture instead of the 4,994-page live corpus.

'use strict';

const { classifyCorpusRecord } = require('./linear-import-rules');

/**
 * One row for a card that is being archived (not going live in Linear) and
 * carries a non-empty Outcome. `disposition` is included for provenance —
 * why the card left the live-import path — but is never itself the filter;
 * the filter is "not live" AND "has something worth keeping".
 */
function extractOutcomeRow(record) {
  const props = (record && record.properties) || {};
  const fields = (record && record.fields) || {};
  const outcome = String(fields.outcome || '').trim();
  if (!outcome) return null;

  const disposition = classifyCorpusRecord(record).disposition;
  if (disposition === 'live') return null; // stays on the live board — not archived

  return {
    pageId: record.id,
    title: String(props.Name || '').trim() || null,
    outcome,
    keyFiles: String(fields.keyFiles || '').trim() || null,
    completedDate: props['Completed Date'] || null,
    status: props.Status || null,
    disposition,
    url: record.url || null,
  };
}

/**
 * Every archived-with-knowledge row, sorted by pageId for a deterministic,
 * diffable file — the same reasoning export-notion-corpus.js uses for
 * corpus.ndjson: two runs over an unchanged board must produce byte-identical
 * output, and unsorted output makes that impossible to verify.
 */
function buildOutcomeHistory(records) {
  const rows = [];
  for (const record of Array.isArray(records) ? records : []) {
    const row = extractOutcomeRow(record);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0));
  return rows;
}

module.exports = { extractOutcomeRow, buildOutcomeHistory };
