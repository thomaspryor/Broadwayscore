import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeCommits, parseWorkspaces, summarizeWorktrees, renderDigestBlock, countStuckSignals } = require('./overnight-digest.js');

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
