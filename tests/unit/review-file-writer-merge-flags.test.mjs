// BRO-3911: current scraper callers select individual fields, and
// buildManualReviewFields supplies false flags, so these replay/override shapes
// are defensive coverage of the public writer's unrestricted fields contract.
// Exercise the persisted result too: the safe-write guard protects breadcrumbs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const clearedAt = new Date().toISOString();
const showId = 'merge-flags-fixture';
const input = {
  outletId: 'variety', outlet: 'Variety', criticName: 'Naveen Kumar',
  url: 'https://variety.com/legit/reviews/merge-flags-fixture', source: 'merge-flags-test',
};

function merge(t, stored, fields, source = input.source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-merge-flags-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir);
  const filepath = path.join(showDir, 'variety--naveen-kumar.json');
  fs.writeFileSync(filepath, JSON.stringify({
    ...input, showId, sources: [source], ...stored,
  }));
  const result = createOrMergeReviewFile(showId, { ...input, source, fields }, { reviewTextsDir: dir });
  return { result, data: JSON.parse(fs.readFileSync(filepath, 'utf8')) };
}

for (const flag of ['wrongProduction', 'wrongShow']) {
  const clear = `${flag}AutoCleared`;
  const at = `${clear}At`;
  const breadcrumb = { [clear]: 'previous automatic clear', [at]: clearedAt };

  function assertInvalidated(data) {
    assert.equal(data[flag], true);
    assert.equal(Object.hasOwn(data, clear), false, `${clear} must stay deleted after safeWriteReview`);
    assert.equal(Object.hasOwn(data, at), false, `${at} must stay deleted after safeWriteReview`);
  }

  test(`${flag}: incoming flag invalidates stored breadcrumbs`, t => {
    const { result, data } = merge(t, { [flag]: false, ...breadcrumb }, { [flag]: true });
    assert.equal(result.action, 'updated');
    assertInvalidated(data);
  });

  for (const flagFirst of [true, false]) {
    test(`${flag}: replayed breadcrumbs cannot survive (flag first: ${flagFirst})`, t => {
      const fields = flagFirst ? { [flag]: true, ...breadcrumb } : { ...breadcrumb, [flag]: true };
      const { data } = merge(t, {}, fields);
      assertInvalidated(data);
    });
  }

  for (const incoming of [breadcrumb, { [clear]: breadcrumb[clear] }, { [at]: clearedAt }]) {
    test(`${flag}: already flagged record rejects incoming ${Object.keys(incoming).join(', ')}`, t => {
      const { result, data } = merge(t, { [flag]: true }, incoming);
      assert.equal(result.action, 'updated');
      assertInvalidated(data);
    });
  }

  test(`${flag}: protected manual flag override invalidates stored breadcrumbs`, t => {
    const { result, data } = merge(t, { [flag]: false, ...breadcrumb }, {
      [flag]: true, protectedFields: [flag],
    }, 'manual-entry');
    assert.equal(result.action, 'updated');
    assertInvalidated(data);
  });

  test(`${flag}: protected flag override cannot accept later replayed breadcrumbs`, t => {
    const { data } = merge(t, { [flag]: false }, {
      [flag]: true, protectedFields: [flag], ...breadcrumb,
    }, 'manual-entry');
    assertInvalidated(data);
  });

  test(`${flag}: protected manual breadcrumb override invalidates both stamps`, t => {
    const { data } = merge(t, { [flag]: true, ...breadcrumb }, {
      [clear]: 'replayed stale clear', protectedFields: [clear],
    }, 'manual-entry');
    assertInvalidated(data);
  });

  test(`${flag}: manual clear preserves the automatic-clear history`, t => {
    const { data } = merge(t, { [flag]: true, ...breadcrumb }, {
      [flag]: false, protectedFields: [flag],
    }, 'manual-entry');
    assert.equal(data[flag], false);
    assert.equal(data[clear], breadcrumb[clear]);
    assert.equal(data[at], clearedAt);
  });

  test(`${flag}: unflagged record can receive a legitimate automatic clear`, t => {
    const { data } = merge(t, { [flag]: false }, breadcrumb);
    assert.equal(data[flag], false);
    assert.equal(data[clear], breadcrumb[clear]);
    assert.equal(data[at], clearedAt);
  });

  test(`${flag}: unrelated merge leaves existing automatic-clear history alone`, t => {
    const { data } = merge(t, { [flag]: true, ...breadcrumb }, { discoveryNote: 'metadata only' });
    assert.equal(data[clear], breadcrumb[clear]);
    assert.equal(data[at], clearedAt);
  });
}
