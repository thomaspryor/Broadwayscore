// BRO-6635: the pause-report guard over verbatim paused session reports from Linear (2026-10).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { guardProcessExit } from '../../tests/helpers/process-exit-guard.mjs';

const require = createRequire(import.meta.url);
const { classifyPauseReport, ADVISORY_MARKER } = require('./pause-report-guard.js');
// A shell that armed or disabled the guard must not change what these tests see.
delete process.env.PAUSE_GUARD_MODE;
delete process.env.PAUSE_GUARD_DISABLED;
// The block-mode test stubs process.exit; keep a stray exit or exitCode from failing the whole file.
afterEach(() => { process.exitCode = 0; });
guardProcessExit();

// Real reports that handed a doable step to a later session with no block named.
const REFUSED = {
  "BRO-2263 2026-10-15 (false Mac claim: outlet-registry.json is public-owned since BRO-1084)": "The original finding (theatrereviews.design) is already cleared: it is registered as its own outlet theatrereviews-design. The detector now lists 6 other hosts. My read: berkshireonstage.blog is a real move for berkshire-on-stage (registered berkshireonstage.com, 6 reviews) and gaytimes.com is likely a real alias for gay-times; aol.co.uk, independent.ie, billboard.com.br and artshub.com.au look like different outlets or regional editions (false positives). No cloud path edits data/outlet-registry.json (private core-data repo, cloud copy is disposable, no approved-fix action type for registry aliases), so the alias add needs a Mac session or a new registry-alias plan action. The VERIFY file tests/unit/outlet-registry-domain-aliases.test.mjs does not exist.",
  "BRO-2263 2026-10-28 (Next worker: judge each host)": "The host named on this card (theatrereviews.design) is already registered as its own outlet (theatrereviews-design), so that case is resolved. The VERIFY file tests/unit/outlet-registry-domain-aliases.test.mjs does not exist. Current detector run (findProbableDomainMoves on today's data) flags 9 other hosts: berkshireonstage.blog, aol.co.uk, aol.ca, independent.ie, northwestend.co.uk, theatreboard.co.uk, njartsmaven.substack.com, billboard.com.br, artshub.com.au. Several are false positives (aol.co.uk to travel-aol, independent.ie to santa-barbara-independent, billboard.com.br). Next worker: judge each host, add true moves to domainAliases via a data/pending-fixes plan, and add the missing test or a safe VERIFY. RECHECK-AFTER: 2026-10-30. Recheck: node scripts/health-check.js (Quality: outlet domain moves row).",
  "BRO-5436 2026-10-29 (Next session: dispatch; cloud can dispatch via cloud-dispatch.js, board-workers.md)": "**Session report (paused)** Re-checked 2026-10-29. data/audit/t1-silent-gaps.json (generated 01:33Z) still lists Lincoln in the Bardo (washpost) and High School Musical (daily-mail); no ensemble scoring run for either was found in the recent run list. Golden Boy is excluded by BRO-6082. Next session: dispatch the two single-show scoring runs, then re-run the gaps audit. RECHECK-AFTER: 2026-10-31"
};

