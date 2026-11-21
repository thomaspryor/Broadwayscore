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

// ─── BRO-3598: committed per-reason daily totals ──────────────────────────
// exclusions-*.jsonl and rebuild-exclusions-*.json are gitignored and live
// only on the runner that wrote them, so daily-digest.yml (a fresh checkout)
// never saw a single exclusion. A full rebuild logs its WHOLE exclusion set
// every run (one line per excluded file, ~27k lines, all distinct), so the
// useful daily signal is small: per reason, how many distinct files the
// latest full rebuild of the day excluded. Distinct-per-run counts are also
// immune to the BRO-75 false alarm (raw lines summed across N runs/day grow
// with N, not with new exclusions). Counts only, no filenames or URLs, so the
// file can be committed; rebuild-fast/rebuild-reviews already stage
// data/audit/*.json.
const DAILY_TOTALS_FILE = 'exclusion-daily-totals.json';
const DAILY_TOTALS_KEEP_DAYS = 15;
const TOP_SHOWS_PER_REASON = 3;

function dailyTotalsPath(auditDir) {
  return path.join(auditDir || AUDIT_DIR, DAILY_TOTALS_FILE);
}

// byShow: rebuild-all-reviews.js's stats.byShow ({ [showId]: { exclusions: [{file, reason}] } }).
// Returns { [reason]: { files, shows, topShows: { [showId]: n } } } — pure.
function buildExclusionTotals(byShow) {
  const perReason = new Map(); // reason -> Map<showId, Set<file>>
  for (const [showId, showStats] of Object.entries(byShow || {})) {
    for (const ex of (showStats && showStats.exclusions) || []) {
      if (!ex || !ex.reason || !ex.file || ex.file === '-') continue;
      if (!perReason.has(ex.reason)) perReason.set(ex.reason, new Map());
      const shows = perReason.get(ex.reason);
      if (!shows.has(showId)) shows.set(showId, new Set());
      shows.get(showId).add(ex.file);
    }
  }
  const out = {};
  for (const reason of [...perReason.keys()].sort()) {
    const shows = perReason.get(reason);
    const counts = [...shows.entries()].map(([id, set]) => [id, set.size]);
    counts.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out[reason] = {
      files: counts.reduce((a, [, n]) => a + n, 0),
      shows: counts.length,
      topShows: Object.fromEntries(counts.slice(0, TOP_SHOWS_PER_REASON)),
    };
  }
  return out;
}

// Latest run of a day wins; days older than keepDays are pruned — pure.
function mergeDailyTotals(existing, day, totals, keepDays = DAILY_TOTALS_KEEP_DAYS) {
  const days = { ...((existing && existing.days) || {}), [day]: totals };
  const kept = Object.keys(days).sort().slice(-keepDays);
  return { days: Object.fromEntries(kept.map((d) => [d, days[d]])) };
}

// One day per line: small diffs, and two bots touching different days never
// share a hunk when push-with-retry rebases.
function serializeDailyTotals(doc) {
  const days = Object.keys(doc.days).sort();
  const lines = days.map((d, i) => `    ${JSON.stringify(d)}: ${JSON.stringify(doc.days[d])}${i < days.length - 1 ? ',' : ''}`);
  return `{\n  "days": {\n${lines.join('\n')}${lines.length ? '\n' : ''}  }\n}\n`;
}

function readDailyTotals(auditDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(dailyTotalsPath(auditDir), 'utf8'));
    return doc && typeof doc.days === 'object' && doc.days ? doc : { days: {} };
  } catch {
    return { days: {} }; // absent or mangled by a rebase: start fresh, never crash
  }
}

// Fails open like writeShowExclusionsFile: never abort a rebuild over an audit file.
function writeDailyExclusionTotals(byShow, { auditDir, now = new Date() } = {}) {
  const outPath = dailyTotalsPath(auditDir);
  try {
    const day = now.toISOString().slice(0, 10);
    const next = mergeDailyTotals(readDailyTotals(auditDir), day, buildExclusionTotals(byShow));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, serializeDailyTotals(next));
    return outPath;
  } catch (err) {
    process.stderr.write(`[rebuild-exclusion-audit] daily totals write failed: ${err.message}\n`);
    return null;
  }
}

// ─── BRO-3508: exclusion evidence for the drop classifier prompt ─────────
// One line per dropped show, reasons sorted by count, capped so a show with
// hundreds of exclusions cannot blow the prompt budget. Returns '' when the
// rebuild wrote no file for the show (zero exclusions, or not run here).
function summarizeShowExclusionsForPrompt(showId, { auditDir, maxReasons = 4, maxExamples = 2 } = {}) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(showExclusionsPath(showId, auditDir), 'utf8'));
  } catch {
    return '';
  }
  const byReason = new Map();
  for (const ex of payload.exclusions || []) {
    if (!ex || !ex.reason) continue;
    if (!byReason.has(ex.reason)) byReason.set(ex.reason, []);
    byReason.get(ex.reason).push(ex.file);
  }
  if (byReason.size === 0) return '';
  const sorted = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const parts = sorted.slice(0, maxReasons).map(([reason, files]) => {
    const examples = files.slice(0, maxExamples).join(', ');
    return `${reason}×${files.length} (e.g. ${examples})`;
  });
  const more = sorted.length > maxReasons ? `; +${sorted.length - maxReasons} more reason(s)` : '';
  return `rebuild exclusion log: ${parts.join('; ')}${more}`;
}

module.exports = {
  AUDIT_DIR,
  showExclusionsPath,
  buildShowExclusionsPayload,
  writeShowExclusionsFile,
  DAILY_TOTALS_FILE,
  dailyTotalsPath,
  buildExclusionTotals,
  mergeDailyTotals,
  serializeDailyTotals,
  readDailyTotals,
  writeDailyExclusionTotals,
  summarizeShowExclusionsForPrompt,
};
