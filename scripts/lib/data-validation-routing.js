'use strict';
/**
 * BRO-7130: per-step alerts for test.yml's Data Validation job.
 *
 * The job is continue-on-error (BRO-3425), so a failing corpus audit never
 * reddens main. Before this, every failure shared ONE condition key
 * (test-yml:data-validation-red) whose title named whatever failed on the run
 * that first opened it, and it only ever went to the digest: BRO-5882 sat
 * titled "Validate archive productions" for weeks while "Validate market
 * expansion" was the step actually red, and nothing pushed it to a worker.
 *
 * Now each failing step gets its own condition (test-yml:data-validation-red:<slug>):
 *  - a digest line first; a card once the same step has failed for
 *    DEFER_FILING_HOURS (owner-alert-router deferFilingHours, BRO-4487);
 *  - escalation (High, Todo, START-NOW) once it has failed ESCALATION_HOURS
 *    (lib/red-escalation-runner.js, BRO-7102);
 *  - resolved when the step runs and passes, or no longer exists in the job.
 * Advisory steps (step-level continue-on-error) are never routed.
 */

const JOB_NAME = 'Data Validation';
const KEY_PREFIX = 'test-yml:data-validation-red:';
// The single shared key this replaces. Resolved on sight, never routed again.
const LEGACY_KEY = 'test-yml:data-validation-red';
const DEFER_FILING_HOURS = 24;
const ESCALATION_HOURS = 48;
const COOLDOWN_HOURS = 24;
// Used when the job's step list cannot be read but the job is failing, so the
// failure still reaches the digest without reopening LEGACY_KEY.
const UNLISTED_KEY = `${KEY_PREFIX}step-lookup-failed`;

