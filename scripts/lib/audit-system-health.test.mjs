// BRO-3034: seven system-health defects Crown v48 reproduced during ordinary
// work. One assertion block per defect, each against the real function that
// now handles it (CLAUDE.md rule 15). The module-level tests next to each
// file cover the detail; this is the card's acceptance wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HOUR = 3600e3;
const NOW = Date.parse('2026-10-13T12:00:00Z');

// #1a — shipped, but the board still says Backlog (BRO-2942).
test('#1a: a passing Backlog card with a land/ branch naming it is reported as shipped-but-open', () => {
  const { findCardLanding } = require('./stuck-card-closer.js');
  const { buildReport } = require('../sweep-open-backlog-acceptance.js');
  const landings = [
    { ts: '2026-09-07T10:00:00Z', branch: 'land/bro-2942-push-deadline', sha: 'aaa' },
    { ts: '2026-09-08T10:00:00Z', branch: 'land/revert-bro-2942', sha: 'bbb' },
    { ts: '2026-09-09T10:00:00Z', branch: 'land/bro-29420-other', sha: 'ccc' },
  ];
  assert.equal(findCardLanding('BRO-2942', landings).sha, 'aaa', 'reverts and BRO-29420 never count');
  assert.equal(findCardLanding('BRO-29', landings), null);
  const report = buildReport({
    generatedAt: new Date(NOW).toISOString(), totalCandidates: 2, eligibleCandidates: 2, fetchTruncated: false, landings,
    results: [
      { cardId: 'BRO-2942', name: 'shipped', verifyCmd: 'node --test x.test.mjs', status: 'pass', detail: null },
      { cardId: 'BRO-7', name: 'passes, never landed', verifyCmd: 'node --test y.test.mjs', status: 'pass', detail: null },
    ],
  });
  assert.deepEqual(report.landedButOpen.map((c) => [c.id, c.branch]), [['BRO-2942', 'land/bro-2942-push-deadline']]);
});

// #1b — an acceptance command naming a test file that exists nowhere (BRO-2977).
test('#1b: a card whose check names a missing test file is flagged; an unknown answer is not', () => {
  const { auditCardCheckPaths } = require('./card-premises-auditor.js');
  const cards = [
    { id: 'BRO-1', name: 'gone', url: 'u', cmd: 'node --test scripts/lib/never-written.test.mjs' },
    { id: 'BRO-2', name: 'unknown', url: 'u', cmd: 'node --test scripts/lib/unreadable.test.mjs' },
  ];
  const out = auditCardCheckPaths(cards, (p) => (p.includes('never-written') ? false : null));
  assert.deepEqual(out.map((c) => c.id), ['BRO-1']);
});

// #2 — orphaned In Progress cards are reclaimed, not just counted.
test('#2: an In Progress card idle 48h+ with no live land ref is reclaimed to the board', () => {
  const { reclaimDecision } = require('./linear-reclaim-abandoned.js');
  const idleIso = new Date(NOW - 72 * HOUR).toISOString();
  const issue = {
    identifier: 'BRO-9', title: 'orphan', priority: 2, updatedAt: idleIso, createdAt: idleIso,
    state: { name: 'In Progress', type: 'started' }, labels: { nodes: [] }, description: '',
  };
  const decision = reclaimDecision({ issue, comments: [], landRefs: [], nowMs: NOW });
  assert.ok(['todo', 'backlog'].includes(decision.action), JSON.stringify(decision));
  const fresh = reclaimDecision({ issue: { ...issue, updatedAt: new Date(NOW - HOUR).toISOString() }, comments: [], landRefs: [], nowMs: NOW });
  assert.equal(fresh.action, 'skip');
});

// #3 — a months-old dispatch breadcrumb says it is probably stale.
test('#3: a dispatch comment older than 24h with no live ledger job is named stale; a fresh or live one is not', () => {
  const { staleDispatchCommentNote } = require('./linear-dispatch.js');
  const old = { body: 'Dispatched to workspace:12', createdAt: '2026-09-04T10:00:00Z' };
  assert.match(staleDispatchCommentNote(old, { nowMs: NOW }), /39 days old .* probably stale/);
  assert.equal(staleDispatchCommentNote(old, { nowMs: NOW, liveLedger: true }), null);
  assert.equal(staleDispatchCommentNote({ ...old, createdAt: new Date(NOW - HOUR).toISOString() }, { nowMs: NOW }), null);
});

