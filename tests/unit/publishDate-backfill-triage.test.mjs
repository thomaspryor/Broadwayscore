import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { runPublishDateBackfillTriage, scopeCrossProductionIssues } = require('../../scripts/lib/publish-date-backfill-triage');

test('refreshes evidence, applies scoped triage, then runs the blocking contamination gate', () => {
  const calls = [];
  const repoRoot = process.cwd();
  let manifest;
  runPublishDateBackfillTriage({
    repoRoot,
    touchedFiles: ['oh-mary-2024/outlet--critic.json', 'children-of-a-lesser-god-1980/outlet--critic.json', 'oh-mary-2024/outlet--critic.json'],
    run(command, args, options) {
      calls.push([path.basename(args[0]), ...args.slice(1)]);
      assert.equal(command, process.execPath);
      assert.equal(options.cwd, repoRoot);
      assert.equal(options.stdio, 'inherit');
      if (path.basename(args[0]) === 'auto-triage-cross-production.js') {
        manifest = args[2].slice('--files-from='.length);
        assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), [
          'children-of-a-lesser-god-1980/outlet--critic.json', 'oh-mary-2024/outlet--critic.json',
        ]);
      }
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [
    ['audit-cross-production.js'],
    ['auto-triage-cross-production.js', '--apply', `--files-from=${manifest}`],
    ['audit-review-contamination.js', '--gate'],
  ]);
  assert.equal(fs.existsSync(path.dirname(manifest)), false, 'temporary scope must be removed');
});

for (const failureIndex of [0, 1, 2]) {
  for (const failure of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failed') }]) {
    test(`fails closed at safety step ${failureIndex + 1}: ${failure.error?.message || failure.signal || failure.status}`, () => {
      let calls = 0;
      assert.throws(() => runPublishDateBackfillTriage({
        touchedFiles: new Set(['oh-mary-2024/outlet--critic.json']),
        run() { return calls++ === failureIndex ? failure : { status: 0 }; },
      }), /publishDate backfill safety check failed/);
      assert.equal(calls, failureIndex + 1, 'must stop before any later step or completion');
    });
  }
}

test('dry runs and batches with no dates written perform no triage writes or audits', () => {
  const run = () => assert.fail('unexpected subprocess');
  runPublishDateBackfillTriage({ touchedFiles: ['oh-mary-2024/outlet--critic.json'], dryRun: true, run });
  runPublishDateBackfillTriage({ touchedFiles: [], run });
});

test('scope includes newly dated files and leaves other reviews in the same show alone', () => {
  const issues = [
    { file: 'children-of-a-lesser-god-1980/outlet--critic.json', filedUnder: 'children-of-a-lesser-god-1980', closerTo: 'children-of-a-lesser-god-2018', matchReason: 'publish-date' },
    { file: 'children-of-a-lesser-god-1980/other--critic.json', filedUnder: 'children-of-a-lesser-god-1980', closerTo: 'children-of-a-lesser-god-2018', matchReason: 'publish-date' },
    { file: 'unrelated-show/outlet--critic.json', filedUnder: 'unrelated-show', closerTo: 'another-production', matchReason: 'publish-date' },
  ];
  assert.deepEqual(scopeCrossProductionIssues(issues, ['children-of-a-lesser-god-1980/outlet--critic.json']), [issues[0]]);
  assert.deepEqual(scopeCrossProductionIssues(issues, []), []);
  assert.equal(scopeCrossProductionIssues(issues, null), issues);
});
