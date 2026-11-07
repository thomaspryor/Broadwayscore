import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { appendAuditRun, MAX_RUNS } = createRequire(import.meta.url)('../../scripts/lib/date-enrichment-audit.js');

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dea-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sub', 'a.json');
};

test('empty entries records a completed run', t => {
  const p = tmp(t);
  assert.equal(appendAuditRun(p, 's', {}, []), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).runs[0].entries, []);
});

test('appends a run with script, mode and entries, creating dirs', t => {
  const p = tmp(t);
  assert.equal(appendAuditRun(p, 'enrich-west-end-dates', { dryRun: true }, [{ kind: 'applied', id: 'x' }]), true);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(d._meta.schema, 'date-enrichment-corrections v1');
  assert.equal(d.runs[0].script, 'enrich-west-end-dates');
  assert.equal(d.runs[0].entries[0].id, 'x');
});

test('preserves other scripts runs, recovers from corrupt file, caps at MAX_RUNS', t => {
  const p = tmp(t);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{bad');
  appendAuditRun(p, 'a', {}, [{ k: 1 }]);
  const firstRun = JSON.parse(fs.readFileSync(p, 'utf8')).runs[0];
  const secondAt = new Date('2026-11-02T00:00:00Z');
  appendAuditRun(p, 'b', {}, [], secondAt);
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).runs, [
    firstRun,
    { runAt: secondAt.toISOString(), script: 'b', mode: {}, entries: [] },
  ]);
  for (let i = 0; i < MAX_RUNS + 5; i++) appendAuditRun(p, 'b', {}, [{ k: i }]);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(d.runs.length, MAX_RUNS);
  assert.equal(d.runs.at(-1).script, 'b');
});
