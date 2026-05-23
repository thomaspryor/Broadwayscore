/**
 * Tests for scripts/lib/bd-telemetry.js.
 *
 * Locks in the `[BD Call] {...}` log-line contract that the weekly scraper-cost
 * report and the upcoming attribution analyzer parse. Phase 1 of the post-Codex
 * BD cost-reduction plan (2026-05-23) — broad cap-shaving missed by ~10x because
 * the dominant spend is from always-on background work in shared helpers, not the
 * bursty workflows we kept tuning. Per-call attribution lets the next cut round
 * be data-driven instead of intuition-driven.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { recordBdCall } = require('../../scripts/lib/bd-telemetry.js');

function _captureStdout(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

function _parseLines(lines) {
  return lines
    .filter(l => l.startsWith('[BD Call] '))
    .map(l => JSON.parse(l.slice('[BD Call] '.length)));
}

test('emits one parseable JSON line per call', () => {
  const out = _captureStdout(() => {
    recordBdCall({ url: 'https://www.variety.com/2026/legit/x', fn: 'web-unlocker', success: true, status: 200 });
  });
  const records = _parseLines(out);
  assert.equal(records.length, 1);
  assert.equal(records[0].host, 'variety.com');
  assert.equal(records[0].fn, 'web-unlocker');
  assert.equal(records[0].success, true);
  assert.equal(records[0].status, 200);
});

test('strips www. and lowercases host', () => {
  const out = _captureStdout(() => {
    recordBdCall({ url: 'https://www.nytimes.com/2026/05/23/theater/foo.html', fn: 'web-unlocker', success: true });
  });
  const [r] = _parseLines(out);
  assert.equal(r.host, 'nytimes.com');
});

test('records failure with error message as status', () => {
  const out = _captureStdout(() => {
    recordBdCall({ url: 'https://example.com', fn: 'web-unlocker', success: false, status: 'timeout' });
  });
  const [r] = _parseLines(out);
  assert.equal(r.success, false);
  assert.equal(r.status, 'timeout');
});

test('records SERP fallback_from', () => {
  const out = _captureStdout(() => {
    recordBdCall({ host: 'serp.brightdata', fn: 'serp-unlocker', success: true, status: 200, fallbackFrom: 'serp-api' });
  });
  const [r] = _parseLines(out);
  assert.equal(r.fn, 'serp-unlocker');
  assert.equal(r.fallback_from, 'serp-api');
});

test('honors explicit host over url-derived host', () => {
  const out = _captureStdout(() => {
    recordBdCall({ host: 'serp.brightdata', fn: 'serp-api', success: true });
  });
  const [r] = _parseLines(out);
  assert.equal(r.host, 'serp.brightdata');
});

test('disabled via BD_TELEMETRY_DISABLED env', () => {
  process.env.BD_TELEMETRY_DISABLED = '1';
  try {
    const out = _captureStdout(() => {
      recordBdCall({ url: 'https://variety.com', fn: 'web-unlocker', success: true });
    });
    assert.equal(_parseLines(out).length, 0);
  } finally {
    delete process.env.BD_TELEMETRY_DISABLED;
  }
});

test('includes workflow when GITHUB_WORKFLOW is set', () => {
  process.env.GITHUB_WORKFLOW = 'Collect Review Texts';
  try {
    const out = _captureStdout(() => {
      recordBdCall({ url: 'https://variety.com', fn: 'web-unlocker', success: true });
    });
    const [r] = _parseLines(out);
    assert.equal(r.workflow, 'Collect Review Texts');
  } finally {
    delete process.env.GITHUB_WORKFLOW;
  }
});

test('never throws on bad input', () => {
  assert.doesNotThrow(() => recordBdCall({ url: 'not a url', fn: 'web-unlocker', success: true }));
  assert.doesNotThrow(() => recordBdCall({}));
  assert.doesNotThrow(() => recordBdCall(null));
});