// Real reports that name a block (Mac-only hands, budget, a parked land) or only mention a cron run.
const ALLOWED = {
  "BRO-5436 2026-10-23 (Mac session + local cookie jar)": "Cloud worker 2026-10-23: the health row lists back-catalogue T1/T2 discovered reviews not reaching the composite (data/audit/t1-silent-gaps.json). Per scripts/health-check.js hint, each entry's fix command needs the local cookie jar, so it cannot be cleared from a cloud container; VERIFY (check-health-row-absent) still fails against the 2026-10-22T19:15Z snapshot. Needs a Mac session or the Silent-gap 120d sweep remainder card.",
  "BRO-5436 2026-10-24 (Mac cookie jar)": "Re-checked 2026-10-24 on fresh main: the only remaining gap is golden-boy-off-west-end-2026 daily-mail (Patrick Marmion, T1), 758h old. Paywalled newspaper.dailymail.com edition returns a teaser; no free copy exists, and there is no waiver path in audit-t1-silent-gaps.js. Needs the Mac cookie jar: run the fix command in data/audit/t1-silent-gaps.json locally, or an owner call to accept the gap. Cloud cannot fix. RECHECK-AFTER: 2026-10-28 ; recheck: node scripts/check-health-row-absent.js --row-b64 RGF0YTogVDEvVDIgc2lsZW50IHJldmlldyBnYXBz",
  "BRO-6487 2026-10-29 (paused at budget)": "Paused at budget. 4 seasons SEASON FAIL on displayable only (0.21/0.65/0.57/0.57); opening PASS in all; unfetched 0. Remaining gap is source supply (Telegraph 402, Times no sitemap, Stage cookie BRO-6530). RECHECK-AFTER: 2026-10-31. Details in the session report comment above.\n\n**Verification:**\nnode scripts/audit-we-historical-season.js --season=2013-2014 -> SEASON FAIL displayable 0.65",
  "BRO-2857 2026-10-18 (hook only on the owner Mac)": "Repo side is already in place: CLAUDE.md rule 6 documents 'linear-session.js report --status=paused' (not '--state Paused'), and scripts/tests/verify-edits-cloud-session-gates.test.mjs:1181-1194 covers the phantom state. The VERIFY test (tests/unit/linear-issue-verify.test.mjs) runs the real ~/.claude/hooks/linear-issue-verify.sh, which exists only on the owner's Mac, so all 5 cases skip here and cannot prove the hook allowlist. Needs a Mac session to confirm the hook.",
  "BRO-2762 2026-10-26 (land parked in the queue)": "Fix committed (da0f0fff: getFixedSortTitle helper + tooltips on all fixed-order sort buttons, tests/unit/sort-toggle.test.mjs 3 tests pass). Pushed to land/bro-2762-default-sort-title; Land run 40293230634 is parked in the landing queue (queue full) after a 58 min wait. Do not push a new ref; the sweep resumes it. Next worker: if the ref is gone, verify node --test tests/unit/sort-toggle.test.mjs on main and close; if it is still there, follow the run. RECHECK-AFTER: 2026-10-27",
  "BRO-6611 2026-10-30 (next run is cron prose)": "Row is one fresh candidate: Middlemarch (Guardian review, RSC Swan Theatre, market uk-regional, missing 0d). Not a defect: the daily scrape-new-aggregators run stages and promotes uk-regional candidates (promote-ob-venue-candidates.js --regional-only), so it should clear on its next run. Nothing to fix in code. RECHECK-AFTER: 2026-11-01. Recheck: node scripts/check-health-row-absent.js --row-b64 RGF0YTogcmV2aWV3ZWQgc2hvd3MgbWlzc2luZyBmcm9tIHNob3dzLmpzb24 ; if Middlemarch is still missing from shows.json then, the regional promotion is failing and that is the bug to chase."
};

for (const [name, summary] of Object.entries(REFUSED)) {
  test(`refuses: ${name}`, () => {
    const r = classifyPauseReport({ status: 'paused', summary });
    assert.equal(r.wouldRefuse, true, JSON.stringify(r));
    assert.ok(r.handoff);
    assert.match(r.reason, /Do the step now/);
  });
}

for (const [name, summary] of Object.entries(ALLOWED)) {
  test(`allows: ${name}`, () => {
    const r = classifyPauseReport({ status: 'paused', summary });
    assert.equal(r.wouldRefuse, false, JSON.stringify(r));
  });
}

test('a RECHECK-AFTER stamp alone does not exempt a hand-off', () => {
  const r = classifyPauseReport({ status: 'paused', summary: 'Next session: re-run the audit. RECHECK-AFTER: 2026-11-01' });
  assert.equal(r.wouldRefuse, true);
});

test('a RECHECK-AFTER stamp with the event it waits on exempts', () => {
  const r = classifyPauseReport({ status: 'paused', summary: 'Next session: confirm the row is gone. It clears only on the next health snapshot. RECHECK-AFTER: 2026-11-01' });
  assert.equal(r.wouldRefuse, false);
  assert.deepEqual(r.blocks, ['wait']);
});

