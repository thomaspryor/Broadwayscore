import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  logicalLines,
  isPublishingStep,
  failureSwallowOffenders,
  requiresOutcomeSuccess,
} = require('./workflow-publish-gate.js');

const push = 'bash scripts/lib/push-with-retry.sh';

for (const comment of [
  "# discover's raw new_slugs",
  '# unmatched " in a comment',
  "  # project's comment ends in a backslash \\",
  "echo ready # project's unmatched \" note",
  "echo ready;# project's unmatched \" note",
]) {
  test(`comment cannot hide a later publisher: ${comment}`, () => {
    const run = `${comment}\n${push}`;
    assert.equal(logicalLines(run).at(-1), push);
    assert.equal(isPublishingStep({ run }), true);
    assert.ok(failureSwallowOffenders({ run: `${run} || true` }).length > 0);
  });
}

test('commented publisher names are ignored, including inline comments', () => {
  assert.deepEqual(logicalLines(`# project's ${push}\necho ready # ${push}`), ['echo ready']);
  assert.equal(isPublishingStep({ run: `echo ready # ${push}` }), false);
});

for (const run of [
  'echo "# quoted hash"',
  "echo '# quoted hash'",
  'echo topic#release',
  String.raw`echo \#literal`,
  String.raw`echo topic\ #suffix`,
]) {
  test(`preserves a hash within a shell word: ${run}`, () => {
    assert.deepEqual(logicalLines(`${run}\n${push}`), [run, push]);
  });
}

test('escaped quotes do not open a string or hide a comment', () => {
  const run = String.raw`echo \" # project's unmatched " note`;
  assert.deepEqual(logicalLines(`${run}\n${push}`), [String.raw`echo \"`, push]);
});

test('multiline quoted hashes stay in the command and cannot hide failure swallowing', () => {
  for (const quote of ['"', "'"]) {
    const commit = `git commit -m ${quote}summary\n# message content\nmore${quote} || true`;
    assert.deepEqual(logicalLines(`${commit}\n${push}`), [commit, push]);
    assert.ok(failureSwallowOffenders({ run: `${commit}\n${push}` }).length > 0);
  }
});

test('a comment after a continuation ends at the physical newline', () => {
  const run = `echo ready \\\n# project's comment\n${push}`;
  assert.deepEqual(logicalLines(run), ['echo ready', push]);
});

test('an unrelated inequality does not invalidate a required success guard', () => {
  const condition = "always() && steps.commit-gate.outcome == 'success' && steps.discover.outputs.new_shows_count != '0'";
  assert.equal(requiresOutcomeSuccess(condition, 'commit-gate'), true);
  assert.equal(requiresOutcomeSuccess(`\${{ ${condition} }}`, 'commit-gate'), true);
  assert.equal(requiresOutcomeSuccess("always() && (steps.commit-gate.outcome == 'success')", 'commit-gate'), true);
});

for (const condition of [
  "always() && steps.commit-gate.outcome != 'failure'",
  "always() && (steps.commit-gate.outcome == 'success' || true)",
  "always() && !(steps.commit-gate.outcome == 'success')",
  "always() && !steps.commit-gate.outcome == 'success'",
  "always() && false != steps.commit-gate.outcome == 'success'",
  "always() && false == steps.commit-gate.outcome == 'success'",
  "always() && contains(steps.commit-gate.outcome == 'success', false)",
  "always() && steps.commit-gate.conclusion == 'success'",
  "always() && steps.other.outcome == 'success'",
]) {
  test(`requires a positive success conjunct: ${condition}`, () => {
    assert.equal(requiresOutcomeSuccess(condition, 'commit-gate'), false);
  });
}
