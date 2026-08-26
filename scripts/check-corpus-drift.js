#!/usr/bin/env node

/**
 * check-corpus-drift.js
 *
 * Passive monitor that runs the three CORPUS-STATISTICS audits and records a
 * single verdict to data/audit/corpus-drift.json. These audits assert on
 * properties of the live review corpus (full-text %, aggregator count ratios,
 * regex false-positive counts) that drift continuously as the CI bots commit
 * shows.json / reviews.json / review-texts every ~30 min. They are MONITORING
 * metrics, not code-correctness invariants, so they do NOT belong in the
 * blocking test.yml gate — when they flap, main goes red for non-code reasons,
 * the signal stops meaning anything, and real regressions hide in the noise.
 *
 * This script is the "separate non-blocking workflow" half of that split
 * (see .github/workflows/check-corpus-drift.yml), mirroring the established
 * check-review-count-drift.js / check-seo-health.js pattern: run daily +
 * after each rebuild, write a verdict JSON, and let scripts/health-check.js
 * surface it in the daily email digest. The catastrophe FLOOR (a genuine
 * quality collapse, not drift) stays blocking in test.yml via
 * `audit-text-quality.js --gate`.
 *
 * It runs each audit as a child process so the audit logic stays single-source
 * (no reimplementation/divergence) and records the exit code:
 *   - audit-text-quality.js        exit 0 = pass, 1 = threshold breach
 *   - validate-aggregator-truth.js exit 0 = ok/warnings, 1 = definite dup error
 *   - audit-regex-patterns.js      exit 0 = under threshold, 1 = over, 2 = scan failed
 *
 * Usage:
 *   node scripts/check-corpus-drift.js            # run audits, write json, exit 0
 *   node scripts/check-corpus-drift.js --strict   # exit 2 if any audit failed
 *   node scripts/check-corpus-drift.js --audit-out=PATH
 *
 * Exit codes:
 *   0 — always, unless --strict (this is a passive monitor; drift is not a job failure)
 *   2 — an audit reported a breach AND --strict
 *   3 — a child audit could not run at all (scan failed / crashed) — a real error
 *
 * Drift "breach" (ok:false) is NOT a workflow failure — it surfaces in the
 * digest. Only a child that cannot run (exit 3) or --strict escalates.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// BRO-2424 (port of BRO-545's guard-escalation pattern): a crashed child
// audit (exit 3) is right to fail this DAILY cron loud on its first
// occurrence, but the same crash recurring run after run (e.g. a corpus file
// that stays malformed) used to fail loud forever with no real escalation —
// its notify-failure call is `severity: 'warning'`, a no-op for anything but
// 'critical' (see .github/actions/notify-failure). See guard-escalation.js
// header for the shape this reuses.
const {
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
} = require('./lib/guard-escalation');

// Locate sibling audit scripts relative to THIS file, but run them — and write
// the verdict — relative to the invocation cwd (the repo root in CI), so the
// audits resolve data/review-texts the same way they do when run standalone.
const SCRIPTS_DIR = __dirname;
const AUDIT_OUT_DEFAULT = path.join(process.cwd(), 'data', 'audit', 'corpus-drift.json');
// Same state file check-rebuild-staleness.js uses (data/audit/, public repo,
// git-tracked) — keyed per-guard so multiple guards can share one file.
const GUARD_STATE_FILE = path.join(process.cwd(), 'data', 'audit', 'guard-escalation-state.json');
const GUARD_ID = 'corpus-drift-audit-crash';
const WORKFLOW_DISPLAY_NAME = 'Check Corpus Drift';
const ALERT_CONDITION_KEY = `guard-escalation:${GUARD_ID}`;

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadGuardState() {
  const doc = loadJSON(GUARD_STATE_FILE, {});
  return (doc && doc[GUARD_ID]) || null;
}

function saveGuardState(state) {
  const doc = loadJSON(GUARD_STATE_FILE, {});
  doc[GUARD_ID] = state;
  try {
    fs.mkdirSync(path.dirname(GUARD_STATE_FILE), { recursive: true });
    fs.writeFileSync(GUARD_STATE_FILE, JSON.stringify(doc, null, 2) + '\n');
  } catch (e) {
    console.error(`::warning::[check-corpus-drift] could not persist guard-escalation state: ${e.message}`);
  }
}

// Each audit: how to run it and how to read its exit code. `crashCodes` are
// exit codes that mean "could not run" (a real error) vs "ran and found drift".
const AUDITS = [
  {
    name: 'text-quality',
    label: 'Review text quality (full/truncated/unknown %)',
    script: 'audit-text-quality.js',
    args: [],
    crashCodes: [2],           // 0 pass / 1 drift / 2 = corpus missing or empty (couldn't run)
  },
  {
    name: 'aggregator-truth',
    label: 'Local vs aggregator review-count ratios',
    script: 'validate-aggregator-truth.js',
    args: [],
    crashCodes: [],            // 0 ok / 1 definite-duplicate drift
  },
  {
    name: 'pull-quote-quality',
    label: 'shipped pull quotes tripping a hard guard (chrome/tag-cloud/mid-word-cut/etc)',
    script: 'audit-pull-quotes.js',
    // Card em-20260801-000455/#727/#728 (second-opinion review 2026-08-17):
    // a corpus-wide 0-hits assertion belongs here, not in the blocking
    // test.yml unit-test manifest — new reviews land continuously via
    // automated ingestion, so a single bad pick on an unrelated push would
    // red main for non-code reasons, the exact flap this file exists to
    // absorb (see file header). scripts/tests/pull-quote-quality.test.mjs
    // keeps only the pinned Les Mis/Cititour regression as a blocking test.
    args: ['--fail-on-hit'],
    crashCodes: [],            // 0 clean / 1 = hard-guard hit (drift). Corpus-missing also exits 1 → shown as drift, same as aggregator-truth.
  },
  {
    name: 'regex-fp',
    label: 'content-quality regex false-positive rate',
    script: 'audit-regex-patterns.js',
    args: ['--full'],
    crashCodes: [2],           // 2 = scan failed (missing corpus / malformed)
  },
  {
    name: 'cross-show-url',
    label: 'cross-show URL contamination (review URL slug names a different show)',
    script: 'audit-cross-show-url.js',
    // --max baseline = known stable false-positive tail (franchise/substring
    // collisions + untriaged singles), measured at 56 unhandled on 2026-06-23
    // after fixing the Schmigadoon/Care/this-is-not-about-me real clusters.
    // Drift (exit 1) fires only when a new scrape leaks cross-show URLs and
    // pushes the count ABOVE the baseline, not on the existing FP backlog.
    // Re-baseline (lower this) after a triage pass clears the singles.
    args: ['--strict', '--max=60'],
    crashCodes: [2],           // 0 under baseline / 1 grew above baseline / 2 = corpus missing
  },
  {
    name: 'unknown-outlets',
    label: 'resolvable unknown outlets (in reviews, not yet in registry)',
    script: 'audit-unknown-outlets.js',
    // Moved off the blocking test.yml gate (was assert.ok(resolvableUnknowns<=5)).
    // Drifts up whenever a new scraper discovers an outlet not yet registered —
    // a no-op push could fail it, so it belongs here, surfaced in the digest.
    args: ['--max=5'],
    crashCodes: [2],           // 0 under threshold / 1 over (drift) / 2 = corpus/registry missing
  },
  {
    name: 'review-key-duplicates',
    label: 'duplicate reviews (same showDir|outlet|critic)',
    script: 'audit-review-key-duplicates.js',
    // Moved off the blocking test.yml gate (was assert.ok(report.current.duplicates<=5)).
    // WE scrapers create timeout/unknown variant files that accumulate between
    // dedup passes — a no-op push could fail it, so it belongs here in the digest.
    args: ['--max=5'],
    crashCodes: [2],           // 0 under threshold / 1 over (drift) / 2 = corpus missing
  },
  {
    name: 'churn-merge-coverage',
    label: 'high-churn tracked files lacking a .gitattributes merge driver',
    script: 'audit-churn-merge-coverage.js',
    // Complements the test.yml "merge drivers registered" guard: that checks
    // every DECLARED driver is registered; this finds files that SHOULD have a
    // driver but never got one (collection-state/*.json sat uncovered for weeks).
    // Needs ~3 days of commit history — the workflow deepens the shallow checkout.
    args: [],
    crashCodes: [2],           // 0 all covered/exempt / 1 files need a decision (drift) / 2 = not a git repo
  },
  {
    name: 'review-contamination',
    label: 'review-text contamination (strict classes A/C/E/F)',
    script: 'audit-review-contamination.js',
    // The per-push test.yml gate runs --gate (catastrophe FLOOR only — class A
    // cross-market leak or a mass spike) so a single pre-existing/parallel C/E/F
    // file in the bot-mutated 39k-file corpus doesn't red the trunk for unrelated
    // pushes. The FULL --strict triage runs HERE, daily, surfaced (non-blocking) in
    // the digest — that is the safety net for sub-floor E/F drift the gate lets pass.
    args: ['--strict'],
    crashCodes: [],            // 0 clean / 1 = strict hits (drift). Corpus-missing also exits 1 → shown as drift, same as aggregator-truth.
  },
  // The four flappy whole-corpus audits gated to a --gate catastrophe floor in
  // test.yml (2026-06-29, Notion 38e637c5). The FULL strict run lives HERE so the
  // sub-floor drift the per-push gate lets pass still surfaces daily in the digest.
  {
    name: 'duplicate-of-url-mismatch',
    label: 'stale duplicateOf flags (our URL ≠ sibling URL) — full report (gate = spike floor)',
    script: 'audit-duplicate-of-url-mismatch.js',
    args: [],                  // report mode: 0 clean / 1 = ANY mismatch (drift)
    crashCodes: [],
  },
  {
    name: 'cast-changes',
    label: 'cast-changes.json integrity — full --strict (gate = cross-show conflict / spike)',
    script: 'audit-cast-changes.js',
    args: ['--strict'],        // 0 clean / 1 = ANY issue (drift)
    crashCodes: [],
  },
  {
    name: 'non-reviews',
    label: 'scored non-review content (definitive wrong-page) — full --strict',
    script: 'audit-non-reviews.js',
    args: ['--strict'],        // 0 clean / 1 = definitive wrong-page among scored (drift)
    crashCodes: [],
  },
  {
    name: 'review-texts',
    label: 'review-text file structure — full validator (gate = catastrophic classes + churn floor)',
    script: 'validate-review-texts.js',
    args: [],                  // 0 clean / 1 = ANY error: dup/garbage/contamination/corrupt (drift)
    crashCodes: [],
  },
  // The next four flappy whole-corpus contamination audits gated to a --gate
  // catastrophe floor in test.yml (2026-06-30, Notion 38f637c5). The per-push gate
  // blocks only on each file's zero-FP catastrophe class; the FULL run (fails +
  // warns, incl. the sub-floor drift the gate lets pass) lives HERE so it still
  // surfaces daily in the digest.
  {
    name: 'cast-contamination',
    label: 'data/cast/*.json wrong-show contamination — full report (gate = wrong-show class only)',
    script: 'audit-cast-contamination.js',
    args: [],                  // report mode: 0 clean / 1 = ANY flagged file (fail or warn = drift)
    crashCodes: [],
  },
  {
    name: 'commercial-contamination',
    label: 'data/commercial.json physics/contradiction — full --strict (gate = FAIL only)',
    script: 'audit-commercial-contamination.js',
    args: ['--strict'],        // 0 clean / 1 = fail or warn (drift)
    crashCodes: [],
  },
  {
    name: 'audience-buzz-contamination',
    label: 'data/audience-buzz.json source divergence — full --strict (gate = divergence spike only)',
    script: 'audit-audience-buzz-contamination.js',
    args: ['--strict'],        // 0 clean / 1 = fail (single divergence) or warn (drift)
    crashCodes: [],
  },
  {
    name: 'critic-consensus-contamination',
    label: 'data/critic-consensus.json orphan/staleness — full --strict (gate = orphan key only)',
    script: 'audit-critic-consensus-contamination.js',
    args: ['--strict'],        // 0 clean / 1 = orphan or staleness drift
    crashCodes: [],
  },
  {
    name: 'stuck-rescore-flags',
    label: 'needsRescore=true reviews the scorer rejects (stuck flags that never clear)',
    // Invariant behind the late-star producer/consumer seam bug (2026-06-30): a
    // review flagged for rescore that isScoreable=false never clears (the scorer
    // filters non-scoreable reviews out BEFORE processing and only clears the flag
    // AFTER scoring), so the queue accumulates. Catches EVERY producer of
    // needsRescore, not just late-star. See scripts/lib/stuck-rescore-flag.js.
    //
    // The 1170-flag backlog measured 2026-07-01 was burned down (--fix) and the
    // enrich-reviews.yml "Drain stuck needsRescore flags" step now clears them every
    // 6h, so steady-state is ~0. --max=25 is a small cushion for in-flight churn
    // between drain cycles (reviews flagged then wrong-flagged within a 6h window).
    // Drift (exit 1) fires when the count exceeds that — a producer flagging
    // non-scoreable reviews faster than the drain clears them (a new producer bug).
    script: 'audit-stuck-rescore-flags.js',
    args: ['--gate', '--max=25'],
    crashCodes: [2],           // 0/under / 1 = grew above backlog (new producer bug) / 2 = corpus missing
  },
  {
    name: 'stale-score-input',
    label: 'reviews scored off an excerpt that now have fullText, never flagged for rescore',
    // Card #1902 (2026-08-26): 653 reviews measured with contentTier
    // complete/truncated but llmMetadata.textSource.type=excerpt — scored
    // off an excerpt despite fullText now on disk, because nothing set
    // needsRescore before the write-time hook (review-file-writer.js) and
    // the wrongProduction auto-clear sites (rebuild-all-reviews.js) existed.
    // `total` is the coarse population (~653, mostly permanent — the
    // 278-file unscoreable residue never reaches 0); gate on `fixable` only,
    // which ratchets toward 0 as the backfill (audit-stale-score-input.js
    // --fix) drains and the write-time hook now catches new drift as it
    // happens. Backfill drained the 379-file baseline to 0 on 2026-08-26;
    // --max=25 is a small cushion for in-flight churn (mirrors
    // audit-stuck-rescore-flags.js's steady-state cushion above), not the
    // measured baseline anymore.
    script: 'audit-stale-score-input.js',
    args: ['--gate', '--max=25'],
    crashCodes: [2],           // 0/under / 1 = fixable grew above baseline / 2 = corpus missing
  },
];

function runAudit(audit) {
  const scriptPath = path.join(SCRIPTS_DIR, audit.script);
  const res = spawnSync('node', [scriptPath, ...audit.args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const exitCode = res.status == null ? -1 : res.status;
  const crashed = exitCode === -1 || audit.crashCodes.includes(exitCode);
  const ok = exitCode === 0;
  // Keep the last ~40 lines of output as a digest-friendly detail snippet.
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const tail = out.split('\n').slice(-40).join('\n');
  return {
    name: audit.name,
    label: audit.label,
    command: `node scripts/${audit.script}${audit.args.length ? ' ' + audit.args.join(' ') : ''}`,
    exitCode,
    ok,
    crashed,
    detail: tail,
  };
}

// Pure: assemble the verdict object from audit results. `now` injected for
// deterministic tests (Date is otherwise the only impurity).
function buildVerdict(auditResults, now) {
  const anyCrashed = auditResults.some((a) => a.crashed);
  const anyDrift = auditResults.some((a) => !a.ok && !a.crashed);
  return {
    _meta: {
      generatedAt: now,
      note: 'Corpus-statistics drift monitor. Non-blocking; surfaced via health-check.js digest. Not a code-correctness gate.',
    },
    summary: {
      auditsRun: auditResults.length,
      driftCount: auditResults.filter((a) => !a.ok && !a.crashed).length,
      crashCount: auditResults.filter((a) => a.crashed).length,
      anyDrift,
      anyCrashed,
    },
    audits: auditResults,
  };
}

// Pure: the exit-code policy. This is the load-bearing decision — drift is NOT
// a failure (it surfaces in the digest); only an audit that couldn't run, or
// drift under --strict, escalates.
//   3 — a child audit crashed / couldn't run (real error)
//   2 — drift detected AND --strict
//   0 — otherwise (passive monitor)
function decideExit({ anyCrashed, anyDrift, strict }) {
  if (anyCrashed) return 3;
  if (anyDrift && strict) return 2;
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const outArg = argv.find((a) => a.startsWith('--audit-out='));
  const auditOut = outArg ? path.resolve(outArg.split('=')[1]) : AUDIT_OUT_DEFAULT;

  const audits = AUDITS.map(runAudit);
  const verdict = buildVerdict(audits, new Date().toISOString());

  fs.mkdirSync(path.dirname(auditOut), { recursive: true });
  fs.writeFileSync(auditOut, JSON.stringify(verdict, null, 2) + '\n');

  console.log(`[check-corpus-drift] wrote ${auditOut}`);
  for (const a of audits) {
    const status = a.crashed ? '💥 CRASHED' : a.ok ? '✅ ok' : '⚠️  drift';
    console.log(`  ${status}  ${a.name} (exit ${a.exitCode}) — ${a.label}`);
  }

  const code = decideExit({ ...verdict.summary, strict });
  if (code === 2) {
    console.error('[check-corpus-drift] drift detected and --strict set.');
    process.exit(code);
  }
  if (code !== 3) {
    // Healthy (or non-strict drift) run: clear any open crash streak so a
    // real recurring crash doesn't get silently forgotten, but a single good
    // run doesn't leave a stale "still blocked" incident open either.
    const priorState = loadGuardState();
    if (priorState && priorState.consecutiveBlocks > 0) {
      try {
        const { resolveCondition } = require('./lib/owner-alert-router');
        resolveCondition(ALERT_CONDITION_KEY);
      } catch (e) { /* best-effort — a missing router/ledger never blocks a healthy run */ }
      saveGuardState(nextGuardState(priorState, false, Date.now()));
    }
    process.exit(code);
  }

  // code === 3: one or more audits crashed (could not run at all).
  const crashedNames = audits.filter((a) => a.crashed).map((a) => a.name).join(', ');
  const priorState = loadGuardState();
  const state = nextGuardState(priorState, true, Date.now());
  saveGuardState(state);

  const overrideCommand = buildOverrideCommand({
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    reason: 'BRO-2424 corpus-drift audit-crash guard manual override',
  });
  const baseMsg =
    `[check-corpus-drift] ${audits.filter((a) => a.crashed).length} audit(s) could not run ` +
    `(crashed): ${crashedNames}. Override: ${overrideCommand}`;

  if (!shouldAutoRecover(GUARD_ID, state.consecutiveBlocks)) {
    // First (or still-below-threshold) crash: fail loud, unchanged from
    // before BRO-2424 — a one-off audit crash is worth flagging immediately.
    console.error(`::error::${baseMsg}`);
    process.exit(3);
  }

  // BRO-2424 auto-recovery: this audit-crash condition has now fired
  // state.consecutiveBlocks runs in a row. The verdict JSON was already
  // written above (other audits' results are still useful), so proceeding
  // just stops marking this DAILY monitor red for a condition that keeps
  // reproducing — it degrades to a loud, escalating alert instead.
  const alert = buildGuardBlockedAlert({
    guardId: GUARD_ID,
    guardLabel: 'Corpus-drift audit-crash guard (check-corpus-drift.js)',
    consecutiveBlocks: state.consecutiveBlocks,
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    overrideCommand,
    impact: `the ${crashedNames} audit(s) have not run — their drift/health signal is stale`,
    runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined,
  });
  console.error(`::warning::${baseMsg}`);
  console.error(`::warning::[guard-escalation] AUTO-RECOVERING — ${alert.description.replace(/\n/g, ' | ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n## ⚠️ Guard auto-recovery — ${alert.title}\n\n${alert.description.replace(/\n/g, '\n\n')}\n`,
      );
    } catch (e) { /* summary write is best-effort */ }
  }

  if (shouldEscalate(state.consecutiveBlocks)) {
    try {
      const { routeAlert } = require('./lib/owner-alert-router');
      // Lower severity than BRO-545's reviews.json-stalled case: this monitor
      // is non-blocking by design (see file header) and the underlying audits
      // still ran (only one crashed) — 'digest', not 'human' (no page).
      await routeAlert({
        conditionKey: ALERT_CONDITION_KEY,
        title: alert.title,
        description: alert.description,
        disposition: 'digest',
        cooldownHours: 1,
      });
    } catch (e) {
      console.error(`::warning::[guard-escalation] routeAlert failed (${e.message}) — escalation was logged above regardless.`);
    }
  }
  // Auto-recovered: exit 0 so this job stays green — the condition is
  // already visible via the warnings/summary/digest alert above.
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`::error::[check-corpus-drift] unexpected failure: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { AUDITS, runAudit, buildVerdict, decideExit };
