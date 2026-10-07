#!/usr/bin/env node
/**
 * audit-archived-in-progress.js — report the tasks trapped by the archiver
 * deadlock, split by whether they ever actually started.
 *
 * WHY THIS EXISTS. task-store-archive.js used to move an `in_progress` task
 * into archive/ after 7 days untouched while its status still said
 * in_progress. The only thing that would ever flip it back to pending is
 * sweepUntrackedInProgress (bsc-reconcile.js), which reads the LIVE dir only
 * (bscNext.loadTasks is live-dir-only by deliberate design — see the card #854
 * docstring at bsc-next.js:84-95). So those tasks became PERMANENTLY
 * in_progress: unreachable by the sweep, invisible to --list/actionable(),
 * dispatchable only by explicit --id. Measured 2026-08-12: 86 of 146.
 *
 * The forward leak is fixed (the archiver now reclaims to pending instead of
 * archiving), but that fix cannot see the ones already inside archive/ — by
 * construction, nothing reads that directory during selection. This script is
 * the read-only half of the recovery: it says exactly what is in there and
 * splits it into the two populations that need DIFFERENT handling.
 *
 * THE SPLIT MATTERS. A trapped task with zero dispatch-ledger entries never
 * actually started — it is un-started work wearing a finished-work label, and
 * returning it to the pool loses nothing. A trapped task WITH ledger entries
 * did start, so there may be real commits on a job branch; restoring it blind
 * could re-run work that already exists. Of 15 sampled by hand on 2026-08-12,
 * 14 were the former and 1 the latter.
 *
 * Read-only by design: it mutates nothing and takes no --fix. Restoring 86
 * tasks to the visible pool changes what every session's --list shows and what
 * the backlog drain can pick, against a measured intake of 34.3 cards/day vs
 * 5.7 burn-down. That is an owner call, not a side effect of an audit.
 *
 * THE RECOVERY (card #1402). `--fix` acts on the split above. It is opt-in,
 * batch-capped, and owner-invoked precisely because of the paragraph above —
 * it is NOT wired into bsc-reconcile.js's 5-min tick. The forward leak is
 * already closed, so this population is finite and drains to zero; permanent
 * machinery would be the wrong shape for a one-time backlog. Per-task
 * decisions come from scripts/lib/task-reclaim.js, which reuses
 * sweepUntrackedInProgress's whole safeguard set rather than reinventing it.
 *
 * Usage:
 *   node scripts/audit-archived-in-progress.js            summary + the split
 *   node scripts/audit-archived-in-progress.js --list     every trapped task
 *   node scripts/audit-archived-in-progress.js --json      machine-readable
 *   node scripts/audit-archived-in-progress.js --fix --dry-run    preview the plan
 *   node scripts/audit-archived-in-progress.js --fix --limit=3    reclaim 3
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const {
  classifyReclaimable, reclaimedTaskShape, supersededTaskShape, parkedTaskShape, taskBranchEvidence,
  notionMarkerOf,
} = require('./lib/task-reclaim.js');
const { acquireArchiveLock } = require('./lib/task-store-archive.js');

const DEFAULT_FIX_LIMIT = 10;
const MAX_UNCONFIRMED_FIX_LIMIT = 25;
const NOTION_FETCH_TIMEOUT_MS = 60_000;

const USAGE = `audit-archived-in-progress.js — report (and optionally recover) tasks trapped in archive/ while still in_progress.

Usage:
  node scripts/audit-archived-in-progress.js [--list] [--json]
  node scripts/audit-archived-in-progress.js --fix [--dry-run] [--limit=N] [--yes] [--reclaim-ids=A,B]

  --list       print every trapped task (default prints the summary + top 15)
  --json       emit JSON instead of prose
  --fix        act on the split: reclaim safe tasks to the live pool as pending,
               park anything with branch evidence or a finished card, close the
               superseded BSC-Daily family
  --dry-run    with --fix, print the plan and write nothing
  --limit=N    with --fix, act on at most N tasks (default ${DEFAULT_FIX_LIMIT})
  --yes        required to raise --limit above ${MAX_UNCONFIRMED_FIX_LIMIT}
  --reclaim-ids=A,B  with --fix, reclaim these specific started-and-lost tasks
               anyway — the owner's answer after reviewing their branches.
               Overrides ONLY the park-started guard; every other guard stands.

Default mode is read-only. --fix returns work to the visible pool, which
changes what every session's --list shows and what the backlog drain can pick
(see this file's header) — hence the batch cap.
`;

const DAY_MS = 24 * 60 * 60 * 1000;

function tasksDir() {
  const listId = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
  return process.env.CLAUDE_CODE_TASKS_DIR || path.join(os.homedir(), '.claude', 'tasks', listId);
}

/**
 * Pure: which archived tasks are trapped, and did each ever start?
 * Extracted per CLAUDE.md §15 so the test exercises the real predicate.
 *
 * @param {Array<{id, status, subject, mtimeMs}>} archivedTasks
 * @param {Set<string>} dispatchedIds - task ids present in the dispatch ledger
 * @param {number} now
 */
