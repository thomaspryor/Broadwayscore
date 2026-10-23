'use strict';
/**
 * validate-data-nonblocking-scan.js (BRO-3194, BRO-2289 cousin) — pure scanner.
 *
 * Finds workflow steps that run `node scripts/validate-data.js` with no
 * `continue-on-error: true` although NOTHING downstream depends on them: every
 * later step in the same job runs under `if: always()`. Such a step gates
 * nothing; its failure only flips the job red, producing false "repeat workflow
 * failure" alerts for transient corpus issues (BRO-2289).
 *
 * A step is correctly BLOCKING (not flagged) when any later step in the job
 * lacks `always()` (it is skipped on failure, so validate gates it) or reads
 * the validate step's outcome/conclusion.
 */
const yaml = require('js-yaml');

// Standalone step only: a run block that does anything else (tee, `|| RC=$?`,
// if/else) is handling the exit code itself on purpose.
const VALIDATE_RE = /^\s*node\s+scripts\/validate-data\.js(?:\s+--\S+)*\s*$/;
// `# validate-blocking-ok: <reason>` in the YAML, within 600 chars before the
// step's `name:`, marks a step that is deliberately blocking.
const MARKER = 'validate-blocking-ok';

function isTrue(v) { return v === true || v === 'true'; }
function ifText(step) { return step.if == null ? '' : String(step.if); }

function hasMarker(text, name) {
  const i = text.indexOf('name: ' + name);
  return i >= 0 && text.slice(Math.max(0, i - 600), i + name.length + 8).includes(MARKER);
}

function scanWorkflow(text) {
  let doc;
  doc = yaml.load(text); // a parse error must surface, not read as "clean"
  const out = [];
  for (const [jobId, job] of Object.entries((doc && doc.jobs) || {})) {
    const steps = Array.isArray(job && job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (!step || typeof step.run !== 'string' || !VALIDATE_RE.test(step.run)) return;
      if (isTrue(step['continue-on-error'])) return;
      const later = steps.slice(i + 1);
      const refsOutcome = step.id
        ? later.some(s => new RegExp('steps\\.' + step.id + '\\.(outcome|conclusion)').test(JSON.stringify(s)))
        : false;
      if (refsOutcome) return; // deliberate gate on validate's result
      // validate-data.js writes the push-core-data refusal sentinel, so any later
      // push-core-data step is gated by validate whatever its `if:` says.
      const readsSentinel = later.some(s => /push-core-data/.test(String(s.uses || '')));
      if (readsSentinel) return;
      const runsAfterFailure = (s) => /\balways\(\)|\bfailure\(\)|!\s*cancelled\(\)/.test(ifText(s));
      const gatedByValidate = later.some(s => !runsAfterFailure(s));
      if (gatedByValidate) return; // later steps are skipped on failure: load-bearing
      if (step.name && hasMarker(text, step.name)) return;
      out.push({ job: jobId, step: step.name || `step ${i + 1}`, laterSteps: later.length });
    });
  }
  return out;
}

module.exports = { scanWorkflow };
