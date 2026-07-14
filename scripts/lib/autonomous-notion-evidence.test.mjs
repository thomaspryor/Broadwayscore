import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MARKER, evidenceCommentText, parseEvidenceComment, latestEvidenceForBranch } = require('./autonomous-notion-evidence.js');

test('round-trips branch, files, checkableDone, checks through the comment text', () => {
  const evidence = {
    branch: 'auto/fix-provisionaloutletidfromhost-garbage--8d385e',
    files: ['tests/unit/provisional-outlet-onboarding.test.mjs'],
    checkableDone: 'node --test tests/unit/provisional-outlet-onboarding.test.mjs',
    checks: ['colocated-tests: PASS'],
  };
  const text = evidenceCommentText(evidence);
  assert.ok(text.startsWith(MARKER));
  assert.deepEqual(parseEvidenceComment(text), evidence);
});

test('checkableDone defaults to null when absent', () => {
  const text = evidenceCommentText({ branch: 'auto/x', files: ['tests/a.test.mjs'] });
  const parsed = parseEvidenceComment(text);
  assert.equal(parsed.checkableDone, null);
  assert.deepEqual(parsed.checks, []);
});

test('parseEvidenceComment rejects non-marker, malformed JSON, and missing branch', () => {
  assert.equal(parseEvidenceComment('just a normal owner comment'), null);
  assert.equal(parseEvidenceComment(`${MARKER} not json`), null);
  assert.equal(parseEvidenceComment(`${MARKER} {"files":[]}`), null); // no branch
  assert.equal(parseEvidenceComment(''), null);
  assert.equal(parseEvidenceComment(null), null);
});

test('latestEvidenceForBranch picks the newest matching comment, ignores other branches and junk', () => {
  const mk = (branch, createdTime, extra = '') => ({
    created_time: createdTime,
    rich_text: [{ plain_text: `${evidenceCommentText({ branch, files: ['tests/a.test.mjs'], checkableDone: extra || null })}` }],
  });
  const results = [
    { created_time: '2026-07-14T01:00:00Z', rich_text: [{ plain_text: '[auto] rejected via signed tap: owner tap' }] },
    mk('auto/other-card-abc', '2026-07-14T01:30:00Z'),
    mk('auto/fix-x--8d385e', '2026-07-14T01:58:01Z', 'node --test old.test.mjs'),
    mk('auto/fix-x--8d385e', '2026-07-14T01:59:11Z', 'node --test new.test.mjs'),
  ];
  const evidence = latestEvidenceForBranch(results, 'auto/fix-x--8d385e');
  assert.equal(evidence.checkableDone, 'node --test new.test.mjs');
});

test('latestEvidenceForBranch returns null when nothing matches', () => {
  assert.equal(latestEvidenceForBranch([], 'auto/x'), null);
  assert.equal(latestEvidenceForBranch([{ created_time: 't', rich_text: [{ plain_text: 'hi' }] }], 'auto/x'), null);
});
