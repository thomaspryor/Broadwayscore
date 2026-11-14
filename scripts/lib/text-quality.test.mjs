/**
 * BRO-2609 / BRO-2610: text-quality.js builds the text the LLM scorer reads
 * (getBestTextForScoring -> scripts/llm-scoring/input-builder.ts).
 *
 * 1. scoring-delta.js must treat an edit here as a score-source change (Phase B)
 *    instead of reporting "nothing to check" (the BRO-36 miss).
 * 2. getBestTextForScoring() must strip the NYT bot-wall stub before scoring,
 *    so re-scored reviews never see it again (BRO-2610 regression guard).
 *
 * Per CLAUDE.md §15: require() the real functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Resolve from this file, not process.cwd(), so the test passes from any cwd.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const delta = require('../scoring-delta.js');
const { getBestTextForScoring } = require('./text-quality.js');

test('text-quality.js is on the scoring-delta Phase B watchlist', () => {
  assert.ok(delta.LLM_INPUT_FILES.includes('scripts/lib/text-quality.js'));
  assert.ok(delta.SCORE_VALUE_FILES.includes('scripts/lib/text-quality.js'));
  // BRO-2610: the patterns text-quality.js strips with live in content-quality.js
  for (const f of ['scripts/lib/content-quality.js', 'scripts/llm-scoring/input-builder.ts', 'scripts/lib/excerpt-fields.js']) {
    assert.ok(delta.LLM_INPUT_FILES.includes(f), f);
  }
  for (const f of delta.LLM_INPUT_FILES) assert.ok(fs.existsSync(path.join(REPO_ROOT, f)), `${f} must exist`);
});

test('an uncommitted text-quality.js edit trips the Phase B diff check', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-delta-tq-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
  const file = path.join(dir, 'scripts/lib/text-quality.js');
  fs.writeFileSync(file, 'module.exports = { getBestTextForScoring: r => r.fullText };\n');
  git('add', '.');
  git('commit', '-qm', 'base');

  const opts = { cwd: dir, baseRef: 'HEAD' };
  assert.equal(delta.gitDiffHasChanges(delta.SCORE_VALUE_FILES, opts), false);

  fs.writeFileSync(file, 'module.exports = { getBestTextForScoring: r => r.fullText.trim() };\n');
  assert.equal(delta.gitDiffHasChanges(delta.SCORE_VALUE_FILES, opts), true);
  assert.equal(delta.gitDiffHasChanges(delta.LLM_INPUT_FILES, opts), true);
  // changedFiles names only what changed, not the whole watchlist.
  assert.deepEqual(delta.changedFiles(delta.LLM_INPUT_FILES, opts), ['scripts/lib/text-quality.js']);
});

test('isSignificant: an LLM input change alone is significant (exit 2)', () => {
  assert.equal(delta.isSignificant({ llmInputChanged: ['scripts/lib/text-quality.js'], totalFlips: 0, t1Flips: 0 }), true);
  assert.equal(delta.isSignificant({ llmInputChanged: [], totalFlips: 0, t1Flips: 0 }), false);
  assert.equal(delta.isSignificant({}), false);
  // The pre-existing triggers still hold.
  assert.equal(delta.isSignificant({ cannotAutoVerify: true }), true);
  assert.equal(delta.isSignificant({ dataInputDrift: true }), true);
  assert.equal(delta.isSignificant({ t1Flips: 1 }), true);
  assert.equal(delta.isSignificant({ totalFlips: 5 }), false);
  assert.equal(delta.isSignificant({ totalFlips: 6 }), true);
});

test('getBestTextForScoring strips the NYT bot-wall stub', () => {
  const prose = 'The revival is a confection of a musical that leaves you grinning. '.repeat(40)
    + 'It is the kind of production that reminds you why people invented musical theater.';
  const stub = '\n\nWe are having trouble retrieving the article content.\n\n'
    + 'Please enable JavaScript in your browser settings.\n\n'
    + 'Thank you for your patience while we verify access.';
  const out = getBestTextForScoring({ fullText: prose + stub });
  assert.ok(out.text.includes('reminds you why people invented musical theater'));
  assert.doesNotMatch(out.text, /trouble retrieving the article content/i);
  assert.doesNotMatch(out.text, /enable JavaScript/i);
});
