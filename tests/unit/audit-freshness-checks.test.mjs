/**
 * BRO-2476: table-driven freshness checks for cron-written data/audit/*.json
 * reports. evaluateAuditFreshness() (scripts/lib/audit-freshness-checks.js) is
 * the pure decision; checkAuditFreshness() (scripts/health-check.js) reads the
 * files and formats digest rows the same way checkFreshness() does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { AUDIT_FRESHNESS_CHECKS, evaluateAuditFreshness, ageHours, auditFreshnessRowName, auditFieldValue, auditFreshnessPlaybookEntries } = require('../../scripts/lib/audit-freshness-checks.js');
const hc = require('../../scripts/health-check.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const H = 60 * 60 * 1000;
const iso = (hoursBefore) => new Date(NOW - hoursBefore * H).toISOString();

function withField(field, value) {
  const out = {};
  const keys = field.split('.');
  let cur = out;
  keys.slice(0, -1).forEach((k) => { cur[k] = {}; cur = cur[k]; });
  cur[keys[keys.length - 1]] = value;
  return out;
}

test('weekly rows: one skipped run (~336h) warns, a normal late landing (174h) does not', () => {
  const weekly = AUDIT_FRESHNESS_CHECKS.filter((r) => /weekly/i.test(r.hint));
  assert.ok(weekly.length >= 3);
  for (const row of weekly) {
    assert.equal(evaluateAuditFreshness(row, withField(row.field, iso(174)), NOW).status, 'ok', row.file);
    assert.equal(evaluateAuditFreshness(row, withField(row.field, iso(336)), NOW).status, 'warn', row.file);
  }
});

test('every AUDIT_FRESHNESS_CHECKS row has an AUTO_FIX_PLAYBOOK entry that dispatches its writer workflow', () => {
  for (const row of AUDIT_FRESHNESS_CHECKS) {
    const entry = hc.getPlaybookEntry(auditFreshnessRowName(row));
    assert.ok(entry, `no playbook entry for ${row.file}`);
    assert.ok(['fix-now', 'this-week'].includes(entry.urgency), `${row.file}: urgency must keep it out of "+N low-priority"`);
    if (!row.workflow) {
      // No automated writer dispatch: the playbook must tell a human what to do.
      assert.equal(entry.workflow, undefined, row.file);
      assert.ok(entry.humanAction, `${row.file}: a row without a workflow needs humanAction`);
    } else {
      assert.equal(entry.workflow, row.workflow, row.file);
      assert.ok(fs.existsSync(path.join(REPO, '.github/workflows', row.workflow)), `${row.workflow} missing`);
      assert.match(fs.readFileSync(path.join(REPO, '.github/workflows', row.workflow), 'utf8'), /workflow_dispatch:/, `${row.workflow} must be dispatchable`);
      assert.ok(entry.humanFallback, row.file);
    }
    // Exact-name match only: a sibling file must not borrow this entry.
    assert.equal(hc.getPlaybookEntry(`${auditFreshnessRowName(row)}x`), null);
    // A stale row is actionable (named in the digest body).
    assert.equal(hc.isActionableResult({ name: auditFreshnessRowName(row), status: 'warn', message: 'x' }), true);
  }
});

test('hints name the workflow kill switches that would freeze the file', () => {
  for (const row of AUDIT_FRESHNESS_CHECKS.filter((r) => r.workflow)) {
    const yml = fs.readFileSync(path.join(REPO, '.github/workflows', row.workflow), 'utf8');
    const jobSwitches = [...yml.matchAll(/^    if: \$\{\{\s*vars\.([A-Z0-9_]+) != 'true'/gm)].map((m) => m[1]);
    for (const v of jobSwitches) assert.ok(row.hint.includes(v), `${row.file}: hint must name job kill switch ${v}`);
  }
});

test('table has at least 5 rows with sane thresholds and hints', () => {
  assert.ok(AUDIT_FRESHNESS_CHECKS.length >= 5);
  const files = new Set();
  for (const row of AUDIT_FRESHNESS_CHECKS) {
    assert.ok(!files.has(row.file), `duplicate row ${row.file}`);
    files.add(row.file);
    assert.match(row.file, /^[a-z0-9-]+\.json$/);
    assert.ok(row.warnH > 0 && row.errorH > row.warnH, `${row.file}: need 0 < warnH < errorH`);
    assert.ok(typeof row.hint === 'string' && /\.yml/.test(row.hint), `${row.file}: hint must name the writer workflow`);
  }
});

for (const row of AUDIT_FRESHNESS_CHECKS) {
  test(`${row.file}: fresh -> ok, past warnH -> warn, past errorH -> error`, () => {
    assert.equal(evaluateAuditFreshness(row, withField(row.field, iso(0.5)), NOW).status, 'ok');
    assert.equal(evaluateAuditFreshness(row, withField(row.field, iso(row.warnH - 0.5)), NOW).status, 'ok');
    const warn = evaluateAuditFreshness(row, withField(row.field, iso(row.warnH + 0.5)), NOW);
    assert.equal(warn.status, 'warn');
    assert.match(warn.message, /warn threshold/);
    const err = evaluateAuditFreshness(row, withField(row.field, iso(row.errorH + 0.5)), NOW);
    assert.equal(err.status, 'error');
    assert.match(err.message, /error threshold/);
    assert.ok(Math.abs(err.ageH - (row.errorH + 0.5)) < 1e-6);
  });

  test(`${row.file}: missing file / missing field / unparseable date -> error (FRESHNESS_CHECKS convention)`, () => {
    assert.deepEqual(evaluateAuditFreshness(row, null, NOW), { status: row.missingStatus || 'error', ageH: null, message: row.missingMessage || 'File missing' });
    assert.equal(evaluateAuditFreshness(row, undefined, NOW).status, row.missingStatus || 'error');
    const noField = evaluateAuditFreshness(row, { somethingElse: 1 }, NOW);
    assert.equal(noField.status, 'error');
    assert.equal(noField.message, `No ${row.field} field`);
    const bad = evaluateAuditFreshness(row, withField(row.field, 'not-a-date'), NOW);
    assert.equal(bad.status, 'error');
    assert.match(bad.message, /^Unparseable date/);
  });
}

test('ageHours is health-check.js hoursAgo() (one shared implementation), including the BRO-3349 bare-day rule and the 0 clamp', () => {
  assert.equal(ageHours, hc.hoursAgo, 'audit freshness must reuse the exact helper, not a copy');
  for (const v of ['2026-10-12', '2026-10-13', '2026-10-13T03:00:00.000Z', '2026-10-01T00:00:00Z', 'garbage', null]) {
    assert.equal(ageHours(v, NOW), hc.hoursAgo(v, NOW), `parity for ${v}`);
  }
});

test('table integrity: every row file is tracked in git and its field exists and parses in the committed copy', () => {
  const tracked = new Set(
    execFileSync('git', ['ls-files', 'data/audit/'], { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean),
  );
  for (const row of AUDIT_FRESHNESS_CHECKS) {
    const rel = `data/audit/${row.file}`;
    assert.ok(tracked.has(rel), `${rel} is not tracked in git`);
    const committed = JSON.parse(execFileSync('git', ['show', `HEAD:${rel}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
    const value = auditFieldValue(committed, row.field);
    assert.ok(value, `${rel} has no ${row.field} in the committed copy`);
    assert.ok(Number.isFinite(ageHours(value, NOW)), `${rel}: ${row.field}=${value} does not parse`);
  }
});

function withAuditDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fresh-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('checkAuditFreshness: one Freshness row per table entry, mapped to digest statuses', () => {
  const [fresh, stale, broken, ...rest] = AUDIT_FRESHNESS_CHECKS;
  const files = {
    [fresh.file]: JSON.stringify(withField(fresh.field, iso(0.5))),
    [stale.file]: JSON.stringify(withField(stale.field, iso(stale.errorH + 1))),
    [broken.file]: '{ not json',
  };
  // A non-parse read error (here: the path is a directory -> EISDIR) is a
  // crash, not "Unparseable JSON".
  const dirRow = rest.shift();
  withAuditDir(files, (auditDir) => {
    fs.mkdirSync(path.join(auditDir, dirRow.file));
    const rows = hc.checkAuditFreshness({ auditDir, now: NOW });
    assert.equal(rows.length, AUDIT_FRESHNESS_CHECKS.length);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    for (const row of AUDIT_FRESHNESS_CHECKS) assert.ok(byName[`Freshness: audit/${row.file}`], `row for ${row.file}`);
    assert.equal(byName[`Freshness: audit/${fresh.file}`].status, 'pass');
    assert.equal(byName[`Freshness: audit/${fresh.file}`].hint, undefined);
    const s = byName[`Freshness: audit/${stale.file}`];
    assert.equal(s.status, 'error');
    assert.equal(s.hint, stale.hint);
    const b = byName[`Freshness: audit/${broken.file}`];
    assert.equal(b.status, 'error');
    assert.match(b.message, /^Unparseable JSON/);
    const d = byName[`Freshness: audit/${dirRow.file}`];
    assert.equal(d.status, 'error');
    assert.match(d.message, /^Check crashed: .*EISDIR/);
    for (const row of rest) {
      const r = byName[`Freshness: audit/${row.file}`];
      const src = AUDIT_FRESHNESS_CHECKS.find((x) => `Freshness: audit/${x.file}` === r.name);
      assert.equal(r.status, src.missingStatus || 'error');
      assert.equal(r.message, src.missingMessage || 'File missing');
    }
    // Same category as checkFreshness() rows, so they share its triage file.
    for (const r of rows) assert.equal(r.name.split(':')[0].trim().toLowerCase(), 'freshness');
  });
});

test('checkAuditFreshness is wired into the core digest check list right after checkFreshness', () => {
  assert.match(String(hc.computeCoreHealthResults), /checkFreshness\(\),\s*\.\.\.checkAuditFreshness\(\)/);
});

test("console line: 'ok' renders the pass icon, never 'undefined'", () => {
  const ok = hc.formatResultLine({ name: 'Freshness: tony-kalshi-odds.json', status: 'ok', message: 'Skipped (off-season)' });
  const pass = hc.formatResultLine({ name: 'X', status: 'pass', message: 'm' });
  assert.ok(!ok.includes('undefined'), ok);
  assert.equal(ok.trim().split(' ')[0], pass.trim().split(' ')[0]);
  assert.ok(!hc.formatResultLine({ name: 'X', status: 'weird', message: 'm' }).includes('undefined'));
});

// BRO-5261 retro-review: a bare `gh workflow run audit-aggregator-gap.yml` is a
// manual run (21-day window, no 6h throttle on the paid ground-truth audit).
// The auto-fix must pass the cron-redispatch input, and that input must exist.
test('audit-aggregator-gap auto-fix dispatches with cron semantics', () => {
  const fs = require('fs');
  const wf = fs.readFileSync(new URL('../../.github/workflows/audit-aggregator-gap.yml', import.meta.url), 'utf8');
  const entries = auditFreshnessPlaybookEntries().filter((e) => e.workflow === 'audit-aggregator-gap.yml');
  assert.ok(entries.length >= 2);
  for (const e of entries) {
    assert.deepEqual(e.dispatchInputs, { redispatched: 'true' });
    for (const k of Object.keys(e.dispatchInputs)) assert.match(wf, new RegExp(`^      ${k}:`, 'm'), `input ${k} missing from workflow_dispatch`);
  }
});
