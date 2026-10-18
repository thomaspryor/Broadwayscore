// Guard A2 (BRO-5298): an UNDATED review whose url a same-title sibling
// production already holds is refused at write time, so one article is not
// counted on both runs (the-comedy-about-spies-west-end-2026/sunday-times--unknown
// re-wrote the 2025 Times review; leopoldstadt-west-end-2021 got three 2020 reviews).
// Real functions only (CLAUDE.md §15); every write goes to a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');
const { buildSiblingIndex } = require('./market-routing.js');
const { findSameTitleSiblingUrlHolder, hasRoutingDate, isCountedSameUrlCopy } = require('./sibling-same-url.js');
const { classifyReason, isDurableRejection } = require('./ingest-skip-classify.js');

// Fictional ids so the live shows.json can never change the verdicts.
const OLD = 'spy-farce-bro5298-west-end-2025';
const NEW = 'spy-farce-bro5298-west-end-2026';
const SIBLINGS = buildSiblingIndex([
  { id: OLD, title: 'Spy Farce BRO5298', category: 'west-end', openingDate: '2025-05-06', closingDate: '2026-01-10' },
  { id: NEW, title: 'Spy Farce BRO5298', category: 'west-end', openingDate: '2026-08-06' },
]);
const URL = 'https://www.thetimes.com/culture/theatre-dance/article/spy-farce-review-inventive-cd2nx6qlc';
const BODY = 'The cast race through doors and disguises at a clip that rarely flags, and the jokes land. '.repeat(10);

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bro5298-')); }
function put(dir, showId, file, data) {
  fs.mkdirSync(path.join(dir, showId), { recursive: true });
  fs.writeFileSync(path.join(dir, showId, file), JSON.stringify({ showId, ...data }, null, 2));
}
function seedOld(dir, extra = {}) {
  put(dir, OLD, 'times-uk--clive-davis.json', {
    outletId: 'times-uk', outlet: 'The Times', criticName: 'Clive Davis', url: URL, publishDate: 'May 14th, 2025', source: 'show-score', ...extra,
  });
}
function write(dir, input, opts = {}) {
  return createOrMergeReviewFile(NEW, {
    outletId: 'times-uk', outlet: 'The Times', criticName: 'Unknown', source: 'serp-discovery',
    fields: { fullText: BODY }, ...input,
  }, { reviewTextsDir: dir, siblingIndex: SIBLINGS, ...opts });
}
const newFiles = (dir) => { try { return fs.readdirSync(path.join(dir, NEW)); } catch { return []; } };

