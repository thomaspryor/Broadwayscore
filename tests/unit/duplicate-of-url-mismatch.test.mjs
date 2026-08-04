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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Fixture dir must be set BEFORE requiring the module (REVIEW_TEXTS_DIR is read
// at load time).
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-audit-'));
process.env.REVIEW_TEXTS_DIR = FIXTURE;
const { stripTrivial, audit, fix } = require('../../scripts/audit-duplicate-of-url-mismatch.js');
const SCRIPT_PATH = path.join(import.meta.dirname, '..', '..', 'scripts', 'audit-duplicate-of-url-mismatch.js');

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

test('self-referential duplicateTextOf IS flagged and --fix clears only that field', () => {
  writeShow('self-ref-2026', {
    'timeout-london--andrzej-lukowski.json': {
      url: 'https://www.timeout.com/london/news/jcs-review',
      duplicateTextOf: 'timeout-london--andrzej-lukowski.json',
    },
  });
  const mismatches = audit().filter(m => m.showId === 'self-ref-2026');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].reason, 'self-reference');
  assert.equal(mismatches[0].field, 'duplicateTextOf');

  fix(mismatches);
  const after = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'self-ref-2026', 'timeout-london--andrzej-lukowski.json'), 'utf-8'));
  assert.equal('duplicateTextOf' in after, false, 'self-ref cleared (field absent, not null)');
  assert.equal(after.duplicateTextOfCleared, undefined, 'must NOT block future re-dedup');
  assert.ok(after.duplicateClearReason, 'clear reason recorded');
});

test('self-referential duplicateOf IS flagged', () => {
  writeShow('self-ref-of-2026', {
    'wsj--charles-isherwood.json': {
      url: 'https://www.wsj.com/arts/becky-shaw-review',
      duplicateOf: 'wsj--charles-isherwood.json',
    },
  });
  const mismatches = audit().filter(m => m.showId === 'self-ref-of-2026');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].reason, 'self-reference');
  assert.equal(mismatches[0].field, 'duplicateOf');

  fix(mismatches);
  const after = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'self-ref-of-2026', 'wsj--charles-isherwood.json'), 'utf-8'));
  assert.equal(after.duplicateOf, null, 'self-ref cleared');
});

test('dangling duplicateTextOf (target deleted) IS flagged; valid pointer is NOT', () => {
  writeShow('dangling-2026', {
    'cambridge--louise-penn.json': {
      url: 'https://cambridge.example/jcs',
      duplicateTextOf: 'loureviews--louise-penn.json', // does not exist
    },
    'guardian-uk--unknown.json': {
      url: 'https://guardian.example/jcs',
      duplicateTextOf: 'guardian--arifa-akbar.json', // exists — legit dedup
    },
    'guardian--arifa-akbar.json': { url: 'https://theguardian.example/jcs-akbar' },
  });
  const mismatches = audit().filter(m => m.showId === 'dangling-2026');
  assert.equal(mismatches.length, 1, 'only the dangling pointer is flagged');
  assert.equal(mismatches[0].file, 'cambridge--louise-penn.json');
  assert.equal(mismatches[0].reason, 'sibling-missing');
  assert.equal(mismatches[0].field, 'duplicateTextOf');
});

test('duplicateTextOf URL mismatch vs existing sibling is NOT flagged (syndication is url-independent)', () => {
  writeShow('synd-2026', {
    'northjersey--robert-feldberg.json': {
      url: 'https://northjersey.example/review',
      duplicateTextOf: 'record--robert-feldberg.json',
    },
    'record--robert-feldberg.json': { url: 'https://record.example/totally-different-path' },
  });
  const mismatches = audit().filter(m => m.showId === 'synd-2026');
  assert.equal(mismatches.length, 0);
});

test('3-node duplicateOf cycle IS flagged for every member and --fix does NOT auto-clear it (Notion #941 washpost regression)', () => {
  // Mirrors the carmen-off-broadway-2025 washpost bug: A -> B -> C -> A, all
  // sharing the same URL. rebuild-all-reviews.js's circular-tiebreak only
  // checks ONE hop back, so this never terminates and every member survives
  // into reviews.json as a same-URL duplicate.
  const url = 'https://www.washingtonpost.com/entertainment/music/2024/01/01/metropolitan-opera-carmen-review/';
  writeShow('cycle-2026', {
    'washpost--a.json': { url, duplicateOf: 'washpost--b.json' },
    'washpost--b.json': { url, duplicateOf: 'washpost--c.json' },
    'washpost--c.json': { url, duplicateOf: 'washpost--a.json' },
  });
  const mismatches = audit().filter(m => m.showId === 'cycle-2026');
  assert.equal(mismatches.length, 3, 'all three cycle members are flagged');
  for (const m of mismatches) {
    assert.equal(m.reason, 'duplicateOf-cycle');
    assert.ok(Array.isArray(m.chain) && m.chain.length >= 3, 'chain records the walked path');
  }

  const cleared = fix(mismatches);
  assert.equal(cleared, 0, '--fix must not guess which cycle member is canonical');
  for (const name of ['washpost--a.json', 'washpost--b.json', 'washpost--c.json']) {
    const after = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'cycle-2026', name), 'utf-8'));
    assert.ok(after.duplicateOf, `${name} duplicateOf left untouched for manual triage`);
  }
});

test('2-node duplicateOf cycle IS flagged (defense-in-depth alongside rebuild circular-tiebreak)', () => {
  const url = 'https://example.com/two-node-cycle-review';
  writeShow('cycle-2-2026', {
    'outlet--a.json': { url, duplicateOf: 'outlet--b.json' },
    'outlet--b.json': { url, duplicateOf: 'outlet--a.json' },
  });
  const mismatches = audit().filter(m => m.showId === 'cycle-2-2026');
  assert.equal(mismatches.length, 2);
  assert.ok(mismatches.every(m => m.reason === 'duplicateOf-cycle'));
});