test('an owner decision block exempts', () => {
  const r = classifyPauseReport({ status: 'blocked', summary: 'Next worker: apply option A.\nDECISION NEEDED: keep or drop the row?' });
  assert.equal(r.wouldRefuse, false);
  assert.ok(r.blocks.includes('owner'));
});

test('a denied hand-off and code spans are not hand-offs', () => {
  assert.equal(classifyPauseReport({ status: 'paused', summary: 'Waiting on CI. No next session needed.' }).wouldRefuse, false);
  assert.equal(classifyPauseReport({ status: 'paused', summary: 'The guard refuses \`next session: X\` wording.' }).wouldRefuse, false);
});

test('done and in-review reports are not checked', () => {
  for (const status of ['done', 'in-review']) {
    assert.equal(classifyPauseReport({ status, summary: 'Next session: close it.' }).wouldRefuse, false);
  }
});

test('the hand-off is read from --verification too', () => {
  assert.equal(classifyPauseReport({ status: 'paused', summary: 'Partly done.', verification: 'Next worker: run the backfill.' }).wouldRefuse, true);
});

test('kill switch', () => {
  process.env.PAUSE_GUARD_DISABLED = '1';
  try {
    assert.equal(classifyPauseReport({ status: 'paused', summary: 'Next session: do it.' }).wouldRefuse, false);
  } finally { delete process.env.PAUSE_GUARD_DISABLED; }
});

test('the advisory marker carries no hand-off phrase', () => {
  assert.equal(classifyPauseReport({ status: 'paused', summary: ADVISORY_MARKER }).wouldRefuse, false);
});

const refuses = (summary, extra = {}) => classifyPauseReport({ status: 'paused', summary, ...extra }).wouldRefuse;

test('a denied or resolved access word names no block', () => {
  assert.equal(refuses('No access needed. Next session: add the aliases.'), true);
  assert.equal(refuses('The 403 is fixed now. Next worker should rerun the backfill.'), true);
  assert.equal(refuses('The site returns 403 to the cloud. Next worker should rerun the backfill.'), false);
});

test('loose words do not exempt a hand-off', () => {
  assert.equal(refuses('Checked the login page markup. Next session: fix the selector.'), true);
  assert.equal(refuses('Spent some credits on the probe. Next session: wire it in.'), true);
  assert.equal(refuses('Quota looks fine. Next session: wire it in.'), true);
  assert.equal(refuses('RECHECK-AFTER: 2026-11-02. Wait until the date, then the next session lands it.'), true);
  assert.equal(refuses('ScrapingBee credits exhausted. Next session reruns it.'), false);
});

test('a denial removes only its phrase, not the sentence', () => {
  assert.equal(refuses('No next session needed for the docs, but the next worker must add the aliases.'), true);
});

test('more hand-off phrasings are caught', () => {
  assert.equal(refuses('Next firing: run the check and push.'), true);
  assert.equal(refuses('A hard-killed run can idle the next firing until its lock goes stale.'), false);
  assert.equal(refuses('Left the rest for another session.'), true);
  assert.equal(refuses('The next pass should dedupe the rows.'), true);
  assert.equal(refuses('Leaving the import for the next-session run.'), true);
});

test('a backticked Mac-only path still names the block', () => {
  assert.equal(refuses('The hook lives in `~/.claude/hooks/x.sh`. Next session on the Mac edits it.'), false);
});

test("the card's own DECISION NEEDED block counts", () => {
  assert.equal(refuses('Next session: ship option A.', { description: 'DECISION NEEDED: A or B' }), false);
});

