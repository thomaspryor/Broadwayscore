// BRO-3092: a URL swap must never land on a URL a sibling review file in the
// same show already owns — that is exactly the state validate-data.js errors
// on, and mergeReviews' applyUrlChangeInvariant wipes the losing file's
// excerpts/llmScore/assignedScore on the way in.
//
// Reproduces the-addams-family-2010 (2026-09-08 08:41Z): an incoming
// BWW-roundup row matched wsj--terry-teachout.json on outlet+byline and
// carried the URL wsj--unknown.json had owned since March.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { sameUrlKey, sameUrlDuplicateKey, findSiblingUrlOwner } =
  require(path.join(REPO, 'scripts/lib/review-url-collision.js'));
const { mergeReviews, maybeUpgradeUrl } =
  require(path.join(REPO, 'scripts/lib/review-normalization.js'));
const { detectAllSelfContradictoryClears } =
  require(path.join(REPO, 'scripts/lib/flag-contradiction.js'));
const { invalidateWrongProductionAutoClear } =
  require(path.join(REPO, 'scripts/lib/review-write-guard.js'));

const OWNED_URL = 'http://online.wsj.com/article/SB10001424052702303411604575168152141751426.html';
const TEACHOUT_URL = 'https://www.wsj.com/articles/SB10001424052702304222504575172743926926460';

function fixtureShowDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro3092-'));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  }
  return dir;
}

test('sameUrlDuplicateKey matches the validator identity (hash + trailing slash + case)', () => {
  assert.equal(sameUrlKey('HTTPS://X.com/A/#frag'), 'https://x.com/a');
  assert.equal(sameUrlKey(''), null);
  assert.equal(sameUrlKey(null), null);
  assert.equal(sameUrlDuplicateKey('s1', 'https://x.com/a/'), 's1|https://x.com/a');
  assert.equal(sameUrlDuplicateKey('s1', null), null);
});

test('findSiblingUrlOwner finds a different file holding the same url', () => {
  const dir = fixtureShowDir({
    'wsj--terry-teachout.json': { outletId: 'wsj', criticName: 'Terry Teachout', url: TEACHOUT_URL },
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: OWNED_URL },
  });
  const owner = findSiblingUrlOwner({
    showDir: dir, url: OWNED_URL, selfOutletId: 'wsj', selfCriticName: 'Terry Teachout',
  });
  assert.equal(owner && owner.filename, 'wsj--unknown.json');
});

test('findSiblingUrlOwner never reports the record itself as its own sibling', () => {
  const dir = fixtureShowDir({
    'wsj--terry-teachout.json': { outletId: 'wsj', criticName: 'Terry Teachout', url: OWNED_URL },
  });
  assert.equal(findSiblingUrlOwner({
    showDir: dir, url: OWNED_URL, selfOutletId: 'wsj', selfCriticName: 'Terry Teachout',
  }), null);
  assert.equal(findSiblingUrlOwner({
    showDir: dir, url: OWNED_URL, selfFilename: 'wsj--terry-teachout.json',
  }), null);
});

test('findSiblingUrlOwner counts FLAGGED siblings (pass-0 dedup skips them)', () => {
  const dir = fixtureShowDir({
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: OWNED_URL, wrongProduction: true },
  });
  const owner = findSiblingUrlOwner({
    showDir: dir, url: OWNED_URL, selfOutletId: 'wsj', selfCriticName: 'Terry Teachout',
  });
  assert.equal(owner && owner.filename, 'wsj--unknown.json');
});

test('findSiblingUrlOwner fails open on a missing dir / unusable url', () => {
  assert.equal(findSiblingUrlOwner({ showDir: '/nonexistent-bro3092', url: OWNED_URL }), null);
  assert.equal(findSiblingUrlOwner({ showDir: os.tmpdir(), url: null }), null);
  assert.equal(findSiblingUrlOwner({}), null);
});