function classifyTrapped(archivedTasks, dispatchedIds, now) {
  const trapped = (archivedTasks || [])
    .filter((t) => t && t.status === 'in_progress')
    .map((t) => ({
      id: String(t.id),
      subject: t.subject || '(no subject)',
      ageDays: typeof t.mtimeMs === 'number' ? Math.floor((now - t.mtimeMs) / DAY_MS) : null,
      everDispatched: dispatchedIds.has(String(t.id)),
    }))
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  return {
    trapped,
    neverStarted: trapped.filter((t) => !t.everDispatched),
    startedAndLost: trapped.filter((t) => t.everDispatched),
  };
}

function readArchivedWithMtime(dir) {
  const archiveDir = path.join(dir, 'archive');
  let files;
  try { files = fs.readdirSync(archiveDir); } catch { return []; }
  const out = [];
  for (const f of files.filter((n) => /^\d+\.json$/.test(n))) {
    const p = path.join(archiveDir, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      out.push({ ...parsed, id: String(parsed.id ?? f.replace('.json', '')), mtimeMs: fs.statSync(p).mtimeMs });
    } catch { /* unparseable archive entry — not this audit's problem */ }
  }
  return out;
}

// Events that mean "this task actually got launched". The ledger also carries
// purely operational rows keyed by taskId — `prune`, `prune-closed`, `vanished`,
// `remapped`, `stall-sweep-attempted` — and 2,351 of its rows are `prune`
// alone. Counting those as evidence of a start would mark a never-started task
// as "started then lost" and route it into the wrong recovery bucket (Codex
// review, 2026-08-12). Keep this list to events emitted by a dispatcher at or
// after launch.
const START_EVENTS = new Set([
  'launch', 'launch-failed', 'job-spawned', 'job-done', 'job-failed',
  'job-orphaned', 'job-retried', 'watchdog-resurrect', 'watchdog-redispatch',
]);

/**
 * Task ids the dispatch ledger shows a real launch attempt for.
 *
 * Returns `null` — NOT an empty Set — when the ledger is unreadable. That
 * distinction is load-bearing: `data/audit/dispatch-ledger.jsonl` is gitignored
 * (.gitignore:312), so it does not exist in a git worktree at all. An empty Set
 * makes every task look never-started, and this audit reported exactly that
 * wrong answer ("86 never started, 0 started-then-lost") when first run from a
 * worktree; the real split from the main checkout is 59/27. Same failure shape
 * as the health digest going green in CI because its ledgers were missing —
 * absent input must read as "cannot answer", never as "answer is zero".
 */
