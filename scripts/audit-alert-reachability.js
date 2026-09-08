#!/usr/bin/env node
/**
 * Advisory guard (BRO-2817): flag page-worthy alert steps that become
 * unreachable once an earlier step in the same job hard-fails without the
 * later step carrying `if: always()`.
 *
 * BRO-2815 class: opening-night-broadcast.yml's "Alert if broadcast overdue"
 * step called routeAlert() with conditionKey 'broadcast:overdue:' (a
 * PAGE_WORTHY_PREFIXES entry — see scripts/lib/page-worthy-alerts.js) but had
 * no `if: always()`. GitHub Actions skips a step by default once any earlier
 * step in the same job fails — exactly the checklist_gate/drift_gate
 * process.exit(1) gates upstream of it — so the ONE alert meant to page the
 * owner when the pipeline is stuck silently never ran, precisely when paging
 * mattered most. Fixed reactively for that one step; this audit is the
 * systematic version so the next occurrence doesn't need someone to notice
 * the alert ledger has zero entries for a known-emitted conditionKey.
 *
 * Detection (per job, walking steps in declaration order):
 *   1. A step "can hard-fail" if it has a `run:` block, is not
 *      `continue-on-error: true`, and that block either contains
 *      `process.exit(1)` or has at least one non-empty, non-comment line
 *      that isn't `|| true`-guarded. This is a heuristic for "GitHub Actions'
 *      default per-step failure propagation applies here" — not a real shell
 *      analyzer. False positives are expected (a command that in practice
 *      never fails still "counts"); that's fine, because the finding only
 *      fires downstream on a step that ALSO emits a page-worthy alert, which
 *      is rare.
 *   2. Once such a step has been seen, every LATER step in the same job that
 *      calls `routeAlert({ conditionKey: ..., disposition: 'human', ... })`
 *      with a conditionKey resolving as page-worthy (against
 *      scripts/lib/page-worthy-alerts.js's PAGE_WORTHY_PREFIXES /
 *      PAGE_WORTHY_CONDITION_KEYS) is flagged UNLESS that step's own `if:`
 *      contains `always()`.
 *   Only `disposition: 'human'` calls are checked — 'auto'/'digest' calls
 *   never reach the page-worthy gate in owner-alert-router.js regardless of
 *   conditionKey, so flagging them would be pure noise.
 *
 * conditionKey is usually built with a dynamic suffix (`'broadcast:overdue:'
 * + (process.env.OVERDUE_IDS || 'unknown')`, or a template literal like
 * `` `cron-health-chronic:${name}` ``) — only the literal PREFIX before the
 * concatenation/interpolation is extracted. That literal is always a prefix
 * of the real runtime conditionKey, so `literal.startsWith(pageWorthyPrefix)`
 * is a sound (if conservative) proxy for "the real key would be page-worthy".
 *
 * Non-blocking by design (same rationale as scripts/audit-run-budget-coverage.js
 * and scripts/audit-workflow-secret-gaps.js): plain-regex/indent-based YAML
 * parsing, not a real parser or a JS analyzer. Needs a period of
 * human-reviewed warnings before it's trustworthy enough to fail CI.
 *
 * Known blind spot (second-opinion review, BRO-2817): this only parses
 * `routeAlert(...)` calls INLINED in a workflow's own `run:` blocks. Of the 6
 * PAGE_WORTHY_PREFIXES/PAGE_WORTHY_CONDITION_KEYS entries, only
 * 'broadcast:overdue:' is ever called that way — the other 5
 * ('on-monitor-launch-failed-', 'on-monitor-auth-failed-',
 * 'on-monitor-attempts-exhausted-', 'broadcast:draft-creation-failed:',
 * 'broadcast:never-sent:') are emitted from inside invoked scripts/*.js files
 * (opening-night-monitor-launch.js, send-opening-night-broadcast.js,
 * check-missed-broadcasts.js), which this audit does not read at all. A
 * BRO-2815-class bug in one of those 5 is invisible to this tool. Extending
 * detection one hop into invoked scripts (mirroring how
 * scripts/lib/workflow-secret-scan.js traces script invocations for
 * audit-workflow-secret-gaps.js) would close this gap but is real, separate
 * work — not done here.
 *
 * Suppress a false positive for a whole workflow file:
 *   # audit-alert-reachability-ok: <reason>
 *
 * No external deps (js-yaml is not a direct project dependency — see
 * scripts/audit-workflow-concurrency.js's header for the same convention).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const ANNOTATION = 'audit-alert-reachability-ok';

const { PAGE_WORTHY_PREFIXES, PAGE_WORTHY_CONDITION_KEYS } = require('./lib/page-worthy-alerts.js');

// --- indent-based YAML block parsing (same convention as
// scripts/audit-run-budget-coverage.js's getJobBlocks/getStepBlocks) --------

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

/** Direct (one-level-deeper) non-blank child lines of the header at `startIdx`. */
function directChildren(lines, startIdx) {
  const headerIndent = indentOf(lines[startIdx]);
  let childIndent = null;
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const ind = indentOf(line);
    if (ind <= headerIndent) break;
    if (childIndent === null) childIndent = ind;
    if (ind === childIndent) out.push({ idx: i, line });
  }
  return out;
}

