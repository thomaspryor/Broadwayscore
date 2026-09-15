#!/usr/bin/env node
/**
 * audit-notion-schedule-coupling.js — BRO-3431 reopen (prevention requirement).
 *
 * The four schedules fixed for BRO-3431 (predispatch-queue-audit.js,
 * bsc-prune.js, sync-pending-review-to-notion.js, reconcile-dead-
 * completions.js) all shared one shape: a LIVE schedule — a loaded launchd
 * plist, or a `schedule:`-cron'd GitHub workflow — ran a script that read
 * the Notion task mirror (frozen 2026-08-20 at task id 1285, CLAUDE.md §6)
 * as if it were a current work source. The fix closed those four instances.
 * The owner's actual question was "are there other gaps like this?", and the
 * honest answer required a four-hour manual audit — that gap is the real
 * defect. This script makes the answer a command.
 *
 * SCOPE, DELIBERATELY NARROW: this reports COUPLING, not correctness. Some
 * coupling is intentional (Notion-side housekeeping like archiving the
 * frozen mirror itself) — those are named in NOTION_COUPLING_ALLOWLIST below
 * with a reason, exactly like every other allow/deny list in this repo
 * (`# hygiene-notify-ok: <reason>`, `NO-VERIFY: <reason>`). Everything else
 * is a candidate for a human to look at, not an accusation.
 *
 * TWO INDEPENDENT HALVES, each never-throws and degrades on its own:
 *   1. GitHub workflow half: scans .github/workflows/*.yml for an active
 *      top-level `schedule:` cron trigger, extracts the `node scripts/X.js`
 *      target(s) from its `run:` steps, and checks X.js (+ its own one-level
 *      `require('./lib/...')` local dependencies) for Notion-mirror
 *      coupling signals. Runs anywhere — this is the half that actually
 *      executes inside data-health-check.yml's ubuntu-latest job.
 *   2. Mac launchd half: shells `launchctl list`, filters to
 *      com.broadwayscore.* / com.bwsc.* LOADED agents, reads each one's
 *      ProgramArguments from ~/Library/LaunchAgents/<label>.plist, and
 *      applies the same coupling check to the script it runs. Only runs on
 *      darwin — CI has no launchd, so this half self-reports `skipped` there
 *      (same restriction check-hook-liveness.js already applies to itself
 *      for the identical reason: "MUST run on this Mac, not GitHub Actions").
 *
 * COUPLING SIGNAL: does the target script (or a same-script `require('./lib/*')`
 * it pulls in, one level deep) reference TASKS_DIR, loadTasksUnioned,
 * notionIdOf(, notion-brain.js, or @notionhq/client — the four literal
 * strings named in the BRO-3431 reopen comment as how the four original
 * instances were actually found.
 *
 * SHADOW MODE: writes data/audit/notion-schedule-coupling.json and prints a
 * summary. Never exits non-zero on a finding — a real coupling is a report
 * for a human to triage (see the allowlist), not a build failure; only a
 * script crash (never expected, but never trusted) exits 1.
 *
 * Usage:
 *   node scripts/audit-notion-schedule-coupling.js            run + write snapshot
 *   node scripts/audit-notion-schedule-coupling.js --dry-run  print only, don't write
 *   node scripts/audit-notion-schedule-coupling.js --help     show this message, do nothing else
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(REPO, '.github', 'workflows');
const SNAPSHOT_PATH = path.join(REPO, 'data', 'audit', 'notion-schedule-coupling.json');

const USAGE = `audit-notion-schedule-coupling.js — find LIVE schedules (loaded launchd
agents, or schedule:-cron'd GitHub workflows) that still run a script coupled
to the frozen Notion task mirror instead of Linear (BRO-3431 reopen).

Usage:
  node scripts/audit-notion-schedule-coupling.js            run + write snapshot
  node scripts/audit-notion-schedule-coupling.js --dry-run  print only, don't write
  node scripts/audit-notion-schedule-coupling.js --help     show this message, do nothing else
`;

// The four literal strings the BRO-3431 reopen comment named as how the
// original four instances were actually found (predispatch-queue-audit.js's
// TASKS_DIR scan, dispatch-watchdog's loadTasksUnioned, dispatch-guards.js's
// notionIdOf, and every script that simply shells notion-brain.js).
const COUPLING_SIGNALS = [
  { name: 'TASKS_DIR', re: /\bTASKS_DIR\b/ },
  { name: 'loadTasksUnioned', re: /\bloadTasksUnioned\b/ },
  { name: 'notionIdOf(', re: /\bnotionIdOf\s*\(/ },
  { name: 'notion-brain.js', re: /notion-brain\.js/ },
  { name: '@notionhq/client', re: /@notionhq\/client/ },
];

// Known-intentional coupling: Notion-side housekeeping of the frozen mirror
// itself, not a schedule mistaking it for a current work source. Each entry
// needs a reason — this list is meant to stay short and reviewed, not grow
// into a second exemption bureaucracy.
const NOTION_COUPLING_ALLOWLIST = {
  'scripts/notion-brain.js': 'is the Notion API wrapper itself, not a caller reading the mirror as a work source',
  'scripts/notion-tasks-sync.js': 'is the Notion<->task-mirror sync utility itself — its whole job is touching Notion',
  'scripts/archive-completed-tasks.js': 'archives completed cards already IN the frozen mirror — housekeeping of Notion, not dispatch from it',
  'scripts/task-store-archive.js': "merges/archives the frozen mirror's own history file — same housekeeping class as archive-completed-tasks.js",
  'scripts/lib/owner-alert-router.js': 'owns the Action Queue Notion-card channel as a deliberate current alert-routing feature (task #279) — flagging its ~30 transitive callers would be noise about a shared utility, not signal about a schedule mistaking the mirror for a work source',
  'scripts/linear-next.js': "Linear's own headless dispatcher — its notionIdOf/TASKS_DIR reads are deliberate cross-board collision guards (sessionTrackingCloneGuard-class, dispatch-guards.js) during the migration, not dispatch from the retired board",
  'scripts/linear-drain-parked.js': "Linear's own parked-card drain — same cross-board collision-guard reasoning as linear-next.js",
  'scripts/bsc-prune.js': 'legacy-mirror housekeeping (parks straggler Notion cards) — already carries the BRO-3431 fix that also parks the Linear twin when one exists',
  'scripts/bsc-reconcile.js': 'legacy-mirror housekeeping/reconciliation of straggler Notion cards, not dispatch of current work from them',
  'scripts/audit-notion-schedule-coupling.js': 'is this detector itself — its own COUPLING_SIGNALS regexes and this allowlist\'s comments literally contain the 4 signal strings as pattern definitions, which self-matches once data-health-check.yml (its own host workflow) is correctly recognized as scheduled',
};

function isAllowlisted(scriptRelPath) {
  return Object.prototype.hasOwnProperty.call(NOTION_COUPLING_ALLOWLIST, scriptRelPath);
}

/**
 * This codebase's own convention is dense why-comments (see this very file's
 * header) — CLAUDE.md files, incident postmortems and "used to do X" notes
 * routinely name notion-brain.js/TASKS_DIR in prose that has nothing to do
 * with what the code actually does at runtime. Stripping comments before
 * matching is what keeps this a signal tool rather than a comment-grep:
 * without it, `scripts/analyze-traffic-sources.js` (which requires none of
 * `./lib/load-env.js`'s coupling) still "matched" purely because load-env.js
 * has an unrelated historical comment mentioning a past notion-brain.js fix.
 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function findSignals(content) {
  const code = stripComments(content);
  return COUPLING_SIGNALS.filter((s) => s.re.test(code)).map((s) => s.name);
}

// Reduces an absolute path to a "scripts/..."-rooted relative one by finding
// the LAST "/scripts/" path segment, rather than path.relative(REPO, ...).
// Deliberate: this process's own REPO can be a worktree checkout
// (.claude/worktrees/<name>/scripts/...) while a dependency being followed
// (or a launchd plist's ProgramArguments) always points at the main checkout
// — path.relative between two different repo roots produces a bogus
// '../../../scripts/...', and even splitting on the literal repo folder name
// breaks inside a worktree path (which nests that same name a second time).
// Anchoring on the "scripts/" directory itself is stable across a worktree
// checkout, the main checkout, and a GitHub Actions checkout (which repeats
// the repo name twice: .../work/Broadwayscore/Broadwayscore/...).
function repoRelativeStable(absPath) {
  const marker = '/scripts/';
  const idx = absPath.lastIndexOf(marker);
  return idx === -1 ? absPath : `scripts/${absPath.slice(idx + marker.length)}`;
}

/**
 * Read a script + its one-level-deep local `require('./lib/...')` deps,
 * combined. A dep that is itself on NOTION_COUPLING_ALLOWLIST is skipped
 * entirely (not just filtered out of the final report) — otherwise a script
 * like check-arm-yield.js, which merely imports the allowlisted, shared
 * owner-alert-router.js for generic alert routing, would still be reported
 * "coupled" purely because that shared lib's OWN allowlisted Notion touch
 * rode along in the combined text. The allowlist check has to happen at the
 * point of inclusion, since scanWorkflowsForCoupling/scanLaunchdForCoupling
 * only ever see the entry script's own path, never its deps' paths.
 */