// Wiring: `linear-session.js report` tags a would-refuse pause in advisory mode, refuses it
// before posting in block mode, and the dispatch-watchdog's machine skip bypasses both.
function withStubbedLinear(run) {
  const linear = require('./linear-client.js');
  const saved = { ...linear };
  const posted = [];
  Object.assign(linear, {
    getIssue: async (id) => ({ id: 'uuid-1', identifier: id, description: '', comments: { nodes: [] } }),
    createComment: async (_id, body) => { posted.push(body); },
    getTeam: async () => ({ id: 't', states: [{ id: 's-p', name: 'Paused', type: 'backlog' }, { id: 's-b', name: 'Backlog', type: 'backlog' }] }),
    updateIssue: async () => ({}),
  });
  const quiet = { log: console.log, error: console.error };
  console.log = () => {}; console.error = () => {};
  return run(posted).finally(() => { Object.assign(linear, saved); Object.assign(console, quiet); });
}

const HANDOFF_ARGS = { issue: 'BRO-1', status: 'paused', summary: 'Scoped it. Next worker: add the aliases.' };

test('report (advisory): posts the pause with the fixed marker', async () => {
  const { cmdReport } = require('../linear-session.js');
  await withStubbedLinear(async (posted) => {
    await cmdReport({ ...HANDOFF_ARGS });
    assert.equal(posted.length, 1);
    assert.ok(posted[0].endsWith(ADVISORY_MARKER));
  });
});

test('report (advisory): a pause naming a block carries no marker', async () => {
  const { cmdReport } = require('../linear-session.js');
  await withStubbedLinear(async (posted) => {
    await cmdReport({ issue: 'BRO-1', status: 'paused', summary: 'Next worker: run it with the Mac cookie jar.' });
    assert.ok(!posted[0].includes(ADVISORY_MARKER));
  });
});

test('report (PAUSE_GUARD_MODE=block): refuses with exit 7 before anything posts', async () => {
  const { cmdReport } = require('../linear-session.js');
  const exit = process.exit;
  process.env.PAUSE_GUARD_MODE = 'block';
  process.exit = (code) => { throw Object.assign(new Error('exit'), { code }); };
  try {
    await withStubbedLinear(async (posted) => {
      await assert.rejects(cmdReport({ ...HANDOFF_ARGS }), (e) => e.code === 7);
      assert.equal(posted.length, 0);
    });
  } finally { process.exit = exit; delete process.env.PAUSE_GUARD_MODE; }
});

test('report: the machine-caller skip (dispatch-watchdog) bypasses the guard even in block mode', async () => {
  const { cmdReport } = require('../linear-session.js');
  process.env.PAUSE_GUARD_MODE = 'block';
  try {
    await withStubbedLinear(async (posted) => {
      await cmdReport({ ...HANDOFF_ARGS, status: 'blocked' }, { skipOwnerQuestionGuard: true });
      assert.equal(posted.length, 1);
      assert.ok(!posted[0].includes(ADVISORY_MARKER));
    });
  } finally { delete process.env.PAUSE_GUARD_MODE; }
});

// Cousin path: `linear-brain.js update --state Paused --comment` also warns (advisory, still writes).
test('linear-brain update --state Paused warns on a hand-off and still writes', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const run = (comment) => spawnSync(process.execPath, ['-e', `
    const { main } = require('./scripts/linear-brain.js');
    main(['update', 'BRO-1', '--state', 'Paused', '--comment', ${JSON.stringify(comment)}], {
      getIssue: async () => ({ id: 'u', identifier: 'BRO-1', title: 't', description: '', state: { name: 'In Progress', type: 'started' }, comments: { nodes: [] }, relations: { nodes: [] } }),
      getTeam: async () => ({ states: [{ id: 's-p', name: 'Paused', type: 'backlog' }, { id: 's-t', name: 'Todo', type: 'unstarted' }] }),
      updateIssue: async () => { console.error('UPDATE_ISSUE_CALLED'); },
      createComment: async () => { console.error('CREATE_COMMENT_CALLED'); },
    });`], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, PAUSE_GUARD_MODE: '', PAUSE_GUARD_DISABLED: '' } });
  const flagged = run('Scoped it. Next worker: add the aliases.');
  assert.match(flagged.stderr, /pause-handoff \(advisory\)/);
  assert.match(flagged.stderr, /UPDATE_ISSUE_CALLED/);
  const clean = run('Paused at budget. Next session finishes the import.');
  assert.doesNotMatch(clean.stderr, /pause-handoff/);
});
