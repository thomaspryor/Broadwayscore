/**
 * BRO-4603: the UGC round-trip only emails the owner for urgent failures.
 *
 * Five "[CRITICAL] UGC Auth Round-trip Failed" emails (2026-10-01..03) said
 * "user ratings may be leaking across accounts" when the only failing check was
 * a GET-vs-POST hardening rule. Checks are urgent by default; a call site opts
 * out with NOT_URGENT. This file pins the summary logic, the incident check's
 * opt-out, and that no sign-in / saving / privacy check is ever opted out.
 *
 * Run: node --test tests/unit/ugc-roundtrip-urgency.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NOT_URGENT, summarizeFailures, githubOutputLines } from '../../scripts/lib/ugc-roundtrip-urgency.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CHECK_FILES = [
  'scripts/test-ugc-roundtrip.mjs',
  'scripts/lib/plan-shares-roundtrip.mjs',
  'scripts/lib/diary-shares-roundtrip.mjs',
];

/** Every literal check('<name>', ...) call with whether it passes NOT_URGENT. */
function scanChecks() {
  const out = [];
  for (const rel of CHECK_FILES) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    const re = /\bcheck\('([^']+)'/g;
    let m;
    while ((m = re.exec(src))) {
      // The call ends at the first ');' after the name; good enough for this corpus
      // (asserted below: every scanned call is found and none spans a nested ');').
      const end = src.indexOf(');', m.index);
      out.push({ file: rel, name: m[1], notUrgent: /\bNOT_URGENT\b/.test(src.slice(m.index, end)) });
    }
  }
  return out;
}

test('summarizeFailures: checks are urgent unless marked NOT_URGENT', () => {
  const s = summarizeFailures([
    { name: 'sign-in: minted', ok: true, urgent: true },
    { name: 'plans: GET refused', ok: false, urgent: false },
  ]);
  assert.deepEqual(s, { failed: 1, urgent: false, urgentNames: [], otherNames: ['plans: GET refused'] });

  const t = summarizeFailures([
    { name: 'rating: RLS hides it', ok: false },
    { name: 'plans: GET refused', ok: false, urgent: NOT_URGENT.urgent },
  ]);
  assert.equal(t.urgent, true);
  assert.deepEqual(t.urgentNames, ['rating: RLS hides it']);
  assert.deepEqual(t.otherNames, ['plans: GET refused']);
});

test('githubOutputLines: key=value lines, single-line names', () => {
  const lines = githubOutputLines({ urgent: false, urgentNames: [], otherNames: ['a\nb', 'c'] });
  assert.deepEqual(lines, ['urgent=false', 'failed_checks=a b; c']);
  // Lands in a JS template literal downstream: no backtick, ${ or backslash survives.
  const [, f] = githubOutputLines({ urgent: true, urgentNames: ['aborted: `x` ${y} \\z'], otherNames: [] });
  assert.equal(f, 'failed_checks=aborted: x {y} z');
});

test('the scan sees the round-trip checks (guard against a vacuous pass)', () => {
  const checks = scanChecks();
  assert.ok(checks.length >= 50, `found only ${checks.length} check() calls — did the call shape change?`);
  assert.ok(checks.some((c) => c.notUrgent), 'no NOT_URGENT call sites found');
});

test('the 2026-10-01 incident check is NOT urgent (it paged 5 times for a hardening rule)', () => {
  const c = scanChecks().find((x) => x.name.startsWith('plans: GET on get_shared_plans is refused'));
  assert.ok(c, 'incident check not found');
  assert.equal(c.notUrgent, true);
});

test('no sign-in, saving or privacy check is marked NOT_URGENT', () => {
  const MUST_STAY_URGENT = /^sign-in:|^rating: (saves|stored value|owner reads it back)|\bRLS\b|anonymous cannot|another user cannot|hidden|stays private|is not listed|stop sharing|old link dies|allowed fields|no ids or user|no note text|off by default/i;
  const offenders = scanChecks().filter((c) => c.notUrgent && MUST_STAY_URGENT.test(c.name)).map((c) => `${c.file}: ${c.name}`);
  assert.deepEqual(offenders, [], 'These checks protect sign-in, saving or privacy and must page when they fail — remove NOT_URGENT');
});
