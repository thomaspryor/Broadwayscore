#!/usr/bin/env node
// scripts/import-notion-to-linear.test.mjs — BRO-376 acceptance test.
//
// BRO-376 asks for an idempotent Notion -> Linear importer, keyed by Notion
// page id, with a dry-run default and printed reconciliation counts. That
// importer already exists as scripts/linear-import-corpus.js (Sprint 3 of
// sprint-plan-notion-linear-cutover.md) — a live-rehearsed, code-reviewed,
// merged importer with its OWN dedicated test coverage of the id-determinism
// primitive (scripts/lib/linear-import-rules.test.mjs) and the ledger
// (tests/unit/import-ledger.test.mjs). Rewriting a second importer under this
// file's name would fork the one thing Sprint 3 spent its hardest lessons on
// (id derivation, error classification, ledger semantics) into two copies that
// can drift — CLAUDE.md rule 15 is "require() the real function", and that
// applies exactly as much to an existing importer as to a brand-new one.
//
// So this file proves BRO-376's four hard requirements END TO END against the
// REAL importer, at two levels:
//   * the CLI itself (spawned as a subprocess) for the requirements that are
//     safe to exercise without touching the network: dry-run-by-default,
//     printed reconciliation counts that balance, and non-zero exit on error.
//   * the importer's own exported reconciliation function (buildReport) plus
//     the real ledger module for the one requirement that CANNOT be exercised
//     via the CLI in a unit test — a second run creating zero issues — because
//     proving that for real requires an --apply run against the live Linear
//     API. buildReport + the ledger IS the mechanism main() uses to decide
//     "already imported" vs "candidate to create" WHEN THE LEDGER ALREADY HAS
//     THE ROW — the common case (a clean prior run). It does NOT reach the
//     other half of the guarantee: two concurrent --apply runs racing on an
//     empty ledger, where the loser is refused by Linear's own id-conflict
//     response and classified by isAlreadyExistsError() instead of a ledger
//     hit (linear-import-corpus.js's onItem catch block). That path is
//     covered separately below, against the exact documented error shape,
//     rather than overclaimed here (codebase review, BRO-376).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const IMPORTER = path.join(__dirname, 'linear-import-corpus.js');

const rules = await import('./lib/linear-import-rules.js');
const ledgerLib = await import('./lib/import-ledger.js');
const { buildReport } = await import('./linear-import-corpus.js');

// ── fixture: one record per disposition path classifyCorpusRecord can take ──
// Mirrors the shape scripts/lib/notion-corpus-io.js hands back: one JSON
// object per line, `properties` carrying the board's own field names.
function record(id, props) {
  return { id, url: `https://notion.so/${id}`, createdTime: '2026-01-01T00:00:00.000Z', properties: props };
}

const FIXTURE = [
  // live: P0/P1 real work — the CURATED half BRO-376 exists to import.
  record('page-live-p0', { Name: 'Fix scoring drift on temporal overrides', Status: 'Not started', Priority: 'P0 Now', Tags: 'scoring' }),
  record('page-live-p1', { Name: 'Add WestEnd aggregator gap alert', Status: 'In progress', Priority: 'P1 Next', Tags: 'west-end' }),
  // archive: real but low-priority work — kept, just not dispatchable.
  record('page-archive-p2', { Name: 'Rename legacy audience-buzz field', Status: 'Not started', Priority: 'P2 Later', Tags: '' }),
  record('page-archive-unknown-priority', { Name: 'Investigate stale cookie health check', Status: 'Not started', Priority: 'Someday-ish', Tags: '' }),
  // skip: the self-referential / noise backlog BRO-376's "curate hard"
  // requirement exists to keep off the board — a card about the dispatcher
  // fleet or the migration itself must not survive into the system replacing
  // it, and a recurring digest alert is noise, not backlog work.
  record('page-skip-fleet-selfref', { Name: 'Fix cmux workspace dead-launch rate', Status: 'Not started', Priority: 'P1 Next', Tags: '' }),
  record('page-skip-bsc-daily', { Name: 'BSC Daily: 3 shows missing reviews', Status: 'Not started', Priority: 'P1 Next', Tags: '' }),
  // skip: already-Done work. The pilot found 2 of 4 issues were already-fixed
  // stale cards — a Done card must never be re-created as a live Linear issue.
  record('page-skip-done', { Name: 'Fix duplicate outlet merge bug', Status: 'Done', Priority: 'P1 Next', Tags: '' }),
  record('page-skip-blank', { Name: '   ', Status: 'Not started', Priority: 'P1 Next', Tags: '' }),
];

