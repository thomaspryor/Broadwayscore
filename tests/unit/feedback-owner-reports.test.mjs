// What the owner actually READS when the feedback pipeline reports to them.
//
// Every assertion here comes from the owner's reaction to the first real
// notifications (2026-08-05), each of which passed every existing test:
//   1. "This link to 'see the page' 404s."   → the route was /shows/, not /show/
//   2. "It should say what review (outlet, critic, show, date)."
//   3. "The failed one has nothing actionable for me... it needs something for
//      me to click to get an agent/session working on it."
//   4. "I have no idea what this email is telling me. It's all technical mumbo
//      jumbo."  (a workflow filename and a JSON blob)
//
// The builders were pure and untested; the 404 shipped because nothing asserted
// the URL a human would click. These tests are that assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const {
  buildLiveAlert,
  buildStuckAlert,
  describeRun,
  pickRunForRequest,
  showUrl,
  entryNamesReviews,
} = require('../../scripts/verify-feedback-requests-live.js');
const { buildAlert, describeOutcome } = require('../../scripts/notify-feedback-outcomes.js');

const SHOWS = [{ id: 'lincoln-2025', slug: '3-summers-of-lincoln-regional-2025', title: '3 Summers of Lincoln' }];

const LIVE_ENTRY = {
  entry: {
    key: 'missing-reviews:lincoln-2025:sub-1',
    kind: 'missing-reviews',
    title: '3 Summers of Lincoln',
    requestedMessage: 'Please finish the reviews for 3 Summers of Lincoln.',
    requestedAt: new Date().toISOString(),
    issueNumber: 543,
    systematicFix: { note: 'Handled by the missing-reviews route.' },
  },
  showId: 'lincoln-2025',
  evidence: '0 → 1 review(s) live',
  reviews: [{ text: 'Pam Kragen · San Diego Union-Tribune · 2025-03-03 · score 79', url: 'https://example.com/review' }],
  url: 'https://broadwayscorecard.com/show/3-summers-of-lincoln-regional-2025',
};

const STUCK_ENTRY = {
  key: 'missing-show:the outsiders:sub-2',
  kind: 'missing-show',
  title: 'The Outsiders',
  market: 'regional',
  workflow: 'add-requested-show.yml',
  issueNumber: 542,
  requestedMessage: 'Please add The Outsiders out of town at The Weiss at La Jolla',
  requestedAt: '2026-07-27T00:00:00Z',
};

// --- 1. the 404 -------------------------------------------------------------

test('the show link points at the route that exists — /show/, singular', () => {
  const url = showUrl({}, 'lincoln-2025', SHOWS);
  assert.equal(url, 'https://broadwayscorecard.com/show/3-summers-of-lincoln-regional-2025');
  assert.doesNotMatch(url, /\/shows\//, 'the /shows/ form 404s on production');
});

test('the app really does route /show/[slug] and not /shows/[slug]', () => {
  // Structural, not stylistic: if the route is ever renamed, this test — not
  // the owner's inbox — is what finds out.
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'src/app/show/[slug]')),
    'src/app/show/[slug] must exist for the link above to resolve'
  );
  assert.ok(
    !fs.existsSync(path.join(REPO_ROOT, 'src/app/shows/[slug]')),
    'no /shows/[slug] route exists — a link using it 404s'
  );
});

test('a show with no slug falls back to its id rather than dropping the link', () => {
  assert.equal(showUrl({}, 'orphan-id', []), 'https://broadwayscorecard.com/show/orphan-id');
});

// --- 2. name the review -----------------------------------------------------

