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
  showUrl,
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

// --- 3. give the stuck one something to click -------------------------------

test('a stuck request stays auto-dispatchable — the click is the digest\'s, not ours', () => {
  const alert = buildStuckAlert([STUCK_ENTRY], new Map());
  assert.equal(alert.severity, 'error');
  assert.ok(!alert.decision,
    'digest-autofix.js dispatches every queued row that is NOT flagged a decision; flagging this would park it');
});

test('the stuck report states what the workflow actually did, not a guess', () => {
  const diagnoses = new Map([['add-requested-show.yml', {
    status: 'completed', conclusion: 'failure', startedAt: '2026-08-01T10:00:00Z',
    url: 'https://github.com/thomaspryor/Broadwayscore/actions/runs/1',
  }]]);
  const alert = buildStuckAlert([STUCK_ENTRY], diagnoses);
  assert.match(alert.description, /ended as failure/);
  assert.match(alert.description, /actions\/runs\/1/);
  assert.doesNotMatch(alert.description, /likely failed/, 'a guess is what the owner called useless');
  assert.equal(alert.url, 'https://github.com/thomaspryor/Broadwayscore/actions/runs/1',
    'the digest renders alert.url as the row\'s clickable "view" — point it at the reason');
});

test('with no run to link, the view link falls back to the tracking issue', () => {
  assert.equal(buildStuckAlert([STUCK_ENTRY], new Map()).url,
    'https://github.com/thomaspryor/Broadwayscore/issues/542');
});

test('a GREEN run that produced nothing is called out as the worse case', () => {
  const text = describeRun({ status: 'completed', conclusion: 'success', startedAt: '2026-08-01T10:00:00Z' });
  assert.match(text, /SUCCEEDED/);
  assert.match(text, /Re-running it will not help/);
});

test('an unknown run says it is unknown rather than inventing a diagnosis', () => {
  assert.match(describeRun(null), /could not tell us/);
  assert.match(describeRun({ status: 'in_progress' }), /still in_progress/);
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
