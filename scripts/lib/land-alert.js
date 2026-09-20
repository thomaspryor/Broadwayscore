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

module.exports = { CONDITION_PREFIX, DEFAULT_COOLDOWN_HOURS, conditionKeyFor, buildLandAlert, sendLandAlert, resolveLandAlert };
// land.yml live case (i): docs-only line, landed through land.yml itself.
