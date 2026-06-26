/**
 * Regression tests for the duplicateOf URL-mismatch audit + --fix sweep.
 *
 * Two behaviours the auto-heal sweep MUST get right (card: duplicateOf cadence):
 *   1. A genuine duplicate whose URL differs only TRIVIALLY (trailing %20 /
 *      whitespace / slash) from its sibling must NOT be flagged — else --fix
 *      clears the flag and resurfaces a real duplicate into scoring. This was
 *      the the-maids-off-broadway-2026 thewrap %20 case.
 *   2. A genuinely STALE flag (URL corrected to a DIFFERENT article — differs by
 *      PATH) MUST still be flagged and cleared by --fix (the Sommers/much-ado
 *      case the audit exists to catch).
 *
 * Run: node --test tests/unit/duplicate-of-url-mismatch.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Fixture dir must be set BEFORE requiring the module (REVIEW_TEXTS_DIR is read
// at load time).
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-audit-'));
process.env.REVIEW_TEXTS_DIR = FIXTURE;
const { stripTrivial, audit, fix } = require('../../scripts/audit-duplicate-of-url-mismatch.js');

function writeShow(showId, files) {
  const dir = path.join(FIXTURE, showId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  }
  return dir;
}

test('stripTrivial collapses trailing %20 / whitespace / slash', () => {
  assert.equal(stripTrivial('https://x.com/a-review/%20'), 'https://x.com/a-review');
  assert.equal(stripTrivial('https://x.com/a-review/'), 'https://x.com/a-review');
  assert.equal(stripTrivial('https://x.com/a-review '), 'https://x.com/a-review');
  // genuinely different paths stay different
  assert.notEqual(stripTrivial('https://x.com/review-a'), stripTrivial('https://x.com/review-b'));
  // query string dropped (existing behaviour)
  assert.equal(stripTrivial('https://x.com/a?utm=1'), 'https://x.com/a');
});

test('trivial %20-only URL diff is NOT flagged (real dup stays deduped)', () => {
  writeShow('trivial-diff-2026', {
    'thewrap--unknown.json': {
      url: 'https://www.thewrap.com/the-maids-review/%20',
      duplicateOf: 'thewrap--jane-doe.json',
    },
    'thewrap--jane-doe.json': { url: 'https://www.thewrap.com/the-maids-review/' },
  });
  const mismatches = audit().filter(m => m.showId === 'trivial-diff-2026');
  assert.equal(mismatches.length, 0, 'trivial %20 diff must not be a mismatch');
});

test('different-article (path) diff IS flagged and --fix clears it', () => {
  writeShow('stale-flag-2026', {
    'guardian--unknown.json': {
      url: 'https://www.theguardian.com/2026/jun/21/globe-much-ado',
      duplicateOf: 'guardian--arifa-akbar.json',
      duplicateReason: 'same url',
    },
    'guardian--arifa-akbar.json': { url: 'https://www.theguardian.com/2025/feb/19/royal-much-ado' },
  });
  const mismatches = audit().filter(m => m.showId === 'stale-flag-2026');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].reason, 'url-mismatch');

  fix(mismatches);
  const after = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'stale-flag-2026', 'guardian--unknown.json'), 'utf-8'));
  assert.equal(after.duplicateOf, null, 'stale flag cleared');
  assert.ok(after.duplicateClearReason, 'clear reason recorded');
});