function dispatchedTaskIds(repoRoot) {
  const ids = new Set();
  const p = path.join(repoRoot, 'data', 'audit', 'dispatch-ledger.jsonl');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      // String() both sides: ledger taskIds are strings ("1355"), task-store
      // ids can be numeric, and === across those types would classify every
      // started task as never-started.
      if (e && e.taskId != null && START_EVENTS.has(e.event)) ids.add(String(e.taskId));
    } catch { /* skip malformed line */ }
  }
  return ids;
}

/** Live-dir tasks, for the duplicate-live guard (plan-review C1). */
function readLiveTasks(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((n) => /^\d+\.json$/.test(n))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // Normalise id off the FILENAME when the JSON lacks one, exactly as
      // readArchivedWithMtime does. Without this the own-id guard that closes
      // the B1 burial (task-reclaim.js: `live.ids.has(id)`) indexes the string
      // "undefined" for such a file, misses, and the task takes the
      // skip-duplicate-live branch again — reopening the burial this whole
      // fix exists to close. 0 of 421 live files lack `id` today, so this is
      // latent, but the two readers disagreeing is the bug.
      out.push({ ...parsed, id: String(parsed.id ?? f.replace('.json', '')) });
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Every local+remote branch and every registered worktree path, as the raw
 * material for taskBranchEvidence. Failure returns empty, which makes the
 * evidence check answer "no branch" — so this must only ever be called where
 * a false negative is acceptable, i.e. never as the sole guard (the ledger
 * START_EVENTS check gates it).
 */
function gitRefSources(repoRoot) {
  const run = (args) => {
    try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }); }
    catch { return ''; }
  };
  const branches = run(['branch', '-a', '--format=%(refname:short)']).split('\n').map((s) => s.trim()).filter(Boolean);
  const worktreePaths = run(['worktree', 'list', '--porcelain']).split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim()).filter(Boolean);
  return { branches, worktreePaths };
}

/** Atomic-ish write: temp file, rename, read-back verify. Returns false on mismatch. */
function writeVerified(destPath, body) {
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, destPath);
  return fs.readFileSync(destPath, 'utf8') === body;
}

/**
 * Act on one classified task.
 *
 * ORDERING IS THE CRASH-SAFETY CONTRACT, and it is the mirror image of
 * archiveCompletedTasks': write the LIVE copy, verify it by read-back, and
 * only then unlink the archive copy. A crash between the two leaves the task
 * present in both directories, which every union loader already tolerates
 * (mergeWithArchive dedupes by id, live wins) — whereas unlinking first would
 * lose the task outright.
 */
