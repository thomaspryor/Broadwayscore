// BRO-6872: an applied fix plan that cleared an exclusion flag must end with an
// includable row in reviews.json. Tests require() the real module (CLAUDE.md 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clearingActions, judgeClearedAction, canonicalReviewUrl, hasScore, REBUILD_GRACE_MS } = require('../../scripts/lib/applied-fix-plan-rows.js');

const FILE = 'some-show-2026/standard--nick-curtis.json';
const planWith = (actions, over = {}) => ({ planId: 'bro-0000', status: 'applied', plan: { actions }, ...over });
const clear = (field = 'wrongProduction', file = FILE) => ({ type: 'review-field-edit', field, file, newValue: false });
const clean = (over = {}) => ({ url: 'https://www.standard.co.uk/a-review/', contentTier: 'complete', assignedScore: 80, wrongProduction: false, ...over });
const ctx = (over = {}) => ({ findRow: () => null, explain: () => null, rebuiltAt: null, ...over });
const only = (plan) => clearingActions(plan, 'bro-1.json')[0];

test('only applied/partial plans with flag-CLEARING edits are collected', () => {
  assert.equal(clearingActions(planWith([clear()]), 'p.json').length, 1);
  assert.equal(clearingActions(planWith([clear()], { status: 'partial' })).length, 1);
  // pending plan has not run; rejected/validation-failed never wrote the file
  assert.equal(clearingActions(planWith([clear()], { status: 'pending' })).length, 0);
  assert.equal(clearingActions(planWith([clear()], { status: 'rejected' })).length, 0);
  // a plan that SETS the flag wanted the row GONE: its absence is success, never a failure
  assert.equal(clearingActions(planWith([{ ...clear(), newValue: true }])).length, 0);
  // unrelated edits and other action types are not ours
  assert.equal(clearingActions(planWith([{ ...clear('assignedScore'), newValue: false }])).length, 0);
  assert.equal(clearingActions(planWith([{ type: 'run-script', field: 'wrongShow', file: FILE, newValue: false }])).length, 0);
  // newValue null is also a clear
  assert.equal(clearingActions(planWith([{ ...clear('isRoundupArticle'), newValue: null }])).length, 1);
  // a file with no show directory cannot be resolved, so it is not reported
  assert.equal(clearingActions(planWith([clear('wrongShow', 'loose.json')])).length, 0);
  const a = only(planWith([clear()]));
  assert.deepEqual([a.planFile, a.showId, a.field, a.index, a.applied], ['bro-1.json', 'some-show-2026', 'wrongProduction', 0, true]);
});

test("a partial plan's own results mark the actions that did not apply", () => {
  const actions = [clear(), clear('wrongShow')];
  const plan = planWith(actions, { status: 'partial', results: [{ ok: true }, { ok: false, error: "current value doesn't match expected" }] });
  const [first, second] = clearingActions(plan, 'bro-1.json');
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(judgeClearedAction(second, clean(), ctx()).reason, 'action-not-applied');
  assert.equal(judgeClearedAction(second, clean(), ctx()).skipped, true);
  // a results array that does not line up with the actions is not trusted positionally
  assert.equal(clearingActions(planWith(actions, { status: 'partial', results: [{ ok: false }] }))[0].applied, true);
});

test('a plan applied after the last rebuild is not yet answerable', () => {
  const rebuiltAt = Date.parse('2026-10-31T02:29:00Z');
  const after = only(planWith([clear()], { executedAt: '2026-11-02T10:00:00Z' }));
  assert.equal(judgeClearedAction(after, clean(), ctx({ rebuiltAt })).reason, 'applied-after-last-rebuild');
  // inside the grace window before the rebuild it is also left alone
  const grazed = only(planWith([clear()], { executedAt: new Date(rebuiltAt - REBUILD_GRACE_MS / 2).toISOString() }));
  assert.equal(judgeClearedAction(grazed, clean(), ctx({ rebuiltAt })).skipped, true);
  // comfortably before it, the rebuild had its chance
  const before = only(planWith([clear()], { executedAt: '2026-09-01T00:00:00Z' }));
  assert.equal(judgeClearedAction(before, clean(), ctx({ rebuiltAt })).reason, 'includable-but-absent');
});