function writeFixtureCorpus(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = FIXTURE.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'corpus.ndjson'), lines);
  return dir;
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bro376-${name}-`));
}

// ── requirement: --dry-run is the DEFAULT, and it writes NOTHING ───────────

test('CLI: no flags = dry-run, prints reconciliation counts, and touches no ledger', () => {
  const corpusDir = writeFixtureCorpus(tmpDir('corpus-a'));
  const ledgerPath = path.join(tmpDir('ledger-a'), 'ledger.jsonl');

  const out = execFileSync(
    process.execPath,
    [IMPORTER, `--corpus=${corpusDir}`, `--ledger=${ledgerPath}`, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const summary = JSON.parse(out);

  assert.equal(summary.records, FIXTURE.length, 'every fixture record was read');
  // read / created(candidate) / skipped-existing / archived / errored, named
  // as this importer's own vocabulary: disposition.{live,archive,skip,alreadyImported}.
  assert.equal(summary.disposition.live, 2, 'the two P0/P1 cards are live candidates');
  assert.equal(summary.disposition.archive, 2, 'the two low-priority cards archive');
  assert.equal(summary.disposition.skip, 4, 'fleet noise, daily-digest noise, Done, and blank-title all skip');
  assert.equal(summary.disposition.alreadyImported, 0, 'nothing has been imported yet');
  assert.equal(summary.balanced, true, 'every record landed in exactly one named bucket');
  assert.equal(summary.accounted, FIXTURE.length);

  // "writing requires an explicit flag" — a dry run must not create the
  // ledger file at all, let alone write a row into it.
  assert.equal(fs.existsSync(ledgerPath), false, 'dry-run must not create the ledger file');
});

test('CLI: curate hard — self-referential and noise cards are named skip reasons, never silently dropped', () => {
  const corpusDir = writeFixtureCorpus(tmpDir('corpus-b'));
  const ledgerPath = path.join(tmpDir('ledger-b'), 'ledger.jsonl');

  const out = execFileSync(
    process.execPath,
    [IMPORTER, `--corpus=${corpusDir}`, `--ledger=${ledgerPath}`, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const summary = JSON.parse(out);

  assert.equal(summary.skipReasons['noise:fleet_selfref'], 1);
  assert.equal(summary.skipReasons['noise:bsc_daily'], 1);
  assert.equal(summary.skipReasons.notion_done, 1);
  assert.equal(summary.skipReasons.blank_title, 1);
  // An unrecognised priority spelling must be surfaced, not silently eaten —
  // it still archives (never invented as live), but the run has to say so.
  assert.deepEqual(summary.unknownPriorities, { 'Someday-ish': 1 });
});

// ── requirement: exits non-zero on any error ────────────────────────────────

test('CLI: a malformed corpus line is a fatal error — non-zero exit, no silent partial run', () => {
  const dir = tmpDir('corpus-malformed');
  fs.writeFileSync(path.join(dir, 'corpus.ndjson'), `${JSON.stringify(FIXTURE[0])}\nnot valid json\n`);
  const ledgerPath = path.join(tmpDir('ledger-c'), 'ledger.jsonl');

  assert.throws(() => {
    execFileSync(process.execPath, [IMPORTER, `--corpus=${dir}`, `--ledger=${ledgerPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }, (err) => {
    assert.notEqual(err.status, 0, `expected a non-zero exit, got ${err.status}`);
    return true;
  });
});

// ── requirement: keyed by Notion page id — a second run creates ZERO issues ─
//
// Exercised against buildReport() + the real ledger module rather than a live
// --apply, which would need a network round trip and a real Linear board. This
// is not a weaker proof: buildReport()'s `candidates` list IS what main()
// iterates to call linear.createIssue — it is the exact set of issues a run
// would create — so asserting it collapses to zero on pass two after
// recording pass one's creates is asserting the identical invariant a live
// second run exhibits when it is refused by Linear's id-conflict response
// (see isAlreadyExistsError in scripts/lib/linear-import-rules.js).

