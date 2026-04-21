// Regression lock for Schmigadoon 2026-04-20: fetch-guardian-reviews.yml was
// dispatched only inside the `if [ "$MARKET" = "west-end" ]` branch, so
// Broadway opening nights never fetched Guardian star ratings from the
// Content API. Schmigadoon's Guardian review scored LLM 71 instead of the
// calibrated 65 for its explicit 3/5 stars.
//
// Fix (commit 081c7892ca): moved the Guardian dispatch out of the WE-only
// branch so it runs unconditionally for both markets.
//
// This test fails if someone nests the dispatch back inside a market-only
// conditional.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.resolve(__dirname, '../../.github/workflows/opening-night-orchestrator.yml');

describe('opening-night-orchestrator — Guardian dispatch', () => {
  it('fetch-guardian-reviews dispatch is not nested inside a $MARKET conditional', () => {
    const src = fs.readFileSync(WORKFLOW, 'utf8');
    const lines = src.split('\n');

    const dispatchIdx = lines.findIndex(l => /dispatch\s+"fetch-guardian-reviews"\s+fetch-guardian-reviews\.yml/.test(l));
    assert.ok(dispatchIdx > 0, 'expected to find a fetch-guardian-reviews dispatch line');

    // Walk backward from the dispatch line. Every `fi` we pass opens a new
    // nesting level; every `if` closes one. If any surviving unmatched `if`
    // mentions $MARKET, the dispatch is nested inside a market conditional.
    let fiDepth = 0;
    const marketGated = [];
    for (let i = dispatchIdx - 1; i >= 0; i--) {
      const line = lines[i];
      if (/^\s*fi\s*$/.test(line)) fiDepth++;
      else if (/^\s*if\s+/.test(line)) {
        if (fiDepth > 0) {
          fiDepth--;
        } else {
          // Unclosed enclosing `if` — we're inside it
          if (/\$MARKET/.test(line)) marketGated.push({ line: i + 1, text: line.trim() });
          break;
        }
      }
      // Hard boundary: stop when we hit a new `run: |` script start (top of the script)
      if (/^\s*run:\s*\|\s*$/.test(line)) break;
    }

    assert.equal(
      marketGated.length,
      0,
      `fetch-guardian-reviews dispatch is nested inside a $MARKET conditional ` +
      `(${JSON.stringify(marketGated)}). Guardian has a US theater critic (Hassenger); ` +
      `Broadway opening nights need this dispatch to land star ratings. See commit 081c7892ca.`
    );
  });
});
