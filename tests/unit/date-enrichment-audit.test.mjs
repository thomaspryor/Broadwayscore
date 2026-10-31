import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { appendAuditRun, MAX_RUNS } = createRequire(import.meta.url)('../../scripts/lib/date-enrichment-audit.js');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dea-')), 'sub', 'a.json');

test('empty entries writes nothing', () => {
  const p = tmp();
  assert.equal(appendAuditRun(p, 's', {}, []), false);
  assert.equal(fs.existsSync(p), false);
});

test('appends a run with script, mode and entries, creating dirs', () => {
  const p = tmp();
  assert.equal(appendAuditRun(p, 'enrich-west-end-dates', { dryRun: true }, [{ kind: 'applied', id: 'x' }]), true);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(d._meta.schema, 'date-enrichment-corrections v1');
  assert.equal(d.runs[0].script, 'enrich-west-end-dates');
  assert.equal(d.runs[0].entries[0].id, 'x');
});

test('preserves other scripts runs, recovers from corrupt file, caps at MAX_RUNS', () => {
  const p = tmp();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{bad');
  appendAuditRun(p, 'a', {}, [{ k: 1 }]);
  for (let i = 0; i < MAX_RUNS + 5; i++) appendAuditRun(p, 'b', {}, [{ k: i }]);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(d.runs.length, MAX_RUNS);
  assert.equal(d.runs.at(-1).script, 'b');
});
