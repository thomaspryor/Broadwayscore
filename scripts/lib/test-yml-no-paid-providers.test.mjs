// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — reads the real workflow
// YAML under .github/workflows/ (CI config, not data/*.json derived data).
/**
 * BRO-2984 — the Test Suite must not spend money at paid providers.
 *
 * `.github/workflows/test.yml`'s `data-validation` job ran
 * `validate-show-venue.js --all-provisional --fail-on-mismatch` with
 * SCRAPINGBEE_API_KEY + BRIGHTDATA_TOKEN in its step `env:`, on EVERY push to
 * main. `data/audit/scraper-spend-ledger.jsonl` carried 222 rows attributed to
 * workflow "Test Suite" in a ~2-day window, all from that one script.
 *
 * The sweep was NOT deleted — CLAUDE.md §3 requires the Playbill
 * cross-validation to exist. It moved to the daily
 * `.github/workflows/audit-provisional-venues.yml`. So this file pins BOTH
 * halves: the spend is gone from the push path, AND the coverage still exists
 * at its new home. Dropping the coverage instead of moving it fails here just
 * as loudly as reintroducing the spend.
 *
 * Pattern: require() the real scanner (CLAUDE.md §15) — the decision logic
 * lives in scripts/lib/paid-provider-push-scan.js and is also wired into
 * scripts/audit-workflow-hygiene.js as rule (k), so this test and the blocking
 * CI lint gate can never disagree about what counts as a violation.
 *
 * Runs in CI via the unit-tests job's `scripts/lib/*.test.mjs` glob
 * (.github/workflows/test.yml, "Run scripts/lib tests"), and a push touching it
 * triggers CI via the `scripts/lib/**` on.push.paths glob — so it needs no
 * manifest entry and no hand-added path allow-list line
 * (memory/feedback_test_yml_push_path_allowlist.md).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  scanWorkflow,
  hasPushTrigger,
  findPaidSecretEnvLines,
  PAID_PROVIDER_SECRETS,
  EXEMPTION_MARKER,
} = require('./paid-provider-push-scan.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const WORKFLOW_DIR = path.join(REPO, '.github', 'workflows');
const TEST_YML = path.join(WORKFLOW_DIR, 'test.yml');
const DAILY_SWEEP_YML = path.join(WORKFLOW_DIR, 'audit-provisional-venues.yml');

const read = (p) => fs.readFileSync(p, 'utf8');

// ── The scanner itself must work ─────────────────────────────────────────────
// Without these, every assertion below could pass because the detector is
// broken rather than because the workflows are clean — the failure mode that
// makes a guard worse than no guard.

test('scanner: flags a paid secret mapped into a step env in a push-triggered workflow', () => {
  const fixture = [
    'name: Fixture',
    'on:',
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: Spend money',
    '        env:',
    '          SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}',
    '        run: node scripts/some-scraper.js',
    '',
  ].join('\n');
  const r = scanWorkflow(fixture, 'fixture.yml');
  assert.equal(r.pushTriggered, true);
  assert.equal(r.violations.length, 1, 'expected exactly one violation');
  assert.equal(r.violations[0].kind, 'paid-secret-in-push-workflow');
});

test('scanner: flags an --all-provisional sweep in a push-triggered workflow', () => {
  const fixture = [
    'on:',
    '  push:',
    'jobs:',
    '  j:',
    '    steps:',
    '      - run: node scripts/validate-show-venue.js --all-provisional --fail-on-mismatch',
    '',
  ].join('\n');
  const r = scanWorkflow(fixture, 'fixture.yml');
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, 'paid-sweep-command-in-push-workflow');
});

test('scanner: a `secrets.X != \'\'` presence test is NOT a violation', () => {
  // test.yml's own HAS_SCRAPE_SECRETS gate compares a secret to the empty
  // string to decide whether to skip. It never hands the value to a process,
  // so it cannot bill. If this ever starts failing, the rule has become
  // unusable on the exact file it exists to protect.
  const fixture = [
    'on:',
    '  push:',
    'jobs:',
    '  j:',
    '    steps:',
    '      - name: Gate',
    '        env:',
    "          HAS_SCRAPE_SECRETS: ${{ (secrets.SCRAPINGBEE_API_KEY != '' && secrets.BRIGHTDATA_TOKEN != '') && 'true' || 'false' }}",
    '        run: echo gated',
    '',
  ].join('\n');
  const r = scanWorkflow(fixture, 'fixture.yml');
  assert.deepEqual(r.violations, [], 'a presence test must not be flagged as a credential hand-off');
});

test('scanner: the same paid secret in a NON-push workflow is not a violation', () => {
  // This is the whole point of the move: the daily cron may spend, the push
  // path may not.
  const fixture = [
    'on:',
    '  schedule:',
    "    - cron: '25 5 * * *'",
    'jobs:',
    '  j:',
    '    steps:',
    '      - env:',
    '          BRIGHTDATA_TOKEN: ${{ secrets.BRIGHTDATA_TOKEN }}',
    '        run: node scripts/validate-show-venue.js --all-provisional',
    '',
  ].join('\n');
  const r = scanWorkflow(fixture, 'fixture.yml');
  assert.equal(r.pushTriggered, false);
  assert.deepEqual(r.violations, []);
});

test('scanner: hasPushTrigger understands inline and list `on:` forms', () => {
  assert.equal(hasPushTrigger('on: push\n'), true);
  assert.equal(hasPushTrigger('on: [push, schedule]\n'), true);
  assert.equal(hasPushTrigger('on: [schedule]\n'), false);
  assert.equal(hasPushTrigger('on:\n  push:\n    branches: [main]\n'), true);
  assert.equal(hasPushTrigger('on:\n  schedule:\n    - cron: "0 5 * * *"\n'), false);
  // `push` nested under another trigger's options is not a push trigger.
  assert.equal(hasPushTrigger('on:\n  workflow_run:\n    workflows: [push]\n'), false);
});

test('scanner: every listed paid secret is actually detected', () => {
  // Guards against a typo in PAID_PROVIDER_SECRETS silently disarming an entry.
  for (const secret of PAID_PROVIDER_SECRETS) {
    const fixture = `on:\n  push:\njobs:\n  j:\n    steps:\n      - env:\n          K: \${{ secrets.${secret} }}\n        run: echo hi\n`;
    const hits = findPaidSecretEnvLines(fixture);
    assert.equal(hits.length, 1, `${secret} was not detected by findPaidSecretEnvLines`);
    assert.equal(hits[0].secret, secret);
  }
});

// ── The real invariant ───────────────────────────────────────────────────────

test('test.yml spends nothing at a paid provider on push', () => {
  const r = scanWorkflow(read(TEST_YML), 'test.yml');
  assert.equal(r.pushTriggered, true, 'test.yml must still be push-triggered (or this test is vacuous)');
  assert.deepEqual(
    r.violations.map((v) => v.message),
    [],
    'test.yml runs on every push to main — it must not hand credentials to a paid provider, ' +
      'and must not invoke a paid sweep. Move the work to a cron workflow ' +
      '(see .github/workflows/audit-provisional-venues.yml, BRO-2984).',
  );
});

test('test.yml does not carry the paid-provider exemption marker', () => {
  // The scanner honors `# paid-provider-ok:` anywhere in a workflow. That
  // escape hatch must never be usable on test.yml itself — otherwise the guard
  // above could be silenced with a one-line comment on the exact file the
  // whole rule exists to protect.
  assert.ok(
    !read(TEST_YML).includes(EXEMPTION_MARKER),
    `test.yml must not contain "${EXEMPTION_MARKER}" — the Test Suite has no legitimate reason to spend money on a push.`,
  );
});

test('no push-triggered workflow spends at a paid provider', () => {
  // The generalized invariant, so the next workflow to acquire an `on: push:`
  // trigger is covered without anyone remembering to add it here.
  const offenders = [];
  for (const f of fs.readdirSync(WORKFLOW_DIR).filter((x) => /\.ya?ml$/.test(x))) {
    const r = scanWorkflow(read(path.join(WORKFLOW_DIR, f)), f);
    for (const v of r.violations) offenders.push(v.message);
  }
  assert.deepEqual(
    offenders,
    [],
    'push-triggered workflow(s) can spend at a paid provider. Move the work to a cron ' +
      `workflow, or (with a written justification) add "# ${EXEMPTION_MARKER} <reason>" to that file.`,
  );
});

// ── The coverage must still exist somewhere ──────────────────────────────────

test('the provisional-venue sweep still runs daily in audit-provisional-venues.yml', () => {
  assert.ok(
    fs.existsSync(DAILY_SWEEP_YML),
    'audit-provisional-venues.yml is missing — the CLAUDE.md §3 Playbill cross-validation was DROPPED, not moved.',
  );
  const raw = read(DAILY_SWEEP_YML);

  assert.match(
    raw,
    /node scripts\/validate-show-venue\.js \$FLAGS/,
    'the daily workflow must still invoke validate-show-venue.js',
  );
  assert.match(
    raw,
    /--all-provisional/,
    'the daily sweep must still cover ALL provisional entries, not a single --show=',
  );
  assert.match(raw, /^\s*-\s*cron:/m, 'the relocated sweep must actually be scheduled');
  assert.equal(
    hasPushTrigger(raw),
    false,
    'the relocated sweep must not itself be push-triggered — that would recreate BRO-2984',
  );
});

test('the relocated sweep commits its rotation state and its spend ledger', () => {
  const raw = read(DAILY_SWEEP_YML);
  // Without the rotation-state commit, --time-budget-min re-reads a stale
  // snapshot every run and the same tail is deferred forever (BRO-2695).
  assert.match(
    raw,
    /git add data\/audit\/venue-date-mismatches\.json/,
    'the daily sweep must persist venue-date-mismatches.json or its budget rotation can never advance (BRO-2695)',
  );
  // Without the ledger commit, the spend rows die on the runner and the move
  // looks like the cost vanished rather than relocated — and
  // `lint-workflow-guards.sh ledger-coverage` fails.
  assert.match(
    raw,
    /commit-scraper-spend-ledger/,
    'the daily sweep must commit the scraper-spend ledger so its cost stays attributed',
  );
});