test('mergeReviews refuses a url swap onto a sibling-owned url and keeps the scored content', () => {
  const dir = fixtureShowDir({
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: OWNED_URL },
  });
  const existing = {
    showId: 'the-addams-family-2010', outletId: 'wsj', outlet: 'The Wall Street Journal',
    criticName: 'Terry Teachout', url: TEACHOUT_URL,
    fullText: 'The Addams Family is a thoroughly professional piece of commercial Broadway craftsmanship.',
    dtliExcerpt: 'It will not kill you.', assignedScore: 72, contentTier: 'truncated',
    llmScore: { score: 76, bucket: 'Positive' },
  };
  const merged = mergeReviews(
    existing,
    { url: OWNED_URL, source: 'bww-roundup', fullText: 'Please register to gain free access to WSJ tools.' },
    {},
    { script: 'test', showId: 'the-addams-family-2010', showDir: dir, file: 'wsj--terry-teachout.json' },
  );
  assert.equal(merged.url, TEACHOUT_URL, 'url must not move onto the sibling-owned url');
  assert.equal(merged.assignedScore, 72, 'score must survive the refused swap');
  assert.deepEqual(merged.llmScore, { score: 76, bucket: 'Positive' });
  assert.equal(merged.dtliExcerpt, 'It will not kill you.');
  assert.equal(merged.fullText, existing.fullText, 'the sibling article body must not be adopted');
  assert.ok(!merged.urlUpdatedFrom, 'no url-change breadcrumb should be stamped');
  assert.ok(!merged._urlChangedClear, 'applyUrlChangeInvariant must not have run');
});

test('mergeReviews still performs a genuine (non-colliding) url correction', () => {
  const dir = fixtureShowDir({
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: OWNED_URL },
  });
  const merged = mergeReviews(
    { showId: 's', outletId: 'nytimes', criticName: 'Ben Brantley', url: 'https://www.nytimes.com/2010/04/09/theater/reviews/old.html', fullText: 'x' },
    { url: 'https://www.nytimes.com/2010/04/09/theater/reviews/new.html' },
    {},
    { script: 'test', showId: 's', showDir: dir, file: 'nytimes--ben-brantley.json' },
  );
  assert.equal(merged.url, 'https://www.nytimes.com/2010/04/09/theater/reviews/new.html');
});

test('mergeReviews without context.showDir keeps its pre-BRO-3092 behaviour (fails open)', () => {
  const merged = mergeReviews(
    { showId: 's', outletId: 'wsj', criticName: 'Terry Teachout', url: TEACHOUT_URL, fullText: 'x' },
    { url: OWNED_URL },
    {},
    { script: 'test', showId: 's' },
  );
  assert.equal(merged.url, OWNED_URL);
});

test('maybeUpgradeUrl refuses a swap onto a sibling-owned url', () => {
  const dir = fixtureShowDir({
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: OWNED_URL, wrongProduction: true },
  });
  const data = {
    outletId: 'wsj', criticName: 'Terry Teachout', url: TEACHOUT_URL,
    fullText: null, contentTier: 'stub', assignedScore: 72,
  };
  const changed = maybeUpgradeUrl(data, OWNED_URL, 'bww-roundup', {
    showDir: dir, selfFilename: 'wsj--terry-teachout.json',
  });
  assert.equal(changed, false);
  assert.equal(data.url, TEACHOUT_URL);
  assert.equal(data.assignedScore, 72);
  assert.ok(!data._urlChangedClear);
});

test('maybeUpgradeUrl still upgrades when no sibling owns the candidate url', () => {
  const dir = fixtureShowDir({
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: 'https://www.wsj.com/articles/some-other-article' },
  });
  const NEW_URL = 'https://www.nytimes.com/2010/04/09/theater/reviews/09addams.html';
  const data = {
    outletId: 'nytimes', criticName: 'Ben Brantley',
    url: 'https://www.nytimes.com/2010/04/09/theater/reviews/09addams-preview.html',
    fullText: null, contentTier: 'stub',
  };
  assert.equal(maybeUpgradeUrl(data, NEW_URL, 'bww-roundup', { showDir: dir }), true);
  assert.equal(data.url, NEW_URL);
});

