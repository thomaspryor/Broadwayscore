/**
 * Unit tests for preserveLlmFlags — carrying LLM pre-classification flags
 * across weekly video-discovery rescans (scripts/lib/video-discovery-merge.js).
 *
 * Regression context: discover-videos.js rewrites discovery files on every
 * scan, which wiped llmFlagged markers and silently killed TikTok review
 * pickup (2026-04 → 2026-06).
 *
 * Run with: node --test tests/unit/video-discovery-merge.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { preserveLlmFlags } = require('../../scripts/lib/video-discovery-merge.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DISCOVERY_DIR = path.join(ROOT, 'data/video-reviews-discovery');

describe('preserveLlmFlags', () => {
  test('carries llmFlagged onto matching ids in a fresh scan', () => {
    const prev = [
      { id: 'a1', title: 'This was pure magic!', llmFlagged: true, classification: 'llm-review-candidate' },
      { id: 'a2', title: 'casting news', llmFlagged: false },
    ];
    const next = [
      { id: 'a1', title: 'This was pure magic!', isReviewCandidate: false, classification: 'unclassified' },
      { id: 'a2', title: 'casting news', isReviewCandidate: false, classification: 'unclassified' },
      { id: 'a3', title: 'brand new video', isReviewCandidate: false, classification: 'unclassified' },
    ];
    const carried = preserveLlmFlags(prev, next);
    assert.strictEqual(carried, 1);
    assert.strictEqual(next[0].llmFlagged, true);
    assert.strictEqual(next[0].classification, 'llm-review-candidate');
    assert.strictEqual(next[1].llmFlagged, undefined);
    assert.strictEqual(next[2].llmFlagged, undefined);
  });

  test('does not downgrade regex candidates and does not double-count already-flagged videos', () => {
    const prev = [
      { id: 'b1', llmFlagged: true, classification: 'llm-review-candidate' },
      { id: 'b2', llmFlagged: true, classification: 'llm-review-candidate' },
    ];
    const next = [
      // b1 now matches the regex too — keep its regex classification
      { id: 'b1', isReviewCandidate: true, classification: 'review-candidate' },
      // b2 already flagged (e.g. pre-classify ran twice) — no re-count
      { id: 'b2', isReviewCandidate: false, llmFlagged: true, classification: 'llm-review-candidate' },
    ];
    const carried = preserveLlmFlags(prev, next);
    assert.strictEqual(carried, 1); // only b1
    assert.strictEqual(next[0].llmFlagged, true);
    assert.strictEqual(next[0].classification, 'review-candidate');
  });

  test('tolerates empty, null, and malformed entries', () => {
    assert.strictEqual(preserveLlmFlags(null, null), 0);
    assert.strictEqual(preserveLlmFlags([], []), 0);
    assert.strictEqual(preserveLlmFlags([{ llmFlagged: true }, null], [{ id: 'x' }, null, {}]), 0);
  });

  test('real data: rescan simulation on committed discovery files preserves flags', function () {
    if (!fs.existsSync(DISCOVERY_DIR)) {
      // Discovery data not present in this checkout (e.g. shallow CI) — structural tests above still ran.
      return;
    }
    const files = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json')).slice(0, 3);
    assert.ok(files.length >= 1, 'expected at least one discovery file');
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, f), 'utf8'));
      const prev = JSON.parse(JSON.stringify(data.videos));
      // Simulate a manual pre-classify pass: flag every 10th non-candidate video
      let expected = 0;
      for (let i = 0; i < prev.length; i += 10) {
        if (!prev[i].isReviewCandidate) { prev[i].llmFlagged = true; expected++; }
      }
      // Simulate the fresh rescan discover-videos.js produces (no flags)
      const next = JSON.parse(JSON.stringify(data.videos)).map(v => {
        const { llmFlagged, ...rest } = v;
        return rest;
      });
      const carried = preserveLlmFlags(prev, next);
      assert.strictEqual(carried, expected, `${f}: carried ${carried}, expected ${expected}`);
      const flaggedIds = new Set(prev.filter(v => v.llmFlagged).map(v => v.id));
      for (const v of next) {
        if (flaggedIds.has(v.id)) assert.strictEqual(v.llmFlagged, true, `${f}: ${v.id} lost its flag`);
      }
    }
  });
});