test('refuses an undated write whose url the same-title sibling already holds', () => {
  const dir = tmp();
  try {
    seedOld(dir);
    // Case and trailing slash differ: sameUrlKey still matches.
    const r = write(dir, { url: URL.toUpperCase().replace('HTTPS://WWW.THETIMES.COM', 'https://www.thetimes.com') + '/' });
    assert.equal(r.action, 'skipped');
    assert.equal(r.reason, `same-title-sibling-url:${OLD}`);
    assert.deepEqual(newFiles(dir), []);
    const c = classifyReason(r.reason);
    assert.equal(c.kind, 'conflict');
    assert.equal(c.detail, OLD);
    assert.equal(isDurableRejection(r.reason), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refuses a merge that would move an existing file of this show onto the sibling url', () => {
  // Guard I (cross-show ownership) only checks NEW files; this is the merge hole.
  const dir = tmp();
  try {
    seedOld(dir);
    put(dir, NEW, 'times-uk--dominic-maxwell.json', {
      outletId: 'times-uk', outlet: 'The Times', criticName: 'Dominic Maxwell', url: null, source: 'show-score', showScoreExcerpt: 'A riot.',
    });
    const r = write(dir, { criticName: 'Dominic Maxwell', url: URL });
    assert.equal(r.action, 'skipped');
    assert.match(r.reason, /^same-title-sibling-url:/);
    const after = JSON.parse(fs.readFileSync(path.join(dir, NEW, 'times-uk--dominic-maxwell.json'), 'utf8'));
    assert.equal(after.url, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('writes an undated review when no sibling folder holds its url', () => {
  const dir = tmp();
  try {
    seedOld(dir);
    const r = write(dir, { url: 'https://www.thetimes.com/culture/theatre-dance/article/spy-farce-returns-review-zz91' });
    assert.equal(r.action, 'new');
    assert.equal(newFiles(dir).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a legitimately dated review is left to the date router, not refused by this guard', () => {
  const dir = tmp();
  try {
    seedOld(dir);
    // In-window publishDate and no sibling copy: written.
    const fresh = write(dir, { url: 'https://www.thetimes.com/culture/theatre-dance/article/spy-farce-2026-review-qq12', publishDate: '2026-08-07' });
    assert.equal(fresh.action, 'new');
    // Dated, and the sibling holds the url: Guard A2 stands aside (whatever else
    // decides, the reason is never this guard's).
    const dated = write(dir, { criticName: 'Clive Davis', url: URL, publishDate: '2026-08-07' });
    assert.notEqual(dated.reason, `same-title-sibling-url:${OLD}`);
    // A /YYYY/MM/ url path also counts as a date.
    assert.equal(hasRoutingDate({ url: 'https://www.theguardian.com/stage/2026/aug/07/spy-farce-review' }), true);
    assert.equal(hasRoutingDate({ url: URL, publishDate: null }), false);
    assert.equal(hasRoutingDate({ url: URL, publishDate: 'not a date' }), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a flagged sibling copy does not block, and an existing copy in this show still merges', () => {
  const dir = tmp();
  try {
    seedOld(dir, { wrongProduction: true, wrongProductionReason: 'manual: belongs to 2026' });
    assert.equal(isCountedSameUrlCopy({ url: URL, wrongProduction: true }), false);
    assert.equal(findSameTitleSiblingUrlHolder({ showId: NEW, url: URL, siblingIndex: SIBLINGS, reviewTextsDir: dir }), null);
    assert.equal(write(dir, { url: URL }).action, 'new');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const dir2 = tmp();
  try {
    seedOld(dir2);
    put(dir2, NEW, 'times-uk--unknown.json', { outletId: 'times-uk', outlet: 'The Times', criticName: 'Unknown', url: URL, source: 'serp-discovery' });
    const r = write(dir2, { url: URL });
    assert.notEqual(r.reason && r.reason.split(':')[0], 'same-title-sibling-url');
  } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
});

test('allowCrossMarket and a caller-set wrongProduction bypass the guard; reroute chain is exempt', () => {
  const dir = tmp();
  try {
    seedOld(dir);
    const cross = write(dir, { url: URL, fields: { fullText: BODY, allowCrossMarket: true } });
    assert.notEqual(cross.reason && cross.reason.split(':')[0], 'same-title-sibling-url');
    const flagged = write(dir, { url: URL, fields: { fullText: BODY, wrongProduction: true, wrongProductionReason: 'caller: 2025 run' } });
    assert.notEqual(flagged.reason && flagged.reason.split(':')[0], 'same-title-sibling-url');
    assert.equal(findSameTitleSiblingUrlHolder({ showId: NEW, url: URL, siblingIndex: SIBLINGS, reviewTextsDir: dir, skipShowIds: new Set([OLD]) }), null);
    assert.equal(findSameTitleSiblingUrlHolder({ showId: NEW, url: URL, siblingIndex: SIBLINGS, reviewTextsDir: dir }).file, 'times-uk--clive-davis.json');
    // Fails open on a show with no siblings or a missing folder.
    assert.equal(findSameTitleSiblingUrlHolder({ showId: 'no-such-show', url: URL, siblingIndex: SIBLINGS, reviewTextsDir: dir }), null);
    assert.equal(findSameTitleSiblingUrlHolder({ showId: NEW, url: URL, siblingIndex: SIBLINGS, reviewTextsDir: path.join(dir, 'missing') }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
