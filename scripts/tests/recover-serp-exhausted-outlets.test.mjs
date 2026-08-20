import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// Notion card 3b1637c5-416f-8163-a707-e156f5e1efc3 (BRO-141): a 2026-08-16
// measurement swept 5 outlet/domain pools to a reproducible zero recovery
// rate (192 combined candidates, 0 recovered — old/niche sites with near-zero
// Google indexing, or paywalled). The card's acceptance criteria is to guard
// that decision in CODE rather than operator memory, so a future session
// can't silently re-burn real SERP provider spend re-running them. This test
// require()s the real exported guard (CLAUDE.md rule 15) rather than
// reimplementing the list.
const {
  isProvenZeroSweep,
  PROVEN_ZERO_SWEEP_DOMAINS,
  PROVEN_ZERO_SWEEP_OUTLETS,
} = require('../lib/serp-text-recovery-candidates.js');

test('proven-zero domain pools are guarded', () => {
  for (const domain of ['lightingandsoundamerica.com', 'wolfentertainmentguide.com', 'dailymail.co.uk', 'thetimes.co.uk']) {
    assert.equal(isProvenZeroSweep({ domain, outlet: null }), true, `expected ${domain} to be guarded`);
  }
});

test('AP is guarded in --outlet mode (0/18 measured via --outlet=ap, not --domain)', () => {
  assert.equal(isProvenZeroSweep({ domain: null, outlet: 'ap' }), true);
});

test('AP is NOT guarded as a --domain target — the measured zero was --outlet mode only', () => {
  // apnews.com itself was never swept via --domain; guarding it there would
  // be broader than what was actually measured (and would also block the
  // BRO-141 domain-alias generalization test fixtures, which use apnews.com
  // as a positive example).
  assert.equal(isProvenZeroSweep({ domain: 'apnews.com', outlet: null }), false);
});

test('un-swept outlets/domains are not guarded (vulture and nypost — the recommended next sweep)', () => {
  assert.equal(isProvenZeroSweep({ domain: 'vulture.com', outlet: null }), false);
  assert.equal(isProvenZeroSweep({ domain: 'nypost.com', outlet: null }), false);
});

test('a target with neither domain nor outlet is not guarded', () => {
  assert.equal(isProvenZeroSweep({ domain: null, outlet: null }), false);
});

test('PROVEN_ZERO_SWEEP_DOMAINS and PROVEN_ZERO_SWEEP_OUTLETS match the measured pools exactly (no drift)', () => {
  assert.deepEqual([...PROVEN_ZERO_SWEEP_DOMAINS].sort(), [
    'dailymail.co.uk',
    'lightingandsoundamerica.com',
    'thetimes.co.uk',
    'wolfentertainmentguide.com',
  ]);
  assert.deepEqual([...PROVEN_ZERO_SWEEP_OUTLETS], ['ap']);
});

test('recover-serp-text.js refuses a proven-zero --domain sweep at the CLI without --force-exhausted', () => {
  let stderr = '';
  let exitCode = 0;
  try {
    execFileSync('node', ['scripts/recover-serp-text.js', '--domain=dailymail.co.uk', '--dry-run', '--limit=1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status;
    stderr = e.stderr || '';
  }
  assert.notEqual(exitCode, 0, 'expected a non-zero exit for a guarded sweep');
  assert.match(stderr, /proven-zero sweep/);
  assert.match(stderr, /--force-exhausted/);
});

test('recover-serp-text.js refuses a proven-zero --outlet=ap sweep at the CLI without --force-exhausted', () => {
  let stderr = '';
  let exitCode = 0;
  try {
    execFileSync('node', ['scripts/recover-serp-text.js', '--outlet=ap', '--dry-run', '--limit=1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status;
    stderr = e.stderr || '';
  }
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /proven-zero sweep/);
});
