#!/usr/bin/env node
'use strict';
/**
 * Markdown job summary for promote-we-aggregator.yml (BRO-4204 S4-T10).
 *
 * Prints, for $GITHUB_STEP_SUMMARY: the ids this run promoted, the
 * candidates it rejected (and now remembers — lib/we-rejected-candidates.js),
 * and the errors validate-data raised, i.e. the ids it refused (that batch is
 * NOT pushed: validate-data arms push-core-data's sentinel). Before S4-T10 a
 * refused batch surfaced only as a `::error::` annotation inside a step that
 * always exited 0 — the same 9 "promoted" ids re-ran green daily for four
 * days without ever landing.
 *
 * Reads the promoter's own state file (data/audit/we-last-promotion-ids.json,
 * written by every non-dry-run promoter run) plus the tee'd validate-data
 * log the workflow step passes as argv[2]. Parses nothing from the jsonl
 * audit log. Pure builder exported for tests (CLAUDE.md §15).
 *
 * Usage: node scripts/we-promotion-job-summary.js [path/to/validate-data.log]
 *          [--state=data/audit/<x>-last-promotion-ids.json] [--rejected-note="<text>"]
 *
 * --state / --rejected-note (BRO-4204 S4-T12): the Off-West End promoter
 * (scripts/promote-owe-venue-candidates.js) writes the SAME state-file
 * shape to data/audit/owe-last-promotion-ids.json, so
 * promote-owe-venue-candidates.yml renders its summary through this one
 * builder instead of a copy — only the file and the "rejected" parenthetical
 * differ (OWE rejections are dropped from staging, not remembered for 90d).
 */

const fs = require('fs');
const path = require('path');
const { REJECTED_TTL_DAYS } = require('./lib/we-rejected-candidates');

const LAST_PROMOTION_FILE = path.join(__dirname, '..', 'data', 'audit', 'we-last-promotion-ids.json');
// validate-data.js's error() prints exactly `❌ ERROR: <msg>` (scripts/validate-data.js).
const VALIDATE_ERROR_RE = /❌ ERROR: (.*)$/;
const MAX_ROWS = 40;
const DEFAULT_STATE_LABEL = 'data/audit/we-last-promotion-ids.json';
const DEFAULT_REJECTED_NOTE = `remembered ${REJECTED_TTL_DAYS}d in data/audit/we-rejected-candidates.json`;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** `❌ ERROR:` lines from a validate-data log; null when there is no log. */
function validateErrorsFrom(logText) {
  if (logText == null) return null;
  return String(logText)
    .split('\n')
    .map((line) => { const m = line.match(VALIDATE_ERROR_RE); return m ? m[1].trim() : null; })
    .filter(Boolean);
}

function mdCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * @param {{lastPromotion: object|null, validateLog: string|null}} input
 *   lastPromotion — parsed we-last-promotion-ids.json ({generatedAt, promoted:[{id,...}], rejected:[{title,venue,source,kind,reason}]}) or null
 *   validateLog   — the validate-data step's captured stdout+stderr, or null when it never ran
 * @returns {string} GitHub-flavoured markdown
 */
function buildJobSummary({ lastPromotion, validateLog, stateFileLabel = DEFAULT_STATE_LABEL, rejectedNote = DEFAULT_REJECTED_NOTE }) {
  const lines = [];
  const promoted = lastPromotion && Array.isArray(lastPromotion.promoted) ? lastPromotion.promoted : [];
  const rejected = lastPromotion && Array.isArray(lastPromotion.rejected) ? lastPromotion.rejected : [];
  const errors = validateErrorsFrom(validateLog);

  if (!lastPromotion) {
    lines.push(`_No ${mdCell(stateFileLabel)} — dry run, core data missing, or the promoter did not run._`);
  } else {
    lines.push(`**Promoted this run:** ${promoted.length}${promoted.length ? ' — ' + promoted.map((p) => `\`${mdCell(p.id)}\``).join(', ') : ''}`);
    if (lastPromotion.generatedAt) lines.push(`<sub>state file written ${mdCell(lastPromotion.generatedAt)}</sub>`);
  }
  lines.push('');

  lines.push(`**Rejected this run (${rejectedNote}):** ${rejected.length}`);
  if (rejected.length) {
    lines.push('');
    lines.push('| title | venue | source | kind | reason |');
    lines.push('|---|---|---|---|---|');
    for (const r of rejected.slice(0, MAX_ROWS)) {
      lines.push(`| ${mdCell(r.title)} | ${mdCell(r.venue)} | ${mdCell(r.source)} | ${mdCell(r.kind)} | ${mdCell(r.reason)} |`);
    }
    if (rejected.length > MAX_ROWS) lines.push(`| … | | | | +${rejected.length - MAX_ROWS} more |`);
  }
  lines.push('');

  if (errors === null) {
    lines.push('**validate-data:** _no log — the step was skipped (core data missing) or did not reach validation_');
  } else if (errors.length > 0) {
    lines.push(`**validate-data:** ❌ refused (${errors.length} error(s)) — push-core-data will NOT push this batch${promoted.length ? `; the ${promoted.length} promoted id(s) above did NOT land` : ''}`);
    lines.push('');
    lines.push('```');
    for (const e of errors.slice(0, MAX_ROWS)) lines.push(e);
    if (errors.length > MAX_ROWS) lines.push(`… +${errors.length - MAX_ROWS} more`);
    lines.push('```');
  } else {
    lines.push('**validate-data:** ✅ passed');
  }

  return lines.join('\n') + '\n';
}

function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const raw = argv.find((a) => a.startsWith(`${name}=`));
    return raw ? raw.slice(name.length + 1) : null;
  };
  const logPath = argv.find((a) => !a.startsWith('--')) || null;
  const stateArg = flag('--state');
  const stateFile = stateArg ? path.resolve(process.cwd(), stateArg) : LAST_PROMOTION_FILE;
  process.stdout.write(buildJobSummary({
    lastPromotion: readJson(stateFile),
    validateLog: logPath ? readText(logPath) : null,
    stateFileLabel: stateArg || DEFAULT_STATE_LABEL,
    rejectedNote: flag('--rejected-note') || DEFAULT_REJECTED_NOTE,
  }));
}

if (require.main === module) main();

module.exports = { buildJobSummary, validateErrorsFrom, LAST_PROMOTION_FILE };