function readScriptWithLocalDeps(absScriptPath) {
  let content;
  try {
    content = fs.readFileSync(absScriptPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(absScriptPath);
  const codeOnly = stripComments(content);
  const localReqRe = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  let combined = content;
  let m;
  while ((m = localReqRe.exec(codeOnly))) {
    let depPath = path.resolve(dir, m[1]);
    if (!path.extname(depPath)) depPath += '.js';
    if (isAllowlisted(repoRelativeStable(depPath))) continue;
    try {
      combined += '\n' + fs.readFileSync(depPath, 'utf8');
    } catch {
      // dep not resolvable (e.g. a node_modules-relative path that happens to
      // start with './' after a build step, or a genuinely missing file) —
      // skip it, the top-level script content is still checked.
    }
  }
  return combined;
}

// ── Half 1: GitHub workflow schedules ──────────────────────────────────────

/** Does this workflow file have an active (uncommented) top-level `schedule:` cron trigger? */
function hasActiveScheduleTrigger(lines) {
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)schedule:\s*$/.exec(lines[i]);
    if (!header) continue;
    const baseIndent = header[1].length;
    // Scan forward with NO fixed line limit — this repo's own workflows
    // routinely carry long why-comments between `schedule:` and its
    // `- cron:` line (data-health-check.yml itself, the workflow that hosts
    // this very audit, has 13 comment lines between the two — an earlier
    // fixed 6-line lookahead made the scanner blind to its own host
    // workflow, confirmed via an adversarial Codex review before this
    // shipped). Blank/comment lines are skipped indefinitely; the block ends
    // only at the first real line, judged by indentation relative to
    // `schedule:` itself rather than a line count.
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= baseIndent) break; // dedented past the schedule: block — no cron found
      if (/^-\s*cron:/.test(trimmed)) return true;
    }
  }
  return false;
}

