// BRO-5293: an `if: always()` commit step after a failed validate-data.js step
// published data the validator rejected (BRO-3511 fixed generate-theater-tips.yml).
// require()s the real lib (CLAUDE.md §15), never a copy of the logic.
// TESTS-VS-DERIVED-DATA-EXEMPT: fixtures only name data/*.json paths as strings; the test asserts workflow-parsing logic, not data facts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  findAlwaysCommitAfterValidate, auditWorkflowDir, protectedStaged, parseJobs,
} = require('../../scripts/lib/always-commit-after-validate.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = path.join(ROOT, '.github', 'workflows');

const wf = (commitStep, validateExtra = '') => [
  'name: t',
  'on: workflow_dispatch',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: Validate data',
  '        id: validate',
  validateExtra,
  '        run: node scripts/validate-data.js',
  '',
  ...commitStep,
].filter((l) => l !== null).join('\n');

const OFFENDER = [
  '      - name: Commit and push',
  '        if: always()',
  '        run: |',
  '          git add data/show-schedules.json data/audit/',
  '          git commit -m x',
  '          bash scripts/lib/push-with-retry.sh',
];

test('synthetic always() commit of a protected file after validate is flagged', () => {
  const hits = findAlwaysCommitAfterValidate(wf(OFFENDER));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].job, 'build');
  assert.equal(hits[0].commitStep, 'Commit and push');
  assert.equal(hits[0].validateStep, 'Validate data');
  assert.deepEqual(hits[0].staged, ['data/show-schedules.json']);
});

test('failure() and !cancelled() count as running after a failed validate', () => {
  for (const cond of ['failure()', '${{ !cancelled() }}']) {
    const step = OFFENDER.map((l) => l.replace('always()', cond));
    assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 1, cond);
  }
});

test('a default-if commit after a hard validate is not flagged', () => {
  const step = OFFENDER.filter((l) => !/if: always/.test(l));
  assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 0);
});

test('a default-if commit after a continue-on-error validate IS flagged', () => {
  const step = OFFENDER.filter((l) => !/if: always/.test(l));
  const hits = findAlwaysCommitAfterValidate(wf(step, '        continue-on-error: true'));
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /soft/);
});

test('# always-commit-ok annotation exempts the step (inside or directly above)', () => {
  const inside = [...OFFENDER.slice(0, 2), '        # always-commit-ok: partial scrape progress is wanted', ...OFFENDER.slice(2)];
  assert.equal(findAlwaysCommitAfterValidate(wf(inside)).length, 0);
  const above = ['      # always-commit-ok: progress', ...OFFENDER];
  assert.equal(findAlwaysCommitAfterValidate(wf(above)).length, 0);
  const noReason = ['      # always-commit-ok:', ...OFFENDER];
  assert.equal(findAlwaysCommitAfterValidate(wf(noReason)).length, 1, 'empty reason is not an exemption');
});

test('outcome reference (steps.<id>.outcome or VALIDATE_OUTCOME env) passes', () => {
  const viaIf = OFFENDER.map((l) => l.replace('always()', "always() && steps.validate.outcome == 'success'"));
  assert.equal(findAlwaysCommitAfterValidate(wf(viaIf)).length, 0);
  const viaEnv = [...OFFENDER.slice(0, 2), '        env:', '          VALIDATE_OUTCOME: ${{ steps.validate.outcome }}', ...OFFENDER.slice(2)];
  assert.equal(findAlwaysCommitAfterValidate(wf(viaEnv)).length, 0);
});

test('commits of only non-protected data (ledgers, audit) are not flagged', () => {
  const step = OFFENDER.map((l) => l.replace('data/show-schedules.json data/audit/', 'data/audit/scraper-spend.jsonl'));
  assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 0);
});

test('push-review-texts action after validate is flagged; push-core-data (sentinel-guarded) is not', () => {
  const rt = ['      - name: Push review-texts', '        if: always()', '        uses: ./.github/actions/push-review-texts'];
  assert.equal(findAlwaysCommitAfterValidate(wf(rt)).length, 1);
  const core = ['      - name: Push core', '        if: always()', '        uses: ./.github/actions/push-core-data'];
  assert.equal(findAlwaysCommitAfterValidate(wf(core)).length, 0);
});

test('protectedStaged recognises whole-tree and stage-data-changes.sh adds', () => {
  assert.deepEqual(protectedStaged('git add -A'), ['-A (whole tree)']);
  assert.deepEqual(protectedStaged('bash scripts/lib/stage-data-changes.sh'), ['data/ (stage-data-changes.sh)']);
  assert.deepEqual(protectedStaged('bash scripts/lib/stage-data-changes.sh data/audit/'), []);
  assert.deepEqual(protectedStaged('git add data/cast/foo.json 2>/dev/null || true'), ['data/cast/foo.json']);
});