test('the rebuild\'s own exclusion rules are never second-guessed', () => {
  const a = only(planWith([clear()]));
  for (const rule of ['skippedDuplicateUrl', 'rejectionReason', 'previewsShow', 'skippedSyndicated']) {
    const v = judgeClearedAction(a, clean(), ctx({ explain: () => rule }));
    assert.equal(v.skipped, true, rule);
    assert.equal(v.reason, `excluded:${rule}`);
  }
});

test('a row the rebuild would include but reviews.json lacks is the loud case', () => {
  const a = only(planWith([clear()]));
  const v = judgeClearedAction(a, clean(), ctx());
  assert.equal(v.ok, false);
  assert.equal(v.skipped, false);
  assert.equal(v.reason, 'includable-but-absent');
  assert.equal(v.url, 'standard.co.uk/a-review');
  // present: nothing to report
  assert.equal(judgeClearedAction(a, clean(), ctx({ findRow: () => ({ url: 'x' }) })).reason, 'includable');
});

test('an unscored review is reported apart: it needs scoring, not a rebuild', () => {
  const a = only(planWith([clear()]));
  const v = judgeClearedAction(a, clean({ assignedScore: null }), ctx());
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'no-score');
  assert.equal(hasScore({ originalScore: 3 }), true);
  assert.equal(hasScore({ assignedScore: 0 }), true);
  assert.equal(hasScore({ assignedScore: null, score: '' }), false);
  // the rebuild ranks humanReviewScore first (rebuild-all-reviews.js), so a human-scored file is scored
  assert.equal(hasScore({ humanReviewScore: 64 }), true);
  // an llmScore OBJECT only counts when it holds a real number: { score: null } is not a score
  assert.equal(hasScore({ llmScore: { score: 72 } }), true);
  assert.equal(hasScore({ llmScore: { score: null } }), false);
  assert.equal(hasScore({ llmScore: {} }), false);
  assert.equal(hasScore({ llmScore: 72 }), true);
  assert.equal(hasScore(null), false);
});

test('a rule the caller cannot answer (unknown-*) skips under its own name, not as an exclusion', () => {
  const a = only(planWith([clear()]));
  // the CLI returns this when the run has no rebuild-exclusions list for the show, so the
  // dedup/no-score passes are invisible and "the rebuild would include this" is not established
  const v = judgeClearedAction(a, clean(), ctx({ explain: () => 'unknown-no-rebuild-exclusion-list' }));
  assert.equal(v.skipped, true);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'unknown-no-rebuild-exclusion-list');
});

test('CLI wiring: the real script runs end to end and never passes green on nothing', async () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.resolve(process.cwd(), 'scripts/audit-applied-fix-plans.js');
  let status = 0; let out = '';
  try {
    out = execFileSync(process.execPath, [cli, '--show=__no-such-show__'], { encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    status = e.status; out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  // 2 = a setup error (no review-texts checkout / no core data): never a silent pass.
  if (status === 2) {
    assert.match(out, /audit-applied-fix-plans: (missing|no )/);
    return;
  }
  assert.equal(status, 0, out);
  assert.match(out, /applied fix plans: \d+ read, \d+ flag-clearing action\(s\) checked/);
});

test('skips: the file is gone, or a later pass re-flagged it', () => {
  const a = only(planWith([clear()]));
  assert.equal(judgeClearedAction(a, null, ctx()).reason, 'review-file-gone');
  for (const f of ['wrongProduction', 'wrongShow', 'isRoundupArticle', 'wrongAttribution']) {
    const v = judgeClearedAction(a, clean({ [f]: true }), ctx());
    assert.equal(v.skipped, true, f);
    assert.equal(v.reason, `re-flagged:${f}`);
  }
});

test('url canonicalization ignores scheme, www, query and trailing slash', () => {
  const same = 'standard.co.uk/a-review';
  for (const u of ['https://www.standard.co.uk/a-review/', 'http://standard.co.uk/a-review?utm=1', 'https://WWW.Standard.co.uk/a-review#top']) {
    assert.equal(canonicalReviewUrl(u), same);
  }
  assert.equal(canonicalReviewUrl(null), '');
});
