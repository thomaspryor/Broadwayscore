/**
 * Cross-show URL ownership gate (Notion 39a637c5-416f-8167).
 *
 * Replays the tender-off-west-end-2026 churn: after Dave Harris Soho reviews
 * were moved to tender-by-dave-harris-off-west-end-2026, six writers kept
 * re-creating the same URLs under the open Bush "Tender" via
 * createOrMergeReviewFile, which had no cross-show URL check.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  buildUrlOwnershipIndex,
  findCrossShowOwners,
  shouldBlockCrossShowCreate,
  recordUrlOwner,
  _resetUrlOwnershipIndex,
  _isBlockingOwnerCopy,
} = require('../../scripts/lib/url-ownership');
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const SOHO_URL = 'https://www.theguardian.com/stage/2026/may/04/tender-review-soho-theatre-london-dave-harris';
const OWNER_SHOW = 'tender-by-dave-harris-off-west-end-2026';
const SIBLING_SHOW = 'tender-off-west-end-2026';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'url-own-'));
  _resetUrlOwnershipIndex();
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetUrlOwnershipIndex();
});

function writeOwnerFile(showId, file, data) {
  const dir = path.join(tmpDir, showId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
}

describe('shouldBlockCrossShowCreate (pure)', () => {
  test('blocks when any owner copy is live', () => {
    const v = shouldBlockCrossShowCreate([
      { showId: OWNER_SHOW, file: 'guardian--david-jays.json', blocking: true },
    ]);
    assert.equal(v.block, true);
    assert.equal(v.owner.showId, OWNER_SHOW);
  });

  test('allows when every owner copy is flagged (re-home case)', () => {
    assert.equal(shouldBlockCrossShowCreate([
      { showId: OWNER_SHOW, file: 'x.json', blocking: false },
    ]).block, false);
  });

  test('allows when unclaimed', () => {
    assert.equal(shouldBlockCrossShowCreate([]).block, false);
  });
});

describe('_isBlockingOwnerCopy semantics', () => {
  test('live review blocks; wrong-flagged, combined, and roundup copies do not', () => {
    assert.equal(_isBlockingOwnerCopy({ url: SOHO_URL }), true);
    assert.equal(_isBlockingOwnerCopy({ url: SOHO_URL, wrongShow: true }), false);
    assert.equal(_isBlockingOwnerCopy({ url: SOHO_URL, wrongProduction: true }), false);
    assert.equal(_isBlockingOwnerCopy({ url: SOHO_URL, isCombinedReview: true }), false);
    assert.equal(_isBlockingOwnerCopy({ url: SOHO_URL, isRoundupArticle: true }), false);
  });
});

describe('index + createOrMergeReviewFile integration (tender replay)', () => {
  test('tender replay: live sibling-owned URL is refused at create time', () => {
    writeOwnerFile(OWNER_SHOW, 'guardian--david-jays.json', {
      showId: OWNER_SHOW, outletId: 'guardian', criticName: 'David Jays',
      url: SOHO_URL, fullText: 'Dave Harris review at Soho.',
    });
    const result = createOrMergeReviewFile(SIBLING_SHOW, {
      outlet: 'The Guardian', outletId: 'guardian', criticName: 'David Jays',
      url: SOHO_URL, source: 'lbo-roundup',
      fields: { fullText: 'rediscovered by aggregator title match' },
    }, { reviewTextsDir: tmpDir });
    assert.equal(result.action, 'skipped');
    assert.match(result.reason, /^cross-show-url-owned:tender-by-dave-harris/);
    assert.equal(fs.existsSync(path.join(tmpDir, SIBLING_SHOW, 'guardian--david-jays.json')), false,
      'no file may be created under the sibling');
  });

  test('URL normalization variants still match the owner', () => {
    writeOwnerFile(OWNER_SHOW, 'guardian--david-jays.json', {
      showId: OWNER_SHOW, outletId: 'guardian', url: SOHO_URL, fullText: 'x',
    });
    const variant = `http://www.theguardian.com/stage/2026/may/04/tender-review-soho-theatre-london-dave-harris/?utm_source=rss`;
    const owners = findCrossShowOwners(variant, SIBLING_SHOW, tmpDir);
    assert.equal(owners.length, 1);
    assert.equal(shouldBlockCrossShowCreate(owners).block, true);
  });

  test('re-home allowed when the owner copy is flagged wrongShow', () => {
    writeOwnerFile(SIBLING_SHOW, 'guardian--david-jays.json', {
      showId: SIBLING_SHOW, outletId: 'guardian', url: SOHO_URL,
      wrongShow: true, wrongShowReason: 'cross-show audit: soho URL on bush show',
    });
    const result = createOrMergeReviewFile(OWNER_SHOW, {
      outlet: 'The Guardian', outletId: 'guardian', criticName: 'David Jays',
      url: SOHO_URL, source: 'gather-reviews',
      fields: { fullText: 'moving home to the right show' },
    }, { reviewTextsDir: tmpDir });
    assert.equal(result.action, 'new');
  });

  test('same-show writes are never blocked (merge path)', () => {
    writeOwnerFile(OWNER_SHOW, 'guardian--david-jays.json', {
      showId: OWNER_SHOW, outletId: 'guardian', criticName: 'David Jays',
      url: SOHO_URL, fullText: 'existing',
    });
    const result = createOrMergeReviewFile(OWNER_SHOW, {
      outlet: 'The Guardian', outletId: 'guardian', criticName: 'David Jays',
      url: SOHO_URL, source: 'weekly-refresh',
      fields: {},
    }, { reviewTextsDir: tmpDir });
    assert.notEqual(result.action, 'skipped');
  });

  test('allowCrossShowUrl escape hatch bypasses the gate', () => {
    writeOwnerFile(OWNER_SHOW, 'guardian--david-jays.json', {
      showId: OWNER_SHOW, outletId: 'guardian', url: SOHO_URL, fullText: 'x',
    });
    const result = createOrMergeReviewFile(SIBLING_SHOW, {
      outlet: 'The Guardian', outletId: 'guardian', criticName: 'David Jays',
      url: SOHO_URL, source: 'ingest-manual-review',
      fields: { fullText: 'operator says both shows', allowCrossShowUrl: true },
    }, { reviewTextsDir: tmpDir });
    assert.equal(result.action, 'new');
  });

  test('recordUrlOwner: a create earlier in the same run blocks a later cross-show create', () => {
    // Force the (empty) index to build for tmpDir first, then record a write.
    buildUrlOwnershipIndex(tmpDir);
    recordUrlOwner(SOHO_URL, OWNER_SHOW, 'guardian--david-jays.json', tmpDir);
    const owners = findCrossShowOwners(SOHO_URL, SIBLING_SHOW, tmpDir);
    assert.equal(shouldBlockCrossShowCreate(owners).block, true);
  });

  test('non-http junk urls never participate in ownership (critic-profile hrefs)', () => {
    // Live corpus: /people/ben-brantley/ sits unflagged under 7 shows. Junk
    // must not become an owner (blocking a whole review over a fixable stub)
    // and must not be looked up.
    writeOwnerFile(OWNER_SHOW, 'nytimes--ben-brantley.json', {
      showId: OWNER_SHOW, outletId: 'nytimes', url: '/people/ben-brantley/', fullText: 'x',
    });
    const map = buildUrlOwnershipIndex(tmpDir, { force: true });
    assert.equal(map.size, 0, 'non-http urls must not be indexed');
    assert.deepEqual(findCrossShowOwners('/people/ben-brantley/', SIBLING_SHOW, tmpDir), []);
  });

  test('reroute chain exemption: owner in _rerouteVisited does not block the rerouted create', () => {
    writeOwnerFile(OWNER_SHOW, 'guardian--david-jays.json', {
      showId: OWNER_SHOW, outletId: 'guardian', url: SOHO_URL, fullText: 'live at origin',
    });
    // Simulate Guard A having rerouted this write AWAY from OWNER_SHOW.
    const result = createOrMergeReviewFile(SIBLING_SHOW, {
      outlet: 'The Guardian', outletId: 'guardian', criticName: 'David Jays',
      url: SOHO_URL, source: 'gather-reviews',
      fields: { fullText: 'routing decided this belongs here' },
    }, { reviewTextsDir: tmpDir, _rerouteVisited: new Set([OWNER_SHOW]) });
    assert.equal(result.action, 'new', 'routing supersedes ownership — review must not be dropped');
  });

  test('_pending and unreadable files are skipped without crashing', () => {
    fs.mkdirSync(path.join(tmpDir, '_pending'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '_pending', 'x.json'), '{"url":"https://a.com/x"}');
    writeOwnerFile(OWNER_SHOW, 'broken.json', {});
    fs.writeFileSync(path.join(tmpDir, OWNER_SHOW, 'corrupt.json'), '{not json');
    const map = buildUrlOwnershipIndex(tmpDir, { force: true });
    assert.equal(map.has('a.com/x'), false, '_pending must not claim ownership');
  });
});
