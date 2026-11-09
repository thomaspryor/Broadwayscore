// BRO-7155: a human-approved exclusion verdict must not be silently undone by a
// heuristic clearer, and the drift audit must tell an erased verdict apart from
// one a later recorded decision explains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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

// BRO-7179: the daily audit files a worker card through owner-alert-router
// when unexplained drift exists, and resolves the condition when it is clean.
const { decideDriftAlert, DRIFT_ALERT_KEY } = require('../../scripts/lib/approved-fix-drift.js');

function drift(i, extra = {}) {
  return {
    file: `show-${i}/outlet--critic.json`, field: 'wrongShow', current: null, explained: null,
    stamp: { field: 'wrongShow', newValue: true, at: '2026-11-08T10:00:00Z', fixId: `fix-${i}`, note: 'reviewer note' },
    ...extra,
  };
}

test('decideDriftAlert: no unexplained drift resolves the condition', () => {
  for (const input of [[], undefined, null]) {
    const d = decideDriftAlert(input);
    assert.equal(d.action, 'resolve');
    assert.equal(d.conditionKey, 'approved-fix-drift:unexplained');
  }
});

test('decideDriftAlert: unexplained drift routes an auto warning card with the agreed settings', () => {
  const d = decideDriftAlert([drift(1)]);
  assert.equal(d.action, 'route');
  const a = d.alert;
  assert.equal(a.conditionKey, DRIFT_ALERT_KEY);
  assert.equal(a.conditionKey, 'approved-fix-drift:unexplained');
  assert.equal(a.disposition, 'auto');
  assert.equal(a.severity, 'warning');
  assert.equal(a.cooldownHours, 20);
  assert.match(a.description, /show-1\/outlet--critic\.json wrongShow: approved true at 2026-11-08T10:00:00Z \(fix fix-1\), now null/);
  assert.ok(!/^P[0-3]/.test(a.title), 'title must not start with a priority prefix');
});

test('decideDriftAlert: the card never carries review text, only path/field/fixId/dates', () => {
  const secret = 'SECRET REVIEW BODY the critic wrote';
  const d = decideDriftAlert([drift(1, { fullText: secret, record: { fullText: secret, excerpt: secret }, stamp: { field: 'wrongShow', newValue: true, at: '2026-11-08', fixId: 'f', note: secret, oldValue: secret } })]);
  const blob = JSON.stringify(d.alert);
  assert.ok(!blob.includes('SECRET'), 'review text leaked into the alert');
});

test('decideDriftAlert: caps rows at 25 and states the overflow; key is stable across counts', () => {
  const many = Array.from({ length: 30 }, (_, i) => drift(i));
  const d = decideDriftAlert(many);
  const rows = d.alert.description.split('\n').filter((l) => l.startsWith('- show-'));
  assert.equal(rows.length, 25);
  assert.match(d.alert.description, /and 5 more/);
  assert.match(d.alert.title, /30 approved exclusion verdicts/);
  assert.equal(d.alert.conditionKey, decideDriftAlert([drift(0)]).alert.conditionKey);
});

test('decideDriftAlert: the filed card is dispatchable (armed verify line)', () => {
  const { buildCardNotes } = require('../../scripts/lib/owner-alert-router.js');
  const { evaluateVerifiability } = require('../../scripts/lib/verify-gate.js');
  const { alert } = decideDriftAlert([drift(1)]);
  const v = evaluateVerifiability(buildCardNotes(alert));
  assert.equal(v.armed, true, JSON.stringify(v));
});

test('decideDriftAlert: non-flag values are clamped, never echoed', () => {
  const long = 'x'.repeat(500);
  const { alert } = decideDriftAlert([drift(1, { current: long, stamp: { newValue: { text: 'BODY' }, at: 'a', fixId: 'f' } })]);
  assert.ok(!alert.description.includes(long) && !alert.description.includes('BODY'));
  assert.match(alert.description, /<string, not shown>/);
});

test('BRO-7179: an empty scan never resolves the alert condition', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afd-empty-'));
  fs.mkdirSync(path.join(dir, 'some-show-2020'));
  fs.writeFileSync(path.join(dir, 'some-show-2020', 'a.json'), JSON.stringify({ url: 'x' }));
  const r = spawnSync('node', [path.join(import.meta.dirname, '../../scripts/audit-approved-fix-drift.js'), `--dir=${dir}`, '--alert'], {
    encoding: 'utf8', env: { ...process.env, LINEAR_API_KEY: '', HOME: dir },
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /scanned 0 files .* leaving the alert condition untouched/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// BRO-7174 class guard: the scheduled writers that clear duplicateOf /
// wrongShow / wrongProduction outside review-guards.js stay wired to the
// approved-fix writer guards (unit-tested in approved-fix-writers.test.mjs).
const WRITERS = {
  'scripts/lib/orphaned-duplicate-pointer-heal.js': /canChangeApprovedField\(/g,
  'scripts/heal-orphaned-duplicate-pointers.js': /canChangeApprovedField\(/g,
  'scripts/fix-circular-duplicate-pairs.js': /canRepairCircularPair\(/g,
  'scripts/verify-existing-reviews.js': /canRecoverReview\(/g,
};
const MIN_CALLS = {
  'scripts/lib/orphaned-duplicate-pointer-heal.js': 3, // clear, retraction restore, chain flatten
  'scripts/heal-orphaned-duplicate-pointers.js': 3, // fix(), revert(), flatten()
  'scripts/fix-circular-duplicate-pairs.js': 2,
  'scripts/verify-existing-reviews.js': 3,
};
for (const [rel, re] of Object.entries(WRITERS)) {
  test(`BRO-7174: ${rel} checks approved fixes before writing`, () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '../..', rel), 'utf8');
    assert.match(src, /require\(['"]\.\/(?:lib\/)?approved-fix-writer-guards['"]\)/);
    assert.ok((src.match(re) || []).length >= MIN_CALLS[rel], `${rel}: expected ${MIN_CALLS[rel]}+ ${re.source} calls`);
  });
}

test('BRO-7174: orphan heal and retraction keep an approved pointer (real decision functions)', () => {
  const heal = require('../../scripts/lib/orphaned-duplicate-pointer-heal.js');
  const text = 'A substantive theatre review. '.repeat(50);
  const loser = { url: 'https://x.com/r', fullText: text, duplicateOf: 't.json' };
  loser.approvedFixes = [stamp(loser, 'duplicateOf', 't.json')];
  assert.equal(heal.shouldClearOrphanedDuplicatePointer(loser, { wrongShow: true }), false);
  const cleared = { url: 'https://x.com/r', fullText: text, duplicateClearReason: heal.buildHealClearReason('2026-11-08', 't.json', 'x') };
  cleared.approvedFixes = [stamp(cleared, 'duplicateOf', null)];
  assert.deepEqual(heal.findUnjustifiedHealClears([{ file: 'a.json', data: cleared }, { file: 't.json', data: { url: 'https://x.com/r', fullText: text } }]), []);
});
