/**
 * BRO-873: update-lottery-rush.yml failed 4+ consecutive scheduled runs
 * (Apr 10-14 2026) with zero owner-visible alert. Root cause was NOT the
 * originally-suspected gitignore bug (already fixed in 03d913d7cb /
 * b6b377e445) — it was that the workflow's "Notify on failure" step never
 * set `severity`/`email`, and notify-failure/action.yml is a no-op for any
 * severity other than 'critical' (scripts/lib/discord-notify.js's
 * EMAILABLE_SEVERITIES only emails 'critical'/'error'; Discord itself was
 * fully removed 2026-05-17). This file pins the fix so the workflow can't
 * silently regress back to unrouted 'low'/no-email again.
 *
 * Run: node --test tests/unit/discord-alert-routing.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

delete process.env.RESEND_API_KEY;
delete process.env.OWNER_EMAIL;
delete process.env.GITHUB_STEP_SUMMARY;

const { shouldEmailAlert } = require('../../scripts/lib/discord-notify.js');

function loadWorkflow(relPath) {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf-8'));
}

function findNotifyFailureStep(workflow) {
  for (const job of Object.values(workflow.jobs || {})) {
    for (const step of job.steps || []) {
      if (step.uses === './.github/actions/notify-failure') return step;
    }
  }
  return undefined;
}

test('routing policy: only critical/error severities are emailable (the gate notify-failure relies on)', () => {
  assert.equal(shouldEmailAlert('critical'), true);
  assert.equal(shouldEmailAlert('error'), true);
  assert.equal(shouldEmailAlert('warning'), false);
  assert.equal(shouldEmailAlert('low'), false);
  assert.equal(shouldEmailAlert(undefined), false);
});

test('update-lottery-rush.yml: "Notify on failure" step actually routes to a real alert', () => {
  const workflow = loadWorkflow('.github/workflows/update-lottery-rush.yml');
  const step = findNotifyFailureStep(workflow);
  assert.ok(step, 'no step uses ./.github/actions/notify-failure — was it removed?');

  const withBlock = step.with || {};
  // notify-failure/action.yml gates its ENTIRE cooldown+send logic on
  // `inputs.severity == 'critical'`. Anything else (including the historical
  // default of unset -> 'low') is a silent no-op — this is the exact gap
  // that let the April incident go unnoticed.
  assert.equal(
    withBlock.severity,
    'critical',
    'severity must be exactly \'critical\' or notify-failure/action.yml silently does nothing on failure'
  );
  // severity:'critical' alone reaches the cooldown-check step, but the actual
  // "Send failure alert" step ALSO requires email:'true' to call sendAlert
  // with email:true (severity is hardcoded to 'error' internally either way).
  assert.equal(
    String(withBlock.email),
    'true',
    'email must be \'true\' or the alert is computed but never delivered'
  );
  assert.ok(withBlock.resend_api_key, 'resend_api_key input missing — email delivery has no API key');
  assert.ok(withBlock.owner_email, 'owner_email input missing — email delivery has no recipient');
});

test('check-cron-health.yml: update-lottery-rush staleness threshold matches its real twice-weekly cadence', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/check-cron-health.yml'), 'utf-8');
  const match = raw.match(/"update-lottery-rush\.yml\|(\d+)\|/);
  assert.ok(match, 'update-lottery-rush.yml entry not found in CRITICAL_CRONS — was it removed?');

  const maxHours = Number(match[1]);
  // The cron fires Mon+Thu (true max gap ~96h). The entry previously used 192h
  // (the once-a-week cushion value used elsewhere in this file), which is
  // looser than the 5-day/120h incident this whole check exists to catch —
  // the staleness backstop would NOT have caught the original incident even
  // with the check already in place. Cap generously above the real cadence
  // (~96h) but well under the old, too-loose 192h.
  assert.ok(
    maxHours <= 130,
    `update-lottery-rush.yml's CRITICAL_CRONS threshold is ${maxHours}h, but its true cadence is ~96h ` +
      '(Mon+Thu). A threshold this loose would not have caught the BRO-873 incident even with this check in place.'
  );
});
