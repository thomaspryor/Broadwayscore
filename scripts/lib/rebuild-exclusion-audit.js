'use strict';
// scripts/lib/rebuild-exclusion-audit.js — per-show exclusion audit file for
// rebuild-all-reviews.js (BRO-925).
//
// scripts/lib/exclusion-logger.js already writes every exclusion event to an
// unconditional daily JSONL (data/audit/exclusions-YYYY-MM-DD.jsonl), keyed
// by nothing in particular — finding "every file excluded for show X" means
// grepping that file by hand. This module adds a second, PER-SHOW view of
// the same events: data/audit/rebuild-exclusions-{showId}.json, written once
// per rebuild run for any show that had at least one exclusion. Same
// event stream, different index — not a replacement for the daily JSONL.
//
// Pure functions only (buildShowExclusionsPayload) plus one thin fs writer,
// mirroring exclusion-logger.js's AUDIT_DIR / env-override pattern so tests
// never touch the real data/audit/ directory.

const fs = require('fs');
const path = require('path');

const AUDIT_DIR = process.env.REBUILD_EXCLUSION_AUDIT_DIR
  || path.join(__dirname, '../../data/audit');

function showExclusionsPath(showId, auditDir) {
  return path.join(auditDir || AUDIT_DIR, `rebuild-exclusions-${showId}.json`);
}

// records: [{ file, reason, evidence }] — pure, no I/O.
function buildShowExclusionsPayload(showId, records) {
  return {
    showId,
    generatedAt: new Date().toISOString(),
    count: records.length,
    exclusions: records.map((r) => ({
      file: r.file,
      reason: r.reason,
      evidence: r.evidence || {},
    })),
  };
}

// Writes nothing (returns null) for a show with zero exclusions — a full
// rebuild touches thousands of shows and most have none; skipping keeps the
// audit dir to only the shows worth looking at.
//
// Fails OPEN, not closed (matches scripts/lib/exclusion-logger.js's own
// try/catch around its JSONL append): this is an optional audit artifact
// written once per show AFTER that show's reviews are already computed — a
// full disk or a permissions error here must never abort the rebuild that
// produces the real reviews.json output (adversarial review finding,
// Codex, BRO-925).
function writeShowExclusionsFile(showId, records, auditDir) {
  if (!records || records.length === 0) return null;
  const dir = auditDir || AUDIT_DIR;
  const outPath = showExclusionsPath(showId, dir);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(buildShowExclusionsPayload(showId, records), null, 2));
    return outPath;
  } catch (err) {
    process.stderr.write(`[rebuild-exclusion-audit] File write failed for ${showId}: ${err.message}\n`);
    return null;
  }
}

module.exports = { AUDIT_DIR, showExclusionsPath, buildShowExclusionsPayload, writeShowExclusionsFile };
