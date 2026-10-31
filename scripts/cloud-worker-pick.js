#!/usr/bin/env node
/**
 * cloud-worker-pick.js — print the one P0/P1 card a scheduled cloud worker
 * session should take on this firing (BRO-4535), or a P2 Todo card when no
 * P0/P1 card is eligible after every rule (`tier: "p2-fallback"`), or a P3
 * (Low) Todo card when no P2 card is either (`tier: "p3-fallback"`). Read-only:
 * it claims nothing. Selection rules and their reasons: scripts/lib/cloud-worker-pick.js.
 *
 * Usage:
 *   node scripts/cloud-worker-pick.js           JSON: { pick, tier, eligible, eligibleP2, eligibleP3, skipped, skippedP2, skippedP3, historySkipped }
 *   node scripts/cloud-worker-pick.js --list=N  JSON: { picks: [up to N], eligible, ... } for the
 *                                               daily Codex runner (BRO-4745): same rules, no
 *                                               resume entries (those stay with the Claude worker);
 *                                               P0/P1 picks first, then P2, then P3.
 *
 * Spend breaker (BRO-6229, scripts/lib/cloud-worker-breaker.js): the single pick
 * carries `breaker` ({ mode, dailyClaims, dailyCap, cardAttemptCap, skipped,
 * wouldSkip }). Advisory by default; CLOUD_WORKER_BREAKER_ENFORCE=true skips
 * non-P0 cards past a cap (a null pick then carries `breakerReason`),
 * CLOUD_WORKER_BREAKER_DISABLED=true turns it off. --list is not metered.
 *
 * `pick` is null when nothing is eligible; the worker then ends with no
 * changes. Each pick carries `tier` ("p0p1" | "p2-fallback" | "p3-fallback") and `model`
 * ("opus" | "sonnet", the linear-next.js policy: pickLinearModel) with
 * `modelReason`. `eligible`/`skipped` count the P0/P1 tier, `eligibleP2`/
 * `skippedP2` the P2 fallback, `eligibleP3`/`skippedP3` the P3 (Low) fallback. Exit 0 on a completed pick (null or not), 1
 * when Linear can't be read.
 *
 * Before a new pick, a card whose land/ ref Land refused and nobody came back
 * to is handed back with `pick.resume` (BRO-4565); a P2 card's only after every
 * P0/P1 entry, a P3 card's only after every P2 entry. The routine prompt can't be
 * edited from outside its own thread, so `pick.resume.instructions` carries
 * the steps. If git or the GitHub API can't be read, resume is skipped with a
 * warning on stderr and the normal pick runs.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv)) {
  console.log('Usage: node scripts/cloud-worker-pick.js [--list=N]\nPrints {pick, eligible, skipped} for the cloud worker routine, or {picks: [up to N]} with --list (add --codex for the Codex runner filtered, best-suited-first list). While a Codex runner is live the single pick leaves Codex-fit cards to it (--no-codex-first: off). Read-only.');
  process.exit(0);
}

require('./lib/load-env').loadEnv();

const REPO = 'thomaspryor/broadwayscore';
// Re-runs a Land run cancelled before it did any work (since BRO-5112 a re-run
// waits in the landing mutex and evicts nobody).
const RERUN_LAND = (run) => `node scripts/land-retry-cancelled.js --run=${run.id}`;
const RESUME_INSTRUCTIONS = (ref, run, kind) => [
  kind === 'evicted'
    ? `RESUME, not a new card: this card is already yours (In Progress) and its landing ${ref} was cancelled before it did any work (run ${run.id}), not refused.`
    : `RESUME, not a new card: this card is already yours (In Progress) and Land refused its landing ${ref}.`,
  'Step 3 claim is a no-op on it. Do NOT start a new branch.',
  'First run the card\'s verify command (pick.verify) on up-to-date origin/main: if it already passes, the work landed another way, so skip to step 7.',
  ...(kind === 'evicted' ? [
    `Nothing to fix: run ${RERUN_LAND(run)}. "re-run requested" → follow it. "skip (attempts-exhausted)" → merge origin/main into the ref and push to the SAME ref (a fresh run). Any other skip (already re-running, landed, superseded) → follow the ref, never push on top of a live landing. Without gh: re-run the failed jobs of run ${run.id} through the GitHub MCP tools.`,
  ] : [
  `Check it out: git worktree remove --force .claude/worktrees/resume 2>/dev/null; git fetch origin ${ref} && git worktree add --detach .claude/worktrees/resume FETCH_HEAD.`,
  `Read why Land refused run ${run.id}${run.url ? ` (${run.url})` : ''}: list its failed jobs (gh api repos/${REPO}/actions/runs/${run.id}/jobs --jq '.jobs[] | select(.conclusion=="failure") | .id'), then each job's annotations (gh api repos/${REPO}/check-runs/<job id>/annotations) or log (gh api repos/${REPO}/actions/jobs/<job id>/logs; if gh says the response contains terminal escape sequences, add --allow-escape-sequences).`,
  'Fix it there (merge origin/main first if it conflicts), then push to the SAME ref:',
  `git push origin HEAD:refs/heads/${ref}`,
  ]),
  'Follow that Land run to its verdict in this same turn: wait until the ref disappears (landed) or the run fails (fix and push again). Never end the turn while it runs.',
  'Then continue at step 6 (verify on main, then close or pause the card).',
].join(' ');

function listLandRefs() {
  const { execFileSync } = require('child_process');
  const out = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/land/*'], { encoding: 'utf8', timeout: 60_000 });
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, ref] = line.split('\t');
    return { sha, ref: ref.replace(/^refs\/heads\//, '') };
  });
}

function latestLandRun(ref) {
  const { execFileSync } = require('child_process');
  const out = execFileSync('gh', ['api', `repos/${REPO}/actions/runs?branch=${encodeURIComponent(ref)}&per_page=1`,
    '--jq', '.total_count as $n | .workflow_runs[0] // empty | {id, status, conclusion, headSha: .head_sha, updatedAt: .updated_at, url: .html_url, attempts: $n, runAttempt: .run_attempt}'],
  { encoding: 'utf8', timeout: 60_000 }).trim();
  return out ? JSON.parse(out) : null;
}

/** True while any dispatched Land run is queued or running (its head_branch is main, not the ref). */
function landDispatchInFlight() {
  const { execFileSync } = require('child_process');
  const out = execFileSync('gh', ['api', `repos/${REPO}/actions/workflows/land.yml/runs?event=workflow_dispatch&per_page=10`,
    '--jq', '[.workflow_runs[] | select(.status != "completed")] | length'], { encoding: 'utf8', timeout: 60_000 }).trim();
  return Number(out) > 0;
}

