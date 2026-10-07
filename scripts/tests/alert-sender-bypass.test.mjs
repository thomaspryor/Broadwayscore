/**
 * alert-sender-bypass.test.mjs — BRO-1699 acceptance.
 *
 * The card's bar: the alert-sender audit reports ZERO direct-bypass call
 * sites (sendAlert(email:true) calls that skip owner-alert-router.js's
 * ACTION-only policy + ledger dedup). Requires the REAL exported scanner
 * (scripts/audit-alert-senders.js's collectFindings/buildDirectCounts) per
 * CLAUDE.md rule 15 — never re-lists SCAN_DIRS/SCAN_EXTENSIONS/walk() or the
 * regex patterns here, so a future scan-dir/skip addition or a new direct
 * sendAlert(email:true) bypass fails this test the same way it fails the
 * CI gate (audit-alert-senders.js --check), instead of two copies silently
 * drifting apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { collectFindings, buildDirectCounts } = require(path.join(REPO, 'scripts/audit-alert-senders.js'));

test('alert-sender audit reports zero direct-bypass call sites', () => {
  const findings = collectFindings();
  const counts = buildDirectCounts(findings);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(
    total,
    0,
    `${total} direct sendAlert(email:true) bypass(es) of owner-alert-router found: ` +
      `${JSON.stringify(counts)} — route through routeAlert() (scripts/lib/owner-alert-router.js) instead.`
  );
});

test('the two historical BRO-1699 bypass sites are migrated onto routeAlert()', () => {
  const broadcastYml = fs.readFileSync(
    path.join(REPO, '.github/workflows/opening-night-broadcast.yml'),
    'utf8'
  );
  const pollerJs = fs.readFileSync(path.join(REPO, 'scripts/opening-night-poller.js'), 'utf8');
  // BRO-2438 finding 2 extracted the tripwire's routeAlert() call out of
  // opening-night-poller.js into scripts/lib/serp-burst-tripwire.js (so the
  // write-after-notify fix is directly unit-testable) — the real call site
  // now lives there, not inline in the poller.
  const tripwireLib = fs.readFileSync(path.join(REPO, 'scripts/lib/serp-burst-tripwire.js'), 'utf8');

  // Anchored on the actual call shape (routeAlert({ ... conditionKey: '<the
  // migrated key>' ...), not a bare /routeAlert/ match — that would also hit
  // this file's own long BRO-1699 comments, so a revert of the real call
  // back to sendAlert(email:true) that left the comments in place would
  // still have passed.
  assert.match(
    broadcastYml,
    /routeAlert\(\{[^}]*conditionKey:\s*'broadcast:overdue:'/s,
    "opening-night-broadcast.yml's overdue alert does not call routeAlert({ conditionKey: 'broadcast:overdue:' ... })"
  );
  assert.match(
    tripwireLib,
    /routeAlert\(\{[^}]*conditionKey:\s*'serp-burst:tripwire'/s,
    "scripts/lib/serp-burst-tripwire.js does not call routeAlert({ conditionKey: 'serp-burst:tripwire' ... })"
  );
  assert.match(
    pollerJs,
    /maybeAlertSerpBurstTripwire\(\{/,
    "opening-night-poller.js no longer wires up the extracted serp-burst-tripwire alert"
  );
  assert.doesNotMatch(
    pollerJs,
    /sendAlert\(\{[^}]*email:\s*true/s,
    'opening-night-poller.js must not call sendAlert(email:true) directly — route through routeAlert() / maybeAlertSerpBurstTripwire'
  );
});

test('the overdue-broadcast alert step is reachable when an earlier gate step fails', () => {
  // BRO-2815: the "Alert if broadcast overdue" step used to have no always()
  // guard, so GitHub Actions skipped it whenever an earlier gate step
  // (Checklist/Drift/Orphan-unscored) failed and blocked the send — the
  // single most likely reason a broadcast goes overdue in the first place.
  // The routeAlert()-reaches-the-allowlist test above only proves the alert
  // is well-formed, not that GHA will ever evaluate the step that sends it.
  const broadcastYml = fs.readFileSync(
    path.join(REPO, '.github/workflows/opening-night-broadcast.yml'),
    'utf8'
  );
  const lines = broadcastYml.split('\n');
  const stepStart = lines.findIndex((l) => l.includes('name: Alert if broadcast overdue'));
  assert.ok(stepStart !== -1, '"Alert if broadcast overdue" step not found in opening-night-broadcast.yml');
  const stepIndent = lines[stepStart].match(/^(\s*)/)[1].length;
  // A step block ends at the next line at the same-or-shallower indent that
  // starts a new `- name:` entry (or a blank line followed by one) — find
  // the next sibling step and slice up to it.
  let stepEnd = lines.length;
  for (let i = stepStart + 1; i < lines.length; i++) {
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (lines[i].trim() !== '' && indent <= stepIndent) { stepEnd = i; break; }
  }
  const stepBlock = lines.slice(stepStart, stepEnd).join('\n');
  const ifLine = stepBlock.split('\n').find((l) => /^\s*if:/.test(l));
  assert.ok(ifLine, '"Alert if broadcast overdue" step has no if: condition');
  assert.match(
    ifLine,
    /always\(\)/,
    '"Alert if broadcast overdue" step\'s if: condition must include always() — ' +
      'otherwise a Checklist/Drift/Orphan-unscored gate failure earlier in the job ' +
      'skips this step and the overdue pager never fires (BRO-2815).'
  );
});

test('both migrated conditionKeys stay on the page-worthy allowlist (no silent digest downgrade)', () => {
  // Ship-check finding (BRO-1699): leaving a migrated conditionKey off this
  // allowlist silently downgrades disposition:'human' to the digest, which
  // regressed real-time paging for the SERP-burst tripwire on the first pass
  // (its own severity rationale argues a 24h-late digest is inadequate). This
  // locks both migrated keys in so a future edit to page-worthy-alerts.js
  // can't quietly re-introduce that regression.
  const { PAGE_WORTHY_PREFIXES, PAGE_WORTHY_CONDITION_KEYS } = require(
    path.join(REPO, 'scripts/lib/page-worthy-alerts.js')
  );
  assert.ok(
    PAGE_WORTHY_PREFIXES.includes('broadcast:overdue:'),
    "'broadcast:overdue:' missing from PAGE_WORTHY_PREFIXES"
  );
  assert.ok(
    PAGE_WORTHY_CONDITION_KEYS.has('serp-burst:tripwire'),
    "'serp-burst:tripwire' missing from PAGE_WORTHY_CONDITION_KEYS"
  );
});
