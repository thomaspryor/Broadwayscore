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
// Reused, not reimplemented (CLAUDE.md rule 15) — same email pattern
// scripts/lint-committed-pii.js already enforces against data/audit/*.json[l].
const { EMAIL_RE } = require('./pii-scan');

const EMAIL_RE_GLOBAL = new RegExp(EMAIL_RE.source, 'g');

/**
 * Outcome text is two years of session prose written for internal debugging,
 * not for public consumption — a real contest entrant's personal email
 * address (a genuine third-party PII leak, adversarial review, BRO-376) was
 * found sitting in one card's incident-response notes. Every email-shaped
 * string is stripped before this ever reaches a committed, PUBLIC-repo file,
 * including the owner's own — a blanket rule needs no per-address judgment
 * call, and the archive's value is the qualitative "what/why/gotchas", not
 * literal contact addresses.
 */
function redactEmails(text) {
  return String(text || '').replace(EMAIL_RE_GLOBAL, '[email-redacted]');
}

/**
 * One row for a card that is being archived (not going live in Linear) and
 * carries a non-empty Outcome. `disposition` is included for provenance —
 * why the card left the live-import path — but is never itself the filter;
 * the filter is "not live" AND "has something worth keeping".
 */
function extractOutcomeRow(record) {
  const props = (record && record.properties) || {};
  const fields = (record && record.fields) || {};
  // fields.outcome/keyFiles are what notion-corpus.js's buildRecord() always
  // populates (it seeds them FROM properties.Outcome/'Key Files' and only
  // improves on that via body-overflow reassembly), so for every record this
  // export actually reads, fields is never less complete than properties. But
  // a record that skipped buildRecord() — a hand-built fixture, or a future
  // lighter-weight export shape — can carry `properties` with no `fields` at
  // all, and reading fields alone would silently drop real Outcome text. The
  // real importer already treats this as a real fallback, not a hypothetical
  // one (scripts/linear-import-corpus.js buildDescription(): `f.outcome ||
  // p.Outcome`) — matched here so this export can't be less complete than the
  // importer whose decisions it exists to double-check (codebase review,
  // BRO-376).
  const outcome = String(fields.outcome || props.Outcome || '').trim();
  if (!outcome) return null;

  const disposition = classifyCorpusRecord(record).disposition;
  if (disposition === 'live') return null; // stays on the live board — not archived

  const pageId = record && record.id;
  if (!pageId) {
    // JSON.stringify silently DROPS an undefined-valued key — a row with no
    // pageId would write to the file with no way to ever tell which Notion
    // page it came from, defeating the one property ("keyed by Notion page
    // ID") this whole export exists to guarantee. Every record this exporter
    // actually reads has an id (notion-corpus.js's buildRecord() sets it from
    // page.id, and Notion pages always have one) — this can only fire against
    // a malformed or hand-built input, and it must be loud, not silent.
    throw new Error(`extractOutcomeRow: record has no id — cannot key an Outcome row (title: ${JSON.stringify(props.Name || null)})`);
  }

  const keyFiles = String(fields.keyFiles || props['Key Files'] || '').trim() || null;
  const title = String(props.Name || '').trim() || null;

  return {
    pageId,
    title: title ? redactEmails(title) : null,
    outcome: redactEmails(outcome),
    keyFiles: keyFiles ? redactEmails(keyFiles) : null,
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
 *
 * Throws on a duplicate pageId rather than silently keeping both rows — the
 * corpus itself is deduped by id at export time (export-notion-corpus.js's
 * `byId.set()` finalize step), so a duplicate here means the corpus this ran
 * against is not what it claims to be, and the archive's one-row-per-page
 * guarantee would otherwise be violated silently.
 */
function buildOutcomeHistory(records) {
  const rows = [];
  const seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const row = extractOutcomeRow(record);
    if (!row) continue;
    if (seen.has(row.pageId)) {
      throw new Error(`buildOutcomeHistory: duplicate pageId ${row.pageId} — corpus is not deduped as expected`);
    }
    seen.add(row.pageId);
    rows.push(row);
  }
  rows.sort((a, b) => (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0));
  return rows;
}

module.exports = { extractOutcomeRow, buildOutcomeHistory, redactEmails };