/** Stranded landings to resume, best first. Never throws: resume is best-effort. */
function findResume(issues, nowMs) {
  const { findResumeCandidates, landRefCardNumber, resumableCardsByNumber } = require('./lib/cloud-worker-pick.js');
  try {
    // Only refs naming a started P0/P1/P2/P3 card need a run lookup (one API call each).
    const tiers = { includeP2: true, includeP3: true };
    const cards = resumableCardsByNumber(issues, tiers);
    const refs = listLandRefs().filter((r) => cards.has(landRefCardNumber(r.ref)));
    for (const r of refs) r.lastRun = latestLandRun(r.ref);
    if (!refs.length) return [];
    return findResumeCandidates(issues, refs, { nowMs, landDispatchInFlight: landDispatchInFlight(), ...tiers });
  } catch (err) {
    console.error(`[cloud-worker-pick] resume check skipped: ${err && err.message ? err.message.split('\n')[0] : err}`);
    return [];
  }
}

// Comment fetches per firing (one Linear call each) for entries main() has no
// comments for. Past this, take the next P0/P1 Todo card unchecked; P2/P3
// entries and paused Backlog cards are always checked (mayTakeUnchecked).
const MAX_HISTORY_CHECKS = 15;

/**
 * First candidate an earlier worker didn't pause on (BRO-4574). Counts each skip
 * in `historySkipped`. A failed comment read keeps a Todo card (pause memory is
 * advisory) but skips a paused Backlog card, which is there because of a pause.
 */
