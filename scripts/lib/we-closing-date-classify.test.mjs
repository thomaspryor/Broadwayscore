// BRO-1158 follow-up: "extension-only write" rule for audit-we-closing-dates.js.
// Blocking lane (scripts/lib shard): no shows.json read. A regression that lets a
// booking-tranche "new closing" candidate (or any non-EXTENSION result) write a
// closingDate fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { routeWeAuditResult, classifyWeClosingDelta } = require('./we-closing-date-classify.js');

const NEVER_WRITE = [
  'NEW_CLOSING_NEEDS_REVIEW', 'EXTENSION_EXCEEDS_CAP_NEEDS_REVIEW', 'NEEDS_HUMAN_REVIEW',
  'POSSIBLY_CLOSED_NEEDS_REVIEW', 'MATCH', 'ERROR', 'SOMETHING_NEW', undefined,
];

test('only EXTENSION on an unprotected show writes', () => {
  assert.deepEqual(routeWeAuditResult('EXTENSION', true), { bucket: 'extensions', write: true });
});

test('EXTENSION on a human-protected show does not write', () => {
  assert.equal(routeWeAuditResult('EXTENSION', false).write, false);
});

for (const action of NEVER_WRITE) {
  for (const canWrite of [true, false]) {
    test(`${action} never writes (canWrite=${canWrite})`, () => {
      assert.equal(routeWeAuditResult(action, canWrite).write, false);
    });
  }
}

test('every classifier output routes to a non-writing bucket unless EXTENSION', () => {
  const cases = [
    { stored: null, extracted: '2027-06-05' },          // booking tranche, no stored close
    { stored: '2027-01-02', extracted: '2027-06-05' },  // Oh, Mary! extension
    { stored: '2027-01-02', extracted: '2028-06-05' },  // over cap
    { stored: '2027-06-05', extracted: '2027-01-02' },  // shrink
    { stored: '2027-01-02', extracted: '2027-01-02' },  // match
  ];
  for (const c of cases) {
    const { action } = classifyWeClosingDelta(c);
    assert.equal(routeWeAuditResult(action, true).write, action === 'EXTENSION', JSON.stringify(c));
  }
});

// Orchestrator guard: the audit script has exactly TWO writeClosingDate calls.
// 1) the extension write, behind routeWeAuditResult's `route.write`;
// 2) the BRO-7993 press-confirmed new-closing write, which is reachable only after
//    decideWeNewClosing(...).apply and a canWriteClosingDate check. A third call,
//    or a write that skips the decision, fails here.
import fs from 'node:fs';
test('audit-we-closing-dates.js: writeClosingDate only behind route.write or a press-confirmed decision', () => {
  const src = fs.readFileSync(new URL('../audit-we-closing-dates.js', import.meta.url), 'utf8');
  const calls = src.match(/writeClosingDate\(/g) || [];
  assert.equal(calls.length, 2);
  assert.match(src, /routeWeAuditResult\(result\.action, canWriteClosingDate\(show\)\)/);
  const i = src.indexOf('writeClosingDate(show, result.extracted');
  assert.ok(i > 0);
  assert.match(src.slice(Math.max(0, i - 400), i), /if \(!route\.write\)[\s\S]*else \{/);
  const j = src.indexOf('writeClosingDate(show, decision.date');
  assert.ok(j > 0);
  const before = src.slice(Math.max(0, j - 700), j);
  assert.match(before, /if \(!decision\.apply\)/);
  assert.match(before, /canWriteClosingDate\(show\)/);
  assert.match(src, /decideWeNewClosing\(\{ stored: show\.closingDate \|\| null/);
});
