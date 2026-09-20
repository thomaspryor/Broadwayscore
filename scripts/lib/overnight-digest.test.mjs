import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { summarizeCommits, parseWorkspaces, summarizeWorktrees, renderDigestBlock, countStuckSignals, gatherDigest, ACTIONABLE_RECONCILE_KINDS } = require('./overnight-digest.js');

// Fixtures are verbatim shapes from origin/main on 2026-07-22.
const LOG = [
  'github-actions[bot]\tchore: Update shows - added 10 new show(s)',
  'github-actions[bot]\tfeat: Ensemble LLM score reviews for midnight-at-the-never-get-west-end-2026',
  'github-actions[bot]\tfeat: Ensemble LLM score reviews',
  'github-actions[bot]\tfeat: Collect review texts (single job)',
  'github-actions[bot]\tdata: Rebuild reviews.json - Opening night poller (inline) (-152 reviews)',
  'github-actions[bot]\tdata: Rebuild reviews.json - Post west-end collection (+2 reviews)',
  'github-actions[bot]\tchore: Auto-maintain show data - fixed 14 issues',
  'github-actions[bot]\tchore: Update deploy watermark + stage-latency [skip ci]',
  'github-actions[bot]\tdata: RSS poller — recoupment scan',
  'Tom Pryor\tfix: pin 42 Balloons Mezzanine match to Chicago Shakespeare (regional pool includes non-London UK venues)',
  'github-actions[bot]\taudit: opening-night checklist + latency [skip ci]',
];

test('summarizeCommits rolls churn into plain-English lines', () => {
  const r = summarizeCommits(LOG);
  assert.ok(r.lines.some(l => l.includes('10 new shows added')));
  // Both the bare and the "for <show>" scoring forms count as runs (real
  // ratio is ~479 bare : 40 suffixed — bare-only was a silent 87% blind spot)
  assert.ok(r.lines.some(l => l.includes('2 review-scoring runs completed (incl. midnight-at-the-never')));
  assert.ok(r.lines.some(l => l.includes('14 data issues auto-fixed')));
  assert.equal(r.reviewDelta, -150); // -152 + 2
  assert.ok(r.lines.some(l => l.includes('net -150 reviews')));
});

test('summarizeCommits surfaces real merged work, drops churn', () => {
  const r = summarizeCommits(LOG);
  assert.equal(r.mergedWork.length, 1);
  assert.match(r.mergedWork[0], /42 Balloons Mezzanine/);
});

test('parseWorkspaces finds open 🤖 sessions and duplicate dispatches', () => {
  const raw = [
    '  workspace:213  ✳ Review email issues and organize digests',
    '  workspace:227  🤖🔮 Data·T1-retrieval Sprint 2: NYC census + SLA ledger in',
    '  workspace:229  🤖🔮 Data·T1-retrieval Sprint 2: NYC census + SLA ledger in',
    '* workspace:209  🤖🔮 Data·iOS bold redesign, Round 1: ONE screen',
    '  workspace:300  ✅ 🤖⚡ Data·finished thing',
    '  workspace:301  ⠂ ✅ 🤖⚡ Data·finished behind an activity glyph',
  ].join('\n');
  const r = parseWorkspaces(raw);
  assert.equal(r.autoOpen.length, 3);
  assert.equal(r.autoDone, 2); // plain ✅ AND glyph-prefixed "⠂ ✅" both count as done
  assert.equal(r.duplicates.length, 1);
  assert.match(r.duplicates[0], /^2× /);
});

// Card #870 ship-check finding (Claude subagent review, verified live): a
// ❓-tagged auto-dispatched tab hit a DECISION NEEDED and belongs in the
// digest's separate "Needs your decision" section — if counted here too, the
// renderer's hardcoded "🤖 tabs, none need you" line would contradict itself
// in the SAME email.
test('parseWorkspaces excludes ❓-tagged auto tabs from the "none need you" bucket', () => {
  const raw = [
    '  workspace:400  🤖⚡ Data·Fix the thing',
    '  workspace:401  ❓ 🤖⚡ Data·Needs a decision',
  ].join('\n');
  const r = parseWorkspaces(raw);
  assert.equal(r.autoOpen.length, 1);
  assert.equal(r.autoOpen[0].ref, 'workspace:400');
});

