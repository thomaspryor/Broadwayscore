import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * BRO-4623. `audit-commercial-data.js --strict` fails on an ID/slug
 * duplicate key pair, and the only thing that heals one is
 * `dedupe-commercial-id-keys.js --apply`. commercial-weekly.yml ran the
 * dedupe before its strict gate; commercial-friday.yml did not, so a pair
 * written mid-week (RSS-poll apply, 2026-09-26/28) would turn the Friday run
 * red for a reason unrelated to anything Friday did, until the Saturday run
 * healed it. This pins the rule for every job, current and future, that
 * runs the strict gate: the dedupe must run earlier in the same job.
 *
 * Commands are matched on non-comment lines only, so a comment naming the
 * script cannot satisfy the check.
 */
const STRICT_RE = /\bnode\s+scripts\/audit-commercial-data\.js\b[^\n]*--strict\b/;
const DEDUPE_RE = /\bnode\s+scripts\/dedupe-commercial-id-keys\.js\b[^\n]*--apply\b/;

function commandText(step) {
  return String(step.run || '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function strictGateJobs() {
  const out = [];
  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const wf = yaml.load(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8'));
    for (const [jobId, job] of Object.entries((wf && wf.jobs) || {})) {
      const steps = (job && job.steps) || [];
      const strictIdx = steps.findIndex((s) => STRICT_RE.test(commandText(s)));
      if (strictIdx >= 0) out.push({ file, jobId, steps, strictIdx });
    }
  }
  return out;
}

test('the strict commercial gate is found in both commercial workflows (guard against a vacuous pass)', () => {
  const where = strictGateJobs().map((j) => j.file);
  assert.ok(where.includes('commercial-weekly.yml'), `strict gate not found in commercial-weekly.yml (found in: ${where.join(', ')})`);
  assert.ok(where.includes('commercial-friday.yml'), `strict gate not found in commercial-friday.yml (found in: ${where.join(', ')})`);
});

test('every job that runs the strict commercial gate runs dedupe --apply before it', () => {
  const offenders = [];
  for (const { file, jobId, steps, strictIdx } of strictGateJobs()) {
    const dedupeIdx = steps.findIndex((s) => DEDUPE_RE.test(commandText(s)));
    if (dedupeIdx < 0 || dedupeIdx > strictIdx) {
      offenders.push(`${file} job "${jobId}": dedupe step ${dedupeIdx < 0 ? 'missing' : `at index ${dedupeIdx}, after the strict gate at ${strictIdx}`}`);
    }
  }
  assert.deepEqual(offenders, [], `run "node scripts/dedupe-commercial-id-keys.js --apply" before the strict gate:\n${offenders.join('\n')}`);
});

test('a comment naming the dedupe script does not count as running it', () => {
  assert.equal(DEDUPE_RE.test(commandText({ run: '# node scripts/dedupe-commercial-id-keys.js --apply\necho hi' })), false);
  assert.equal(DEDUPE_RE.test(commandText({ run: 'node scripts/dedupe-commercial-id-keys.js --apply' })), true);
  assert.equal(DEDUPE_RE.test(commandText({ run: 'node scripts/dedupe-commercial-id-keys.js' })), false, 'a dry run heals nothing');
});