function applyDecision(decision, { liveDir, archiveDir, now, correctCardFn }) {
  const id = decision.id;
  const archivePath = path.join(archiveDir, `${id}.json`);
  const livePath = path.join(liveDir, `${id}.json`);
  let task;
  try { task = JSON.parse(fs.readFileSync(archivePath, 'utf8')); }
  catch { return { id, done: false, why: 'archive copy vanished mid-run' }; }
  // Re-verify under the lock: another writer could have corrected it between
  // the scan and now (same check-then-act guard as sweepUntrackedInProgress's
  // flipFn — the re-read is the last word, never the stale snapshot).
  if (task.status !== 'in_progress') return { id, done: false, why: `no longer trapped (status is now ${task.status})` };

  // Finish an interrupted reclaim (ship-check B1): the live copy already
  // exists and is correct, only the archive copy lingers. Verify the live copy
  // really is a reclaimed record before unlinking — if it is not, this id was
  // reused by something else and dropping the archive copy would lose history.
  if (decision.action === 'resume-interrupted-reclaim') {
    let liveTask = null;
    try { liveTask = JSON.parse(fs.readFileSync(livePath, 'utf8')); } catch { /* handled below */ }
    if (!liveTask || !liveTask.reclaimedFromArchiveAt) {
      return { id, done: false, why: 'live copy is not a reclaimed record — refusing to drop the archive copy' };
    }
    try { fs.unlinkSync(archivePath); } catch (e) { return { id, done: false, why: `archive unlink failed: ${e.message}` }; }
    return { id, done: true, action: 'resume-interrupted-reclaim' };
  }

  if (decision.action === 'close-superseded') {
    const body = `${JSON.stringify(supersededTaskShape(task, { now }), null, 2)}\n`;
    if (!writeVerified(archivePath, body)) return { id, done: false, why: 'archive read-back mismatch' };
    return { id, done: true, action: 'close-superseded' };
  }

  // Not returning to the pool, but the archived record is still lying. Write
  // the honest terminal status in place (never `pending` — see task-reclaim.js's
  // header for why an archive-resident pending arms two dispatchers).
  if (decision.action === 'park-outcome' || decision.action === 'skip-duplicate-live') {
    const body = `${JSON.stringify(parkedTaskShape(task, { now, reason: decision.reason }), null, 2)}\n`;
    if (!writeVerified(archivePath, body)) return { id, done: false, why: 'archive read-back mismatch' };
    let cardCorrected = null;
    // The #1272 convention: a card whose Outcome records finished work gets
    // Paused for a human yes/no, never auto-reopened and never auto-closed.
    // Only correct a card that still READS In progress. A card already at Done
    // is right; flipping it to Paused would invent a decision nobody asked for
    // and would show up on the owner's board as a regression.
    if (decision.action === 'park-outcome' && decision.cardStatus === 'In progress' && decision.notionId && correctCardFn) {
      cardCorrected = correctCardFn(decision.notionId, `Auto-parked ${new Date(now).toISOString().slice(0, 10)} by audit-archived-in-progress --fix: this card's task was archived while still in_progress, but the card already records completed work — parked for a human yes/no rather than reopened (card #1402, the #1272 class). Resume with \`node scripts/bsc-next.js --id ${id} --force\` if it is genuinely unfinished.`, 'Paused');
    }
    return { id, done: true, action: decision.action, cardCorrected };
  }

  // reclaim
  if (fs.existsSync(livePath)) return { id, done: false, why: 'a live file already holds this id — refusing to clobber' };
  const body = `${JSON.stringify(reclaimedTaskShape(task, { now }), null, 2)}\n`;
  if (!writeVerified(livePath, body)) return { id, done: false, why: 'live read-back mismatch — archive copy kept' };
  try { fs.unlinkSync(archivePath); }
  catch (e) { return { id, done: true, action: 'reclaim', warn: `live copy written but archive unlink failed: ${e.message}` }; }

  let cardCorrected = null;
  const notionId = decision.notionId;
  // Same guard as the park path, and as sweepUntrackedInProgress's own
  // `if (card.status === 'In progress')` before it corrects a card.
  if (notionId && correctCardFn && (decision.cardStatus === 'In progress' || decision.cardStatus == null)) {
    cardCorrected = correctCardFn(notionId, `Auto-corrected ${new Date(now).toISOString().slice(0, 10)} by audit-archived-in-progress --fix: this card's task was archived while its status still said in_progress, so no sweep could reach it (card #1402). Returned to the backlog as Not started.`, 'Not started');
  }
  return { id, done: true, action: 'reclaim', cardCorrected };
}