/** PURE. Ledger key for one Data Validation step. */
function stepConditionKey(stepName) {
  const slug = String(stepName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return KEY_PREFIX + (slug || 'unnamed-step');
}

/**
 * Names of steps in the Data Validation job that carry step-level
 * continue-on-error (advisory audits and commit steps). Empty set when the
 * workflow cannot be parsed: then nothing is excluded, which over-reports
 * rather than hides a failure.
 */
function advisoryStepNames(ymlText) {
  try {
    const yaml = require('js-yaml');
    const doc = yaml.load(String(ymlText || ''));
    const job = Object.values((doc && doc.jobs) || {}).find((j) => j && j.name === JOB_NAME);
    return new Set(((job && job.steps) || []).filter((s) => s && s.name && s['continue-on-error']).map((s) => s.name));
  } catch (e) {
    console.error(`::warning::[data-validation-routing] could not read advisory steps from test.yml: ${e.message}`);
    return new Set();
  }
}

/**
 * PURE. What to route and what to resolve for one run.
 * @param {{steps: (Array<{name: string, conclusion: (string|null)}>|null), advisory: Set<string>, ledgerConditions: object}} p
 *   steps: the Data Validation job's steps from the Actions API, or null when the lookup failed
 * @returns {{route: string[], resolve: Array<{key: string, reason: string}>}}
 */
function planDataValidationRouting({ steps, advisory = new Set(), ledgerConditions = {} }) {
  const resolve = [];
  const legacy = ledgerConditions[LEGACY_KEY];
  if (legacy && legacy.status === 'open') resolve.push({ key: LEGACY_KEY, reason: 'retired: per-step keys (BRO-7130)' });
  if (!Array.isArray(steps) || !steps.length) return { route: [], resolve };

  const route = [];
  const failingKeys = new Set();
  const passedKeys = new Set();
  const presentKeys = new Set();
  for (const s of steps) {
    if (!s || !s.name) continue;
    const key = stepConditionKey(s.name);
    if (advisory.has(s.name)) continue; // advisory: never routed, and its key reads as absent below
    presentKeys.add(key);
    if (s.conclusion === 'failure') {
      if (!failingKeys.has(key)) route.push(s.name);
      failingKeys.add(key);
    } else if (s.conclusion === 'success') {
      passedKeys.add(key);
    }
  }
  for (const [key, c] of Object.entries(ledgerConditions)) {
    if (!key.startsWith(KEY_PREFIX) || !c || c.status !== 'open' || failingKeys.has(key)) continue;
    if (key === UNLISTED_KEY) { resolve.push({ key, reason: 'step list readable again' }); continue; }
    // A skipped / not-yet-run step proves nothing; only a pass or the step's
    // removal (rename, deletion, demotion to advisory) clears it.
    if (passedKeys.has(key)) resolve.push({ key, reason: 'step passed' });
    else if (!presentKeys.has(key)) resolve.push({ key, reason: 'step no longer a blocking step in the Data Validation job' });
  }
  return { route, resolve };
}

/** PURE apart from reading the workflow text it is given. routeAlert options for one failing step. */
function alertForStep(stepName, { runUrl, ymlText } = {}) {
  const { verifyForSignature } = require('./red-signature-verify-cmd.js');
  return {
    conditionKey: stepConditionKey(stepName),
    title: `Data audit failing: ${stepName}`,
    description: `The "${stepName}" step of test.yml's Data Validation job is failing on main. The job is non-blocking (BRO-3425), so main stays green, but the audit is reporting a real data or code problem. This card is scoped to this one step; another failing step gets its own card.`,
    severity: 'warning',
    disposition: 'auto',
    cardAction: 'Fix',
    deferFilingHours: DEFER_FILING_HOURS,
    cooldownHours: COOLDOWN_HOURS,
    fields: [
      { name: 'Job', value: JOB_NAME },
      { name: 'Step', value: stepName },
      { name: 'Run', value: runUrl ? `[View logs](${runUrl})` : 'n/a' },
    ],
    url: runUrl || undefined,
    verify: verifyForSignature({ job: JOB_NAME, step: stepName }, ymlText),
  };
}

/**
 * Called from test.yml's "Route data-audit failures" step. Best-effort: logs
 * and returns, never throws into the workflow.
 * @param {{steps: (Array|null), ymlText: string, runUrl: string, jobStatus: string}} p
 */
async function routeDataValidationRun({ steps, ymlText, runUrl, jobStatus }, deps = {}) {
  const router = deps.router || require('./owner-alert-router.js');
  const escalate = deps.escalate || require('./red-escalation-runner.js').escalateLongRedConditions;
  const ledger = router.loadLedger();
  const plan = planDataValidationRouting({ steps, advisory: advisoryStepNames(ymlText), ledgerConditions: ledger.conditions || {} });
  for (const { key, reason } of plan.resolve) {
    if (router.resolveCondition(key, { reason })) console.log(`[data-validation-routing] resolved ${key}: ${reason}`);
  }
  const routed = [];
  for (const step of plan.route) {
    try {
      const res = await router.routeAlert(alertForStep(step, { runUrl, ymlText }));
      routed.push(stepConditionKey(step));
      console.log(`[data-validation-routing] ${step}: ${res && res.action}`);
    } catch (e) {
      console.error(`::warning::[data-validation-routing] routing "${step}" failed: ${e.message}`);
    }
  }
  if (!Array.isArray(steps) && jobStatus === 'failure') {
    try {
      await router.routeAlert({
        conditionKey: UNLISTED_KEY,
        title: 'Data audits failing: step list unavailable',
        description: `test.yml Data Validation failed but its step list could not be read, so the failing step is unknown. Run: ${runUrl || 'n/a'}`,
        disposition: 'digest', severity: 'warning', cooldownHours: COOLDOWN_HOURS,
      });
    } catch (e) {
      console.error(`::warning::[data-validation-routing] fallback digest failed: ${e.message}`);
    }
  }
  try {
    await escalate(routed, {
      thresholdHours: ESCALATION_HOURS,
      subject: 'this Data Validation audit has been failing on main',
      logTag: 'data-validation-routing',
    });
  } catch (e) {
    console.error(`::warning::[data-validation-routing] escalation failed: ${e.message}`);
  }
  return { ...plan, routed };
}

module.exports = {
  JOB_NAME, KEY_PREFIX, LEGACY_KEY, UNLISTED_KEY, DEFER_FILING_HOURS, ESCALATION_HOURS,
  stepConditionKey, advisoryStepNames, planDataValidationRouting, alertForStep, routeDataValidationRun,
};