/**
 * Extract `scripts/X.js`-shaped targets that are actually EXECUTED by a
 * `node`/`npx tsx`/`npx ts-node` invocation, one line at a time.
 *
 * Deliberately NOT a whole-file regex: this repo's workflow files carry huge
 * `paths:` trigger lists and header comments that mention `scripts/*.js`
 * paths without ever running them (test.yml alone lists 150+ such paths in
 * its path-trigger filter) — matching the whole file text made an early
 * version of this scanner report the entire scripts/ directory as "coupled"
 * for every cron'd workflow, which is exactly the noise this audit exists to
 * avoid (see this file's own header: report-only signal has to stay signal).
 * Restricting to lines that actually invoke node/tsx narrows this to real
 * execution targets. `.test.mjs`/`scripts/tests/` targets are excluded: a
 * unit-test batch exercising a Notion-coupled module in CI is not the
 * "schedule mistaking the frozen mirror for a work source" shape this audit
 * looks for — see the BRO-3431 reopen comment's four original examples,
 * which are all live dispatch/report scripts, none of them test files.
 */
function extractScriptTargets(fileContent) {
  const targets = new Set();
  const invocationRe = /\b(?:node|npx\s+tsx|npx\s+ts-node)\b/;
  const pathRe = /\bscripts\/[\w./-]+\.(?:js|mjs|ts)\b/g;
  for (const line of fileContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue; // YAML/shell comment line, not an executed command
    if (!invocationRe.test(line)) continue;
    let m;
    while ((m = pathRe.exec(line))) {
      if (m[0].endsWith('.test.mjs') || m[0].startsWith('scripts/tests/')) continue;
      targets.add(m[0]);
    }
  }
  return [...targets];
}