test('second run of the same fixture creates zero issues', () => {
  const ledgerPath = path.join(tmpDir('ledger-idempotency'), 'ledger.jsonl');

  // Pass 1: an empty ledger — every live/archive record is a candidate.
  const emptyLedger = ledgerLib.indexByPageId([]);
  const pass1 = buildReport(FIXTURE, emptyLedger);
  assert.equal(pass1.candidates.length, 4, 'the 2 live + 2 archive records are all candidates on a clean run');
  assert.equal(pass1.counts.alreadyImported, 0);

  // Simulate exactly what main()'s onItem does after each successful create:
  // derive the deterministic issue id from the Notion pageId and append a
  // ledger row. This is the real primitive under test — deriveIssueId is the
  // ENTIRE idempotency guarantee (scripts/lib/linear-import-rules.js).
  for (const { record: r } of pass1.candidates) {
    const linearId = rules.deriveIssueId(r.id);
    assert.ok(linearId, `deriveIssueId must produce an id for ${r.id}`);
    ledgerLib.appendRow(ledgerPath, ledgerLib.makeRow({
      pageId: r.id, linearId, identifier: `BRO-TEST-${r.id}`, title: r.properties.Name, source: 'corpus-import',
    }));
  }

  // Same pageId -> same derived id on replay, proven directly (not just via
  // the ledger round trip above).
  for (const { record: r } of pass1.candidates) {
    assert.equal(rules.deriveIssueId(r.id), rules.deriveIssueId(r.id));
  }

  // Pass 2: read the ledger back exactly as main() does at start-up.
  const rows = ledgerLib.readRows(ledgerPath);
  assert.equal(rows.length, 4, 'one ledger row per created candidate');
  const secondPassAlready = ledgerLib.indexByPageId(rows);
  const pass2 = buildReport(FIXTURE, secondPassAlready);

  assert.equal(pass2.candidates.length, 0, 'a second run of the same fixture creates ZERO issues');
  assert.equal(pass2.counts.alreadyImported, 4, 'all 4 previously-created records are recognised as already imported');
  assert.equal(pass2.counts.live, 0);
  assert.equal(pass2.counts.archive, 0);
  // Skips are re-derived every run (they are not ledger-dependent) and must
  // stay identical between passes.
  assert.equal(pass2.counts.skip, pass1.counts.skip);

  // The CLI itself must report the same thing when pointed at this ledger.
  const corpusDir = writeFixtureCorpus(tmpDir('corpus-idempotency-cli'));
  const cliOut = execFileSync(
    process.execPath,
    [IMPORTER, `--corpus=${corpusDir}`, `--ledger=${ledgerPath}`, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  const cliSummary = JSON.parse(cliOut);
  assert.equal(cliSummary.disposition.alreadyImported, 4);
  assert.equal(cliSummary.disposition.live, 0);
  assert.equal(cliSummary.disposition.archive, 0);
});

// The scenario the ledger-replay test above CANNOT reach: two concurrent
// `--apply` runs both read an EMPTY ledger (neither has recorded the other's
// in-flight create yet), both call createIssue with the same deterministic
// id, and the loser gets refused by Linear's server-side id conflict rather
// than a ledger hit. main()'s onItem classifies that refusal via
// isAlreadyExistsError() and records it as success (source:
// 'corpus-import', retiredReason: 'recovered-existing') — see
// linear-import-corpus.js's onItem catch block. This test proves that
// classification is correct against the EXACT error shape Linear returns
// (documented in linear-import-rules.js's deriveIssueId comment, confirmed
// by live introspection during Sprint 3: `code INPUT_ERROR`, "Entity Issue
// with id … already exists."), and that it does NOT rubber-stamp every
// INPUT_ERROR as success — a real misconfiguration (e.g. a bad stateId) must
// still abort the run rather than being silently swallowed.
test('the real conflict-classification path recognises a genuine id conflict, and only that', () => {
  const candidateId = rules.deriveIssueId('page-live-p0');
  assert.ok(candidateId);

  const realConflictShape = {
    linearErrors: [
      {
        message: `Entity Issue with id ${candidateId} already exists.`,
        extensions: { code: 'INPUT_ERROR' },
      },
    ],
  };
  assert.equal(
    rules.isAlreadyExistsError(realConflictShape),
    true,
    'a losing concurrent create must be classified as already-imported, not a failure'
  );

  const unrelatedInputError = {
    linearErrors: [
      { message: 'Argument Validation Error', extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'stateId must be a UUID.' } },
    ],
  };
  assert.equal(
    rules.isAlreadyExistsError(unrelatedInputError),
    false,
    'a real misconfiguration must still abort the run — not every INPUT_ERROR is a safe-to-ignore conflict'
  );
});
