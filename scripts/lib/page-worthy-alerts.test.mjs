import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { isPageWorthy } = createRequire(import.meta.url)('./page-worthy-alerts.js');

test('the dead on-monitor-escalation- prefix no longer pages; the window-end escalation is the per-show final report (BRO-5490)', () => {
  assert.equal(isPageWorthy('on-monitor-escalation-on-monitor-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21-show-a-escalation-final'), true);
});

test('owner option A (BRO-5490): technical alerts stop emailing; Mac and broadcast ones stay', () => {
  for (const k of ['serp-burst:tripwire', 'guard-escalation:stale-checkout-staleness', 'guard-escalation:scoring-queue-scan-failed',
    'guard-escalation:ensemble-scoring-pipeline-crashed', 'guard-escalation:review-count-drift-strict-breach']) {
    assert.equal(isPageWorthy(k), false, k);
  }
  for (const k of ['on-monitor-launch-failed-2026-10-16', 'on-monitor-dead-session-2026-10-16', 'on-monitor-auth-starved-sustained-2026-10-16',
    'broadcast:overdue:some-show', 'broadcast:never-sent:some-show']) {
    assert.equal(isPageWorthy(k), true, k);
  }
});

test('the success report and per-pass monitor noise stay in the digest', () => {
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-attempts-exhausted-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-auth-starved-2026-09-04'), false);
});

test('the one FINAL per-show opening-night report pages; the base per-night key does not (BRO-4043)', () => {
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21-show-a-parity-final'), true);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21-show-a-escalation-final'), true);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21'), false);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21-show-a-parity-final-retry'), false);
});

// BRO-5477 (owner decision 2026-10-16): these opening-night pipeline failures
// start an automatic fix first and email only if the fix fails.
const policy = createRequire(import.meta.url)('./page-worthy-alerts.js');

test('auto-fix first covers exactly the three opening-night pipeline workflows (BRO-5477)', () => {
  assert.deepEqual([...policy.AUTO_FIX_FIRST_WORKFLOWS].sort(), ['opening-night-broadcast.yml', 'opening-night-orchestrator.yml', 'opening-night-poller.yml']);
  for (const wf of policy.AUTO_FIX_FIRST_WORKFLOWS) {
    assert.equal(policy.isPageWorthyWorkflow(wf), true, `${wf} must still page when the fix fails`);
    assert.equal(policy.isAutoFixFirstWorkflow(`.github/workflows/${wf}`), true);
  }
  // The owner's one email after a failed fix pages and names its action.
  assert.equal(policy.isPageWorthy('auto-fix-first:escalation:BRO-1'), true);
  assert.ok(policy.OWNER_ACTIONS['auto-fix-first:escalation:']);
});

test('alerts that ask the owner to act stay immediate (BRO-5477)', () => {
  // Only workflow failures are held for a fix; routeAlert() keys like these always email at once.
  for (const key of ['broadcast:overdue:show-a', 'broadcast:never-sent:show-a', 'broadcast:deadline-draft:show-a', 'broadcast:draft-unsent:abc']) {
    assert.equal(policy.isPageWorthy(key), true, key);
  }
  const router = fs.readFileSync(new URL('./owner-alert-router.js', import.meta.url), 'utf8');
  assert.doesNotMatch(router, /auto-fix-first/, 'routeAlert() must not hold any key for auto-fix');
  for (const wf of ['check-morning-digest-sent.yml', 'restore-supabase.yml', 'opening-night-checklist.yml']) {
    assert.equal(policy.isAutoFixFirstWorkflow(wf), false, wf);
  }
});

test('the kill switch reads only the exact value true (BRO-5477)', () => {
  assert.equal(policy.autoFixFirstDisabled({ AUTO_FIX_FIRST_DISABLED: 'true' }), true);
  assert.equal(policy.autoFixFirstDisabled({ AUTO_FIX_FIRST_DISABLED: ' TRUE ' }), true);
  assert.equal(policy.autoFixFirstDisabled({ AUTO_FIX_FIRST_DISABLED: '' }), false);
  assert.equal(policy.autoFixFirstDisabled({}), false);
});

