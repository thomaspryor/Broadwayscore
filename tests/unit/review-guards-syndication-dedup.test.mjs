/**
 * Unit tests for isIncludableForRebuild's runtime KNOWN_SYNDICATION_PAIRS
 * dedup — parity with rebuild-all-reviews.js.
 *
 * rebuild-all-reviews.js skips a secondary-outlet copy of a syndicated
 * critic's review (e.g. Chris Jones: chicagotribune primary, nydailynews
 * secondary) even without an isSyndicatedDuplicate flag on file, as long as
 * an unflagged primary file exists in the same show directory. Task #838:
 * les-miserables-arena-concert-spectacular-off-broadway-2026
 * nydailynews--chris-jones.json was excluded with reason="skippedSyndicated"
 * in the real rebuild but isIncludableForRebuild() did not mirror this.
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md §15). Follows the filePath temp-dir pattern established in
 * tests/unit/review-guards-circular-dup-recovery.test.mjs.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isIncludableForRebuild } = require('../../scripts/lib/review-guards.js');

function basePayload(overrides = {}) {
  return {
    contentTier: 'complete',
    isFullReview: true,
    fullText: 'A real critic review with substance and verdict. '.repeat(40),
    ...overrides,
  };
}

let tmpDir;
before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syndication-dedup-'));
});
after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name, payload) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(payload, null, 2));
  return p;
}

describe('isIncludableForRebuild — runtime known-syndication dedup (task #838)', () => {
  test('secondary outlet excluded when an unflagged primary sibling exists', () => {
    const primaryData = basePayload({ criticName: 'Chris Jones', outletId: 'chicagotribune' });
    const secondaryData = basePayload({ criticName: 'Chris Jones', outletId: 'nydailynews' });
    writeFile('chicagotribune--chris-jones.json', primaryData);
    const secondaryPath = writeFile('nydailynews--chris-jones.json', secondaryData);

    assert.strictEqual(isIncludableForRebuild(secondaryData, undefined, secondaryPath), false);
  });

  test('primary outlet itself is unaffected', () => {
    const primaryData = basePayload({ criticName: 'Chris Jones', outletId: 'chicagotribune' });
    const primaryPath = writeFile('chicagotribune--chris-jones.json', primaryData);
    writeFile('nydailynews--chris-jones.json', basePayload({ criticName: 'Chris Jones', outletId: 'nydailynews' }));

    assert.strictEqual(isIncludableForRebuild(primaryData, undefined, primaryPath), true);
  });

  test('secondary outlet included when the primary sibling is flagged wrongProduction', () => {
    writeFile('chicagotribune--chris-jones.json', basePayload({
      criticName: 'Chris Jones', outletId: 'chicagotribune', wrongProduction: true,
    }));
    const secondaryData = basePayload({ criticName: 'Chris Jones', outletId: 'nydailynews' });
    const secondaryPath = writeFile('nydailynews--chris-jones.json', secondaryData);

    assert.strictEqual(isIncludableForRebuild(secondaryData, undefined, secondaryPath), true);
  });

  test('secondary outlet included when no primary sibling file exists', () => {
    const secondaryData = basePayload({ criticName: 'Chris Jones', outletId: 'nydailynews' });
    const secondaryPath = writeFile('nydailynews--chris-jones.json', secondaryData);

    assert.strictEqual(isIncludableForRebuild(secondaryData, undefined, secondaryPath), true);
  });

  test('non-syndicated critic is unaffected', () => {
    const data = basePayload({ criticName: 'Someone Else', outletId: 'nydailynews' });
    const p = writeFile('nydailynews--someone-else.json', data);

    assert.strictEqual(isIncludableForRebuild(data, undefined, p), true);
  });

  test('filePath omitted → dedup skipped (same opt-in mechanism as duplicateOf, though the pre-existing no-filePath default differs: duplicateOf excludes, syndication includes)', () => {
    const secondaryData = basePayload({ criticName: 'Chris Jones', outletId: 'nydailynews' });
    assert.strictEqual(isIncludableForRebuild(secondaryData), true);
  });
});
