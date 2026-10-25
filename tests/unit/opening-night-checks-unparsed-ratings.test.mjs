import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const check = require('../../scripts/lib/opening-night-checks/unparsed-explicit-ratings.check.js');

function makeContext(reviews) {
  return { reviewsDoc: { 'test-2026': reviews }, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };
}

describe('unparsed-explicit-ratings check', () => {
  it('Guardian (correct outletId "guardian") with null originalRating → warning with fix command', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /guardian/);
    assert.match(result.message, /recover-explicit-ratings/);
  });

  it('Guardian with parsed originalRating "4/5 stars" → ok', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: '4/5 stars', url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('outlet not in RATING_SCHEMA_OUTLETS with null originalRating → ok (not our concern)', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'some-blog', originalRating: null, url: 'https://blog.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('multiple outlets missing (correct IDs: guardian, nypost) → multiple warnings', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review' },
      { outletId: 'nypost', originalRating: null, url: 'https://nypost.com/review' },
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /guardian/);
    assert.match(result.message, /nypost/);
    assert.equal(result.details.missing.length, 2);
  });

  it('wrongProduction review skipped even if originalRating is null', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, wrongProduction: true, url: 'https://guardian.com/review' }
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
  });

  it('RATING_SCHEMA_OUTLETS keys match real reviews.json outletId values', () => {
    // Regression guard: ensure outlet IDs haven't drifted back to wrong names
    const outlets = check.RATING_SCHEMA_OUTLETS;
    assert.ok('guardian' in outlets, 'should use "guardian" not "the-guardian"');
    assert.ok('nypost' in outlets, 'should use "nypost" not "ny-post"');
    assert.ok('telegraph' in outlets, 'should use "telegraph" not "the-telegraph"');
    assert.ok('timeout' in outlets, 'should use "timeout" not "time-out"');
    assert.ok('times-uk' in outlets, 'should use "times-uk" not "the-times"');
    assert.ok('standard' in outlets, 'should use "standard" not "evening-standard"');
    // Verify the wrong names are NOT present
    assert.ok(!('the-guardian' in outlets), '"the-guardian" is wrong outletId');
    assert.ok(!('ny-post' in outlets), '"ny-post" is wrong outletId');
  });
});

// BRO-68 — the check used to stop at printing the fix command in `message`;
// nothing ran it. opening-night-remediation.js's collectRemediations() picks
// up any details.remediation self-declared by a failing check (task #389
// contract), so this check closes the loop by emitting one kind:'workflow'
// spec per distinct unparsed outlet, targeting recover-explicit-ratings.yml
// with the exact --show/--outlet the printed message recommends.
describe('unparsed-explicit-ratings check — remediation', () => {
  it('single unparsed outlet → one workflow remediation spec targeting recover-explicit-ratings.yml', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review' },
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    const remediation = result.details.remediation;
    assert.ok(Array.isArray(remediation));
    assert.equal(remediation.length, 1);
    assert.equal(remediation[0].kind, 'workflow');
    assert.equal(remediation[0].key, `explicit-ratings:${show.id}:guardian`);
    assert.equal(remediation[0].workflow, 'recover-explicit-ratings.yml');
    assert.deepEqual(remediation[0].inputs, { show: show.id, outlet: 'guardian', phases: '0,1,2,3' });
  });

  it('two unparsed reviews from the same outlet → one remediation spec, not two', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review-1' },
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review-2' },
    ]);
    const result = check.run(show, context);
    assert.equal(result.details.remediation.length, 1);
  });

  it('two distinct unparsed outlets → two remediation specs, each outlet-scoped', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review' },
      { outletId: 'nypost', originalRating: null, url: 'https://nypost.com/review' },
    ]);
    const result = check.run(show, context);
    const keys = result.details.remediation.map(r => r.key).sort();
    assert.deepEqual(keys, [`explicit-ratings:${show.id}:guardian`, `explicit-ratings:${show.id}:nypost`]);
  });

  it('all remediation inputs are declared workflow_dispatch inputs on recover-explicit-ratings.yml', () => {
    // Regression guard: a typo'd or renamed input here makes GitHub's dispatch
    // API reject the call outright (422), which is silent from the checklist's
    // point of view (dispatchWorkflow only logs a ::warning::).
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: null, url: 'https://guardian.com/review' },
    ]);
    const result = check.run(show, context);
    const yaml = require('yaml');
    const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'recover-explicit-ratings.yml');
    const workflowDoc = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
    const declaredInputs = new Set(Object.keys(workflowDoc.on.workflow_dispatch.inputs || {}));
    for (const spec of result.details.remediation) {
      for (const key of Object.keys(spec.inputs)) {
        assert.ok(declaredInputs.has(key), `recover-explicit-ratings.yml has no workflow_dispatch input named '${key}' (declared: ${[...declaredInputs].join(', ')})`);
      }
    }
  });

  it('ok result (all outlets parsed) → no remediation field', () => {
    const show = { id: 'test-2026' };
    const context = makeContext([
      { outletId: 'guardian', originalRating: '4/5 stars', url: 'https://guardian.com/review' },
    ]);
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.details, undefined);
  });
});