// #4 — live duplicates are told apart by activity, never by a ✅/"handed off" title.
test('#4: the duplicate crown tab still working is kept even when its title says DONE and its version is lower', () => {
  const { detectDuplicateCrownTabs } = require('./crown-duplicate-detector.js');
  const workspaces = [
    { ref: 'workspace:1', title: '👑 ✅ Crown v45 DONE, tail handed to Crown v48', cwd: '/repo' },
    { ref: 'workspace:2', title: '👑 Crown v48', cwd: '/repo' },
  ];
  // Real ledger vocabulary: v48 was launched first and has since been
  // prune-closed (its tab went ✅ then idle); the DONE-titled tab was
  // re-launched later and is still running.
  const entries = [
    { ts: new Date(NOW - 6 * HOUR).toISOString(), workspaceRef: 'workspace:2', event: 'launch', taskId: 'crown' },
    { ts: new Date(NOW - 2 * HOUR).toISOString(), workspaceRef: 'workspace:1', event: 'launch', taskId: 'crown' },
    { ts: new Date(NOW - 5 * 60e3).toISOString(), workspaceRef: 'workspace:2', event: 'prune-closed', taskId: 'crown' },
  ];
  const { duplicateGroups } = detectDuplicateCrownTabs({
    workspaces, entries, repoRoot: '/repo', isCrownTab: (t) => t.startsWith('👑'),
    launchByRef: () => ({ taskId: 'crown' }), checkLivenessFn: () => ({ dead: false }),
    aliveFn: () => true, surfaceAliveFn: () => true,
  });
  assert.equal(duplicateGroups.length, 1);
  assert.equal(duplicateGroups[0].keep.ref, 'workspace:1');
  assert.deepEqual(duplicateGroups[0].stale.map((s) => s.ref), ['workspace:2']);
});

// #5 — the memory verdict comes from the kernel, not swap percent.
test('#5: memory pressure is the kernel level, so 28% swap can still be critical', () => {
  const { classifyVmPressureLevel, isSwapPressureCritical } = require('./swap-pressure.js');
  // The card's incident: swap 582M of 2,048M, yet the harness killed a task for low memory.
  assert.equal(isSwapPressureCritical({ totalMB: 2048, freeMB: 2048 - 582, floorMB: 512 }), false);
  assert.deepEqual(classifyVmPressureLevel('4\n'), { level: 'critical', critical: true, dispatchViable: false });
  assert.equal(classifyVmPressureLevel('2').dispatchViable, false);
  assert.equal(classifyVmPressureLevel('1').dispatchViable, true);
  assert.equal(classifyVmPressureLevel(''), null, 'no reading is no verdict, never "normal"');
});

// #6 — how stale main's CI verdict is, measurable.
test('#6: a verdict with newer commits untested and runs piling up is reported as lagging in the digest', () => {
  const { assessVerdictLag, summarizeTrunkRuns, renderTrunkDigestLine } = require('./trunk-status.js');
  const at = (h) => new Date(NOW - h * HOUR).toISOString();
  const runs = [
    { conclusion: 'failure', status: 'completed', createdAt: at(5), headSha: 'red' },
    ...Array.from({ length: 10 }, (_, i) => ({ conclusion: null, status: 'in_progress', createdAt: at(4 - i * 0.3), headSha: `h${i}` })),
  ];
  const lag = assessVerdictLag(runs, { now: NOW });
  assert.equal(lag.verdictSha, 'red');
  assert.equal(lag.runsInFlight, 10);
  assert.equal(lag.newerHeads, 10);
  assert.equal(lag.lagging, true);
  const line = renderTrunkDigestLine({ ...summarizeTrunkRuns(runs, { now: NOW }), verdictLag: lag });
  assert.match(line.text, /verdict is from a run started 5h ago: 10\+ newer commit\(s\) untested, 10 run\(s\) still in flight/);
  const current = assessVerdictLag([{ conclusion: 'success', status: 'completed', createdAt: at(0.2), headSha: 'tip' }], { now: NOW });
  assert.equal(current.lagging, false);
});

// #7 — a local gate result is only as fresh as the local corpus.
test('#7: a review-texts clone behind origin is flagged untrustworthy; a copied tree with no .git is unknown', () => {
  const { reviewTextsFreshness, classifyDataFreshness } = require('./data-freshness.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fresh-'));
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe', encoding: 'utf8' });
  const origin = path.join(tmp, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
  const clone = path.join(tmp, 'clone');
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });
  for (const m of ['two', 'three']) git(origin, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', m);

  const before = reviewTextsFreshness({ dir: clone });
  assert.equal(before.trustworthy, false, 'unfetched refs are never proof of currency');
  const fetched = reviewTextsFreshness({ dir: clone, fetch: true });
  assert.equal(fetched.behindCount, 2);
  assert.equal(fetched.trustworthy, false);
  assert.match(fetched.message, /^Review texts is 2 commit\(s\) behind origin/);

  const copied = path.join(origin, 'copied-tree');
  fs.mkdirSync(copied);
  assert.equal(reviewTextsFreshness({ dir: copied }).level, 'unknown', 'never measured against the enclosing repo');
  assert.match(classifyDataFreshness({ behindCount: 3, refsFetched: true }).message, /^Core data is 3/, 'core-data wording unchanged');
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