test('the "now live" report names the review, not just a count', () => {
  const alert = buildLiveAlert([LIVE_ENTRY]);
  assert.match(alert.description, /Pam Kragen/);
  assert.match(alert.description, /San Diego Union-Tribune/);
  assert.match(alert.description, /2025-03-03/);
  assert.match(alert.description, /3 Summers of Lincoln/);
  assert.match(alert.description, /show\/3-summers-of-lincoln-regional-2025/);
  assert.doesNotMatch(alert.description, /\/shows\//);
});

test('good news never burns an agent session on itself', () => {
  const alert = buildLiveAlert([LIVE_ENTRY]);
  assert.equal(alert.severity, 'info');
  assert.equal(alert.decision, true, 'digest-autofix auto-dispatches every row that is not flagged a decision');
});

test('with no reviews to name, the report says so instead of implying it listed them', () => {
  const alert = buildLiveAlert([{ ...LIVE_ENTRY, reviews: [] }]);
  assert.match(alert.description, /no individual reviews to name/);
});

// --- content-fix kinds (task #1440): "Manual Fix Needed" content-error asks
// get the same live/stuck treatment as missing-show/missing-reviews. Most
// content-fix types (wrong-critic-name, outlet-rename, new-show-record)
// legitimately never have reviews to name — the old denylist here was
// `kind !== 'missing-image'`, which would have wrongly printed the caveat
// below for every one of them.

test('entryNamesReviews: only missing-reviews and content-fix/single-review can ever name a review', () => {
  assert.equal(entryNamesReviews({ kind: 'missing-reviews' }), true);
  assert.equal(entryNamesReviews({ kind: 'content-fix', contentErrorType: 'single-review' }), true);
  assert.equal(entryNamesReviews({ kind: 'missing-show' }), false);
  assert.equal(entryNamesReviews({ kind: 'missing-image' }), false);
  assert.equal(entryNamesReviews({ kind: 'content-fix', contentErrorType: 'wrong-critic-name' }), false);
  assert.equal(entryNamesReviews({ kind: 'content-fix', contentErrorType: 'outlet-rename' }), false);
  assert.equal(entryNamesReviews({ kind: 'content-fix', contentErrorType: 'new-show-record' }), false);
});

test('a fixed wrong-critic-name report never prints the "no readable review rows" caveat', () => {
  const alert = buildLiveAlert([{
    entry: { title: 'Some Show', kind: 'content-fix', contentErrorType: 'wrong-critic-name', requestedMessage: 'fix the byline' },
    showId: 'x',
    evidence: 'BroadwayWorld review now credited to Pam Kragen',
    reviews: [],
    url: 'https://broadwayscorecard.com/show/some-show',
  }]);
  assert.doesNotMatch(alert.description, /no readable review rows/);
  assert.match(alert.description, /now credited to Pam Kragen/);
});

test('a fixed single-review content-fix with no readable rows still gets the caveat', () => {
  const alert = buildLiveAlert([{
    entry: { title: 'Some Show', kind: 'content-fix', contentErrorType: 'single-review', requestedMessage: 'add the missing review' },
    showId: 'x',
    evidence: 'Outlet review is now live',
    reviews: [],
    url: 'https://broadwayscorecard.com/show/some-show',
  }]);
  assert.match(alert.description, /no readable review rows/);
});

// --- 3. give the stuck one something to click -------------------------------

test('a stuck request stays auto-dispatchable — the click is the digest\'s, not ours', () => {
  const alert = buildStuckAlert([STUCK_ENTRY], new Map());
  assert.equal(alert.severity, 'error');
  assert.ok(!alert.decision,
    'digest-autofix.js dispatches every queued row that is NOT flagged a decision; flagging this would park it');
});

const FETCHED = (runs) => new Map([['add-requested-show.yml', { ok: true, runs }]]);

test('the stuck report states what the workflow actually did, not a guess', () => {
  const alert = buildStuckAlert([STUCK_ENTRY], FETCHED([{
    status: 'completed', conclusion: 'failure', startedAt: '2026-08-01T10:00:00Z',
    url: 'https://github.com/thomaspryor/Broadwayscore/actions/runs/1',
  }]));
  assert.match(alert.description, /ended as failure/);
  assert.match(alert.description, /actions\/runs\/1/);
  assert.doesNotMatch(alert.description, /likely failed/, 'a guess is what the owner called useless');
  assert.equal(alert.url, 'https://github.com/thomaspryor/Broadwayscore/actions/runs/1',
    'the digest renders alert.url as the row\'s clickable "view" — point it at the reason');
});

// The bug this guards is REAL and was reproduced against the live API on
// 2026-08-05: add-requested-show.yml is shared by every missing-show request,
// and its two most recent runs were green — for OTHER shows — while The
// Outsiders' own run had failed hours earlier. Attributing the newest run to
// this request would have told the owner "it SUCCEEDED, re-running will not
// help" about a run that never touched their request.
test('a run that predates the request is never attributed to it', () => {
  const picked = pickRunForRequest(
    { ok: true, runs: [{ status: 'completed', conclusion: 'success', startedAt: '2026-07-01T00:00:00Z', url: 'u' }] },
    '2026-07-27T00:00:00Z'
  );
  assert.equal(picked.state, 'never-ran',
    'the only run started before the request — it cannot have served it');
  assert.match(describeRun(picked), /not run at all since the request/);
});

test('among runs since the request, the newest is used and the count is stated', () => {
  const picked = pickRunForRequest({ ok: true, runs: [
    { status: 'completed', conclusion: 'success', startedAt: '2026-08-06T02:48:29Z', url: 'newest' },
    { status: 'completed', conclusion: 'failure', startedAt: '2026-08-05T17:21:04Z', url: 'older' },
    { status: 'completed', conclusion: 'failure', startedAt: '2026-07-01T00:00:00Z', url: 'pre-request' },
  ] }, '2026-07-27T00:00:00Z');
  assert.equal(picked.run.url, 'newest');
  assert.equal(picked.count, 2, 'the pre-request run is excluded from the count');
  const text = describeRun(picked);
  assert.match(text, /most recent run since then/, 'never claim it was THIS request\'s run');
  assert.doesNotMatch(text, /Its last run/, 'the shared workflow makes "its last run" a false attribution');
  assert.match(text, /the most recent of 2 runs since the request/);
});

test('an unreachable GitHub is reported as unchecked, not as "nothing happened"', () => {
  const picked = pickRunForRequest({ ok: false }, '2026-07-27T00:00:00Z');
  assert.equal(picked.state, 'unknown');
  assert.match(describeRun(picked), /could not establish what its workflow did/);
  assert.doesNotMatch(describeRun(picked), /never/, 'do not imply the job was not started');
});

test('a genuinely never-run workflow is distinguished from an API failure', () => {
  assert.equal(pickRunForRequest({ ok: true, runs: [] }, '2026-07-27T00:00:00Z').state, 'never-ran');
});

// Round-2 review finding: an unparseable requestedAt used to fall back to
// "consider every run", which silently restores the exact misattribution this
// function exists to prevent. A bad timestamp must produce "unknown".
test('an unparseable request date yields unknown, never a guess from all runs', () => {
  const runs = [{ status: 'completed', conclusion: 'success', startedAt: '2026-08-06T02:48:29Z', url: 'unrelated' }];
  for (const bad of [undefined, null, '', 'not-a-date']) {
    const picked = pickRunForRequest({ ok: true, runs }, bad);
    assert.equal(picked.state, 'unknown', `must not attribute a run when requestedAt is ${JSON.stringify(bad)}`);
    assert.equal(picked.run, undefined);
  }
});

// Round-2 review finding: per_page caps the fetch. If every run on a full page
// is post-request there are almost certainly more we never saw, so the count is
// a floor and "never ran" is unprovable.
test('a truncated page reports a floor, not a total', () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({
    status: 'completed', conclusion: 'failure', startedAt: `2026-08-0${(i % 5) + 1}T00:00:00Z`, url: `r${i}`,
  }));
  const picked = pickRunForRequest({ ok: true, truncated: true, runs }, '2026-07-27T00:00:00Z');
  assert.equal(picked.partial, true);
  assert.match(describeRun(picked), /at least 20 runs since the request/);
});