// Inline copy of the BRO-3511 guarded shape from generate-theater-tips.yml, so
// this test pins the rule, not whatever that workflow says today.
const THEATER_TIPS_FIXTURE = [
  'jobs:',
  '  generate-tips:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Merge tips into theater metadata',
  '        id: merge',
  "        if: ${{ github.event_name == 'schedule' || inputs.dry_run != true }}",
  '        run: node scripts/merge-theater-tips.js',
  '',
  '      - name: Validate data',
  '        id: validate',
  "        if: ${{ github.event_name == 'schedule' || inputs.dry_run != true }}",
  '        run: node scripts/validate-data.js',
  '',
  '      - name: Commit and push if changed',
  '        if: always()',
  '        env:',
  '          MERGE_OUTCOME: ${{ steps.merge.outcome }}',
  '          VALIDATE_OUTCOME: ${{ steps.validate.outcome }}',
  '        run: |',
  '          git add data/theater-tips-scraped.json data/theater-tips-draft.json',
  '          for o in "$MERGE_OUTCOME" "$VALIDATE_OUTCOME"; do',
  '            if [ "$o" != "success" ] && [ "$o" != "skipped" ]; then',
  '              git checkout -- data/theater-metadata.json || true',
  '              PUBLISH_METADATA=false',
  '            fi',
  '          done',
  '          if [ "${PUBLISH_METADATA:-true}" = "true" ]; then git add data/theater-metadata.json; fi',
  '          if git diff --staged --quiet; then echo none; else',
  '            git commit -m "chore: Update theater tips data (automated)"',
  '            bash scripts/lib/push-with-retry.sh',
  '          fi',
].join('\n');

test('generate-theater-tips (BRO-3511 guarded shape, inline fixture) is NOT flagged', () => {
  const steps = parseJobs(THEATER_TIPS_FIXTURE).flatMap((j) => j.steps.map((s) => s.name));
  assert.ok(steps.includes('Validate data') && steps.includes('Commit and push if changed'), 'parser sees the steps');
  assert.deepEqual(findAlwaysCommitAfterValidate(THEATER_TIPS_FIXTURE), []);
  // The outcome guard is what passes it: strip it and the same step is flagged.
  const stripped = THEATER_TIPS_FIXTURE.replace(/^.*(?:MERGE|VALIDATE)_OUTCOME.*$\n/gm, '');
  const hits = findAlwaysCommitAfterValidate(stripped);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].staged, ['data/theater-metadata.json']);
});

test('multi-line `if: >-` / `if: |` blocks are read as the joined expression', () => {
  for (const marker of ['>-', '|', '>']) {
    const step = [
      '      - name: Commit and push',
      `        if: ${marker}`,
      '          always() &&',
      "          github.ref == 'refs/heads/main'",
      ...OFFENDER.slice(2),
    ];
    const hits = findAlwaysCommitAfterValidate(wf(step));
    assert.equal(hits.length, 1, marker);
    assert.match(hits[0].reason, /always\(\) && github\.ref == 'refs\/heads\/main'/);
    // A guarded multi-line if passes.
    const guarded = [...step.slice(0, 4), "          && steps.validate.outcome == 'success'", ...step.slice(4)];
    assert.equal(findAlwaysCommitAfterValidate(wf(guarded)).length, 0, `${marker} guarded`);
  }
  // A multi-line if without always() after a hard validate is not flagged.
  const plain = ['      - name: Commit and push', '        if: >-', "          github.ref == 'refs/heads/main'", ...OFFENDER.slice(2)];
  assert.equal(findAlwaysCommitAfterValidate(wf(plain)).length, 0);
});

test('every git add on one line is considered (`git add a && git add b && git commit`)', () => {
  assert.deepEqual(
    protectedStaged('git add data/audit/x.json && git add data/awards.json && git commit -m x'),
    ['data/awards.json'],
  );
  assert.deepEqual(protectedStaged('git add data/audit/ ; git add data/cast/ || true'), ['data/cast/']);
  const step = OFFENDER.map((l) => l.replace('git add data/show-schedules.json data/audit/',
    'git add data/audit/ && git add data/lottery-rush.json && git commit -m y'));
  assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 1);
});