test('summarizeWorktrees only reports branches ahead of main', () => {
  const r = summarizeWorktrees([
    { name: 'clean', ahead: 0, lastCommitDays: 1 },
    { name: 'stranded', ahead: 5, lastCommitDays: 10 },
  ]);
  assert.equal(r.length, 1);
  assert.match(r[0], /stranded: 5 unmerged commits \(last touched 10d ago\)/);
});

test('renderDigestBlock: big review drop and duplicates land in the stuck section', () => {
  const html = renderDigestBlock({
    generatedAt: '2026-07-22T12:00:00Z', hours: 24, errors: [],
    commits: { lines: ['x'], mergedWork: [], reviewDelta: -150 },
    stuck: { workspaces: { autoOpen: [], autoDone: 0, duplicates: ['2× "T1 Sprint 2"'] }, worktrees: [] },
  });
  assert.match(html, /Possibly stuck/);
  assert.match(html, /dropped -150/);
  assert.match(html, /dispatched more than once/);
});

test('renderDigestBlock: clean night says nothing looks stuck', () => {
  const html = renderDigestBlock({
    generatedAt: '2026-07-22T12:00:00Z', hours: 24, errors: [],
    commits: { lines: ['3 new shows added'], mergedWork: [], reviewDelta: 4 },
    stuck: { workspaces: { autoOpen: [], autoDone: 2, duplicates: [] }, worktrees: [] },
  });
  assert.match(html, /Nothing looks stuck/);
  assert.doesNotMatch(html, /Possibly stuck/);
});