test('a truncated page can never prove a workflow never ran', () => {
  const allOld = [{ status: 'completed', conclusion: 'success', startedAt: '2026-01-01T00:00:00Z', url: 'old' }];
  assert.equal(pickRunForRequest({ ok: true, truncated: true, runs: allOld }, '2026-07-27T00:00:00Z').state, 'unknown',
    'a full page of pre-request runs means we did not page back far enough, not that nothing ran');
  assert.equal(pickRunForRequest({ ok: true, truncated: false, runs: allOld }, '2026-07-27T00:00:00Z').state, 'never-ran');
});

test('a malformed run object never prints "undefined" at the owner', () => {
  const text = describeRun({ state: 'ran', count: 1, run: {} });
  assert.doesNotMatch(text, /undefined/);
});

test('with no run to link, the view link falls back to the tracking issue', () => {
  assert.equal(buildStuckAlert([STUCK_ENTRY], new Map()).url,
    'https://github.com/thomaspryor/Broadwayscore/issues/542');
});

test('a GREEN run that produced nothing is called out as the worse case', () => {
  const text = describeRun({ state: 'ran', count: 1, run: { status: 'completed', conclusion: 'success', startedAt: '2026-08-01T10:00:00Z' } });
  assert.match(text, /SUCCEEDED/);
  assert.match(text, /re-running it will not help/i);
});