// --- BRO-3092, second half: the drain-test failure ---
//
// adjudicate-review-queue.js re-flags wrongProduction on a high-confidence
// contamination verdict. Until now it left any earlier wrongProductionAuto-
// Cleared breadcrumb standing, producing the flag + its own clear breadcrumb
// on one record — contradiction #1020, which the BRO-185 drain acceptance
// test fails on. Asserted against the real helpers, in the adjudicator's own
// write order, so the invariant holds no matter how that call site is
// reshuffled.
test('re-flagging wrongProduction retracts the auto-clear breadcrumb it overrules', () => {
  const record = {
    showId: 'the-car-man-west-end-2026',
    outletId: 'north-west-end',
    criticName: 'Natalia Prucnal',
    url: 'https://northwestend.com/matthew-bournes-the-car-man-sheffield-lyceum/',
    wrongProductionAutoCleared: "rebuild: registry region 'london' outlet on London show (north-west-end)",
    wrongProductionAutoClearedAt: '2026-08-30',
  };

  // Pre-condition: the un-retracted write really does self-contradict.
  const naive = { ...record, wrongProduction: true, wrongProductionReason: 'contamination-adjudicated: national-tour' };
  assert.ok(detectAllSelfContradictoryClears(naive).some(h => h.flag === 'wrongProduction'),
    'fixture must reproduce contradiction #1020 without the retraction');

  // The adjudicator's write order, with the retraction.
  record.wrongProduction = true;
  record.wrongProductionNote = 'Adjudicated: national-tour. Reviewed at Sheffield Lyceum.';
  record.wrongProductionReason = 'contamination-adjudicated: national-tour';
  invalidateWrongProductionAutoClear(record);

  assert.deepEqual(detectAllSelfContradictoryClears(record), [], 'no contradiction may survive the re-flag');
  assert.equal(record.wrongProduction, true, 'the adjudicated flag itself must stand');
  assert.ok(!('wrongProductionAutoCleared' in record));
  assert.ok(!('wrongProductionAutoClearedAt' in record));
  // Without a retraction stamp, push-review-texts' PROTECTED_FIELDS restore
  // resurrects both breadcrumbs on the next rebase, making this a no-op.
  const stampedFields = record.clearBreadcrumbRetractedFields
    || (record._clearBreadcrumbRetracted && record._clearBreadcrumbRetracted.fields);
  assert.ok(Array.isArray(stampedFields)
    && stampedFields.includes('wrongProductionAutoCleared')
    && stampedFields.includes('wrongProductionAutoClearedAt'),
    `retraction must be stamped for the push guard, got ${JSON.stringify(stampedFields)}`);
});


// Real-corpus regression (found by replaying the bug over 4 real shows):
// 1536-west-end-2026 holds broadwayworld--cindy-marcolina.json whose
// criticName field reads "Debbie Gilpin" — identical (outletId, criticName) to
// its broadwayworld--debbie-gilpin.json sibling. An (outlet, critic) self-check
// therefore mistakes the colliding sibling for the record itself and waves the
// swap through. When the caller knows the filename, that is the identity.
test('byline drift: (outlet, critic) is not unique, so selfFilename wins', () => {
  const dir = fixtureShowDir({
    'broadwayworld--debbie-gilpin.json': { outletId: 'broadwayworld', criticName: 'Debbie Gilpin', url: 'https://www.broadwayworld.com/westend/article/review-1536-old' },
    'broadwayworld--cindy-marcolina.json': { outletId: 'broadwayworld', criticName: 'Debbie Gilpin', url: 'https://www.broadwayworld.com/westend/article/review-1536-20260514' },
  });
  const owner = findSiblingUrlOwner({
    showDir: dir,
    url: 'https://www.broadwayworld.com/westend/article/review-1536-20260514',
    selfOutletId: 'broadwayworld',
    selfCriticName: 'Debbie Gilpin',
    selfFilename: 'broadwayworld--debbie-gilpin.json',
  });
  assert.equal(owner && owner.filename, 'broadwayworld--cindy-marcolina.json');
});


// --- BRO-3092 ship-check findings (Codex adversarial review) ---

