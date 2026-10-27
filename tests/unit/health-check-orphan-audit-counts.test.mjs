// BRO-6038: digest rows for the BRO-2688 rank 1-8 audits, and the workflow wiring that feeds them.
// TESTS-VS-DERIVED-DATA-EXEMPT: structural only (the star-bands run asserts a counts-only shape, no data facts).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { orphanAuditCountsResults, ORPHAN_AUDIT_DIGESTS } = require('../../scripts/health-check.js');
const { countsPathFrom, writeAuditCounts } = require('../../scripts/lib/audit-counts.js');
const { CORE_DATA_MERGE_REGISTRY: MERGE_REGISTRY } = require('../../scripts/lib/core-data-merge-registry.js');

const spec = { file: 'x.json', script: 'audit-x.js', max: 0, name: 'Data: x', what: 'x thing(s)' };
const now = Date.parse('2026-10-27T12:00:00Z');
const fresh = '2026-10-27T02:00:00Z';

test('warn above the limit, pass at or below it, warn when stale or unusable, nothing when missing', () => {
  assert.deepStrictEqual(orphanAuditCountsResults(spec, null, now), []);
  assert.strictEqual(orphanAuditCountsResults(spec, { generatedAt: fresh, findings: 2 }, now)[0].status, 'warn');
  assert.strictEqual(orphanAuditCountsResults(spec, { generatedAt: fresh, findings: 0 }, now)[0].status, 'pass');
  assert.strictEqual(orphanAuditCountsResults({ ...spec, max: 5 }, { generatedAt: fresh, findings: 5 }, now)[0].status, 'pass');
  assert.strictEqual(orphanAuditCountsResults({ ...spec, max: 5 }, { generatedAt: fresh, findings: 6 }, now)[0].status, 'warn');
  const stale = orphanAuditCountsResults(spec, { generatedAt: '2026-10-20T00:00:00Z', findings: 0 }, now);
  assert.strictEqual(stale[0].status, 'warn');
  assert.match(stale[0].message, /more than 3 days old/);
  const insufficient = orphanAuditCountsResults(spec, { generatedAt: fresh, findings: null, insufficient: true }, now);
  assert.strictEqual(insufficient[0].status, 'warn');
  assert.match(insufficient[0].message, /not enough history/);
});

test('audit-counts writes only with --counts and keeps findings numeric or null', () => {
  assert.strictEqual(countsPathFrom(['--json']), null);
  assert.strictEqual(writeAuditCounts(['--json'], 3), null);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-counts-')), 'sub', 'c.json');
  writeAuditCounts([`--counts=${file}`], 3, { scanned: 9 });
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(body.findings, 3);
  assert.strictEqual(body.scanned, 9);
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
  writeAuditCounts([`--counts=${file}`], NaN);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).findings, null);
});

test('every digest row is fed by a data-health-check.yml step, committed, and registered', () => {
  const wf = fs.readFileSync(path.join(REPO, '.github/workflows/data-health-check.yml'), 'utf8');
  for (const s of ORPHAN_AUDIT_DIGESTS) {
    assert.ok(fs.existsSync(path.join(REPO, 'scripts', s.script)), `${s.script} missing`);
    assert.match(wf, new RegExp(`node scripts/${s.script.replace('.', '\\.')} [^\\n]*--counts=data/audit/${s.file.replace('.', '\\.')}`), `${s.script} not run with --counts=data/audit/${s.file}`);
    assert.ok(wf.includes(`git add data/audit/${s.file}`), `data/audit/${s.file} not staged by a commit step`);
    assert.ok(MERGE_REGISTRY.some((e) => e.file === `audit/${s.file}`), `audit/${s.file} missing from core-data-merge-registry.js`);
  }
});

test('star-bands --counts writes a counts-only snapshot from a fixture-free run', { skip: !fs.existsSync(path.join(REPO, 'data/reviews.json')) }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-counts-')), 'sb.json');
  execFileSync(process.execPath, [path.join(REPO, 'scripts/audit-star-bands.js'), `--counts=${file}`], { stdio: 'ignore' });
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Number.isInteger(body.findings));
  assert.ok(!JSON.stringify(body).includes('http'), 'counts file must not carry URLs');
});