async function firstUnpaused(queue, nowMs, historySkipped, breakerSkip = () => false) {
  const { getIssue } = require('./lib/linear-client.js');
  const { historySkipReason, mayTakeUnchecked, isPausedBacklog } = require('./lib/cloud-worker-pick.js');
  let fetches = 0;
  for (let i = 0; i < queue.length; i++) {
    // main() already read comments for every candidate (needsComments); fetch only when it could not.
    const pre = queue[i].issue.comments && queue[i].issue.comments.nodes;
    // Spend breaker before any comment read (BRO-6229): the daily cap needs none, and the
    // per-card cap uses the prefetched comments when there are any.
    if (breakerSkip(queue[i], pre || [])) continue;
    if (!pre && fetches >= MAX_HISTORY_CHECKS && mayTakeUnchecked(queue[i])) {
      console.error(`[cloud-worker-pick] ${MAX_HISTORY_CHECKS} history checks used; ${queue[i].issue.identifier} taken unchecked`);
      return queue[i];
    }
    let reason = null;
    try {
      if (!pre) fetches++;
      const full = pre ? null : await getIssue(queue[i].issue.identifier);
      const nodes = pre || (full && full.comments ? full.comments.nodes : []);
      // Both reads cap at 50 comments; past that the latest report may be cut off.
      if (nodes.length >= 50) console.error(`[cloud-worker-pick] ${queue[i].issue.identifier}: 50+ comments, pause history may be incomplete`);
      reason = historySkipReason(queue[i].issue, nodes, nowMs, { cloudLane: !process.argv.includes('--codex') });
      // Comments fetched just now: the per-card cap can apply only here.
      if (!reason && !pre && breakerSkip(queue[i], nodes)) continue;
    } catch (err) {
      console.error(`[cloud-worker-pick] history check skipped for ${queue[i].issue.identifier}: ${err && err.message ? err.message.split('\n')[0] : err}`);
      if (isPausedBacklog(queue[i].issue)) reason = 'history-unreadable';
    }
    if (!reason) return queue[i];
    historySkipped[reason] = (historySkipped[reason] || 0) + 1;
    console.error(`[cloud-worker-pick] skip ${queue[i].issue.identifier}: ${reason}`);
  }
  return null;
}

