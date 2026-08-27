#!/usr/bin/env node
/**
 * Advisory guard (task #1855): catch workflow steps that invoke a script
 * reading process.env.SECRET, where SECRET was never wired into that step's
 * (or its job's/workflow's) env: block — the exact bug class BRO-67 found by
 * hand in opening-night-checklist.yml, opening-night-poller.yml, and
 * opening-night-orchestrator.yml (all three called into
 * scripts/lib/llm-extractor.js for months without ANTHROPIC_API_KEY ever
 * being available; callClaudeWithRetry degrades gracefully on a missing key,
 * so nothing crashed — the LLM fallback just silently no-op'd).
 *
 * Parsing/tracing logic lives in scripts/lib/workflow-secret-scan.js (see its
 * header for the YAML-parsing approach and the transitive require-chain
 * tracing this needed — one hop, like audit-test-yml-lib-deps.js uses, would
 * have missed the actual BRO-67 chain).
 *
 * Non-blocking by design (same rationale as scripts/audit-run-budget-coverage.js
 * and scripts/audit-test-yml-lib-deps.js): static analysis here is
 * regex/heuristic-based, not a real JS analyzer — false negatives are
 * expected (conditional requires, computed script paths, secrets read via
 * something other than process.env) and false positives are possible (a
 * transitively-required file reads a secret behind a code path this
 * particular invocation never reaches). Needs a period of human-reviewed
 * warnings before it's trustworthy enough to fail CI.
 *
 * Suppress a specific false positive with a comment anywhere in the workflow
 * file: `# audit-secret-gap-ok: SECRET_NAME`
 *
 * Usage:
 *   node scripts/audit-workflow-secret-gaps.js            # human-readable, exit 0 always
 *   node scripts/audit-workflow-secret-gaps.js --json      # JSON output for CI/scripts
 *   node scripts/audit-workflow-secret-gaps.js --dir=PATH  # scan a different workflow dir (tests)
 *
 * No external deps (js-yaml is not a direct project dependency — see
 * scripts/audit-workflow-concurrency.js's header for the same convention).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseWorkflowFile,
  extractScriptInvocations,
  resolveModulePath,
  buildRequirerCounts,
  collectTransitiveSource,
  extractEnvReads,
  collectKnownSecrets,
  collectExemptions,
} = require('./lib/workflow-secret-scan.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

function findGaps(workflowDir, { repoRoot = ROOT, scriptsDir = path.join(repoRoot, 'scripts') } = {}) {
  const files = fs
    .readdirSync(workflowDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  const rawByFile = new Map();
  for (const file of files) rawByFile.set(file, fs.readFileSync(path.join(workflowDir, file), 'utf8'));
  const knownSecrets = collectKnownSecrets([...rawByFile.values()]);
  const requirerCounts = buildRequirerCounts(scriptsDir);

  // Cache secret-reads-per-script across workflows so a script invoked by
  // many workflows (e.g. rebuild-all-reviews.js) is only traced once.
  const secretReadsCache = new Map();
  function secretReadsForScript(scriptAbsPath) {
    if (secretReadsCache.has(scriptAbsPath)) return secretReadsCache.get(scriptAbsPath);
    const combinedSource = collectTransitiveSource(scriptAbsPath, { requirerCounts });
    const reads = extractEnvReads(combinedSource);
    const secretReads = new Set([...reads].filter((r) => knownSecrets.has(r)));
    secretReadsCache.set(scriptAbsPath, secretReads);
    return secretReads;
  }

  const gaps = [];
  for (const file of files) {
    const raw = rawByFile.get(file);
    const exempt = collectExemptions(raw);
    const { workflowEnv, jobs } = parseWorkflowFile(raw);

    for (const job of jobs) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const providedEnv = new Set([...workflowEnv, ...job.env, ...step.env]);
        for (const scriptRel of extractScriptInvocations(step.run)) {
          const scriptAbs = resolveModulePath(repoRoot, scriptRel);
          if (!scriptAbs) continue; // unresolvable (e.g. dynamic path) — skip
          const secretReads = secretReadsForScript(scriptAbs);
          for (const secret of secretReads) {
            if (providedEnv.has(secret)) continue;
            if (exempt.has(secret)) continue;
            gaps.push({ workflow: file, job: job.name, step: step.name, script: scriptRel, secret });
          }
        }
      }
    }
  }
  return gaps;
}

function main() {
  // Advisory tools must never break the CI job hosting them (ship-check
  // review, task #1855): an unexpected malformed-workflow parse error here
  // would otherwise fail `lint-workflows` even though this step's whole
  // point is to be a soft warning, not a gate.
  try {
    const args = process.argv.slice(2);
    const asJson = args.includes('--json');
    const dirArg = args.find((a) => a.startsWith('--dir='));
    const workflowDir = dirArg ? path.resolve(ROOT, dirArg.slice('--dir='.length)) : DEFAULT_WORKFLOW_DIR;

    const gaps = findGaps(workflowDir);

    if (asJson) {
      console.log(JSON.stringify({ gaps }, null, 2));
    } else if (gaps.length === 0) {
      console.log('audit-workflow-secret-gaps: no gaps found — every secret a workflow-invoked script reads is provided somewhere in that step\'s env chain.');
    } else {
      console.log(`::warning::audit-workflow-secret-gaps: ${gaps.length} step(s) invoke a script that reads a secret their env never provides (silent no-op, not a crash — see script header):`);
      for (const g of gaps) {
        console.log(`  ${g.workflow} :: job "${g.job}" :: step "${g.step}" -> ${g.script} reads ${g.secret}`);
      }
      console.log('Add the missing secret to that step\'s (or its job\'s) env: block in the workflow file, or suppress a false positive with `# audit-secret-gap-ok: SECRET_NAME`.');
    }
  } catch (err) {
    console.log(`::warning::audit-workflow-secret-gaps crashed (${err.message}) — treating as no findings rather than failing the job (see file header).`);
  }
  process.exit(0); // advisory — never fails CI (see file header)
}

module.exports = { findGaps };

if (require.main === module) main();
