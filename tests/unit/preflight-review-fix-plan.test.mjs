/**
 * BRO-4849: preflight-review-fix-plan replays a plan on a throwaway copy through the real executor and write guard.
 * Run: node --test tests/unit/preflight-review-fix-plan.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preflight } = require('../../scripts/lib/preflight-review-fix-plan.js');

function fixture(files, actions, status = 'pending') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
  const rt = path.join(root, 'review-texts', 'fixture-show-2026');
  fs.mkdirSync(rt, { recursive: true });
  for (const [f, d] of Object.entries(files)) fs.writeFileSync(path.join(rt, f), JSON.stringify(d, null, 2));
  const plan = path.join(root, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ issueNumber: 'bro-test', status, plan: { actions } }));
  return { root, reviewTextsDir: path.join(root, 'review-texts'), plan, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const edit = (file, field, oldValue, newValue) => ({ type: 'review-field-edit', file: `fixture-show-2026/${file}`, field, oldValue, newValue });
const url = 'https://chicago.suntimes.com/theater/2026/06/30/fixture-review';

test('a clean plan passes, later actions see earlier writes, and the source files are never written', () => {
  const c = fixture({ 'a.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'A', url: 'https://ew.com/a', originalScore: 'B' } }, [
    edit('a.json', 'originalScore', 'B', 'B+'),
    edit('a.json', 'humanReviewScore', null, 80),
  ]);
  const before = fs.readFileSync(path.join(c.reviewTextsDir, 'fixture-show-2026', 'a.json'), 'utf8');
  try {
    const logs = [];
    assert.equal(preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) }).failed, 0, logs.join('\n'));
    assert.equal(fs.readFileSync(path.join(c.reviewTextsDir, 'fixture-show-2026', 'a.json'), 'utf8'), before);
  } finally { c.cleanup(); }
});

test('a stale oldValue and a write-guard side effect both fail (the iceboy url-collision case)', () => {
  const c = fixture({
    'first.json': { showId: 'fixture-show-2026', outletId: 'chicago-sun-times', criticName: 'First', url, fullText: 'x'.repeat(400) },
    'second.json': { showId: 'fixture-show-2026', outletId: 'chicago-sun-times', criticName: 'Second', url, fullText: 'x'.repeat(400) },
    'stale.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'S', url: 'https://ew.com/s', humanReviewScore: 50 },
  }, [
    edit('second.json', 'humanReviewScore', null, 71),
    edit('stale.json', 'humanReviewScore', 40, 60),
  ]);
  try {
    const logs = [];
    const { failed } = preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) });
    assert.equal(failed, 2, logs.join('\n'));
    assert.ok(logs.some((l) => /second\.json humanReviewScore.*duplicateOf/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /stale\.json.*doesn't match expected/.test(l)), logs.join('\n'));
  } finally { c.cleanup(); }
});

// BRO-3414: a 277-action plan passed preflight and was refused at land by the
// MAX_PLAN_ACTIONS cap; preflight now fails it up front.
test('a plan over the action cap fails preflight', () => {
  const { MAX_PLAN_ACTIONS } = require('../../scripts/lib/pending-fix-limits.js');
  const actions = Array.from({ length: MAX_PLAN_ACTIONS + 1 }, (_, i) => edit('a.json', 'humanReviewScore', i === 0 ? null : 50 + i - 1, 50 + i));
  const c = fixture({ 'a.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'A', url: 'https://ew.com/a' } }, actions);
  try {
    const logs = [];
    assert.equal(preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) }).failed, 1, logs.join('\n'));
    assert.ok(logs.some((l) => l.includes(`max ${MAX_PLAN_ACTIONS}`)), logs.join('\n'));
  } finally { c.cleanup(); }
});

test('a status the executor will not run fails here, not after the land (BRO-5015, BRO-5254 plan G)', () => {
  for (const status of ['approved', null]) {
    const c = fixture({ 'a.json': { showId: 'fixture-show-2026', outletId: 'ew', criticName: 'A', url: 'https://ew.com/a', originalScore: 'B' } }, [
      edit('a.json', 'originalScore', 'B', 'B+'),
    ], status);
    try {
      const logs = [];
      assert.equal(preflight([c.plan], { reviewTextsDir: c.reviewTextsDir, log: (m) => logs.push(m) }).failed, 1, logs.join('\n'));
      assert.match(logs.join('\n'), /must be "pending"/);
    } finally { c.cleanup(); }
  }
});

// BRO-5528: commercial.json plans (add-commercial-entry, data-edit) were only checked after a ~45 min land, when
// execute-approved-fix.js applies them, runs the commercial record rules and rolls the whole plan back.
function commercialFixture(plans) {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-com-core-'));
  fs.writeFileSync(path.join(core, 'shows.json'), JSON.stringify({ shows: [
    { id: 'alpha-2026', slug: 'alpha', title: 'Alpha', category: 'broadway', status: 'open', venue: 'V' },
    { id: 'beta-2026', slug: 'beta', title: 'Beta', category: 'broadway', status: 'open', venue: 'V' },
  ] }));
  fs.writeFileSync(path.join(core, 'commercial.json'), JSON.stringify({ _meta: {}, shows: {
    alpha: { designation: 'TBD', notes: 'Original note', lastUpdated: '2026-01-01T00:00:00.000Z' },
  } }));
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-com-rt-'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-com-plan-'));
  const paths = plans.map(([name, actions]) => {
    const p = path.join(dir, `${name}.json`);
    fs.writeFileSync(p, JSON.stringify({ issueNumber: name, status: 'pending', plan: { actions } }));
    return p;
  });
  const lines = [];
  const run = () => preflight(paths, { reviewTextsDir: rt, coreDataDir: core, log: (l) => lines.push(l) });
  return { run, lines, core };
}
const comEdit = (field, oldValue, newValue, slug = 'alpha') => ({ type: 'data-edit', file: 'commercial.json', showSlug: slug, showId: slug, field, oldValue, newValue });
const addBeta = (slug = 'beta') => ({ type: 'add-commercial-entry', slug, entry: { designation: 'TBD', sources: [{ url: 'https://example.com/a', type: 'manual', date: null }] } });

test('a clean commercial plan passes, with add-commercial-entry replayed and a later edit chaining onto it', () => {
  const { run, lines, core } = commercialFixture([['c1', [comEdit('notes', 'Original note', 'Better note'), addBeta(), comEdit('notes', null, 'Beta note', 'beta')]]]);
  const { failed } = run();
  assert.equal(failed, 0, lines.join('\n'));
  assert.ok(!lines.some((l) => /skip add-commercial-entry/.test(l)));
  assert.ok(lines.some((l) => /c1: 3\/3 applied cleanly/.test(l)), lines.join('\n'));
  // In memory only.
  assert.equal(JSON.parse(fs.readFileSync(path.join(core, 'commercial.json'), 'utf8')).shows.beta, undefined);
});

test('a commercial.json data-edit with a stale oldValue FAILs and names the action', () => {
  const { run, lines } = commercialFixture([['c2', [comEdit('notes', 'Stale note', 'New')]]]);
  assert.equal(run().failed, 1, lines.join('\n'));
  assert.ok(lines.some((l) => /FAIL c2 commercial.json alpha.notes: .*changed since plan/.test(l)));
});

test('a duplicate add-commercial-entry FAILs; an unknown slug FAILs', () => {
  const { run, lines } = commercialFixture([['c3', [addBeta('alpha'), addBeta('nope')]]]);
  assert.equal(run().failed, 2, lines.join('\n'));
  assert.ok(lines.some((l) => /FAIL c3 add-commercial-entry alpha: .*already has a commercial entry/.test(l)));
  assert.ok(lines.some((l) => /FAIL c3 add-commercial-entry nope: .*not a shows.json slug/.test(l)));
});

test('an edit the commercial record rules would roll back FAILs before the land', () => {
  const { run, lines } = commercialFixture([['c4', [comEdit('notes', 'Original note', 'Per the GPT summary, it recouped.')]]]);
  const { failed } = run();
  assert.ok(failed >= 1, lines.join('\n'));
  assert.ok(lines.some((l) => /FAIL c4 commercial rules: .*alpha/.test(l)), lines.join('\n'));
});

test('prior records are per plan: a later plan repeating an earlier plan\'s text is not flagged as introducing it', () => {
  const doubled = 'He said ""hello"" twice';
  const { run, lines } = commercialFixture([
    ['c5a', [comEdit('notes', 'Original note', doubled)]],
    ['c5b', [comEdit('notes', doubled, doubled)]],
  ]);
  run();
  assert.ok(lines.some((l) => /FAIL c5a commercial rules: .*doubled quotation/.test(l)), lines.join('\n'));
  assert.equal(lines.some((l) => /FAIL c5b commercial rules/.test(l)), false, lines.join('\n'));
});

test('touchedRecordProblems checks only the named records and uses priorShows', () => {
  const { touchedRecordProblems } = require('../../scripts/lib/commercial-record-checks.js');
  const shows = [{ id: 'a-1', slug: 'a', category: 'broadway', status: 'open' }];
  const data = { shows: { a: { designation: 'TBD', notes: 'Per the GPT summary' }, b: { designation: 'TBD', notes: 'Per the GPT summary' } } };
  assert.equal(touchedRecordProblems(data, shows, ['a'], null).length > 0, true);
  assert.deepEqual(touchedRecordProblems(data, shows, ['zzz'], null), []);
  assert.deepEqual(touchedRecordProblems(data, shows, [], null), []);
});

test('a commercial plan with no shows.json in the core dir FAILs the add cleanly instead of crashing', () => {
  const { run, lines, core } = commercialFixture([['c6', [addBeta()]]]);
  fs.rmSync(path.join(core, 'shows.json'));
  const { failed } = run();
  assert.equal(failed, 1, lines.join('\n'));
  assert.ok(lines.some((l) => /FAIL c6 add-commercial-entry beta: .*shows.json not found/.test(l)));
});
