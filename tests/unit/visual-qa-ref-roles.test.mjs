// BRO-5555: an owner's BEFORE screenshot must not fail the change they asked
// for. With the BEFORE override appended after (or even ahead of) the matching
// checklist, gpt-5.4-mini still failed it as a copy mismatch, so a BEFORE-only
// run gets its own prompt (with a sameAsBefore judgment the parser enforces);
// mixed runs lead with the override and rely on the GOAL match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolePromptHeader, REVIEW_CHECKLIST, BEFORE_ONLY_PROMPT, parseVerdictJson } from '../../scripts/lib/visual-qa-prompt.mjs';

test('goal-only and role-less runs get the plain checklist', () => {
  assert.equal(rolePromptHeader(null), REVIEW_CHECKLIST);
  assert.equal(rolePromptHeader([]), REVIEW_CHECKLIST);
  assert.equal(rolePromptHeader(['goal', 'goal']), REVIEW_CHECKLIST);
  assert.match(rolePromptHeader(['goal']), /never report elements outside the crop as missing/);
});

test('runs with only BEFORE references never see the matching checklist', () => {
  for (const roles of [['before'], ['before', 'before']]) {
    const h = rolePromptHeader(roles);
    assert.equal(h, BEFORE_ONLY_PROMPT);
    assert.doesNotMatch(h, /Copy mismatch|HARD FAILURES/);
  }
});

test('the did-not-land judgment covers the whole page, crops and dynamic data', () => {
  for (const h of [BEFORE_ONLY_PROMPT]) {
    assert.match(h, /Name the clearest visible non-dynamic difference/);
    assert.match(h, /crop of one component/);
    assert.match(h, /Ignore dynamic content/);
    assert.match(h, /"difference": "<the difference, or empty>", "sameAsBefore": true \| false/);
  }
  assert.doesNotMatch(BEFORE_ONLY_PROMPT, /first sections/);
});

test('mixed roles lead with the override and scope every comparison check to GOAL', () => {
  const h = rolePromptHeader(['goal', 'before']);
  assert.ok(h.startsWith('READ THIS FIRST'));
  assert.match(h, /HARD FAILURES 1-3 and SOFT SIGNALS 6-8 compare against GOAL/);
  assert.ok(h.indexOf('GOAL references only') < h.indexOf('HARD FAILURES (auto FAIL'));
  assert.ok(h.endsWith(REVIEW_CHECKLIST), 'checklist and its reply format follow unchanged');
  assert.doesNotMatch(h, /sameAsBefore/, 'a GOAL match proves the change landed; no extra judgment');
});

test('BEFORE-only runs: sameAsBefore is required, and true or an unnamed difference forces FAIL', () => {
  const failed = parseVerdictJson('{"sameAsBefore": true, "verdict": "PASS", "issues": []}', { beforeOnly: true });
  assert.equal(failed.verdict, 'FAIL');
  assert.match(failed.issues[0], /did not land/);
  assert.equal(parseVerdictJson('{"sameAsBefore": "true", "verdict": "PASS", "issues": []}', { beforeOnly: true }).verdict, 'FAIL');
  assert.equal(parseVerdictJson('{"difference": "heading reads opens", "sameAsBefore": false, "verdict": "PASS", "issues": []}', { beforeOnly: true }).verdict, 'PASS');
  // "Different" without naming the difference is not believed.
  assert.equal(parseVerdictJson('{"difference": "", "sameAsBefore": false, "verdict": "PASS", "issues": []}', { beforeOnly: true }).verdict, 'FAIL');
  assert.equal(parseVerdictJson('{"sameAsBefore": false, "verdict": "PASS", "issues": []}', { beforeOnly: true }).verdict, 'FAIL');
  assert.throws(() => parseVerdictJson('{"verdict": "PASS", "issues": []}', { beforeOnly: true }), /sameAsBefore/);
  assert.throws(() => parseVerdictJson('{"sameAsBefore": "yes", "verdict": "PASS", "issues": []}', { beforeOnly: true }), /sameAsBefore/);
  // GOAL-only and mixed runs never need the field.
  assert.equal(parseVerdictJson('{"verdict": "PASS", "issues": []}').verdict, 'PASS');
  assert.equal(parseVerdictJson('{"verdict": "PASS", "issues": []}', { beforeOnly: false }).verdict, 'PASS');
});

test('the parser tolerates fences and a sentence around the JSON, and rejects bad verdicts', () => {
  assert.equal(parseVerdictJson('```json\n{"verdict": "FAIL", "issues": ["x"]}\n```').verdict, 'FAIL');
  assert.equal(parseVerdictJson('Step 1 done. {"difference": "x moved", "sameAsBefore": false, "verdict": "PASS", "issues": []} Thanks.', { beforeOnly: true }).verdict, 'PASS');
  assert.throws(() => parseVerdictJson('{"verdict": "MAYBE", "issues": []}'));
  assert.throws(() => parseVerdictJson('no json here'));
});
