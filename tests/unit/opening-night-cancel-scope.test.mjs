/**
 * BRO-5952: Express and the poller cancelled each other's runs on press
 * night (a cancelled run loses its finds and its deploy). Pins that
 *  - the poller workflow has no inline `gh run cancel` at all (rebuilds
 *    serialize via their own concurrency groups), and
 *  - Express only cancels via scripts/lib/express-preemption.js, which only
 *    skips poller/scoring runs scoped to ANOTHER show (orchestrators and
 *    auto pollers cover every show, so they stay cancellable: a running
 *    orchestrator does not re-check the pause lease mid-loop).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { shouldCancel } = require('../../scripts/lib/express-preemption.js');
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(REPO_ROOT, '.github/workflows', f), 'utf8');

const codeLines = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l));

test('poller workflow has no `gh run cancel` invocation', () => {
  const hits = codeLines(read('opening-night-poller.yml')).filter((l) => /gh\s+run\s+cancel/.test(l));
  assert.deepEqual(hits, []);
});

test('express workflow has no inline `gh run cancel` (cancels go through the show-scoped lib)', () => {
  const hits = codeLines(read('opening-night-express.yml')).filter((l) => /gh\s+run\s+cancel/.test(l));
  assert.deepEqual(hits, []);
});

test('every express-preemption cancel call passes --show', () => {
  const calls = codeLines(read('opening-night-express.yml')).filter((l) => /express-preemption\.js\s+cancel/.test(l));
  assert.ok(calls.length >= 1);
  for (const l of calls) assert.match(l, /--show="?\$\{?EXPRESS_SHOW_ID/, l);
});

test('shouldCancel never cancels a run scoped to a different show', () => {
  const P = 'opening-night-poller.yml';
  const S = 'llm-ensemble-score.yml';
  assert.equal(shouldCancel(P, 'Opening Night Poller — show-a', 'show-a'), true);
  assert.equal(shouldCancel(S, 'LLM Ensemble Score Reviews — show-a', 'show-a'), true);
  assert.equal(shouldCancel(P, 'Opening Night Poller — show-b', 'show-a'), false);
  assert.equal(shouldCancel(S, 'LLM Ensemble Score Reviews — show-b', 'show-a'), false);
  // prefix of another slug is not the same show
  assert.equal(shouldCancel(P, 'Opening Night Poller — show-ab', 'show-a'), false);
});
