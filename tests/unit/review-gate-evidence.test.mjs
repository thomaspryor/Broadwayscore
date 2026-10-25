// tests/unit/review-gate-evidence.test.mjs — BRO-4277: a bare
// `--query=record --reviewer=ship-check --result=pass` must not satisfy the
// gate. A strong-reviewer pass needs evidence produced by the skill run
// (outputsHash, invocationId, checks). Advisory by default (rule 19), strict
// with REVIEW_EVIDENCE_REQUIRED=1.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE_LINE_BUDGET, isEvidencedStrongPass, recordVerdict, queryPushAllowed, evidenceValid, readLedger,
} from '../../scripts/lib/review-gate.mjs';

const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
const GOOD = { outputsHash: 'a'.repeat(64), invocationId: 'skill-run-1', checks: [{ name: 'tsc', ok: true }] };

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'review-gate-evidence-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'base.js'), 'console.log(1);\n');
  writeFileSync(join(repo, '.gitignore'), '.claude/review-verdicts.jsonl\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(repo, 'scripts', 'big.js'),
    Array.from({ length: GATE_LINE_BUDGET + 20 }, (_, i) => `console.log(${i});`).join('\n') + '\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'big');
  return repo;
}

async function withEnv(v, fn) {
  const prev = process.env.REVIEW_EVIDENCE_REQUIRED;
  if (v === undefined) delete process.env.REVIEW_EVIDENCE_REQUIRED; else process.env.REVIEW_EVIDENCE_REQUIRED = v;
  const quiet = process.stderr.write; process.stderr.write = () => true;
  try { return await fn(); } finally {
    process.stderr.write = quiet;
    if (prev === undefined) delete process.env.REVIEW_EVIDENCE_REQUIRED; else process.env.REVIEW_EVIDENCE_REQUIRED = prev;
  }
}

test('evidenceValid rejects partial and malformed evidence', () => {
  assert.ok(evidenceValid(GOOD));
  for (const bad of [null, {}, { ...GOOD, outputsHash: 'xyz' }, { ...GOOD, invocationId: ' ' }, { ...GOOD, checks: [] }, { ...GOOD, checks: {} }, 'str']) {
    assert.ok(!evidenceValid(bad), JSON.stringify(bad));
  }
});

test('strict mode refuses a bare ship-check and code-review pass, writes nothing', () => withEnv('1', () => {
  const repo = makeRepo();
  for (const reviewer of ['ship-check', 'code-review']) {
    const r = recordVerdict({ repoRoot: repo, reviewer, result: 'pass' });
    assert.strictEqual(r.recorded, false);
    assert.match(r.reason, /evidence/);
  }
  assert.deepStrictEqual(readLedger(repo), []);
}));

test('strict mode accepts a pass carrying evidence, and the push gate honours it', () => withEnv('1', () => {
  const repo = makeRepo();
  const r = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass', evidence: GOOD });
  assert.strictEqual(r.recorded, true);
  assert.deepStrictEqual(r.entry.evidence, GOOD);
  assert.strictEqual(queryPushAllowed({ repoRoot: repo }).allowed, true);
}));

test('strict mode: push gate ignores an unevidenced strong pass already in the ledger', () => {
  const repo = makeRepo();
  withEnv(undefined, () => recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' }));
  assert.strictEqual(queryPushAllowed({ repoRoot: repo }).allowed, true, 'advisory default still allows');
  return withEnv('1', () => assert.strictEqual(queryPushAllowed({ repoRoot: repo }).allowed, false));
});

test('advisory default records a bare pass flagged evidenceMissing', () => withEnv(undefined, () => {
  const repo = makeRepo();
  const r = recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'pass' });
  assert.strictEqual(r.recorded, true);
  assert.strictEqual(r.entry.evidenceMissing, true);
  assert.ok(readFileSync(join(repo, '.claude/review-verdicts.jsonl'), 'utf8').includes('evidenceMissing'));
}));

test('second-opinion and fail verdicts need no evidence, even in strict mode', () => withEnv('1', () => {
  const repo = makeRepo();
  assert.strictEqual(recordVerdict({ repoRoot: repo, reviewer: 'second-opinion', result: 'pass' }).recorded, true);
  assert.strictEqual(recordVerdict({ repoRoot: repo, reviewer: 'ship-check', result: 'fail' }).recorded, true);
}));

test('isEvidencedStrongPass: strict mode needs evidence, advisory does not', () => {
  const bare = { reviewer: 'ship-check', result: 'pass' };
  assert.ok(isEvidencedStrongPass(bare, {}));
  assert.ok(!isEvidencedStrongPass(bare, { REVIEW_EVIDENCE_REQUIRED: '1' }));
  assert.ok(isEvidencedStrongPass({ ...bare, evidence: GOOD }, { REVIEW_EVIDENCE_REQUIRED: '1' }));
  assert.ok(!isEvidencedStrongPass({ reviewer: 'second-opinion', result: 'pass' }, {}));
});
