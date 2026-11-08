// BRO-7155: a human-approved exclusion verdict must not be silently undone by a
// heuristic clearer, and the drift audit must tell an erased verdict apart from
// one a later recorded decision explains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const guards = require('../../scripts/lib/review-guards.js');
const { approvedFixBinding } = require('../../scripts/lib/approved-fix-flag.js');
const { classifyRecord } = require('../../scripts/lib/approved-fix-drift.js');

// Shape of waiting-for-godot-2009/backstage--erik-haagensen.json on 2026-11-08,
// minus the review text (private repo).
function godot() {
  return {
    url: 'https://www.backstage.com/bso/reviews-ny-theatre-broadway/9-to-5-1003968308.story',
    fullText: 'A short stand-in body for a 9 to 5 review.',
    wrongShow: true,
    wrongShowReason: 'CV-promoted: The scraped content is a review, but it\'s for the Broadway production of "9 to 5", not "Waiting for Godot".',
    contentVerificationPromoted: 'rebuild: promoted from contentVerification (llm:gemini, high)',
    contentVerification: {
      isValid: false, confidence: 'high', truncated: true, wrongArticle: true, wrongProduction: false,
      articleType: 'review', articleTypeConfidence: 'high', isFilmTv: false,
      issues: ['Wrong show: Review is for "9 to 5", not "Waiting for Godot".'],
      reasoning: 'The scraped content is a review of the Broadway production of "9 to 5"',
      verifiedBy: 'llm:gemini', verifiedAt: '2026-04-08T02:18:33.396Z',
    },
  };
}
const stamp = (rec, field, newValue, at = '2026-11-08T13:23:31.465Z') =>
  ({ fixId: 'fx', field, at, newValue, boundTo: approvedFixBinding(rec) });

test('BRO-6716 mis-family heal keeps an approved wrongShow (Godot, 2026-11-08)', () => {
  const plain = godot();
  assert.equal(guards.isMisFamilyCvPromotedWrongShow(plain, {}), true, 'fixture must be one the heal would clear');
  const approved = godot();
  approved.approvedFixes = [stamp(approved, 'wrongShow', true)];
  assert.equal(guards.isMisFamilyCvPromotedWrongShow(approved, {}), false);
});

test('an approval about older content no longer blocks the heal', () => {
  const rec = godot();
  rec.approvedFixes = [stamp(rec, 'wrongShow', true)];
  rec.fullText = 'A different body fetched later.';
  assert.equal(guards.isMisFamilyCvPromotedWrongShow(rec, {}), true);
});

// Class guard: every review-guards predicate that clears or ignores an
// exclusion flag checks for a human-approved verdict first.
// isEligibleForStaleWrongProductionRecovery is left out on purpose: it only
// picks files to search for the critic's current review, and a person who
// confirmed the file is the wrong production agrees with that premise.
const CLEARERS = {
  isMisFamilyCvPromotedWrongShow: 'wrongShow',
  isStaleGenericHomepageWrongShow: 'wrongShow',
  isStaleBulkTitleWrongShow: 'wrongShow',
  isStaleCvPromotedWrongShow: 'wrongShow',
  isLikelyStaleWrongShow: 'wrongShow',
  isLikelyStaleWrongProduction: 'wrongProduction',
  isStaleCvPromotedWrongProduction: 'wrongProduction',
  isVenueCarveoutPersistedWrongProduction: 'wrongProduction',
  isNonReviewDemotedByFreshCV: 'isNonReview',
  cvFlagVetoedInWindow: 'wrongShow',
  isLikelyStaleRoundupFlag: 'isRoundupArticle',
  isStaleCvNonReviewVerdictOverruled: 'isNonReview',
  isLikelyStaleSuspectedMisattribution: 'suspectedMisattribution',
};
const SRC = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/lib/review-guards.js'), 'utf8');
function body(name) {
  const start = SRC.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `${name} not found in review-guards.js`);
  const next = SRC.indexOf('\nfunction ', start + 10);
  return SRC.slice(start, next < 0 ? undefined : next);
}

for (const [name, field] of Object.entries(CLEARERS)) {
  test(`${name} honours an approved ${field}`, () => {
    assert.equal(typeof guards[name], 'function', `${name} must stay exported`);
    const held = { wrongShow: /isWrongShowHeld\(data\)|hasApprovedFlag\(data, 'wrongShow'\)/, wrongProduction: /isWrongProductionHeld\(data\)/, }[field] || new RegExp(`hasApprovedFlag\\(data, '${field}'\\)`);
    assert.match(body(name), held);
  });
}

