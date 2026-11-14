// BRO-7077 (BRO-4594, BRO-4888): the two audits wired into check-corpus-drift gate
// on growth past --max, and exit 2 (crash code) when the corpus is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const run = (script, args, dir) => spawnSync('node', [path.join(root, 'scripts', script), ...args], {
  env: { ...process.env, REVIEW_TEXTS_DIR: dir }, encoding: 'utf8',
}).status;

function corpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7077-'));
  for (const show of ['show-a-2026', 'show-b-2026']) {
    fs.mkdirSync(path.join(dir, show));
    fs.writeFileSync(path.join(dir, show, 'outlet--critic.json'), JSON.stringify({
      url: 'https://example.com/column-two-shows', llmPullQuote: 'One quote copied onto both shows of the column.',
    }));
  }
  return dir;
}

test('audit-shared-url-quote: --max baseline gates growth only', () => {
  const dir = corpus();
  assert.equal(run('audit-shared-url-quote.js', [], dir), 0, 'report mode never gates');
  assert.equal(run('audit-shared-url-quote.js', ['--max=1'], dir), 0);
  assert.equal(run('audit-shared-url-quote.js', ['--max=0'], dir), 1);
  assert.equal(run('audit-shared-url-quote.js', ['--max=0'], path.join(dir, 'missing')), 2);
});

test('audit-review-pair-anomalies: --max gate and missing-corpus crash code', () => {
  const dir = corpus();
  assert.equal(run('audit-review-pair-anomalies.js', ['--max=0'], dir), 0);
  assert.equal(run('audit-review-pair-anomalies.js', ['--max=0'], path.join(dir, 'missing')), 2);
  assert.equal(run('audit-review-pair-anomalies.js', ['--max=x'], dir), 2);
});

test('check-corpus-drift wires both with the measured baselines', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/check-corpus-drift.js'), 'utf8');
  assert.match(src, /script: 'audit-shared-url-quote\.js',\s*args: \['--max=62'\]/);
  assert.match(src, /script: 'audit-review-pair-anomalies\.js',\s*args: \['--max=74'\]/);
});
