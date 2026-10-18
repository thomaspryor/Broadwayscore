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
    assert.deepEqual(plans.map((p) => p.name), ['bro-4159', 'bro-4159-b']);
    assert.deepEqual(plans.map((p) => p.plan.plan.actions.length), [MAX_PLAN_ACTIONS, 42 - MAX_PLAN_ACTIONS]);
    for (const { name, plan } of plans) {
      assert.equal(plan.status, 'pending');
      assert.deepEqual(pendingPlanProblems(`${name}.json`, plan), []);
    }
  });

  test('no eligible rows means no plan', () => {
    assert.deepEqual(buildFlagPlans([]), []);
  });
});

// End-to-end on a fixture corpus: the contaminated row sits OUTSIDE any
// backlog list, so only the corpus-wide default can find it.
test('script: corpus-wide default finds contamination and writes a plan; holding dirs ignored', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xshow-sweep-'));
  const rt = path.join(tmp, 'review-texts');
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(rt, rel)), { recursive: true });
    fs.writeFileSync(path.join(rt, rel), JSON.stringify(data));
  };
  // Verified wrong-show copy under Brigadoon (the corroborating wrongFullText).
  write('brigadoon-west-end-2024/guardian--x.json', { wrongFullText: BRIGADOON_TEXT, wrongShow: true });
  // Excerpt-only, scored, unflagged victim.
  write('book-of-mormon-west-end-2024/guardian--arifa-akbar.json', { westEndTheatreExcerpt: BRIGADOON_TEXT, llmScore: { score: 40 } });
  // Superseded archive copy: must not be targeted or indexed.
  write('_superseded-misattributed/old.json', { westEndTheatreExcerpt: BRIGADOON_TEXT, llmScore: { score: 40 } });
  const report = path.join(tmp, 'report.json');
  const plans = path.join(tmp, 'plans');
  execFileSync('node', [SCRIPT, `--review-texts-dir=${rt}`, `--report-path=${report}`, `--plan-out=${plans}`], { stdio: 'pipe' });
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(r.config.target, 'corpus');
  assert.equal(r.summary.backlogEntries, 2);
  assert.equal(r.summary.autoFlagEligible, 1);
  const plan = JSON.parse(fs.readFileSync(path.join(plans, 'bro-4159.json'), 'utf8'));
  assert.deepEqual(plan.plan.actions.map((a) => a.file), ['book-of-mormon-west-end-2024/guardian--arifa-akbar.json']);
  assert.deepEqual(pendingPlanProblems('bro-4159.json', plan), []);
  // Dry run wrote nothing to the corpus.
  assert.equal(JSON.parse(fs.readFileSync(path.join(rt, 'book-of-mormon-west-end-2024/guardian--arifa-akbar.json'), 'utf8')).wrongShow, undefined);

  // --file narrows; an already-flagged target yields no plan.
  fs.rmSync(plans, { recursive: true });
  execFileSync('node', [SCRIPT, `--review-texts-dir=${rt}`, `--report-path=${report}`, `--plan-out=${plans}`, '--file=brigadoon-west-end-2024/guardian--x.json'], { stdio: 'pipe' });
  const r2 = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(r2.config.target, 'files');
  assert.equal(r2.summary.backlogEntries, 1);
  assert.equal(fs.existsSync(path.join(plans, 'bro-4159.json')), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('shouldAutoFlag bar is unchanged by the sweep (fixture sanity)', () => {
  const idx = buildExcerptIndex([{ showId: 'brigadoon-west-end-2024', file: 'g.json', data: { wrongFullText: BRIGADOON_TEXT, wrongShow: true } }]);
  const m = findCrossShowMatches('book-of-mormon-west-end-2024', 'g.json', { westEndTheatreExcerpt: BRIGADOON_TEXT }, idx);
  assert.equal(m.length, 1);
  assert.equal(shouldAutoFlag(m[0]), true);
});