test('non-circular duplicateOf chain (terminates at a canonical file) is NOT flagged as a cycle', () => {
  const url = 'https://example.com/chain-terminates-review';
  writeShow('chain-ok-2026', {
    'outlet--a.json': { url, duplicateOf: 'outlet--b.json' },
    'outlet--b.json': { url, duplicateOf: 'outlet--canonical.json' },
    'outlet--canonical.json': { url },
  });
  const mismatches = audit().filter(m => m.showId === 'chain-ok-2026');
  assert.equal(mismatches.length, 0, 'a terminating chain is legitimate, not a cycle');
});

test('duplicateOf-cycle mismatches are excluded from the FIX_SURGE_THRESHOLD count (never self-heal, so must not eat the auto-heal floor)', () => {
  // A single large cycle (30 files, all mutually duplicateOf) exceeds
  // FIX_SURGE_THRESHOLD (25) on raw mismatch count alone, but --fix must still
  // run for genuinely auto-healable stale flags elsewhere in the corpus —
  // cycles never clear via fix() regardless, so they must not count against
  // the surge floor meant to catch a producer-regression SPIKE in fixable churn.
  // Runs against an ISOLATED fixture dir (not the shared module-level FIXTURE,
  // which accumulates every other test's show dirs) so counts are exact.
  const isolatedFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-audit-surge-'));
  const url = 'https://example.com/big-cycle-review';
  const names = Array.from({ length: 30 }, (_, i) => `outlet${i}--critic${i}.json`);
  const showDir = path.join(isolatedFixture, 'big-cycle-2026');
  fs.mkdirSync(showDir, { recursive: true });
  for (let i = 0; i < names.length; i++) {
    fs.writeFileSync(path.join(showDir, names[i]), JSON.stringify({ url, duplicateOf: names[(i + 1) % names.length] }));
  }
  const staleDir = path.join(isolatedFixture, 'genuine-stale-2026');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'guardian--unknown.json'), JSON.stringify({
    url: 'https://www.theguardian.com/2026/jun/21/globe-much-ado',
    duplicateOf: 'guardian--arifa-akbar.json',
  }));
  fs.writeFileSync(path.join(staleDir, 'guardian--arifa-akbar.json'), JSON.stringify({
    url: 'https://www.theguardian.com/2025/feb/19/royal-much-ado',
  }));

  const out = execFileSync('node', [SCRIPT_PATH, '--fix'], {
    env: { ...process.env, REVIEW_TEXTS_DIR: isolatedFixture },
    encoding: 'utf-8',
  });
  assert.match(out, /Cleared 1 stale duplicateOf flag/, '--fix ran to completion (was not refused as a surge) and cleared the one genuine stale flag');
  assert.match(out, /30 duplicateOf-cycle mismatch\(es\) were NOT auto-fixed/, 'all 30 cycle members reported but not cleared');

  const staleAfter = JSON.parse(fs.readFileSync(path.join(staleDir, 'guardian--unknown.json'), 'utf-8'));
  assert.equal(staleAfter.duplicateOf, null, 'genuine stale flag elsewhere in the corpus still gets cleared despite the 30-file cycle');

  const cycleFileAfter = JSON.parse(fs.readFileSync(path.join(showDir, names[0]), 'utf-8'));
  assert.ok(cycleFileAfter.duplicateOf, 'cycle member untouched');
});

test('non-filename duplicateOf sentinel values are ignored (report-only conservatism)', () => {
  writeShow('sentinel-2026', {
    'northjerseycom--robert-feldberg.json': {
      url: 'https://northjersey.example/review',
      duplicateOf: 'northjerseycom',
    },
  });
  const mismatches = audit().filter(m => m.showId === 'sentinel-2026');
  assert.equal(mismatches.length, 0, 'sentinel-valued pointers are not auto-clearable');
});

test('non-show buckets (_pending, _superseded-misattributed) are NOT scanned — their pointers are historical and never self-heal', () => {
  // Task #1002: 27 files task #988 archived into _superseded-misattributed/
  // pointed at siblings that stayed behind in the real show dirs, so each read
  // as `sibling-missing` forever. That pushed the auto-healable count to 32,
  // past the 25 floor, and reddened main for every unrelated push — a false
  // spike, not the producer regression the gate exists to catch. rebuild-all-
  // reviews.js already ignores these dirs (not in shows.json), so nothing in
  // them can reach scoring.
  writeShow('_superseded-misattributed', {
    'archived-show-2026--outlet--critic.json': {
      url: 'https://example.com/a-review',
      duplicateOf: 'outlet--someone-else.json', // sibling lives in the real show dir
    },
  });
  writeShow('_pending', {
    'outlet--unknown.json': {
      url: 'https://example.com/b-review',
      duplicateOf: 'outlet--never-written.json',
    },
  });
  const flagged = audit().filter(
    m => m.showId === '_superseded-misattributed' || m.showId === '_pending'
  );
  assert.deepEqual(flagged, [], 'non-show buckets must not contribute mismatches');

  // Control: the identical dangling pointer in a REAL show dir is still caught,
  // so the skip is scoped to the buckets and did not blunt the audit.
  writeShow('real-show-2026', {
    'outlet--critic.json': {
      url: 'https://example.com/c-review',
      duplicateOf: 'outlet--never-written.json',
    },
  });
  const real = audit().filter(m => m.showId === 'real-show-2026');
  assert.equal(real.length, 1, 'a dangling pointer in a real show dir is still flagged');
  assert.equal(real[0].reason, 'sibling-missing');
});