// --- BRO-5480: every page names what the OWNER does about it ---
const { OWNER_ACTIONS, AWAITING_OWNER_DECISION, allPageWorthyEntries } = createRequire(import.meta.url)('./page-worthy-alerts.js');

test('every page-worthy entry names the owner action, or is in the frozen awaiting-decision set', () => {
  const missing = allPageWorthyEntries().filter((e) => !(OWNER_ACTIONS[e] && OWNER_ACTIONS[e].trim()) && !AWAITING_OWNER_DECISION.has(e));
  assert.deepEqual(missing, [], 'Owner rule BRO-4603: email only when urgent AND the owner must act. Name the action in OWNER_ACTIONS, or route it to a worker card (disposition \'auto\') instead.');
});

test('no stale rows: every owner action and awaiting entry is a live page', () => {
  const live = new Set(allPageWorthyEntries());
  assert.deepEqual(Object.keys(OWNER_ACTIONS).filter((k) => !live.has(k)), []);
  assert.deepEqual([...AWAITING_OWNER_DECISION].filter((k) => !live.has(k)), []);
});

test('the awaiting-decision set may shrink but never grow (pinned)', () => {
  const PINNED = ['ugc:signin-redirect-broken:'];
  const extra = [...AWAITING_OWNER_DECISION].filter((k) => !PINNED.includes(k));
  assert.deepEqual(extra, [], 'a new page must name the owner action; it cannot join the awaiting set');
});

test('stuck opening-night reviews never email the owner (BRO-5480)', () => {
  assert.equal(isPageWorthy('opening-night-sla:pages-stuck'), false);
});

test('ownerActionFor: exact key, longest prefix, final report; null for awaiting (BRO-5498)', () => {
  const { ownerActionFor, OWNER_ACTIONS } = createRequire(import.meta.url)('./page-worthy-alerts.js');
  assert.equal(ownerActionFor('claude-auth:revoked'), OWNER_ACTIONS['claude-auth:revoked']);
  assert.equal(ownerActionFor('broadcast:overdue:some-show'), OWNER_ACTIONS['broadcast:overdue:']);
  assert.equal(ownerActionFor('on-monitor-dead-session-2026-10-16'), OWNER_ACTIONS['on-monitor-dead-session-']);
  assert.equal(ownerActionFor('on-monitor-report-on-monitor-2026-09-21-show-a-parity-final'), OWNER_ACTIONS['on-monitor-report-*-final']);
  assert.equal(ownerActionFor('ugc-roundtrip:users-affected'), OWNER_ACTIONS['ugc-roundtrip:users-affected']);
  assert.equal(ownerActionFor('ugc:signin-redirect-broken:x'), null);
  assert.equal(ownerActionFor('not-a-page'), null);
});

test('every email-capable key or prefix gets a What-to-do line except the awaiting ones', () => {
  const { ownerActionFor, PAGE_WORTHY_CONDITION_KEYS, PAGE_WORTHY_PREFIXES, AWAITING_OWNER_DECISION } = createRequire(import.meta.url)('./page-worthy-alerts.js');
  const missing = [...PAGE_WORTHY_CONDITION_KEYS, ...PAGE_WORTHY_PREFIXES.map((p) => `${p}x`)]
    .filter((k) => !ownerActionFor(k) && ![...AWAITING_OWNER_DECISION].some((a) => k === a || k.startsWith(a)));
  assert.deepEqual(missing, []);
});

test('withOwnerAction: workflow refs resolve to their file; prototype keys and unknowns are untouched', () => {
  const { withOwnerAction, OWNER_ACTIONS } = createRequire(import.meta.url)('./page-worthy-alerts.js');
  const ref = 'thomaspryor/Broadwayscore/.github/workflows/update-theatr.yml@refs/heads/main';
  assert.equal(withOwnerAction(ref, 'body'), `What to do: ${OWNER_ACTIONS['update-theatr.yml']}\n\nbody`);
  assert.equal(withOwnerAction('constructor', 'body'), 'body');
  assert.equal(withOwnerAction('', 'body'), 'body');
  assert.match(withOwnerAction('auto-fix-first:escalation:', 'pre'), /^What to do: Nothing is needed from you\. .*automatic fix/);
});
