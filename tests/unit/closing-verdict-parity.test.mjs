// BRO-6020 tripwire: the cloud closing verdicts (SAFE TO ARCHIVE / KEEP OPEN /
// ACTION NEEDED FROM YOU) are read by several consumers. A verdict change that
// updates the Stop hook but misses a parser has happened twice before (the
// 2026-07-27 THIS SESSION change left session-wrapups.js matching nothing),
// so every consumer and the instructions that teach the format are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ALL = ['SAFE TO ARCHIVE', 'KEEP OPEN', 'ACTION NEEDED FROM YOU'];

const CONSUMERS = {
  '.claude/hooks/verify-edits.sh': ALL,
  'scripts/lib/session-wrapups.js': ALL,
  'scripts/lib/headless-result-classifier.js': ALL,
  // Only the SAFE claim is gated there; the hold verdicts must never block.
  'scripts/lib/review-coverage.mjs': ['SAFE TO ARCHIVE'],
  '.claude/commands/wrap-up.md': ALL,
  '.agents/skills/wrap-up/SKILL.md': ALL,
  '.claude/CLOUD.md': ALL,
};

for (const [rel, verdicts] of Object.entries(CONSUMERS)) {
  test(`closing verdicts: ${rel} knows ${verdicts.join(' / ')}`, () => {
    const text = read(rel);
    for (const v of verdicts) assert.ok(text.includes(v), `${rel} never mentions "${v}"`);
  });
}

test('closing verdicts: instructions no longer teach the legacy SAFE TO EXIT line', () => {
  // Parsers keep reading legacy lines for old transcripts; what sessions are
  // TOLD to write must be the new verdicts only.
  for (const rel of ['.claude/commands/wrap-up.md', '.agents/skills/wrap-up/SKILL.md', '.claude/commands/ship-check.md',
    '.agents/skills/ship-check/SKILL.md', '.claude/hooks/session-start.sh', 'CLAUDE.md']) {
    assert.doesNotMatch(read(rel), /SAFE TO EXIT/, `${rel} still teaches SAFE TO EXIT`);
  }
});