// opts.workflowsDir/opts.repo are test-only seams (defaulting to the real
// WORKFLOWS_DIR/REPO) so unit tests can point this at a throwaway fixture
// tree instead of asserting against this repo's own live workflow set.
function scanWorkflowsForCoupling(opts = {}) {
  const workflowsDir = opts.workflowsDir || WORKFLOWS_DIR;
  const repo = opts.repo || REPO;
  const findings = [];
  let workflowFiles;
  try {
    workflowFiles = fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  } catch (e) {
    return { ok: false, reason: `cannot list ${workflowsDir}: ${e.message}`, findings: [], scannedWorkflows: 0, scannedScripts: 0 };
  }

  let scannedWorkflows = 0;
  let scannedScripts = 0;
  for (const wf of workflowFiles) {
    const abs = path.join(workflowsDir, wf);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    if (!hasActiveScheduleTrigger(lines)) continue;
    scannedWorkflows++;

    for (const rel of extractScriptTargets(content)) {
      scannedScripts++;
      if (isAllowlisted(rel)) continue;
      const absScript = path.join(repo, rel);
      const combined = readScriptWithLocalDeps(absScript);
      if (combined === null) continue; // target doesn't exist on disk — not this audit's problem
      const signals = findSignals(combined);
      if (signals.length) {
        findings.push({ workflow: wf, script: rel, signals });
      }
    }
  }

  return { ok: true, reason: null, findings, scannedWorkflows, scannedScripts };
}

// ── Half 2: Mac launchd agents ──────────────────────────────────────────────

/** Minimal ProgramArguments extractor — these plists are simple, hand-authored XML. */
function extractProgramArguments(plistXml) {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plistXml);
  if (!m) return [];
  const strs = [];
  const re = /<string>([^<]*)<\/string>/g;
  let sm;
  while ((sm = re.exec(m[1]))) strs.push(sm[1]);
  return strs;
}

function scriptFromProgramArguments(args) {
  for (const a of args) {
    if (/\.(js|mjs|sh)$/.test(a)) return a;
  }
  return null;
}

