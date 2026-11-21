/**
 * Regression test for Guardian Broadway dispatch.
 *
 * Background: For Broadway openings, Guardian reviews (Hassenger is the US
 * critic) have a starRating that only exists in the Guardian Content API,
 * not the rendered HTML. Opening-night SERP-discovery captures the URL but
 * leaves originalScore=null — without fetch-guardian-reviews running for
 * the Broadway show, the star rating never lands. Schmigadoon (2026-04-20)
 * shipped with LLM score 71 instead of Guardian API 3★=65 because
 * fetch-guardian-reviews was gated inside `if [ "$MARKET" = "west-end" ]`.
 *
 * Fixed in merge commit 887b58911f (cherry-picked 081c7892ca).
 *
 * This test locks in the invariant: the Guardian dispatch line MUST be
 * outside any market conditional so it fires for Broadway as well. A future
 * edit that re-gates it inside a West End branch will break this test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const ORCHESTRATOR_PATH = path.join(
  process.cwd(),
  '.github/workflows/opening-night-orchestrator.yml'
);

describe('Guardian Broadway dispatch', () => {
  const yaml = fs.readFileSync(ORCHESTRATOR_PATH, 'utf8');
  const lines = yaml.split('\n');

  it('dispatches fetch-guardian-reviews.yml from the orchestrator', () => {
    const idx = lines.findIndex((l) => /fetch-guardian-reviews\.yml/.test(l));
    assert.ok(
      idx !== -1,
      'fetch-guardian-reviews.yml dispatch not found in orchestrator — Guardian star ratings will be lost on opening night'
    );
  });

  it('is not gated inside a West End-only conditional', () => {
    const dispatchIdx = lines.findIndex((l) =>
      /fetch-guardian-reviews\.yml/.test(l)
    );
    assert.ok(dispatchIdx !== -1, 'dispatch line missing');

    // Walk backwards up to 15 lines; confirm we never enter an open
    // `if [ "$MARKET" = "west-end" ]` block before hitting the preceding
    // section header. If we did, Broadway would be skipped.
    for (let i = dispatchIdx - 1; i >= Math.max(0, dispatchIdx - 15); i--) {
      const l = lines[i];
      if (/^\s*if\s+\[\s+"\$MARKET"\s*=\s*"west-end"/.test(l)) {
        assert.fail(
          `Guardian dispatch at line ${dispatchIdx + 1} is wrapped in a West End-only if-block (line ${i + 1}) — Broadway star ratings will regress.`
        );
      }
      // Stop scanning if we hit a preceding `fi` or step boundary (`- name:`)
      if (/^\s*fi\s*$/.test(l) || /^\s*-\s*name:/.test(l)) break;
    }
  });

  it('is not gated inside a Broadway-skip conditional', () => {
    const dispatchIdx = lines.findIndex((l) =>
      /fetch-guardian-reviews\.yml/.test(l)
    );
    for (let i = dispatchIdx - 1; i >= Math.max(0, dispatchIdx - 15); i--) {
      const l = lines[i];
      if (/^\s*if\s+\[\s+"\$MARKET"\s*!=\s*"broadway"/.test(l)) {
        assert.fail(
          `Guardian dispatch is wrapped in a Broadway-skip if-block (line ${i + 1})`
        );
      }
      if (/^\s*fi\s*$/.test(l) || /^\s*-\s*name:/.test(l)) break;
    }
  });

  it('has a rationale comment explaining both-markets coverage', () => {
    const dispatchIdx = lines.findIndex((l) =>
      /fetch-guardian-reviews\.yml/.test(l)
    );
    const preamble = lines.slice(Math.max(0, dispatchIdx - 8), dispatchIdx).join('\n');
    assert.ok(
      /Guardian/i.test(preamble) && /(both|broadway)/i.test(preamble),
      'Guardian dispatch should have a preceding comment explaining it runs for Broadway too — prevents a future reviewer from "tidying" it back into the West End branch.'
    );
  });
});