test('any new is(Stale|LikelyStale|MisFamily)* predicate is on the clearer list', () => {
  const names = [...SRC.matchAll(/\nfunction (is(?:Stale|LikelyStale|MisFamily)\w*)\(/g)].map((m) => m[1]);
  const missing = names.filter((n) => !(n in CLEARERS) && !/hasApprovedFlag\(|is(?:WrongShow|WrongProduction)Held\(/.test(body(n)));
  assert.deepEqual(missing, [], 'add hasApprovedFlag to the new clearer and list it in CLEARERS');
});

// classifyRecord
test('erased approved wrongShow is unexplained', () => {
  const rec = godot();
  rec.approvedFixes = [stamp(rec, 'wrongShow', true)];
  rec.wrongShow = false;
  const [d] = classifyRecord('waiting-for-godot-2009/backstage--erik-haagensen.json', rec, {});
  assert.equal(d.field, 'wrongShow');
  assert.equal(d.explained, null);
});

test('unbound true stamp and manual clear are explained', () => {
  const rec = godot();
  rec.approvedFixes = [stamp(rec, 'wrongShow', true)];
  rec.fullText = 'changed';
  rec.wrongShow = false;
  assert.match(classifyRecord('s/a.json', rec, {})[0].explained, /^unbound/);
  const cleared = { wrongProduction: true, wrongProductionManualClear: true,
    approvedFixes: [{ fixId: 'x', field: 'wrongProduction', at: '2026-11-04T00:00:00Z', newValue: null }] };
  assert.match(classifyRecord('s/b.json', cleared, {})[0].explained, /^manual-clear/);
});

test('duplicateOf drifts: self, missing, cycle, excluded target, text twin, restorable', () => {
  const dup = (target, extra = {}) => ({ url: 'https://x.com/r', ...extra,
    approvedFixes: [{ fixId: 'd', field: 'duplicateOf', at: '2026-10-11T00:00:00Z', newValue: target }] });
  const cls = (rec, siblings) => classifyRecord('show/a.json', rec, { siblings })[0].explained;
  assert.match(cls(dup('a.json'), { 'a.json': {} }), /^invalid-approval/);
  assert.match(cls(dup('b.json'), { 'a.json': {} }), /^target-missing/);
  assert.match(cls(dup('b.json'), { 'b.json': { duplicateOf: 'a.json' } }), /^cycle/);
  assert.match(cls(dup('b.json'), { 'b.json': { contentTier: 'invalid' } }), /^target-excluded/);
  assert.match(cls(dup('b.json'), { 'b.json': { url: 'https://x.com/r', rejectedBy: 'x' } }), /^target-excluded/);
  // a flag a person cleared does not explain the drift
  assert.equal(cls(dup('b.json'), { 'b.json': { url: 'https://x.com/r', wrongShow: true, wrongShowManualClear: true } }), null);
  assert.equal(cls(dup('b.json'), { 'b.json': { url: 'https://x.com/r', duplicateTextOf: 'a.json' } }), null);
  assert.match(cls(dup('b.json', { duplicateTextOf: 'b.json' }), { 'b.json': { url: 'https://x.com/r' } }), /^text-duplicate/);
  assert.match(cls(dup('b.json'), { 'b.json': { url: 'https://x.com/other' } }), /^url-diverged/);
  assert.equal(cls(dup('b.json'), { 'b.json': { url: 'https://www.x.com/r/', contentTier: 'complete' } }), null);
});

test('a syndicated pair approved across two urls still alarms when erased', () => {
  const rec = { url: 'https://a.com/r', fullText: 'x' };
  rec.approvedFixes = [{ fixId: 'd', field: 'duplicateOf', at: '2026-10-11T00:00:00Z', newValue: 'b.json', boundTo: approvedFixBinding(rec) }];
  const sib = { 'b.json': { url: 'https://b.com/r', contentTier: 'complete' } };
  assert.equal(classifyRecord('show/a.json', rec, { siblings: sib })[0].explained, null);
  rec.url = 'https://a.com/moved';
  assert.match(classifyRecord('show/a.json', rec, { siblings: sib })[0].explained, /^url-diverged/);
});

test('veto window never overrides an approved wrongShow or wrongProduction', () => {
  for (const field of ['wrongShow', 'wrongProduction']) {
    const rec = godot();
    rec[field] = true;
    rec.approvedFixes = [stamp(rec, field, true)];
    assert.equal(guards.cvFlagVetoedInWindow(rec, { id: 'x', title: 'Waiting for Godot' }, field, {}), false);
  }
});

test('a held approval is not a drift', () => {
  const rec = godot();
  rec.approvedFixes = [stamp(rec, 'wrongShow', true)];
  assert.deepEqual(classifyRecord('s/a.json', rec, {}), []);
});
