// BRO-5588: the two bare `node --test` batches in test.yml (opening-night live,
// scripts/lib) must name failing tests like the main batch does (BRO-2238).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'lib', 'summarize-failing-tests.sh');
const yml = readFileSync(join(root, '.github', 'workflows', 'test.yml'), 'utf8');

function run(log, rc, level) {
  const dir = mkdtempSync(join(tmpdir(), 'sft-'));
  const logFile = join(dir, 'batch.log');
  const summary = join(dir, 'summary.md');
  writeFileSync(logFile, log);
  writeFileSync(summary, '');
  const args = ['demo', logFile, String(rc), ...(level ? [level] : [])];
  const r = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
  return { ...r, summary: readFileSync(summary, 'utf8') };
}

const TAP = `ok 1 - fine
not ok 2 - broken thing
  ---
  location: 'file.test.mjs:3:1'
  ...
not ok 3 - second break
  ---
  location: 'file.test.mjs:9:1'
  ...
# fail 2
`;

test('names failing tests as errors and in the step summary', () => {
  const r = run(TAP, 1);
  assert.equal(r.status, 0, 'never changes the caller result');
  assert.match(r.stdout, /::error::demo batch failing test: broken thing/);
  assert.match(r.stdout, /::error::demo batch failing test: second break/);
  assert.match(r.summary, /not ok 2 - broken thing/);
  assert.match(r.summary, /location: 'file\.test\.mjs:9:1'/);
});

test('advisory level emits warnings', () => {
  const r = run(TAP, 1, 'warning');
  assert.match(r.stdout, /::warning::demo batch failing test: broken thing/);
  assert.doesNotMatch(r.stdout, /::error::/);
});

test('passing batch prints nothing; crash with no TAP line warns', () => {
  assert.equal(run(TAP, 0).stdout, '');
  assert.match(run('boom\n', 2).stdout, /::warning::demo batch exited 2 but no top-level 'not ok'/);
});

test('caps annotations at 10 and points at the summary', () => {
  const many = Array.from({ length: 14 }, (_, i) => `not ok ${i + 1} - t${i + 1}\n`).join('');
  const r = run(many, 1);
  assert.equal((r.stdout.match(/failing test: t/g) || []).length, 10);
  assert.match(r.stdout, /\+4 more failing tests/);
});

test('missing log and percent-sign names are handled', () => {
  const r = spawnSync('bash', [script, 'demo', '/nonexistent/x.log', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /log \/nonexistent\/x\.log is missing or unreadable/);
  assert.match(run('not ok 1 - 100%0A done\n', 1).stdout, /failing test: 100%250A done/);
});

test('works without GITHUB_STEP_SUMMARY set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sft-'));
  const logFile = join(dir, 'b.log');
  writeFileSync(logFile, TAP);
  const env = { ...process.env }; delete env.GITHUB_STEP_SUMMARY;
  const r = spawnSync('bash', [script, 'demo', logFile, '1'], { encoding: 'utf8', env });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /broken thing/);
});

test('both bare batches in test.yml call the summarizer and keep the exit code', () => {
  for (const [log, label] of [['/tmp/opening-night-live-batch.log', 'opening-night live'], ['/tmp/scripts-lib-batch.log', 'scripts/lib'], ['/tmp/e2e-unit-batch.log', 'e2e unit']]) {
    const i = yml.indexOf(`tee ${log}`);
    assert.ok(i > 0, `${log} tee missing`);
    const block = yml.slice(i, i + 400);
    assert.match(block, /rc=\$\{PIPESTATUS\[0\]\}/);
    assert.ok(block.includes(`summarize-failing-tests.sh "${label}" ${log} "$rc"`), `${label} summarizer call missing`);
    assert.match(block, /exit "\$rc"/);
  }
  assert.match(yml, /tests=\(scripts\/lib\/\*\.test\.mjs\)/);
});

test('extraction awk matches run_batch() in test.yml (no drift)', () => {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const body = "/^not ok / { print; show=1; next } show && /^ location:/ { print; show=0; next } show && /^ \\.\\.\\.$/ { show=0; next }";
  assert.ok(norm(yml).includes(norm(body)), 'run_batch awk changed');
  assert.ok(norm(readFileSync(script, 'utf8')).includes(norm(body)), 'script awk changed');
});
