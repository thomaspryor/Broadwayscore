/**
 * BRO-4466: an opening-night ingest-urls dispatch (only show_id set) shared the
 * default `scoring-reviews` group with the 350-min scheduled batch and sat
 * pending 22+ min, so Guardian/WOS/Standard/Telegraph reviews stayed unscored.
 * Evaluates the REAL group expression from llm-ensemble-score.yml.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const yml = fs.readFileSync(path.join(root, '.github/workflows/llm-ensemble-score.yml'), 'utf8');
const { downstreamWorkflows } = require('../../scripts/lib/ingest-downstream.js');

const m = yml.match(/^concurrency:\n\s+group: (.+)\n\s+cancel-in-progress: (\w+)/m);
assert.ok(m, 'concurrency block not found');
const expr = m[1].match(/\$\{\{\s*(.+?)\s*\}\}/)[1];
const prefix = m[1].split('${{')[0];

function group(inputs) {
  const format = (f, v) => f.replace('{0}', v);
  // GHA: unset/empty inputs are '' (falsy); schedule runs have no inputs at all.
  const fn = new Function('inputs', 'format', `return (${expr});`);
  return prefix + fn(inputs || {}, format);
}

test('scheduled run keeps the default group', () => {
  assert.equal(group(undefined), 'scoring-reviews');
  assert.equal(group({ show_id: '', rescore_reason: '' }), 'scoring-reviews');
});

test('show-targeted dispatch (ingest-urls) never shares the scheduled run group', () => {
  const sched = group(undefined);
  for (const wf of downstreamWorkflows('waovw-2026', 3)) {
    if (wf.file !== 'llm-ensemble-score.yml') continue;
    const showId = wf.args.match(/show_id=(\S+)/)[1];
    assert.notEqual(group({ show_id: showId }), sched);
  }
});

test('different shows get different lanes; rescore_reason lane preserved', () => {
  assert.notEqual(group({ show_id: 'a' }), group({ show_id: 'b' }));
  assert.equal(group({ show_id: 'a', rescore_reason: 'verify-all-scored-a' }), 'scoring-reviews-verify-all-scored-a');
});

test('cancel-in-progress stays false (never kill a mid-flight scoring run)', () => {
  assert.equal(m[2], 'false');
});
