// BRO-6866 class guard: a bare `data/audit/` sweep must not carry paths that
// disqualify the Git Data API push fallback (it lost audit ledgers on a
// contended branch). Fails with the helper call removed from the workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { makeTmpDir } = createRequire(import.meta.url)('./tmpdir-for-tests.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const helper = path.join(here, 'unstage-api-fallback-disqualifiers.js');

test('helper unstages disqualifying audit paths and keeps fallback-safe ledgers staged', (t) => {
  const d = makeTmpDir(t, 'unstage-');
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8' });
  g('init', '-q');
  fs.mkdirSync(path.join(d, 'data/audit/validation'), { recursive: true });
  const files = ['data/audit/gemini-usage-ledger.jsonl', 'data/audit/stage-latency.jsonl',
    'data/audit/url-collision-report.json', 'data/audit/validation-baseline.json',
    'data/audit/validation/collection-report-x.json'];
  for (const f of files) fs.writeFileSync(path.join(d, f), '{}\n');
  g('add', 'data/audit');
  const out = execFileSync(process.execPath, [helper], { cwd: d, encoding: 'utf8' });
  const staged = g('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  assert.deepEqual(staged, ['data/audit/gemini-usage-ledger.jsonl']);
  assert.equal(out.split('\n').filter(Boolean).length, 4);
});

test('every data/audit sweep in collect-review-texts.yml is followed by the helper', () => {
  const lines = fs.readFileSync(path.join(repo, '.github/workflows/collect-review-texts.yml'), 'utf8').split('\n');
  const sweeps = lines.map((l, i) => [l, i]).filter(([l]) => /git add data\/audit\/ /.test(l));
  assert.ok(sweeps.length >= 2);
  for (const [, i] of sweeps) {
    assert.match(lines.slice(i + 1, i + 6).join('\n'), /unstage-api-fallback-disqualifiers\.js/, `sweep at line ${i + 1}`);
  }
});