function findChild(lines, startIdx, re) {
  return directChildren(lines, startIdx).find((c) => re.test(c.line.trim())) || null;
}

function inlineValue(line) {
  const trimmed = line.trim();
  return trimmed.slice(trimmed.indexOf(':') + 1).trim();
}

// A step is a YAML sequence item ("- name: Foo"), so its FIRST field is
// usually fused onto the dash line itself — directChildren(lines, h.idx)
// only sees lines AFTER h.idx, so a naive findChild(lines, h.idx, ...) can
// never match that fused field (e.g. "- name: Gate" was silently read as
// "(unnamed step)" until this was caught by this file's own colocated test).
// `fieldLike` strips a leading "- " purely for the regex match; inlineValue
// still reads the real line, where it works unmodified (the first ':' still
// separates the field name from its value either way).
function fieldLike(line) {
  return line.trim().replace(/^-\s*/, '');
}

/** Finds a step-level field, checking the dash header line itself first (see fieldLike above), then its indented children. */
function findStepField(lines, headerIdx, re) {
  if (re.test(fieldLike(lines[headerIdx]))) return { idx: headerIdx };
  const child = directChildren(lines, headerIdx).find((c) => re.test(fieldLike(c.line)));
  return child || null;
}

/** Splits a job's `steps:` list into per-step {name, ifRaw, continueOnError, run}. */
function getStepBlocks(lines, stepsHeaderIdx, jobEndIdx) {
  const stepHeaders = directChildren(lines, stepsHeaderIdx); // each "- name: ..." / "- uses: ..." / "- run: ..." line
  return stepHeaders.map((h, i) => {
    const endIdx = i + 1 < stepHeaders.length ? stepHeaders[i + 1].idx : jobEndIdx;
    const nameEntry = findStepField(lines, h.idx, /^name\s*:/);
    const ifEntry = findStepField(lines, h.idx, /^if\s*:/);
    const coEntry = findStepField(lines, h.idx, /^continue-on-error\s*:/);
    const runEntry = findStepField(lines, h.idx, /^run\s*:/);

    let run = '';
    if (runEntry) {
      const inline = inlineValue(lines[runEntry.idx]);
      if (inline && !inline.startsWith('|') && !inline.startsWith('>')) {
        run = inline;
      } else {
        const runIndent = indentOf(lines[runEntry.idx]);
        const bodyLines = [];
        for (let j = runEntry.idx + 1; j < endIdx; j++) {
          if (lines[j].trim() === '') { bodyLines.push(''); continue; }
          if (indentOf(lines[j]) <= runIndent) break;
          bodyLines.push(lines[j]);
        }
        run = bodyLines.join('\n');
      }
    }

    return {
      name: nameEntry ? inlineValue(lines[nameEntry.idx]) : '(unnamed step)',
      ifRaw: ifEntry ? inlineValue(lines[ifEntry.idx]) : null,
      continueOnError: coEntry ? inlineValue(lines[coEntry.idx]) === 'true' : false,
      run,
    };
  });
}

/** Splits the `jobs:` block into per-job {name, steps}. */
function getJobBlocks(raw) {
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l) && indentOf(l) === 0);
  if (jobsIdx === -1) return [];
  const jobHeaders = directChildren(lines, jobsIdx);
  let jobsEnd = lines.length;
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indentOf(lines[i]) <= indentOf(lines[jobsIdx])) { jobsEnd = i; break; }
  }
  return jobHeaders.map((h, i) => {
    const name = h.line.trim().replace(/:.*$/, '');
    const jobEndIdx = i + 1 < jobHeaders.length ? jobHeaders[i + 1].idx : jobsEnd;
    const stepsEntry = findChild(lines, h.idx, /^steps\s*:/);
    const steps = stepsEntry ? getStepBlocks(lines, stepsEntry.idx, jobEndIdx) : [];
    return { name, steps };
  });
}

// --- hard-fail-gate heuristic -----------------------------------------------

const EXIT_1_RE = /\bprocess\.exit\(\s*1\s*\)/;
const TRAILING_OR_TRUE_RE = /\|\|\s*true\s*$/;

/** True if `runText` has at least one line that isn't `|| true`-guarded (i.e. can propagate a non-zero exit). */
function hasUnguardedCommand(runText) {
  const lines = runText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.some((l) => !TRAILING_OR_TRUE_RE.test(l));
}

/** True if this step's failure would, by default GitHub Actions semantics, skip later steps lacking `if: always()`. */
function stepCanHardFail(step) {
  if (!step || !step.run) return false;
  if (step.continueOnError) return false;
  if (EXIT_1_RE.test(step.run)) return true;
  return hasUnguardedCommand(step.run);
}

function stepIfHasAlways(step) {
  return Boolean(step && step.ifRaw && /\balways\(\)/.test(step.ifRaw));
}

// --- routeAlert() call extraction -------------------------------------------