function runFix(argv, { dir, repoRoot, trapped, dispatched }) {
  const dry = argv.includes('--dry-run');
  const limitArg = (argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1];
  const limit = limitArg === undefined || limitArg === '' ? DEFAULT_FIX_LIMIT : parseInt(limitArg, 10);
  if (!Number.isFinite(limit) || limit < 1) { console.error('[audit-archived-in-progress] --limit must be a positive integer'); process.exitCode = 2; return; }
  if (limit > MAX_UNCONFIRMED_FIX_LIMIT && !argv.includes('--yes')) {
    console.error(`[audit-archived-in-progress] REFUSED — --limit=${limit} exceeds ${MAX_UNCONFIRMED_FIX_LIMIT}. Returning that much work to the visible pool at once changes what every session sees; pass --yes if that is intended.`);
    process.exitCode = 2; return;
  }

  // --reclaim-ids=647,752 — the owner's answer to the one question this tool
  // deliberately refuses to guess: "did that surviving branch's work already
  // land?". Ids must be named explicitly, so it can never widen into a sweep,
  // and it overrides ONLY the park-started guard.
  const forceRaw = (argv.find((a) => a.startsWith('--reclaim-ids=')) || '').split('=')[1] || '';
  const forceReclaimIds = new Set(forceRaw.split(',').map((s) => s.trim()).filter(Boolean));
  if (forceReclaimIds.size) {
    console.log(`[audit-archived-in-progress] owner-directed reclaim of ${forceReclaimIds.size} started-and-lost task(s): ${[...forceReclaimIds].join(', ')}`);
    // A typo'd or already-drained id would otherwise print the confirming line
    // above and then silently do nothing (review nit) — say so instead.
    const trappedIds = new Set(trapped.map((t) => String(t.id)));
    const unmatched = [...forceReclaimIds].filter((id) => !trappedIds.has(id));
    if (unmatched.length) console.log(`[audit-archived-in-progress] WARN ${unmatched.length} --reclaim-ids value(s) match no trapped task and will do nothing: ${unmatched.join(', ')}`);
  }

  const archiveDir = path.join(dir, 'archive');
  const liveTasks = readLiveTasks(dir);
  const refs = gitRefSources(repoRoot);
  const startedIds = new Set([...dispatched]);
  const cardCache = new Map();
  const fetchCard = (notionId) => {
    if (cardCache.has(notionId)) return cardCache.get(notionId);
    const r = spawnSync('node', [path.join(repoRoot, 'scripts', 'notion-brain.js'), 'get', notionId], { encoding: 'utf8', timeout: NOTION_FETCH_TIMEOUT_MS });
    let card = null;
    if (r.status === 0) { try { card = JSON.parse(r.stdout); } catch { card = null; } }
    cardCache.set(notionId, card);
    return card;
  };

  // Read the archived records in full (the summary rows carry only the fields
  // classifyTrapped projects), then decide.
  const full = [];
  for (const t of trapped) {
    try { full.push(JSON.parse(fs.readFileSync(path.join(archiveDir, `${t.id}.json`), 'utf8'))); } catch { /* skip */ }
  }
  // Liveness guards, wired to the REAL implementations (ship-check B2). These
  // defaulted to () => false / () => null, so `skip-live` could never fire in
  // production even though the module documented it as borrowed wholesale from
  // sweepUntrackedInProgress — a task an interactive session was actively
  // holding would have been flipped to pending and re-dispatched. The tests
  // passed only because they inject these, which is exactly the pure-function
  // vs IO-boundary gap CLAUDE.md warns about.
  let leaseAliveOf = () => false;
  let liveTabOf = () => null;
  try {
    const { readLease, pidLooksLikeClaude } = require('./lib/bsc-runner.js');
    leaseAliveOf = (id) => { const l = readLease(id); return !!(l && pidLooksLikeClaude(l.pid)); };
  } catch (e) { console.error(`[audit-archived-in-progress] WARN lease guard unavailable (${e.message}) — refusing to run without it`); process.exitCode = 2; return; }
  try {
    const cmuxws = require('./lib/cmux-workspaces.js');
    const ledger = require('./lib/dispatch-ledger.js');
    const workspaces = cmuxws.listWorkspaces() || [];
    liveTabOf = (task) => {
      const w = workspaces.find((ws) => ledger.titleMatchesSubject(ws.title, task.subject));
      return w ? w.ref : null;
    };
  } catch (e) {
    // cmux being unobservable is the one case where degrading is worse than
    // stopping: without the tab guard a live session's task can be reclaimed.
    console.error(`[audit-archived-in-progress] REFUSED — cmux workspace listing failed (${e.message}); cannot prove no live tab holds these tasks.`);
    process.exitCode = 2; return;
  }

  const decisions = classifyReclaimable(full, {
    liveTasks,
    startedIds,
    branchEvidenceOf: (id) => taskBranchEvidence(id, refs),
    leaseAliveOf,
    liveTabOf,
    cardOf: fetchCard,
    now: Date.now(),
    forceReclaimIds,
  });

  const byAction = decisions.reduce((acc, d) => { (acc[d.action] = acc[d.action] || []).push(d); return acc; }, {});
  console.log(`[audit-archived-in-progress] --fix plan over ${decisions.length} trapped task(s)${dry ? ' (DRY RUN)' : ''}:`);
  for (const [action, rows] of Object.entries(byAction).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${action}: ${rows.length}`);
    for (const r of rows.slice(0, dry ? 100 : 5)) console.log(`    #${r.id} — ${r.reason}`);
    if (rows.length > (dry ? 100 : 5)) console.log(`    ... +${rows.length - (dry ? 100 : 5)} more`);
  }

  // Every action that WRITES. park-started is deliberately excluded: "a human
  // must look at this branch" is not a terminal state, so those keep reading
  // in_progress and keep being counted as trapped — honestly.
  const WRITES = new Set(['reclaim', 'close-superseded', 'park-outcome', 'skip-duplicate-live', 'resume-interrupted-reclaim']);
  const actionable = decisions.filter((d) => WRITES.has(d.action));
  const batch = actionable.slice(0, limit);
  console.log(`\n  actionable: ${actionable.length}; acting on ${batch.length} this run (--limit=${limit})`);
  if (dry) { console.log('  DRY RUN — nothing written.'); return; }
  if (!batch.length) return;

  const byId = new Map(full.map((t) => [String(t.id), t]));

  // The lock guards archive/<id>.json against archiveCompletedTasks' rename —
  // and it goes stale after LOCK_STALE_MS (5 min, task-store-archive.js). Notion
  // writes therefore happen AFTER the lock is released: each is a spawnSync with
  // a 60s timeout, so doing them inside would provably let another writer steal
  // the lock mid-batch on any run of more than a few tasks (ship-check warning).
  // The filesystem phase below is pure-local and fast.
  const release = acquireArchiveLock(dir);
  const results = [];
  const cardWrites = [];
  try {
    for (const d of batch) {
      // notionMarkerOf, not a raw description regex (follow-up review F2): a
      // task carrying only metadata.notionCard classifies WITH a marker (its
      // card is fetched and every Notion guard applies) but a description-only
      // regex yields undefined here, so correctCardFn never fires and the card
      // silently keeps reading In progress after the task was acted on.
      const notionId = notionMarkerOf(byId.get(d.id));
      // One task's failure must never abort the batch or hide the summary of
      // what already moved (ship-check warning: an ENOSPC on task 3 of 25
      // propagated past the finally and printed nothing at all).
      try {
        results.push(applyDecision({ ...d, notionId }, {
          liveDir: dir, archiveDir, now: Date.now(),
          correctCardFn: (nid, note, status) => { cardWrites.push({ id: d.id, nid, note, status }); return null; },
        }));
      } catch (e) {
        results.push({ id: d.id, done: false, why: `write threw: ${e.message}` });
      }
    }
  } finally { release(); }

  for (const w of cardWrites) {
    const r = spawnSync('node', [path.join(repoRoot, 'scripts', 'notion-brain.js'), 'update', w.nid, '--status', w.status, '--outcome', w.note], { encoding: 'utf8', timeout: NOTION_FETCH_TIMEOUT_MS });
    const row = results.find((x) => x.id === w.id);
    if (row) row.cardCorrected = r.status === 0;
  }

  const ok = results.filter((r) => r.done);
  console.log(`\n  applied: ${ok.length}/${batch.length}`);
  for (const r of results) {
    if (r.done) console.log(`    ✓ #${r.id} ${r.action}${r.cardCorrected === false ? ' (Notion card update FAILED — card still reads In progress)' : ''}${r.warn ? ` — WARN ${r.warn}` : ''}`);
    else console.log(`    ✗ #${r.id} skipped — ${r.why}`);
  }
  const remaining = actionable.length - ok.length;
  if (remaining > 0) console.log(`\n  ${remaining} actionable task(s) remain — re-run with --limit to continue.`);
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const dir = tasksDir();
  const repoRoot = path.join(__dirname, '..');
  const archived = readArchivedWithMtime(dir);
  const dispatched = dispatchedTaskIds(repoRoot);
  if (dispatched === null) {
    // Refuse rather than mislead. The never-started/started split is the whole
    // point of this audit and it is unanswerable without the ledger.
    const msg = `dispatch-ledger.jsonl not readable at ${path.join(repoRoot, 'data', 'audit', 'dispatch-ledger.jsonl')}\n`
      + '  It is gitignored, so it does not exist in a git worktree. Re-run from the main checkout\n'
      + '  (/Users/tompryor/Broadwayscore). Refusing to classify: with no ledger every task would\n'
      + '  look never-started, which is a wrong answer, not a cautious one.';
    if (argv.includes('--json')) console.log(JSON.stringify({ error: msg }, null, 2));
    else console.error(`[audit-archived-in-progress] REFUSED — ${msg}`);
    process.exitCode = 2;
    return;
  }
  const { trapped, neverStarted, startedAndLost } = classifyTrapped(archived, dispatched, Date.now());

  if (argv.includes('--fix')) {
    if (!trapped.length) { console.log('[audit-archived-in-progress] nothing trapped — --fix has no work to do.'); return; }
    runFix(argv, { dir, repoRoot, trapped, dispatched });
    return;
  }

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ dir, archivedTotal: archived.length, trapped, neverStarted: neverStarted.length, startedAndLost: startedAndLost.length }, null, 2));
    return;
  }

  console.log(`[audit-archived-in-progress] dir=${dir}`);
  console.log(`  ${archived.length} archived task(s); ${trapped.length} still say in_progress and are therefore unreachable`);
  if (!trapped.length) { console.log('  nothing trapped — the deadlock population is drained.'); return; }
  console.log(`    never started (0 dispatch-ledger rows): ${neverStarted.length} — safe to return to the pool, no work exists to lose`);
  console.log(`    started then lost (has ledger rows):     ${startedAndLost.length} — check for commits on a job branch BEFORE re-running`);
  const ages = trapped.map((t) => t.ageDays).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (ages.length) {
    console.log(`  age in archive: median ${ages[Math.floor(ages.length / 2)]}d, oldest ${ages[ages.length - 1]}d`);
  }
  const show = argv.includes('--list') ? trapped : trapped.slice(0, 15);
  console.log(`  ${argv.includes('--list') ? 'all' : 'oldest 15'}:`);
  for (const t of show) {
    console.log(`    #${t.id} ${t.ageDays != null ? `${t.ageDays}d` : '?'} ${t.everDispatched ? '[STARTED]' : '[never started]'} ${t.subject.slice(0, 74)}`);
  }
  if (!argv.includes('--list') && trapped.length > 15) console.log(`    ... +${trapped.length - 15} more (--list for all)`);
}

if (require.main === module) main();

module.exports = {
  classifyTrapped, readArchivedWithMtime, dispatchedTaskIds, tasksDir, START_EVENTS,
  readLiveTasks, gitRefSources, applyDecision, writeVerified, runFix,
  DEFAULT_FIX_LIMIT, MAX_UNCONFIRMED_FIX_LIMIT, USAGE,
};
