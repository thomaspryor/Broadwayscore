// BRO-4159: audit-cross-show-excerpt-contamination.js used to check only
// BRO-461's fixed 259-file backlog list, so the Book of Mormon (West End)
// Guardian row carrying Brigadoon's WestEndTheatre.com excerpt was never
// looked at. These tests pin the corpus-wide default, the narrowing flags,
// the holding-dir exclusion, and the pending-fix plan output (which must pass
// the same shape checks the land hook runs on data/pending-fixes).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectAuditTargets,
  buildWrongShowFlagAction,
  buildFlagPlans,
  isAuditableShowDir,
  buildExcerptIndex,
  findCrossShowMatches,
  shouldAutoFlag,
  isQuarantinedTargetMatch,
  targetOwnsMatchedText,
  planName,
  PLAN_ID_RE,
} = require('../../scripts/lib/excerpt-contamination-audit.js');
const { MAX_PLAN_ACTIONS } = require('../../scripts/lib/pending-fix-limits.js');
const { pendingPlanProblems } = require('../../scripts/lib/pending-fix-plan-checks.js');
const { REVIEW_TEXT_EDITABLE_FIELDS } = require('../../scripts/lib/review-field-edit.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SCRIPT = path.join(ROOT, 'scripts/audit-cross-show-excerpt-contamination.js');

const BRIGADOON_TEXT = 'A lush, swooning revival that finds new melancholy in the Lerner and Loewe score, with the mist-wrapped village conjured by gorgeous lighting and a cast in superb voice throughout the evening.';

const records = [
  { showId: 'b-show', file: 'x.json', data: {} },
  { showId: 'a-show', file: 'y.json', data: {} },
];

describe('selectAuditTargets', () => {
  test('defaults to the whole corpus, sorted', () => {
    assert.deepEqual(selectAuditTargets(records), { mode: 'corpus', targets: ['a-show/y.json', 'b-show/x.json'] });
  });
  test('--list narrows to the backlog lines', () => {
    assert.deepEqual(selectAuditTargets(records, { list: ['b-show/x.json'] }), { mode: 'list', targets: ['b-show/x.json'] });
  });
  test('--file wins over --list', () => {
    assert.equal(selectAuditTargets(records, { files: ['a-show/y.json'], list: ['b-show/x.json'] }).mode, 'files');
  });
});

test('isAuditableShowDir skips underscore holding dirs', () => {
  assert.equal(isAuditableShowDir('book-of-mormon-west-end-2024'), true);
  assert.equal(isAuditableShowDir('_pending'), false);
  assert.equal(isAuditableShowDir('_superseded-misattributed'), false);
  assert.equal(isAuditableShowDir(''), false);
});

const eligibleMatch = {
  targetField: 'westEndTheatreExcerpt', matchedShowId: 'brigadoon-west-end-2024', matchedFile: 'guardian--x.json',
  matchedField: 'wrongFullText', matchedWrongShow: true, matchedWrongProduction: false, matchLength: 190,
  sameBase: false, confidence: 'high', isGarbageNotReview: false,
};

describe('flag plans', () => {
  test('action is an allowlisted compare-and-set wrongShow edit', () => {
    const a = buildWrongShowFlagAction('book-of-mormon-west-end-2024/guardian--arifa-akbar.json', eligibleMatch);
    assert.equal(a.type, 'review-field-edit');
    assert.equal(a.field, 'wrongShow');
    assert.equal(a.oldValue, null);
    assert.equal(a.newValue, true);
    assert.ok(REVIEW_TEXT_EDITABLE_FIELDS.includes(a.field));
    assert.match(a.description, /brigadoon-west-end-2024\/guardian--x\.json/);
  });

  test('chunks to the executor cap and every plan passes the pending-plan checks', () => {
    const rows = Array.from({ length: 42 }, (_, i) => ({ rel: `show-${String(i).padStart(2, '0')}/f.json`, match: eligibleMatch }));
    const plans = buildFlagPlans(rows, { makeId: (n) => `id-${n}`, createdAt: '2026-10-18T00:00:00.000Z' });
    assert.deepEqual(plans.map((p) => p.name), ['bro-4159', 'bro-4159-p2']);
    assert.deepEqual(plans.map((p) => p.plan.plan.actions.length), [MAX_PLAN_ACTIONS, 42 - MAX_PLAN_ACTIONS]);
    for (const { name, plan } of plans) {
      assert.equal(plan.status, 'pending');
      assert.deepEqual(pendingPlanProblems(`${name}.json`, plan), []);
    }
  });

  test('plan names stay valid past 26 parts', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ rel: `s-${String(i).padStart(2, '0')}/f.json`, match: eligibleMatch }));
    const plans = buildFlagPlans(rows, { maxActions: 1, makeId: (n) => n });
    assert.equal(plans.length, 30);
    assert.equal(new Set(plans.map((p) => p.name)).size, 30);
    for (const { name } of plans) assert.match(name, PLAN_ID_RE);
    assert.equal(plans[0].name, 'bro-4159');
    assert.equal(plans[29].name, 'bro-4159-p30');
    assert.equal(planName('bro-1', 26), 'bro-1-p27');
    assert.throws(() => planName('../x', 0));
  });

  test('oldValue carries an explicit false (compare-and-set)', () => {
    assert.equal(buildWrongShowFlagAction('a/b.json', eligibleMatch, false).oldValue, false);
    assert.equal(buildWrongShowFlagAction('a/b.json', eligibleMatch).oldValue, null);
    const [p] = buildFlagPlans([{ rel: 'a/b.json', match: eligibleMatch, oldValue: false }]);
    assert.equal(p.plan.plan.actions[0].oldValue, false);
  });

  test('no eligible rows means no plan', () => {
    assert.deepEqual(buildFlagPlans([]), []);
  });
});