async function main() {
  const { listOpenIssuesWithDescriptions, listIssueComments } = require('./lib/linear-client.js');
  const { verifyCommand } = require('./lib/linear-drain-parked.js');
  const { pickCloudCard, buildPickQueue, needsComments, isStartNow, modelPicker } = require('./lib/cloud-worker-pick.js');
  const issues = await listOpenIssuesWithDescriptions();
  const nowMs = Date.now();
  // A VERIFY posted as a comment arms a card, and a newer one corrects the
  // description's (BRO-4642). The list query has no comments, so read them for
  // every P0/P1 card, parked and started (resume) ones included, and every P2
  // and P3 Todo or resumable card (the fallback tiers; needsComments): one
  // request per 50 cards.
  const candidates = issues.filter((iss) => needsComments(iss, nowMs));
  let commentsRead = true;
  if (candidates.length) {
    try {
      const comments = await listIssueComments(candidates.map((iss) => iss.identifier));
      for (const iss of candidates) if (comments.has(iss.identifier)) iss.comments = { nodes: comments.get(iss.identifier) };
    } catch (err) {
      commentsRead = false;
      console.error(`[cloud-worker-pick] comment VERIFY check skipped: ${err && err.message ? err.message.split('\n')[0] : err}`);
    }
  }
  const tiers = pickCloudCard(issues, { nowMs, codex: process.argv.includes('--codex') });
  const { eligible, skipped, startNowSkipped, eligibleP2, skippedP2, eligibleP3, skippedP3 } = tiers;
  // P2 goes after P0/P1 and P3 after P2: a fallback card (resume or new) is
  // reached only when every entry ahead of it was skipped for its history (or,
  // for Codex, bounced).
  const queue = buildPickQueue(findResume(issues, nowMs), tiers);
  const counts = { eligible, eligibleP2, eligibleP3, open: issues.length, skipped, skippedP2, skippedP3, startNowSkipped };
  const modelOf = modelPicker({ opusBudget: await require('./lib/opus-budget.js').loadOpusBudget() });
  const historySkipped = {};
  const listN = listArg(process.argv);
  if (listN) {
    // Without comments the Codex bounce marker is invisible: hand Codex nothing this time.
    if (!commentsRead) {
      console.log(JSON.stringify({ picks: [], ...counts, historySkipped, commentsUnavailable: true }, null, 2));
      return;
    }
    // Same queue minus resume entries: a stranded landing is the Claude worker's to finish.
    // Cards Codex bounced recently (14d; 3d after a single 'landed part') go to the Claude worker, not back to Codex.
    const { codexBouncedRecently } = require('./lib/codex-runner.js');
    let rest = queue.filter((q) => !q.resume && !codexBouncedRecently(q.issue.comments && q.issue.comments.nodes, nowMs));
    // --codex (the Codex runner, BRO-5287): drop cards an unattended Codex run cannot finish
    // (Mac-only, too broad) and, within each tier, put the best-suited (small, one-test VERIFY) first.
    if (process.argv.includes('--codex')) {
      const { codexCardFit, codexLadderAccess } = require('./lib/codex-runner.js');
      // The trust ladder (BRO-6303), read once per pick from origin/main: min score, cloud data route, review-texts.
      const ladder = codexLadderAccess();
      console.error(`[cloud-worker-pick] codex ladder: ${ladder.mode} (${ladder.source}) minScore=${ladder.minScore} dataRouteLocked=${ladder.cloudDataRouteLocked} reviewTextsLocked=${ladder.reviewTextsLocked}`);
      const fit = new Map(rest.map((q) => [q, codexCardFit({ title: q.issue.title, description: q.issue.description, verify: verifyCommand(q.issue), comments: q.issue.comments && q.issue.comments.nodes, ladder })]));
      for (const [q, f] of fit) if (f.skip) console.error(`[cloud-worker-pick] codex skip ${q.issue.identifier}: ${f.skip} (${f.why.join(',')})`);
      const tierRank = new Map(rest.map((q) => [q.tier, 0]));
      [...tierRank.keys()].forEach((t, i) => tierRank.set(t, i)); // queue order already goes P0/P1, P2, P3
      rest = rest.filter((q) => !fit.get(q).skip)
        .sort((a, b) => tierRank.get(a.tier) - tierRank.get(b.tier)
          || Number(isStartNow(b.issue, nowMs)) - Number(isStartNow(a.issue, nowMs)) // owner's START-NOW stays first
          || fit.get(b).score - fit.get(a).score);
    }
    const picks = [];
    while (picks.length < listN && rest.length) {
      const chosen = await firstUnpaused(rest, nowMs, historySkipped);
      if (!chosen) break;
      picks.push(pickJson(chosen, nowMs, verifyCommand, isStartNow, modelOf));
      rest.splice(0, rest.indexOf(chosen) + 1);
    }
    console.log(JSON.stringify({ picks, ...counts, historySkipped }, null, 2));
    return;
  }
  // Codex first (BRO-5384): while a Codex runner is live, the Claude worker leaves the cards one
  // Codex firing will take (leaveCodexCards) and works the rest. No live runner (lane skipped,
  // weekly cap, login gone, run over) or unknown bounce state: everything, as before.
  let claudeQueue = queue;
  let leftToCodex = [];
  const codexCap = commentsRead && !process.argv.includes('--no-codex-first') ? codexLiveCap() : 0;
  if (codexCap > 0) {
    const { leaveCodexCards } = require('./lib/cloud-worker-pick.js');
    ({ queue: claudeQueue, left: leftToCodex } = leaveCodexCards(queue, { nowMs, verifyOf: verifyCommand, cap: codexCap }));
  }
  const breaker = await cloudBreaker(nowMs);
  const chosen = await firstUnpaused(claudeQueue, nowMs, historySkipped, breaker.skip);
  const pick = chosen && chosen.issue;
  const resume = chosen && chosen.resume;
  const out = {
    pick: pickJson(chosen, nowMs, verifyCommand, isStartNow, modelOf),
    tier: chosen ? chosen.tier : null,
    ...counts,
    leftToCodex,
    // Resume candidates and eligible cards passed over for an earlier pause.
    historySkipped,
    breaker: breaker.report,
    ...(!chosen && Object.keys(breaker.report.skipped).length && { breakerReason: Object.keys(breaker.report.skipped).join(',') }),
  };
  // Before the JSON: stdout must stay one parseable document.
  await breaker.alert();
  console.log(JSON.stringify(out, null, 2));
  if (resume) {
    // The routine prompt says "new branch"; .claude/CLOUD.md says pick.resume
    // overrides that. Repeat it where a skimming worker will see it.
    console.error(`[cloud-worker-pick] RESUME ${pick.identifier}: follow pick.resume.instructions (land ref ${resume.ref}), not a new branch.`);
  }
}