test('git add -u / --update and shell-variable operands count as unknown-path staging', () => {
  assert.deepEqual(protectedStaged('git add -u'), ['-u (all tracked files)']);
  assert.deepEqual(protectedStaged('git add --update'), ['-u (all tracked files)']);
  assert.deepEqual(protectedStaged('git add -u data/audit/'), [], 'scoped -u judged by its pathspec');
  assert.deepEqual(protectedStaged('git add "$FILE"'), ['$FILE (unknown paths)']);
  assert.deepEqual(protectedStaged('git add ${TARGETS} 2>/dev/null || true'), ['${TARGETS} (unknown paths)']);
  assert.deepEqual(protectedStaged('git add data/audit/${{ matrix.domain }}.json'), [], '${{ }} is not a shell var');
  for (const add of ['git add -u', 'git add "$FILE"']) {
    const step = OFFENDER.map((l) => l.replace('git add data/show-schedules.json data/audit/', add));
    assert.equal(findAlwaysCommitAfterValidate(wf(step)).length, 1, add);
  }
});

test('runs over the real .github/workflows without throwing', () => {
  const hits = auditWorkflowDir(WF_DIR);
  assert.ok(Array.isArray(hits));
  assert.ok(!hits.some((h) => h.file === 'generate-theater-tips.yml'));
  for (const h of hits) {
    assert.ok(h.file && h.job && h.commitStep && h.validateStep && h.staged.length, JSON.stringify(h));
  }
});

test('flags a validate-data.js workflow the parser cannot read; passes a normal one', () => {
  const os = require('os');
  const { unscannableWorkflows } = require('../../scripts/lib/always-commit-after-validate.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acv-'));
  fs.writeFileSync(path.join(d, 'odd.yml'), 'jobs:\n    j:\n        steps:\n            - run: node scripts/validate-data.js\n');
  fs.writeFileSync(path.join(d, 'ok.yml'), 'jobs:\n  j:\n    steps:\n      - name: v\n        run: node scripts/validate-data.js\n');
  assert.deepEqual(unscannableWorkflows(d), ['odd.yml']);
});

const twoCommits = (c1Tail, c2Lead = []) => wf([
  '      - name: Commit C1',
  '        if: always()',
  '        run: |',
  '          git add data/awards.json',
  '          git commit -m c1',
  ...c1Tail,
  '',
  ...c2Lead,
  '      - name: Commit C2',
  '        if: always()',
  '        run: |',
  '          git add data/cast/',
  '          git commit -m c2',
]);

test('a trailing deeper-indented annotation stays with its own step (C1), not the next (C2)', () => {
  const hits = findAlwaysCommitAfterValidate(twoCommits(['          # always-commit-ok: c1 progress is wanted']));
  assert.deepEqual(hits.map((h) => h.commitStep), ['Commit C2']);
  // Annotation at the step-marker indent above C2 is C2's lead comment.
  const lead = findAlwaysCommitAfterValidate(twoCommits([], ['      # always-commit-ok: c2 progress']));
  assert.deepEqual(lead.map((h) => h.commitStep), ['Commit C1']);
});

test('push-aggregator-archive action after validate is flagged', () => {
  const st = ['      - name: Push archive', '        if: always()', '        uses: ./.github/actions/push-aggregator-archive'];
  const hits = findAlwaysCommitAfterValidate(wf(st));
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].staged, ['data/aggregator-archive/']);
});

const customValidate = (runLines) => [
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Validate data',
  '        run: |',
  ...runLines.map((l) => `          ${l}`),
  '',
  ...OFFENDER,
].join('\n');

test('inline `if node validate-data.js; then` is a hard gate when the else branch exits non-zero', () => {
  const hard = customValidate(['if node scripts/validate-data.js; then', '  echo ok', 'else', '  echo bad', '  exit 1', 'fi']);
  assert.equal(findAlwaysCommitAfterValidate(hard).length, 1);
  const handled = customValidate(['if node scripts/validate-data.js; then', '  echo ok', 'else', '  git checkout -- data/shows.json', 'fi']);
  assert.equal(findAlwaysCommitAfterValidate(handled).length, 0);
});

test('an echo mentioning validate-data.js is not a validate step', () => {
  assert.equal(findAlwaysCommitAfterValidate(customValidate(['echo "run node scripts/validate-data.js locally"'])).length, 0);
  assert.equal(findAlwaysCommitAfterValidate(customValidate(["printf '%s' 'node scripts/validate-data.js'"])).length, 0);
  assert.equal(findAlwaysCommitAfterValidate(customValidate(['echo start && node scripts/validate-data.js'])).length, 1);
});

test('CLI exits 0 and --json parses', async () => {
  const { spawnSync } = await import('node:child_process');
  const cli = path.join(ROOT, 'scripts', 'audit-always-commit-after-validate.js');
  const plain = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  const j = spawnSync(process.execPath, [cli, '--json'], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const parsed = JSON.parse(j.stdout);
  assert.equal(typeof parsed.count, 'number');
  assert.ok(Array.isArray(parsed.offenders));
  assert.equal(parsed.count, parsed.offenders.length);
});
