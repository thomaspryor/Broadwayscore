// BRO-8209: the feedback planner must be told about every executor action it should use. Feedback #1203
// (wrong review links on Falls for Jodie) got "No automatic fix could be planned" because the prompt
// offered three action types and never review-field-edit, which execute-approved-fix.js already ran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const P = require('./remediation-planner-prompt.js');
const handoff = require('./html-handoff.js');

const diagnosis = { summary: 's', whatsHappening: 'w', findings: ['f'], proposedFix: 'p', fixType: 'data', confidence: 'high' };
const prompt = P.buildPlannerPrompt({
  diagnosis, fixAction: 'skipped', contextParts: ['## Show Data: X'],
  allowedFieldsList: '  shows.json: venue', allowedScripts: ['rebuild-all-reviews.js'],
});

function executorActionTypes() {
  const src = fs.readFileSync(path.join(here, '..', 'execute-approved-fix.js'), 'utf8');
  const body = src.slice(src.indexOf('switch (action.type)'));
  const end = body.indexOf('default:');
  const types = [...body.slice(0, end).matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
  if (/case htmlHandoff\.ACTION_TYPE:/.test(body.slice(0, end))) types.push(handoff.ACTION_TYPE);
  return types;
}

test('every executor action type is advertised to the planner or explicitly not offered', () => {
  const types = executorActionTypes();
  assert.ok(types.length >= 10, `executor switch parsed: ${types.join(',')}`);
  const advertised = new Set(P.advertisedActionTypes());
  for (const t of types) {
    assert.ok(advertised.has(t) || t in P.NOT_OFFERED_TO_PLANNER,
      `executor runs "${t}" but the planner prompt neither offers it nor lists it in NOT_OFFERED_TO_PLANNER`);
  }
});

test('every advertised type is one the executor can run, and none is also listed as not offered', () => {
  const types = new Set(executorActionTypes());
  for (const t of P.advertisedActionTypes()) {
    assert.ok(types.has(t), `planner advertises "${t}" but execute-approved-fix.js has no case for it`);
    assert.ok(!(t in P.NOT_OFFERED_TO_PLANNER), `${t} is both advertised and not offered`);
  }
  for (const [t, why] of Object.entries(P.NOT_OFFERED_TO_PLANNER)) assert.ok(why && why.length > 10, `reason for ${t}`);
});

test('the built prompt names every advertised action type and the review-field-edit schema', () => {
  for (const t of P.advertisedActionTypes()) assert.ok(prompt.includes(t), `prompt mentions ${t}`);
  assert.match(prompt, /review-field-edit — Fix one field on one review record/);
  assert.match(prompt, /field: url|- url: only repairs a url that is provably wrong/);
  assert.match(prompt, /Do NOT answer "review records are not in the allowed editable files"/);
  assert.match(prompt, /outletId itself is NOT an editable field/);
});

test('review records context gives file, url and critic for the show (inferred filenames when no review-texts)', () => {
  const show = { id: 'falls-for-jodie-off-broadway-2026', title: 'Falls for Jodie' };
  const rows = [
    { showId: show.id, outletId: 'talkinbroadway', outlet: 'Talkin\' Broadway', criticName: 'Michael Dale', url: 'https://www.talkinbroadway.com/page/ob/x.html', publishDate: '2026-10-05' },
    { showId: 'other', outletId: 'nytimes', criticName: 'Z', url: 'https://nyt.example/z' },
  ];
  const ctx = P.buildReviewRecordContext(show, rows, { reviewTextsDir: null });
  assert.match(ctx, /falls-for-jodie-off-broadway-2026\/talkinbroadway--michael-dale\.json/);
  assert.match(ctx, /talkinbroadway\.com\/page\/ob\/x\.html/);
  assert.doesNotMatch(ctx, /nyt\.example/);
  assert.equal(P.buildReviewRecordContext(show, [], { reviewTextsDir: null }), '');
});

test('the planner script builds its prompt through the shared builder, not an inline template', () => {
  const src = fs.readFileSync(path.join(here, '..', 'generate-remediation-plan.js'), 'utf8');
  assert.match(src, /buildPlannerPrompt\(/);
  assert.doesNotMatch(src, /You may include these action types/);
});