const ROUTE_ALERT_START_RE = /routeAlert\s*\(/g;
const CONDITION_KEY_RE = /conditionKey\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*?)(?:\$\{|`))/;
const DISPOSITION_RE = /disposition\s*:\s*(?:'([^']*)'|"([^"]*)")/;

/** Splits `runText` into one chunk per `routeAlert(...)` call site (chunk runs to the next call or end of text). */
function splitRouteAlertCalls(runText) {
  if (!runText) return [];
  const starts = [];
  const re = new RegExp(ROUTE_ALERT_START_RE);
  let m;
  while ((m = re.exec(runText)) !== null) starts.push(m.index);
  return starts.map((start, i) => runText.slice(start, i + 1 < starts.length ? starts[i + 1] : runText.length));
}

/** Every `routeAlert({...})` call in `runText` as `{ conditionKeyLiteral, disposition }` (conditionKeyLiteral is the literal prefix before any concatenation/interpolation). */
function extractRouteAlertCalls(runText) {
  return splitRouteAlertCalls(runText)
    .map((chunk) => {
      const keyMatch = CONDITION_KEY_RE.exec(chunk);
      const dispMatch = DISPOSITION_RE.exec(chunk);
      if (!keyMatch) return null;
      const conditionKeyLiteral = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3] ?? '';
      const disposition = dispMatch ? (dispMatch[1] ?? dispMatch[2] ?? null) : null;
      return { conditionKeyLiteral, disposition };
    })
    .filter(Boolean);
}

/** True if `literal` (a known-good PREFIX of the real runtime conditionKey) resolves as page-worthy. */
function isPageWorthyLiteralPrefix(literal) {
  if (!literal) return false;
  if (PAGE_WORTHY_CONDITION_KEYS.has(literal)) return true;
  return PAGE_WORTHY_PREFIXES.some((p) => literal.startsWith(p));
}

// --- per-job reachability scan ----------------------------------------------

/** Unreachable page-worthy alerts across all jobs: [{ job, step, conditionKey }]. */
function findUnreachableAlerts(jobs) {
  const findings = [];
  for (const job of jobs) {
    let hardFailSeen = false;
    for (const step of job.steps) {
      for (const call of extractRouteAlertCalls(step.run)) {
        if (call.disposition !== 'human') continue;
        if (!isPageWorthyLiteralPrefix(call.conditionKeyLiteral)) continue;
        if (!hardFailSeen) continue;
        if (stepIfHasAlways(step)) continue;
        findings.push({ job: job.name, step: step.name, conditionKey: call.conditionKeyLiteral });
      }
      if (stepCanHardFail(step)) hardFailSeen = true;
    }
  }
  return findings;
}

// --- corpus scan -------------------------------------------------------------

/**
 * Scans the live .github/workflows/ corpus. Pure core (no printing/exit
 * behavior) — both main() and the colocated test call this (CLAUDE.md §15:
 * tests require() the real function, never re-implement its scan logic).
 */
function collectFindings(workflowDir = WORKFLOW_DIR) {
  const files = fs
    .readdirSync(workflowDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  const findings = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(workflowDir, file), 'utf8');
    if (raw.includes(`${ANNOTATION}:`)) continue;
    for (const f of findUnreachableAlerts(getJobBlocks(raw))) {
      findings.push({ workflow: file, ...f });
    }
  }
  return { files, findings };
}

function main() {
  // Advisory tools must never break the CI job hosting them (same rationale
  // as audit-workflow-secret-gaps.js): an unexpected malformed-workflow parse
  // error here must not fail a job whose whole point is a soft warning.
  try {
    const { files, findings } = collectFindings();

    if (findings.length === 0) {
      console.log(`✅ Alert-reachability guard: no unreachable page-worthy alerts found (${files.length} workflows checked).`);
    } else {
      console.log(`::warning::audit-alert-reachability: ${findings.length} page-worthy alert step(s) are unreachable after an earlier hard-fail gate (BRO-2815 class):`);
      for (const f of findings) {
        console.log(`  ${f.workflow} :: job "${f.job}" :: step "${f.step}" -> conditionKey '${f.conditionKey}' (missing if: always())`);
      }
      console.log('Fix: add `always()` to the alert step\'s `if:` condition (see opening-night-broadcast.yml\'s "Alert if broadcast overdue" step for the pattern).');
      console.log(`Exempt (false positive): add  # ${ANNOTATION}: <reason>  anywhere in the workflow file.`);
    }
  } catch (err) {
    console.log(`::warning::audit-alert-reachability crashed (${err.message}) — treating as no findings rather than failing the job (see file header).`);
  }
  process.exit(0); // advisory — never fails CI (see file header)
}

module.exports = {
  getJobBlocks,
  getStepBlocks,
  stepCanHardFail,
  stepIfHasAlways,
  hasUnguardedCommand,
  extractRouteAlertCalls,
  splitRouteAlertCalls,
  isPageWorthyLiteralPrefix,
  findUnreachableAlerts,
  collectFindings,
};

if (require.main === module) main();
