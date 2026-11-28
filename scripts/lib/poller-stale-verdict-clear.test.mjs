// BRO-6968: the press-night poller must clear stale automated text verdicts for each show before
// scoring it, or a review rejected on its page blurb waits hours for the scheduled sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yml = fs.readFileSync(new URL('../../.github/workflows/opening-night-poller.yml', import.meta.url), 'utf8');

test('poller clears stale text verdicts per show before the inline scorer', () => {
  const clear = yml.indexOf('node scripts/clear-stale-automated-text-verdicts.js --apply --show="$SHOW_ID"');
  const score = yml.indexOf('npx ts-node scripts/llm-scoring/index.ts --show="$SHOW_ID" --ensemble');
  assert.ok(clear > 0, 'clear step missing from the score loop');
  assert.ok(score > clear, 'clear must run before the scorer');
});