// End-to-end on a fixture corpus. The contaminated row sits OUTSIDE any
// backlog list, so only the corpus-wide default can find it.
//  positive: HP's file quarantined a review of ANOTHER show (reason names
//            Brigadoon); Book of Mormon's excerpt is that same text -> flag.
//  negative: HP's file quarantined Shadowlands' own review (reason names
//            Shadowlands); Shadowlands' excerpt is that text -> genuine, skip.
//  negative: no reason, but the text itself names the target's title -> skip.
//  unscored targets and holding dirs are never queued.
const SHADOWLANDS_TEXT = 'Crompton also finds that the script skates along the surface of multiple moral dilemmas: the production could do more to illuminate the internal struggle of the man who wrote a seven book Christian allegory.';
// BRO-5622: parked-domain junk two records both quarantined in wrongFullText.
const PARKED_TEXT = 'The domain name theaternewsonline.com is for sale! Premium verified domain, get a price in less than 24 hours. First name, last name, email, phone, country.';
const NAMED_TEXT = 'Come From Away remains a big-hearted, foot-stomping account of the Gander airlift, staged with brisk economy and an ensemble that switches roles with real precision across the evening.';

function fixtureCorpus() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xshow-sweep-'));
  const rt = path.join(tmp, 'review-texts');
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(rt, rel)), { recursive: true });
    fs.writeFileSync(path.join(rt, rel), JSON.stringify(data));
  };
  write('hp-west-end-2021/stage--a.json', { wrongFullText: BRIGADOON_TEXT, wrongShow: true, wrongShowReason: 'Text is a review of Brigadoon, not this show.' });
  write('book-of-mormon-west-end-2024/guardian--arifa-akbar.json', { westEndTheatreExcerpt: BRIGADOON_TEXT, llmScore: { score: 40 }, wrongShow: false });
  write('hp-west-end-2021/stage--b.json', { wrongFullText: SHADOWLANDS_TEXT, wrongProduction: true, wrongProductionReason: 'Content is a review of Shadowlands.' });
  write('shadowlands-west-end-2024/stage--a.json', { theStageExcerpt: SHADOWLANDS_TEXT, llmScore: { score: 70 } });
  write('hp-west-end-2021/stage--c.json', { wrongFullText: NAMED_TEXT, wrongShow: true });
  write('come-from-away-west-end-2019/x--y.json', { bwwExcerpt: NAMED_TEXT, llmScore: { score: 80 } });
  // BRO-5622: a scored, unflagged excerpt review whose own quarantined
  // wrongFullText is the same junk another (flagged) record quarantined.
  write('torch-song-2018/tno--a.json', { bwwExcerpt: 'A tender, funny revival that earns every one of its tears, with a lead performance of real wit and warmth in a beautifully paced staging.', wrongFullText: PARKED_TEXT, llmScore: { score: 64 } });
  write('all-my-sons-2008/tno--b.json', { wrongFullText: PARKED_TEXT, wrongProduction: true, wrongProductionReason: 'Production mismatch.' });
  write('other-show-2020/unscored.json', { bwwExcerpt: BRIGADOON_TEXT });
  write('_superseded-misattributed/old.json', { westEndTheatreExcerpt: BRIGADOON_TEXT, llmScore: { score: 40 } });
  return { tmp, rt };
}
const run = (args) => execFileSync('node', [SCRIPT, ...args], { stdio: 'pipe', cwd: os.tmpdir() });

