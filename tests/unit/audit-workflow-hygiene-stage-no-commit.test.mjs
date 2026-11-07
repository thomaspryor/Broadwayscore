/**
 * Unit tests for findStageWithoutCommitSteps (rule (p), BRO-4897): a step
 * that stages files and calls push-with-retry.sh without committing pushes
 * nothing, silently. send-follow-notifications.yml did this and one follower
 * got the same email seven Mondays in a row.
 *
 * Pattern: require() the real function (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findStageWithoutCommitSteps } = require('../../scripts/audit-workflow-hygiene.js');

const G = 'g' + 'it';
const wf = (run) => `name: X
on: workflow_dispatch
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: Commit updates
        run: |
${run.map((l) => `          ${l}`).join('\n')}
`;

test('flags stage then push with no commit (the BRO-4897 shape)', () => {
  const hits = findStageWithoutCommitSteps(wf([
    `${G} add data/audit/show-changes-digest.json`,
    `if ${G} diff --cached --quiet; then exit 0; fi`,
    'bash scripts/lib/push-with-retry.sh',
  ]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'Commit updates');
});

test('passes when a commit sits between stage and push', () => {
  assert.deepEqual(findStageWithoutCommitSteps(wf([
    `${G} add data/audit/x.json`,
    `${G} commit -m "data: x [skip ci]"`,
    'bash scripts/lib/push-with-retry.sh 5 main',
  ])), []);
});

test('commit-or-amend.sh and staging helpers count', () => {
  assert.deepEqual(findStageWithoutCommitSteps(wf([
    'bash scripts/lib/stage-data-changes.sh data/',
    'bash scripts/lib/commit-or-amend.sh "" "msg"',
    'bash scripts/lib/push-with-retry.sh',
  ])), []);
  assert.equal(findStageWithoutCommitSteps(wf([
    `bash scripts/lib/${G}-add-existing.sh data/audit/a.json`,
    'bash scripts/lib/push-with-retry.sh',
  ])).length, 1);
});

test('push with no staging in the step (commit done in an earlier step) is fine', () => {
  assert.deepEqual(findStageWithoutCommitSteps(wf(['bash scripts/lib/push-with-retry.sh || true'])), []);
});

test('comment lines are ignored', () => {
  assert.deepEqual(findStageWithoutCommitSteps(wf([
    `# ${G} add happens elsewhere`,
    'bash scripts/lib/push-with-retry.sh',
  ])), []);
});

test('a commit mentioned only in echo text does not count', () => {
  assert.equal(findStageWithoutCommitSteps(wf([
    `${G} add data/x.json`,
    `echo "skipping ${G} commit"`,
    'bash scripts/lib/push-with-retry.sh',
  ])).length, 1);
});