/**
 * The spend breaker for this firing (BRO-6229, scripts/lib/cloud-worker-breaker.js): reads the
 * last 24h of Claude-lane claims from Linear once, and returns
 *   skip(entry, nodes) -> true when the breaker (enforce mode) skips the card; advisory mode
 *     records it in report.wouldSkip and returns false. Resume entries are never metered.
 *   report -> the `breaker` JSON field.
 *   alert() -> routes the owner alert when the daily cap is reached; never throws.
 */
async function cloudBreaker(nowMs) {
  const brk = require('./lib/cloud-worker-breaker.js');
  const config = brk.breakerConfig();
  const report = { mode: config.mode, dailyCap: config.dailyCap, cardAttemptCap: config.cardAttemptCap, dailyClaims: null, skipped: {}, wouldSkip: [] };
  const noted = new Set(); // a card is checked twice when its comments are fetched late
  if (config.mode === 'off') return { skip: () => false, report, alert: async () => {} };
  try {
    const { listRecentCommentsContaining } = require('./lib/linear-client.js');
    const sinceIso = new Date(nowMs - brk.DAY_MS).toISOString();
    // One query per model: "Worker model:" alone also matches the Codex lane's claims.
    const parts = await Promise.all(brk.CLAUDE_LANE_MODELS.map((m) => listRecentCommentsContaining({ sinceIso, text: `Worker model: ${m}`, max: 2000 })));
    report.dailyClaims = brk.countDailyClaims(parts.flat(), nowMs);
  } catch (err) {
    report.dailyClaimsError = String(err && err.message || err).split('\n')[0];
    console.error(`[cloud-worker-pick] breaker daily count unreadable, daily cap not applied: ${report.dailyClaimsError}`);
  }
  const skip = (entry, nodes) => {
    if (entry.resume) return false;
    const d = brk.breakerDecision({ issue: entry.issue, dailyClaims: report.dailyClaims, cardAttempts: brk.cardAttempts(nodes, nowMs), config });
    if (d.wouldSkip && !noted.has(entry.issue.identifier)) {
      noted.add(entry.issue.identifier);
      report.wouldSkip.push({ identifier: entry.issue.identifier, reason: d.wouldSkip });
      console.error(`[cloud-worker-pick] breaker (advisory) would skip ${entry.issue.identifier}: ${d.wouldSkip}`);
    }
    if (!d.skip) return false;
    report.skipped[d.reason] = (report.skipped[d.reason] || 0) + 1;
    console.error(`[cloud-worker-pick] breaker skip ${entry.issue.identifier}: ${d.reason}`);
    return true;
  };
  const alert = async () => {
    if (!brk.dailyCapReached(report.dailyClaims, config)) return;
    // Off a runner the router's ledger, attempt log and digest queue default to a home-dir file
    // and tracked repo files; neither survives (or belongs in) a cloud worker checkout. The Linear search on
    // the conditionKey is the dedupe that holds here.
    if (!process.env.GITHUB_ACTIONS && !process.env.CI) {
      const tmp = require('os').tmpdir();
      process.env.ALERT_LEDGER_PATH = process.env.ALERT_LEDGER_PATH || require('path').join(tmp, 'cloud-worker-breaker-alert-ledger.json');
      process.env.ALERT_ATTEMPTS_LOG_PATH = process.env.ALERT_ATTEMPTS_LOG_PATH || require('path').join(tmp, 'cloud-worker-breaker-alert-attempts.jsonl');
      process.env.ALERT_DIGEST_QUEUE_PATH = process.env.ALERT_DIGEST_QUEUE_PATH || require('path').join(tmp, 'cloud-worker-breaker-alert-digest.json');
    }
    // The router logs to stdout; the pick JSON owns stdout. Bounded so a Linear retry storm
    // cannot hold the worker's pick.
    const log = console.log;
    console.log = (...a) => console.error(...a);
    let timer;
    let timedOut = false;
    try {
      const { routeAlert } = require('./lib/owner-alert-router.js');
      await Promise.race([
        routeAlert(brk.tripAlert({ dailyClaims: report.dailyClaims, config })),
        new Promise((_, rej) => { timer = setTimeout(() => { timedOut = true; rej(new Error('timed out after 90s')); }, 90_000); }),
      ]);
    } catch (err) {
      console.error(`[cloud-worker-pick] breaker alert failed: ${String(err && err.message || err).split('\n')[0]}`);
    } finally {
      clearTimeout(timer);
      // A timed-out route keeps running and logging: leave it on stderr for good.
      if (!timedOut) console.log = log;
    }
  };
  return { skip, report, alert };
}

