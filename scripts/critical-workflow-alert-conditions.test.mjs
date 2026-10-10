import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const {
  findCriticalNotifySteps,
  coversCancellation,
  checkoutBlocksCancelledNotify,
} = require('./lib/critical-workflow-notify-cancelled.js');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * BRO-3707: found while landing BRO-2531 — opening-digest.yml's job hit its
 * own timeout-minutes on a hung checkout, the job's conclusion came back
 * `cancelled`, and its Notify-on-failure step's bare `if: failure()` never
 * fired as a result (opening-digest.yml's own Notify is severity:'warning',
 * a no-op regardless, so that specific incident had no alerting
 * consequence). The SAME bare-`if: failure()` shape existed on 8 of 12
 * severity:'critical' workflows (later found to be 12 of 13 once
 * card-verifiability-audit.yml — undocumented drift, matching this repo's
 * own "doc says 11, grep finds 12/13" history) — for THOSE, a job-timeout
 * cancellation would silently swallow the one real-time alert this repo
 * relies on. Fixed by adding `|| cancelled()`, mirroring opening-digest.yml
 * (and, until BRO-4434 moved it out, test.yml's "Awards Data Stale" step).
 *
 * A workflow/step belongs here ONLY when its risky step(s) genuinely rely on
 * the job-level timeout-minutes ceiling to catch a hang. If a step already
 * converts a hang into a real failure() via the inline
 * `timeout <seconds> cmd; [ "$status" -ne 0 ] && exit 1` pattern (the
 * .github/workflows/CLAUDE.md "reference implementation"), the job timeout
 * is just a backstop that should never fire in practice, and a bare
 * `if: failure()` Notify step is correct as-is.
 */
// vercel-deploy.yml's entry was removed by BRO-4603: it is no longer
// severity:'critical' (not on the owner's page-worthy list), so there is no
// critical Notify step left to exempt. Its Build/Deploy steps still use the
// inline `timeout <seconds> cmd` guard.
const EXEMPT = new Map([]);

function scan() {
  return findCriticalNotifySteps(WORKFLOWS_DIR, yaml.load);
}

test('the scan actually finds severity:critical Notify-on-failure steps (guard against a vacuous pass)', () => {
  const found = scan();
  // BRO-4603 cut the critical set to the owner's page-worthy list (6 at time
  // of writing, see scripts/lib/page-worthy-alerts.js PAGE_WORTHY_WORKFLOWS;
  // tests/unit/page-worthy-workflows.test.mjs pins the exact set). Not pinned
  // here — a drop near/at 0 means the matcher broke, not that every critical
  // alert vanished.
  assert.ok(
    found.length >= 4,
    `expected at least 4 severity:'critical' Notify-on-failure steps across ${WORKFLOWS_DIR}, found ${found.length} — the matcher (uses: ./.github/actions/notify-failure + with.severity == 'critical') or the workflow shape changed`
  );
});

test('every severity:critical Notify-on-failure condition survives a job-timeout cancellation', () => {
  const offenders = scan()
    .map((entry) => ({ entry, key: `${entry.file} / ${entry.jobId} / ${entry.name}` }))
    .filter(({ key }) => !EXEMPT.has(key))
    .filter(({ entry }) => !coversCancellation(entry.if));

  assert.deepEqual(
    offenders.map((o) => o.key),
    [],
    'These severity:critical Notify-on-failure steps have a bare `if: failure()` (no `cancelled()`), ' +
      'so a job-timeout-minutes cancellation on this job would silently drop the one real-time alert ' +
      'this repo relies on (BRO-3707). Add `cancelled()` to the condition (see opening-digest.yml for ' +
      'the reference shape), or add the step to EXEMPT above with a reason:\n' +
      offenders.map((o) => `  - ${o.key}\n      if: ${JSON.stringify(o.entry.if)}`).join('\n')
  );
});

test('every EXEMPT entry still exists and is still the shape it was exempted for', () => {
  const byKey = new Map(scan().map((e) => [`${e.file} / ${e.jobId} / ${e.name}`, e]));
  const stale = [...EXEMPT.keys()].filter((key) => !byKey.has(key));
  assert.deepEqual(
    stale,
    [],
    'These EXEMPT entries no longer match any severity:critical Notify-on-failure step — the step ' +
      'was renamed, removed, or is no longer critical. Remove the stale entry (a step that no longer ' +
      'needs an exemption should be enforced like everything else):\n' + stale.join('\n  ')
  );
});

test('a critical Notify step covering cancelled() can still actually resolve its local composite action', () => {
  const offenders = scan()
    .filter((entry) => coversCancellation(entry.if))
    .filter((entry) => checkoutBlocksCancelledNotify(entry))
    .map((entry) => `${entry.file} / ${entry.jobId} / ${entry.name}`);

  assert.deepEqual(
    offenders,
    [],
    'These Notify-on-failure steps cover cancelled() themselves, but every checkout step ahead of ' +
      'them in the job is conditional and NONE of those checkouts cover cancelled() — on a job-timeout ' +
      'cancellation, `uses: ./.github/actions/notify-failure` would still fail to resolve because the ' +
      'workspace was never checked out (r2-cold-backup.yml\'s "Checkout for notify action" is the ' +
      'reference fix — its condition must match the Notify step\'s own):\n' +
      offenders.map((o) => `  - ${o}`).join('\n')
  );
});