test('an unknown run says it is unknown rather than inventing a diagnosis', () => {
  assert.match(describeRun(null), /could not establish what its workflow did/);
  assert.match(describeRun({ state: 'ran', count: 1, run: { status: 'in_progress' } }), /still in_progress/);
});

// --- 4. no mumbo jumbo ------------------------------------------------------

const RUN_REPORT = {
  items: [{
    submissionId: 'sub-9',
    show: 'The Outsiders (Regional) and Two Strangers (Carry a Cake Across New York) Regional',
    message: 'Please add both The Outsiders and Two Strangers',
    category: 'Content Error',
    priority: 'Medium',
    issueNumber: 548,
    dispatches: [
      { ok: true, workflow: 'add-requested-show.yml', inputs: { title: 'The Outsiders', venue_hint: 'The Weiss' } },
      { ok: true, workflow: 'add-requested-show.yml', inputs: { title: 'Two Strangers (Carry a Cake Across New York)', venue_hint: '' } },
    ],
  }],
};

test('a handled submission is described by outcome, never by workflow + JSON', () => {
  const alert = buildAlert(RUN_REPORT, 'success', '');
  assert.match(alert.description, /Adding to the site: The Outsiders, Two Strangers/);
  assert.doesNotMatch(alert.description, /\.yml/, 'the owner sees no workflow filenames');
  assert.doesNotMatch(alert.description, /venue_hint/, 'the owner sees no JSON input blobs');
  assert.match(alert.description, /another email when it is live/, 'say what happens next');
});

test('a stalled submission says what it needs, and stays auto-dispatchable', () => {
  const stalled = { items: [{ ...RUN_REPORT.items[0], dispatches: [] }] };
  const alert = buildAlert(stalled, 'success', '');
  const outcome = describeOutcome(stalled.items[0]);
  assert.equal(outcome.needsYou, true);
  assert.ok(outcome.whatNow, 'every needs-you outcome must say what it needs');
  assert.doesNotMatch(outcome.detail, /routed or diagnosed/, 'the old wording the owner could not parse');
  assert.match(alert.description, /could not work out which show/);
  assert.match(alert.description, /pick(s)? it up|until someone picks it up/);
  assert.equal(alert.severity, 'error');
  assert.ok(!alert.decision, 'a stalled run must stay auto-dispatchable');
});

test('a fully-handled run is a receipt, not a fix request', () => {
  const alert = buildAlert(RUN_REPORT, 'success', '');
  assert.equal(alert.severity, 'info');
  assert.equal(alert.decision, true, 'otherwise digest-autofix spends a session on "everything worked"');
  assert.match(alert.decisionPrompt, /Nothing to fix/);
});

test('a dispatch GitHub refused reads as "could not start", in plain words', () => {
  const failed = {
    items: [{
      ...RUN_REPORT.items[0],
      dispatches: [{ ok: false, workflow: 'add-requested-show.yml', error: 'Resource not accessible by integration' }],
    }],
  };
  const alert = buildAlert(failed, 'success', '');
  assert.match(alert.description, /GitHub refused it/);
  assert.match(alert.description, /Nothing has been done about this request yet/);
  assert.ok(!alert.decision);
});

// The digest renders a queued row as clip(description, 200). Everything above
// is invisible past that cut, so the first 200 characters have to stand alone —
// this is the assertion that keeps the fix from silently regressing into a
// truncated fragment, which is how the owner's complaint started.
test('the first 200 characters of every report stand alone', () => {
  const cases = [
    ['now live', buildLiveAlert([LIVE_ENTRY]).description],
    ['stuck', buildStuckAlert([STUCK_ENTRY], new Map()).description],
    ['pipeline run', buildAlert(RUN_REPORT, 'success', '').description],
  ];
  for (const [name, description] of cases) {
    const head = description.slice(0, 200);
    assert.match(head, /Outsiders|Lincoln|user requests|message/i,
      `${name}: the clipped head must name the subject`);
    assert.doesNotMatch(head, /^\s*\[|^\s{2}/, `${name}: the head must not open on a bracket tag or an indented detail line`);
    assert.doesNotMatch(head, /mailto:/, `${name}: an encoded mailto cannot survive the clip`);
  }
});
