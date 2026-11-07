// BRO-5254: a rescore_reason with spaces must reach the scorer and the chained
// dispatch as ONE argument. Run 38512845342 passed "fullText replaced by forced
// refetch ..." through the word-split ARGS string, so the filter became the
// prefix "fullText" and matched 1264 unrelated rows. These tests run the real
// command lines out of the workflow with node/gh stubbed to print their argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yml = readFileSync(path.join(root, '.github/workflows/llm-ensemble-score.yml'), 'utf8');
const lines = yml.split('\n');
const REASON = 'fullText replaced by forced refetch (stored text was from the wrong page)';

function line(needle) {
  const hits = lines.filter(l => l.includes(needle));
  assert.equal(hits.length, 1, `expected exactly one line containing ${needle}, got ${hits.length}`);
  return hits[0].trim();
}

function argvOf(cmdLine, stubName, env) {
  const script = [
    `${stubName}() { for a in "$@"; do echo "ARG<$a>"; done; }`,
    cmdLine,
  ].join('\n');
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
    .split('\n').filter(Boolean).map(l => l.slice(4, -1));
}

test('scoring step: reason with spaces arrives as one --rescore-reason arg', () => {
  const cmd = line('node scripts/run-ensemble-scoring-guard.js');
  const argv = argvOf(cmd, 'node', { SCORING_ARGS: '--ensemble --all --limit=15 --needs-rescore', INPUT_RESCORE_REASON: REASON });
  assert.ok(argv.includes(`--rescore-reason=${REASON}`), JSON.stringify(argv));
  assert.ok(argv.includes('--limit=15') && argv.includes('--needs-rescore'), 'flag list must still be split');
  assert.ok(!argv.includes('replaced'), 'reason was word-split');
});

test('scoring step: no reason means no --rescore-reason arg at all', () => {
  const argv = argvOf(line('node scripts/run-ensemble-scoring-guard.js'), 'node', { SCORING_ARGS: '--ensemble --all', INPUT_RESCORE_REASON: '' });
  assert.ok(!argv.some(a => a.startsWith('--rescore-reason')), JSON.stringify(argv));
});

test('build-args never puts the reason into the word-split ARGS string', () => {
  assert.doesNotMatch(yml, /ARGS="\$ARGS --rescore-reason=/);
  assert.doesNotMatch(yml, /CHAIN_ARGS="\$CHAIN_ARGS -f rescore_reason=/);
});

test('scoring step does not splice step outputs into the shell source', () => {
  assert.doesNotMatch(yml, /run-ensemble-scoring-guard\.js \$\{\{/);
});

test('chain dispatch: reason with spaces stays one -f value', () => {
  const cmd = line('gh workflow run llm-ensemble-score.yml $CHAIN_ARGS');
  const argv = argvOf(cmd, 'gh', { CHAIN_ARGS: '-f limit=15 -f chain=true', INPUT_RESCORE_REASON: REASON });
  const i = argv.indexOf(`rescore_reason=${REASON}`);
  assert.ok(i > 0 && argv[i - 1] === '-f', JSON.stringify(argv));
  const none = argvOf(cmd, 'gh', { CHAIN_ARGS: '-f limit=15', INPUT_RESCORE_REASON: '' });
  assert.ok(!none.some(a => a.startsWith('rescore_reason')), JSON.stringify(none));
});