// Cards one Codex firing works per lane (docs/cloud-routines/board-workers.md: --slots 3 --limit 9;
// .github/workflows/codex-runner.yml: --lane gha with its default --limit 6).
const CODEX_FIRING_CARDS = { cloud: 9, gha: 6 };

/**
 * Cards the live Codex lanes will take: the sum over lanes holding a run lock
 * (daily-runner.js --lock-status prints "held slots: 0,3"). Unknown or none: 0.
 */
function codexLiveCap() {
  const { spawnSync } = require('child_process');
  const { LANES } = require('./lib/codex-runner.js');
  const r = spawnSync(process.execPath, [require('path').join(__dirname, 'codex', 'daily-runner.js'), '--lock-status', '--lane', 'all'], { encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 3) return 0;
  const m = String(r.stdout || '').match(/^held slots: ([\d,]+)$/m);
  const held = m ? m[1].split(',').map(Number) : [0];
  return Object.entries(LANES).reduce((n, [lane, l]) => n + (held.some((k) => k >= l.base && k < l.base + l.max) ? CODEX_FIRING_CARDS[lane] || 0 : 0), 0);
}

/** `--list=N` as a positive integer, 0 when absent; a malformed value is an error, never the single-pick output. */
function listArg(argv) {
  const a = argv.find((x) => x === '--list' || x.startsWith('--list='));
  if (!a) return 0;
  const n = Number(a.slice('--list='.length));
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[cloud-worker-pick] bad ${a}: want --list=N with N a positive integer`);
    process.exit(2);
  }
  return n;
}

function pickJson(chosen, nowMs, verifyCommand, isStartNow, modelOf) {
  if (!chosen) return null;
  const { issue: pick, resume, tier } = chosen;
  const { model, reason: modelReason } = modelOf(pick);
  return {
    identifier: pick.identifier,
    title: pick.title,
    priority: pick.priority,
    state: pick.state && pick.state.name,
    url: pick.url,
    tier,
    model,
    modelReason,
    verify: verifyCommand(pick),
    // START-NOW is not applied to the P2/P3 tiers (the lib's skipReason), so never report it there.
    startNow: tier === require('./lib/cloud-worker-pick.js').TIER_P0P1 && isStartNow(pick, nowMs),
    ...(resume && {
      resume: {
        landRef: resume.ref,
        lastRun: resume.lastRun,
        kind: resume.kind,
        instructions: RESUME_INSTRUCTIONS(resume.ref, resume.lastRun, resume.kind),
      },
    }),
  };
}

main().catch((err) => {
  console.error(`[cloud-worker-pick] ${err && err.message ? err.message : err}`);
  process.exit(1);
});