test('script: corpus-wide default flags only true contamination of scored files', () => {
  const { tmp, rt } = fixtureCorpus();
  const report = path.join(tmp, 'report.json');
  const plans = path.join(tmp, 'plans');
  run([`--review-texts-dir=${rt}`, `--report-path=${report}`, `--plan-out=${plans}`, '--shows-path=/nonexistent']);
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(r.config.target, 'corpus');
  assert.equal(r.summary.backlogEntries, 9, 'underscore dir excluded');
  const byRel = Object.fromEntries(r.files.map((f) => [f.rel, f.action]));
  assert.equal(byRel['book-of-mormon-west-end-2024/guardian--arifa-akbar.json'], 'auto-flag-eligible');
  assert.equal(byRel['shadowlands-west-end-2024/stage--a.json'], 'needs-manual-review-target-owns-text');
  assert.equal(byRel['come-from-away-west-end-2019/x--y.json'], 'needs-manual-review-target-owns-text');
  assert.equal(r.summary.targetOwnsTextSkipped, 2);
  assert.equal(byRel['torch-song-2018/tno--a.json'], 'quarantined-target-text-only', 'junk-vs-junk wrongFullText leaves the manual queue');
  // the three HP quarantine records and all-my-sons' match only through their own wrongFullText too
  assert.equal(r.summary.quarantinedTargetTextOnly, 5);
  assert.equal(byRel['hp-west-end-2021/stage--a.json'], 'quarantined-target-text-only');
  const plan = JSON.parse(fs.readFileSync(path.join(plans, 'bro-4159.json'), 'utf8'));
  assert.deepEqual(plan.plan.actions.map((a) => a.file), ['book-of-mormon-west-end-2024/guardian--arifa-akbar.json'], 'unscored other-show-2020 not queued');
  assert.equal(plan.plan.actions[0].oldValue, false, 'compare-and-set uses the stored false');
  assert.deepEqual(pendingPlanProblems('bro-4159.json', plan), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rt, 'book-of-mormon-west-end-2024/guardian--arifa-akbar.json'), 'utf8')).wrongShow, false, 'dry run writes nothing');

  // A rerun must not replace an existing (pending or applied) plan.
  assert.throws(() => run([`--review-texts-dir=${rt}`, `--report-path=${report}`, `--plan-out=${plans}`]), /Refusing to overwrite/);
  // --issue picks a fresh id.
  run([`--review-texts-dir=${rt}`, `--report-path=${report}`, `--plan-out=${plans}`, '--issue=bro-9999']);
  assert.ok(fs.existsSync(path.join(plans, 'bro-9999.json')));
  assert.throws(() => run([`--review-texts-dir=${rt}`, `--report-path=${report}`, `--plan-out=${plans}`, '--issue=../evil']), /invalid plan issue id/);

  // --file narrows.
  run([`--review-texts-dir=${rt}`, `--report-path=${report}`, '--file=shadowlands-west-end-2024/stage--a.json']);
  const r2 = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(r2.config.target, 'files');
  assert.equal(r2.summary.backlogEntries, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('targetOwnsMatchedText', () => {
  const base = { matchedVerdictText: '', excerpt: '' };
  test('verdict naming the target id or title', () => {
    assert.equal(targetOwnsMatchedText({ ...base, matchedVerdictText: 'see shadowlands-west-end-2024' }, 'shadowlands-west-end-2024'), true);
    assert.equal(targetOwnsMatchedText({ ...base, matchedVerdictText: 'Content is a review of Shadowlands.' }, 'shadowlands-west-end-2024'), true);
  });
  test('text naming a shows.json title', () => {
    assert.equal(targetOwnsMatchedText(base, 'hpcc-2021', ['Harry Potter and the Cursed Child'], 'the harry potter and the cursed child cast...'), true);
  });
  test('unrelated verdict and text', () => {
    assert.equal(targetOwnsMatchedText({ ...base, matchedVerdictText: 'review of Brigadoon' }, 'book-of-mormon-west-end-2024', [], BRIGADOON_TEXT), false);
  });
});

test('shouldAutoFlag: positive cross-show case passes, target-owned text does not', () => {
  const idx = buildExcerptIndex([{ showId: 'hp-west-end-2021', file: 'g.json', data: { wrongFullText: BRIGADOON_TEXT, wrongShow: true, wrongShowReason: 'review of Brigadoon' } }]);
  const m = findCrossShowMatches('book-of-mormon-west-end-2024', 'g.json', { westEndTheatreExcerpt: BRIGADOON_TEXT }, idx);
  assert.equal(m.length, 1);
  assert.equal(shouldAutoFlag(m[0]), true);
  const own = findCrossShowMatches('brigadoon-west-end-2024', 'g.json', { westEndTheatreExcerpt: BRIGADOON_TEXT }, idx);
  assert.equal(own[0].targetOwnsText, true);
  assert.equal(shouldAutoFlag(own[0]), false);
});

test('BRO-5622: a match through the target\'s own wrongFullText never auto-flags', () => {
  const idx = buildExcerptIndex([{ showId: 'all-my-sons-2008', file: 'b.json', data: { wrongFullText: PARKED_TEXT, wrongProduction: true, wrongProductionReason: 'Production mismatch.' } }]);
  const m = findCrossShowMatches('torch-song-2018', 'a.json', { wrongFullText: PARKED_TEXT }, idx);
  assert.equal(m.length, 1);
  assert.equal(m[0].targetField, 'wrongFullText');
  assert.equal(isQuarantinedTargetMatch(m[0]), true);
  assert.equal(shouldAutoFlag(m[0]), false, 'otherwise corroborated: only the quarantined target field blocks it');
  assert.equal(shouldAutoFlag({ ...m[0], targetField: 'bwwExcerpt' }), true, 'same match through a scored excerpt still flags');
  assert.equal(isQuarantinedTargetMatch(null), false);
});
