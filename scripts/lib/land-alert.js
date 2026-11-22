/**
 * land-alert.js — the owner-facing signal for .github/workflows/land.yml
 * (BRO-3873 step 3). One stable conditionKey per land/** branch
 * (`land:<branch>`), disposition 'digest': a red gate on a landing branch is
 * not a page, it is a line in the morning digest naming the gate and the
 * branch, deduped by the router's cooldown so a branch that stays red does
 * not re-notify every push. A successful landing resolves the condition so
 * the next branch of the same name starts clean.
 *
 * buildLandAlert() is pure (tested); sendLandAlert()/resolveLandAlert() are
 * the thin IO wrappers scripts/land-alert.js calls from the workflow.
 */

'use strict';

const CONDITION_PREFIX = 'land:';
const DEFAULT_COOLDOWN_HOURS = 6;

function conditionKeyFor(branch) {
  return `${CONDITION_PREFIX}${String(branch || '').replace(/^refs\/heads\//, '')}`;
}

/**
 * @param {object} o
 * @param {string} o.branch   land/** branch (with or without refs/heads/)
 * @param {string} o.gate     the failing gate, e.g. 'tsc', 'unit-tests', 'rebase', 'race'
 * @param {string} [o.runUrl] the workflow run
 * @param {string} [o.sha]    branch tip that was checked
 * @param {string} [o.detail] first lines of the failure, clipped
 * @param {number} [o.cooldownHours]
 */
function buildLandAlert({ branch, gate, runUrl = '', sha = '', detail = '', cooldownHours = DEFAULT_COOLDOWN_HOURS }) {
  const name = String(branch || '').replace(/^refs\/heads\//, '');
  if (!name) throw new Error('buildLandAlert requires branch');
  if (!gate) throw new Error('buildLandAlert requires gate');
  const clipped = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const parts = [
    `land.yml did not land ${name}: the ${gate} gate went red${sha ? ` at ${String(sha).slice(0, 10)}` : ''}.`,
    'The branch ref was left in place and nothing was pushed to main.',
    clipped ? `First failure: ${clipped}` : '',
    runUrl ? `Run: ${runUrl}` : '',
  ].filter(Boolean);
  return {
    conditionKey: conditionKeyFor(name),
    title: `Landing blocked: ${gate} red on ${name}`,
    description: parts.join(' '),
    hint: `Fix the ${gate} failure on ${name} and push again (any push to land/** re-runs the checks), or delete the ref: gh api -X DELETE repos/thomaspryor/Broadwayscore/git/refs/heads/${name}`,
    severity: 'error',
    disposition: 'digest',
    cooldownHours,
    fields: [
      { name: 'branch', value: name },
      { name: 'gate', value: String(gate) },
      ...(sha ? [{ name: 'tip', value: String(sha) }] : []),
      ...(runUrl ? [{ name: 'run', value: String(runUrl) }] : []),
    ],
  };
}

async function sendLandAlert(o, { route = null } = {}) {
  const routeAlert = route || require('./owner-alert-router.js').routeAlert;
  return routeAlert(buildLandAlert(o));
}

function resolveLandAlert(branch, { resolve = null } = {}) {
  const resolveCondition = resolve || require('./owner-alert-router.js').resolveCondition;
  return resolveCondition(conditionKeyFor(branch));
}

// BRO-7950: a test red on both the branch and origin/main is not blocking, so
// nothing surfaced it. One digest row per test (conditionKey keyed on file::name,
// not on the branch) so the same red is one alert, not one per landing; the
// router's cooldown makes a repeat 'silent'. Never blocks a landing.
const PRE_EXISTING_PREFIX = 'land-preexisting:';
const PRE_EXISTING_COOLDOWN_HOURS = 24;

function preExistingKeyFor(file, name) {
  const raw = `${file}::${name}`.replace(/\s+/g, ' ').trim();
  if (raw.length <= 120) return `${PRE_EXISTING_PREFIX}${raw}`;
  const h = require('crypto').createHash('sha1').update(raw).digest('hex').slice(0, 10);
  return `${PRE_EXISTING_PREFIX}${raw.slice(0, 100)}#${h}`;
}

function buildPreExistingAlert({ file = '', name = '', gate = '', branch = '', runUrl = '' }) {
  if (!file && !name) throw new Error('buildPreExistingAlert requires file or name');
  const label = `${file}::${name}`;
  return {
    conditionKey: preExistingKeyFor(file, name),
    title: `Test red on main: ${String(name || file).slice(0, 120)}`,
    description: `${label} fails on origin/main itself (${gate || 'a gate'}), so landings pass it as pre-existing. It stays red until someone fixes it.${branch ? ` Seen on ${branch}.` : ''}${runUrl ? ` Run: ${runUrl}` : ''}`,
    hint: `Fix ${label} on main; landings do not block on it.`,
    severity: 'warning',
    disposition: 'digest',
    cooldownHours: PRE_EXISTING_COOLDOWN_HOURS,
    fields: [
      { name: 'gate', value: String(gate) },
      { name: 'test', value: label.slice(0, 200) },
      ...(runUrl ? [{ name: 'run', value: String(runUrl) }] : []),
    ],
  };
}

// The router is required lazily, like sendLandAlert: a top-level require would
// make the alert-ledger-commit / routealert-linear-key lints see this file's
// callers as router callers.
async function sendPreExistingAlerts(rows, { route = null, branch = '', runUrl = '' } = {}) {
  const routeAlert = route || require('./owner-alert-router.js').routeAlert;
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const alert = buildPreExistingAlert({ ...r, branch, runUrl });
    if (seen.has(alert.conditionKey)) continue;
    seen.add(alert.conditionKey);
    out.push(await routeAlert(alert));
  }
  return out;
}

module.exports = { PRE_EXISTING_PREFIX, preExistingKeyFor, buildPreExistingAlert, sendPreExistingAlerts, CONDITION_PREFIX, DEFAULT_COOLDOWN_HOURS, conditionKeyFor, buildLandAlert, sendLandAlert, resolveLandAlert };
// land.yml live case (i): docs-only line, landed through land.yml itself.
// land.yml live case (i), 2026-09-20: pushed under the new-failures-vs-base gate (BRO-3873).
// land.yml live case (c1), 2026-09-21: docs-only line landed through scripts/merge-worktree-to-main.sh → land/** (BRO-3873 step 4).
