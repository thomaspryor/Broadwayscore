#!/usr/bin/env node

/**
 * Task #1069. Prevents the vacuous-gate class (#1063 lineage) recurring a
 * seventh time: a NEW audit-*.js promoted to a blocking `--gate` step in
 * test.yml that walks data/review-texts but never calls
 * scripts/lib/corpus-scan-guard.js's assertCorpusScanned() reports a clean
 * pass when the private review-texts checkout is missing or empty — the
 * exact bug fixed reactively across #1063/#1065/#1066/#1067/#1068 (10
 * scripts total, 5+ sessions).
 *
 * Scope is deliberately narrow: only --gate-wired scripts that ACTUALLY
 * walk review-texts (source contains both 'review-texts' and 'readdirSync')
 * need the guard. Several --gate-wired audits (cast-changes,
 * cast-contamination, commercial-contamination, audience-buzz-contamination,
 * critic-consensus-contamination) gate on a different corpus entirely and
 * correctly have no assertCorpusScanned call — flagging them would be a
 * false positive, not prevention.
 */

'use strict';

const GATE_INVOCATION_RE = /\bnode\s+scripts\/(audit-[\w.-]+\.js)\b([^\n]*)/;
const GATE_FLAG_RE = /(^|\s)--gate(\s|$)/;
const REVIEW_TEXTS_RE = /review-texts/;
const READDIR_RE = /readdirSync/;
const GUARD_RE = /assertCorpusScanned|corpus-scan-guard/;

/**
 * Merges shell line-continuations (a line ending in a trailing `\`) into one
 * logical line, keyed to the line number of the FIRST physical line — so a
 * step written as:
 *   run: node scripts/audit-foo.js \
 *     --gate
 * is matched the same as a single-line invocation. Without this, a future
 * gate step that wraps onto a second line for readability (as
 * audit-self-contradictory-clears.js's `--gate --max=780` already hints a
 * script could grow into) would be silently invisible to this lint —
 * exactly the "next audit reintroduces the bug" gap this check exists to
 * close.
 */
function joinContinuationLines(lines) {
  const joined = [];
  let buffer = null;
  let startLineNum = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const continues = /\\\s*$/.test(line);
    const stripped = line.replace(/\\\s*$/, '');
    if (buffer === null) {
      buffer = stripped;
      startLineNum = i + 1;
    } else {
      buffer += ' ' + stripped.trimStart();
    }
    if (!continues) {
      joined.push({ text: buffer, line: startLineNum });
      buffer = null;
      startLineNum = null;
    }
  }
  if (buffer !== null) joined.push({ text: buffer, line: startLineNum });
  return joined;
}

/**
 * Every `node scripts/audit-*.js ... --gate` invocation found in the raw
 * workflow YAML text, one entry per (script, line). Skips commented-out
 * lines. Line-based (not a full YAML parse), but joins `\`-continued lines
 * first so a --gate flag wrapped onto a second line is still caught.
 */
function parseGateWiredAudits(workflowText) {
  const results = [];
  const logicalLines = joinContinuationLines(workflowText.split('\n'));
  for (const { text, line } of logicalLines) {
    if (text.trim().startsWith('#')) continue;
    const m = GATE_INVOCATION_RE.exec(text);
    if (!m) continue;
    const [, script, rest] = m;
    if (!GATE_FLAG_RE.test(rest)) continue;
    results.push({ script, line });
  }
  return results;
}

/** True if the script's source walks data/review-texts (readdirSync over a review-texts path). */
function isReviewTextsCorpusScanner(source) {
  return REVIEW_TEXTS_RE.test(source) && READDIR_RE.test(source);
}

/** True if the script calls assertCorpusScanned (or requires the guard lib directly). */
function hasCorpusGuard(source) {
  return GUARD_RE.test(source);
}

/**
 * getScriptSource(scriptFileName) -> source string, or null if the file
 * doesn't exist on disk. Injected so this stays pure/testable — the CLI
 * wrapper wires it to fs.readFileSync.
 */
function findUnguardedGateAudits({ workflowText, getScriptSource }) {
  const wired = parseGateWiredAudits(workflowText);
  const violations = [];
  const missingScripts = [];
  const checked = new Set();

  for (const { script, line } of wired) {
    if (checked.has(script)) continue;
    checked.add(script);

    const source = getScriptSource(script);
    if (source == null) {
      missingScripts.push({ script, line });
      continue;
    }
    if (isReviewTextsCorpusScanner(source) && !hasCorpusGuard(source)) {
      violations.push({ script, line });
    }
  }

  return { violations, missingScripts, wiredCount: wired.length };
}

module.exports = {
  joinContinuationLines,
  parseGateWiredAudits,
  isReviewTextsCorpusScanner,
  hasCorpusGuard,
  findUnguardedGateAudits,
};