function scanLaunchdForCoupling() {
  if (os.platform() !== 'darwin') {
    return { ok: false, reason: 'not darwin — launchd is Mac-only, this half is CI-blind by design (same restriction as check-hook-liveness.js)', findings: [], scannedAgents: 0, scannedScripts: 0 };
  }

  let listOutput;
  try {
    listOutput = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 10_000 });
  } catch (e) {
    return { ok: false, reason: `launchctl list failed: ${e.message}`, findings: [], scannedAgents: 0, scannedScripts: 0 };
  }

  const labels = listOutput
    .split('\n')
    .map((l) => l.trim().split(/\s+/).pop())
    .filter((label) => label && (label.startsWith('com.broadwayscore.') || label.startsWith('com.bwsc.')));

  const findings = [];
  let scannedAgents = 0;
  let scannedScripts = 0;
  const home = os.homedir();
  for (const label of labels) {
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    let plistXml;
    try {
      plistXml = fs.readFileSync(plistPath, 'utf8');
    } catch {
      continue; // loaded but no matching plist on disk — not this audit's problem
    }
    scannedAgents++;
    const args = extractProgramArguments(plistXml);
    const scriptArg = scriptFromProgramArguments(args);
    if (!scriptArg || !scriptArg.includes('/Broadwayscore/')) continue;
    const absScript = scriptArg;
    const rel = repoRelativeStable(absScript);
    scannedScripts++;
    if (isAllowlisted(rel)) continue;
    const combined = readScriptWithLocalDeps(absScript);
    if (combined === null) continue;
    const signals = findSignals(combined);
    if (signals.length) {
      findings.push({ label, script: rel, signals });
    }
  }

  return { ok: true, reason: null, findings, scannedAgents, scannedScripts };
}

// write-then-rename, same pattern as predispatch-queue-audit.js's writeFileAtomic.
function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const dryRun = process.argv.includes('--dry-run');

  const workflowResult = scanWorkflowsForCoupling();
  const launchdResult = scanLaunchdForCoupling();

  const totalFindings = workflowResult.findings.length + launchdResult.findings.length;
  const snapshot = {
    generatedAt: new Date().toISOString(),
    workflowHalf: {
      ok: workflowResult.ok,
      reason: workflowResult.reason,
      scannedWorkflows: workflowResult.scannedWorkflows || 0,
      scannedScripts: workflowResult.scannedScripts || 0,
      findings: workflowResult.findings,
    },
    launchdHalf: {
      ok: launchdResult.ok,
      reason: launchdResult.reason,
      scannedAgents: launchdResult.scannedAgents || 0,
      scannedScripts: launchdResult.scannedScripts || 0,
      findings: launchdResult.findings,
    },
    totalFindings,
    bannerText: totalFindings === 0
      ? 'notion-schedule-coupling: 0 live schedules found reading the frozen Notion mirror'
      : `notion-schedule-coupling: ${totalFindings} live schedule(s) still reference the frozen Notion mirror — see data/audit/notion-schedule-coupling.json`,
  };

  console.log(snapshot.bannerText);
  console.log(`[audit-notion-schedule-coupling] workflow half: ok=${workflowResult.ok} scanned=${workflowResult.scannedWorkflows || 0} workflow(s)/${workflowResult.scannedScripts || 0} script(s)${workflowResult.reason ? ` (${workflowResult.reason})` : ''}`);
  console.log(`[audit-notion-schedule-coupling] launchd half:  ok=${launchdResult.ok} scanned=${launchdResult.scannedAgents || 0} agent(s)/${launchdResult.scannedScripts || 0} script(s)${launchdResult.reason ? ` (${launchdResult.reason})` : ''}`);
  for (const f of workflowResult.findings) {
    console.log(`  [workflow] ${f.workflow} -> ${f.script}: ${f.signals.join(', ')}`);
  }
  for (const f of launchdResult.findings) {
    console.log(`  [launchd]  ${f.label} -> ${f.script}: ${f.signals.join(', ')}`);
  }

  if (dryRun) return;

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileAtomic(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[audit-notion-schedule-coupling] FATAL: ${e && e.stack ? e.stack : e}`);
    process.exit(1);
  }
}

module.exports = {
  COUPLING_SIGNALS,
  NOTION_COUPLING_ALLOWLIST,
  isAllowlisted,
  findSignals,
  stripComments,
  repoRelativeStable,
  hasActiveScheduleTrigger,
  extractScriptTargets,
  extractProgramArguments,
  scriptFromProgramArguments,
  scanWorkflowsForCoupling,
  scanLaunchdForCoupling,
  SNAPSHOT_PATH,
};
