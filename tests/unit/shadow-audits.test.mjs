// BRO-6038: every audit in scripts/lib/shadow-audits.js must be run, in shadow
// mode, by data-health-check.yml's shadow-audits job and write the counts file
// the digest row reads, and the digest rows must stay non-actionable while in
// shadow. Uses the real registry, workflow and health-check functions (rule 15).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const yaml = require('js-yaml');
const { SHADOW_AUDITS, SHADOW_AUDITS_DIR, shadowAuditCountsPath } = require('../../scripts/lib/shadow-audits.js');
const { writeAuditCounts, countsPathFromArgv } = require('../../scripts/lib/audit-counts.js');
const { shadowAuditResults, getPlaybookEntry, isActionableResult } = require('../../scripts/health-check.js');

const wf = yaml.load(fs.readFileSync(path.join(REPO, '.github/workflows/data-health-check.yml'), 'utf8'));
const job = wf.jobs['shadow-audits'];

test('shadow-audits job runs after health-check (even if it failed) and clears old counts first', () => {
  assert.ok(job, 'data-health-check.yml has no shadow-audits job');
  assert.equal(job.needs, 'health-check');
  assert.match(String(job.if), /!cancelled\(\)/);
  const clear = job.steps.findIndex((s) => /rm -f data\/audit\/shadow-audits\/\*\.json/.test(s.run || ''));
  const firstAudit = job.steps.findIndex((s) => /scripts\/audit-/.test(s.run || ''));
  assert.ok(clear >= 0 && clear < firstAudit, 'stale counts must be removed before the first audit runs');
});

test('every registry script produces a findings count', () => {
  for (const a of SHADOW_AUDITS) {
    const src = fs.readFileSync(path.join(REPO, 'scripts', a.script), 'utf8');
    if (a.countsFlag === '--report-out') assert.match(src, /findings:/, `${a.script}: report must carry findings`);
    else assert.match(src, /writeAuditCounts\(/, `${a.script}: --counts must go through writeAuditCounts`);
  }
});

test('every registry audit has a continue-on-error step writing its counts file', () => {
  for (const a of SHADOW_AUDITS) {
    assert.ok(fs.existsSync(path.join(REPO, 'scripts', a.script)), `${a.script} missing`);
    const flag = `${a.countsFlag || '--counts'}=${shadowAuditCountsPath(a.name)}`;
    const steps = job.steps.filter((s) => typeof s.run === 'string' && s.run.includes(`scripts/${a.script}`));
    assert.equal(steps.length, 1, `${a.script}: expected exactly one shadow-audits step`);
    assert.ok(steps[0].run.includes(flag), `${a.script}: step must pass ${flag}`);
    assert.equal(steps[0]['continue-on-error'], true, `${a.script}: shadow mode needs continue-on-error: true (rule 19)`);
    assert.ok(Number(steps[0]['timeout-minutes']) > 0, `${a.script}: needs a timeout-minutes cap`);
  }
});

test('the job commits every counts file', () => {
  const commit = job.steps.find((s) => /^Commit shadow audit counts/.test(s.name || ''));
  assert.ok(commit, 'no commit step');
  for (const a of SHADOW_AUDITS) {
    assert.ok(commit.run.includes(`git add ${shadowAuditCountsPath(a.name)} `), `${a.name}: commit step must stage ${shadowAuditCountsPath(a.name)}`);
  }
  assert.ok(shadowAuditCountsPath('x').startsWith(`${SHADOW_AUDITS_DIR}/`));
  assert.ok(commit.run.includes('push-with-retry.sh'));
});

test('digest rows: over max warns, at max passes, undetermined and stale warn, missing is silent before the expected date', () => {
  const a = { name: 'x', script: 'audit-x.js', label: 'x things', max: 2, hint: 'h' };
  const now = Date.parse('2026-11-01T12:00:00Z');
  const fresh = new Date(now - 3600e3).toISOString();
  const row = (report, t = now) => shadowAuditResults([a], { x: report }, t);
  assert.equal(row({ generatedAt: fresh, findings: 3 })[0].status, 'warn');
  assert.equal(row({ generatedAt: fresh, findings: 2 })[0].status, 'pass');
  assert.equal(row({ generatedAt: fresh, findings: null, undetermined: true })[0].status, 'warn');
  assert.equal(row({ generatedAt: new Date(now - 4 * 86400e3).toISOString(), findings: 0 })[0].status, 'warn');
  assert.deepEqual(row(null), []);
  assert.equal(row(null, Date.parse('2026-11-07T00:00:00Z'))[0].status, 'warn');
  assert.equal(row({ generatedAt: fresh, findings: 3 })[0].name, 'Shadow audit: x things');
  const y = { ...a, year: 2026 };
  assert.equal(shadowAuditResults([y], { x: { generatedAt: fresh, findings: 0, year: 2027 } }, now)[0].status, 'warn');
  assert.equal(shadowAuditResults([y], { x: { generatedAt: fresh, findings: 0, year: 2026 } }, now)[0].status, 'pass');
});

test('shadow rows are low urgency: counted, never actionable', () => {
  for (const a of SHADOW_AUDITS) {
    const r = { name: `Shadow audit: ${a.label}`, status: 'warn', message: 'm' };
    assert.equal(getPlaybookEntry(r.name).urgency, 'low', a.name);
    assert.equal(isActionableResult(r), false, a.name);
  }
});

test('writeAuditCounts: counts file shape, null findings marked undetermined', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-counts-'));
  const f = path.join(dir, 'sub', 'a.json');
  writeAuditCounts(f, 'audit-a.js', { findings: 4, scanned: 9 });
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(j.findings, 4); assert.equal(j.script, 'audit-a.js'); assert.ok(Date.parse(j.generatedAt));
  assert.equal(j.undetermined, undefined);
  writeAuditCounts(f, 'audit-a.js', { findings: null });
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).undetermined, true);
  assert.equal(countsPathFromArgv(['--x', '--counts=out.json']), 'out.json');
  assert.equal(countsPathFromArgv(['--counts=']), null);
});

test('ownership-gate audit refuses a review-texts dir that is not its own git root', () => {
  const dir = fs.mkdtempSync(path.join(REPO, '.tmp-not-a-repo-'));
  try {
    let status = 0;
    try {
      execFileSync(process.execPath, [path.join(REPO, 'scripts/audit-ownership-gate-losses.js')], { env: { ...process.env, REVIEW_TEXTS_DIR: dir }, stdio: 'pipe' });
    } catch (e) { status = e.status; }
    assert.equal(status, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