// A refused URL is not evidence of anything. mergeReviews' URL-based
// wrongProduction self-heal only ever checked that incoming.url LOOKED like an
// http url, never that the swap was accepted — so a rejected candidate still
// un-excluded the review while it kept the very URL the flag is about. The
// urlSwapRegressed / urlFlipFlop guards had this hole before this change; the
// collision guard would have inherited it.
test('a REFUSED colliding url does not un-flag a URL-based wrongProduction', () => {
  const dir = fixtureShowDir({
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: OWNED_URL },
  });
  const existing = {
    showId: 'the-addams-family-2010', outletId: 'wsj', criticName: 'Terry Teachout',
    url: TEACHOUT_URL, fullText: 'x',
    wrongProduction: true,
    wrongProductionNote: 'Same URL as another show — cross-show collision',
  };
  const merged = mergeReviews(
    { ...existing },
    { url: OWNED_URL },
    {},
    { script: 'test', showId: 'the-addams-family-2010', showDir: dir, file: 'wsj--terry-teachout.json' },
  );
  assert.equal(merged.url, TEACHOUT_URL, 'the swap must still be refused');
  assert.equal(merged.wrongProduction, true,
    'the exclusion must survive: no url change happened to justify clearing it');
  assert.ok(!merged.wrongProductionAutoCleared);

  // Control: the SAME self-heal must still fire on an accepted url change, so
  // the guard has not simply disabled it.
  const healed = mergeReviews(
    { ...existing },
    { url: 'https://www.wsj.com/articles/a-genuinely-different-article' },
    {},
    { script: 'test', showId: 'the-addams-family-2010', showDir: dir, file: 'wsj--terry-teachout.json' },
  );
  assert.ok(!healed.wrongProduction,
    'an ACCEPTED url change still clears the flag — the guard has not disabled the self-heal');
});

// review-file-writer's first-set branch is a bypass of the maybeUpgradeUrl
// guard: an empty-url record accepts the refusal silently and then falls
// through to a branch that only checked the cross-show slug + date guards.
test('findSiblingUrlOwner catches the first-set case (empty existing url)', () => {
  const dir = fixtureShowDir({
    'wsj--unknown.json': { outletId: 'wsj', criticName: 'Unknown', url: OWNED_URL },
  });
  // maybeUpgradeUrl short-circuits on a record with no url at all, which is
  // exactly why the writer needs its own check on the first-set path.
  const emptyUrlRecord = { outletId: 'wsj', criticName: 'Terry Teachout', url: null };
  assert.equal(maybeUpgradeUrl(emptyUrlRecord, OWNED_URL, 'bww-roundup', {
    showDir: dir, selfFilename: 'wsj--terry-teachout.json',
  }), false, 'precondition: the upgrade path does not cover a first set');

  const owner = findSiblingUrlOwner({
    showDir: dir, url: OWNED_URL,
    selfOutletId: 'wsj', selfCriticName: 'Terry Teachout',
    selfFilename: 'wsj--terry-teachout.json',
  });
  assert.equal(owner && owner.filename, 'wsj--unknown.json',
    'the writer must be able to detect the collision before a first set');
});


// Wiring pin (BRO-3092 ship-check). The guard is fail-open by design: without
// context.showDir / opts.showDir it is a silent no-op. Every behavioural test
// above calls the library directly, so dropping showDir from gather-reviews'
// call sites — the writer that actually produced this bug — would be
// completely undetectable. This asserts the wiring itself.
test('gather-reviews wires showDir + filename into every mergeReviews call', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/gather-reviews.js'), 'utf8');
  const contexts = src.match(/\{ script: 'gather-reviews', showId[^}]*show: _showMeta \}/g) || [];
  assert.ok(contexts.length >= 6,
    `expected >=6 gather-reviews mergeReviews contexts, found ${contexts.length}`);
  for (const ctx of contexts) {
    assert.ok(ctx.includes('showDir'), `mergeReviews context missing showDir: ${ctx}`);
    assert.ok(ctx.includes('file:'), `mergeReviews context missing file: ${ctx}`);
  }
  // The wrongShow/wrongProduction replacement branch bypasses mergeReviews
  // entirely, so it needs its own call.
  assert.ok(src.includes('findSiblingUrlOwner'),
    'the replacement branch must check the collision guard directly');
});

test('review-file-writer guards BOTH the upgrade and the first-set url paths', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/lib/review-file-writer.js'), 'utf8');
  const upgradeCall = src.slice(src.indexOf('maybeUpgradeUrl(existing,'));
  assert.ok(upgradeCall && upgradeCall.slice(0, 900).includes('showDir:'),
    'maybeUpgradeUrl call must pass showDir');
  assert.ok(src.includes('findSiblingUrlOwner'),
    'the first-set branch must check the collision guard directly');
});