// Parity guard (card #409): the approval email's top-line "nothing broken"
// (autonomous-email-render.js digestStuckCount) delegates to countStuckSignals.
// If a future edit to renderDigestBlock's stuck bullets stops matching
// countStuckSignals, the top line can lie. Assert they count identically —
// countStuckSignals === the number of <li> bullets in the ⚠️ stuck list.
test('countStuckSignals matches the bullets renderDigestBlock actually flags', () => {
  const cases = [
    { errors: [], commits: { lines: ['x'], mergedWork: [], reviewDelta: 4 }, stuck: { workspaces: { autoOpen: [], duplicates: [] }, worktrees: [] } },
    { errors: [], commits: { lines: ['x'], mergedWork: [], reviewDelta: -150 }, stuck: { workspaces: { autoOpen: [], duplicates: ['2× "A"'] }, reviewRegressions: ['show-b: 3→1'], worktrees: ['wt1', 'wt2'] } },
    { errors: [], commits: { lines: [], mergedWork: [], reviewDelta: -99 }, stuck: { workspaces: { autoOpen: [], duplicates: [] }, worktrees: ['only-one'] } },
  ];
  for (const d of cases) {
    const html = renderDigestBlock(d);
    const m = html.match(/⚠️ Possibly stuck[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/);
    const bullets = m ? (m[1].match(/<li>/g) || []).length : 0;
    assert.equal(countStuckSignals(d), bullets, `mismatch for ${JSON.stringify(d.stuck)}`);
  }
});

// Card #794: routine bsc-reconcile.js heartbeat/success kinds (card-drift-
// pass/summary, successful redispatches/revives/resumes, per-tick budget
// throttles) fire on EVERY 5-min tick regardless of health — including them
// in the "needing a look" bucket guaranteed a daily false "Stuck pipeline
// items" alarm. Only kinds that mean an automated pass hit something it
// could not fix on its own belong here.
function writeReconcileReport(repo, entries) {
  const dir = path.join(repo, 'data', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'reconcile-report.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
  );
}

test('gatherDigest ignores routine reconcile heartbeat/success kinds', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-digest-'));
  try {
    const now = new Date().toISOString();
    writeReconcileReport(repo, [
      { ts: now, kind: 'card-drift-pass', detail: 'starting drift pass over 1 in-flight session(s)' },
      { ts: now, kind: 'card-drift-summary', detail: 'checked 1 in-flight session(s): 0 proven drift, 0 suspected' },
      { ts: now, kind: 'task-redispatched', detail: 'redispatched #1' },
      { ts: now, kind: 'task-redispatch-throttled', detail: 'deferred to next tick' },
      { ts: now, kind: 'orphan-resolved', detail: 'job already terminal' },
      { ts: now, kind: 'retry', detail: 'resuming session' },
      { ts: now, kind: 'timeout-resume', detail: 'resuming timed-out session' },
      { ts: now, kind: 'flagless-revived', detail: 'revived workspace' },
    ]);
    const digest = gatherDigest({ repo });
    assert.equal(digest.stuck.headlessJobs, undefined);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('gatherDigest surfaces genuinely actionable reconcile kinds', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-digest-'));
  try {
    const now = new Date().toISOString();
    writeReconcileReport(repo, [
      { ts: now, kind: 'card-drift-pass', detail: 'starting drift pass over 1 in-flight session(s)' },
      { ts: now, kind: 'orphan', detail: 'job j1 (task #1) has no live claude process' },
      { ts: now, kind: 'zombie-flip', detail: 'in_progress task #2 flipped back to pending' },
    ]);
    const digest = gatherDigest({ repo });
    assert.equal(digest.stuck.headlessJobs.length, 2);
    assert.ok(digest.stuck.headlessJobs.some(l => l.includes('[orphan]')));
    assert.ok(digest.stuck.headlessJobs.some(l => l.includes('[zombie-flip]')));
    assert.ok(!digest.stuck.headlessJobs.some(l => l.includes('[card-drift-pass]')));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('gatherDigest suppresses an actionable event once its correlated resolving event lands in the window', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-digest-'));
  try {
    const now = new Date().toISOString();
    writeReconcileReport(repo, [
      { ts: now, kind: 'task-session-dead', taskId: '42', detail: 'dispatched workspace has no live claude process' },
      { ts: now, kind: 'task-redispatched', taskId: '42', detail: 'redispatched #42' },
      { ts: now, kind: 'orphan', taskId: '7', jobId: 'j1', detail: 'job j1 has no live claude process' },
      { ts: now, kind: 'orphan-resolved', taskId: '7', jobId: 'j1', detail: 'job j1 already terminal' },
      // A different job under the same task is NOT resolved by j1's fix.
      { ts: now, kind: 'orphan', taskId: '7', jobId: 'j2', detail: 'job j2 has no live claude process' },
    ]);
    const digest = gatherDigest({ repo });
    assert.equal(digest.stuck.headlessJobs.length, 1);
    assert.match(digest.stuck.headlessJobs[0], /job j2/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('gatherDigest does not correlate flagless-session (shared pseudo-taskId) or zombie-flip (self-heal is the point)', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-digest-'));
  try {
    const now = new Date().toISOString();
    writeReconcileReport(repo, [
      { ts: now, kind: 'flagless-session', taskId: 'sweep', detail: 'workspace:100 running without --dangerously-skip-permissions' },
      { ts: now, kind: 'flagless-revived', taskId: 'sweep', detail: 'revived a different workspace' },
      { ts: now, kind: 'zombie-flip', taskId: '99', detail: 'in_progress task #99 flipped back to pending' },
    ]);
    const digest = gatherDigest({ repo });
    assert.equal(digest.stuck.headlessJobs.length, 2);
    assert.ok(digest.stuck.headlessJobs.some(l => l.includes('[flagless-session]')));
    assert.ok(digest.stuck.headlessJobs.some(l => l.includes('[zombie-flip]')));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('gatherDigest({ skipFetch: true }) never shells out to git fetch', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-digest-'));
  try {
    // No .git directory at all — if gatherDigest tried to fetch or log
    // origin/main, every git call would throw and land in digest.errors.
    // skipFetch must skip the fetch specifically; `git log` still runs and
    // fails soft (no .git here), which is the pre-existing, unrelated
    // "couldn't read git history" path.
    const digest = gatherDigest({ repo, skipFetch: true });
    assert.ok(!digest.errors.some(e => /git fetch failed/.test(e)), `unexpected fetch error: ${JSON.stringify(digest.errors)}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ACTIONABLE_RECONCILE_KINDS excludes known routine/success kinds', () => {
  for (const k of ['card-drift-pass', 'card-drift-summary', 'card-drift-would-deliver', 'card-drift-delivered',
    'task-session-wrapper-alive', 'task-redispatched', 'task-redispatch-throttled', 'task-stall-throttled',
    'flagless-revived', 'flagless-revive-deferred-busy', 'flagless-revive-throttled',
    'retry', 'timeout-resume', 'orphan-resolved']) {
    assert.ok(!ACTIONABLE_RECONCILE_KINDS.has(k), `expected ${k} to be excluded (routine/success)`);
  }
});
