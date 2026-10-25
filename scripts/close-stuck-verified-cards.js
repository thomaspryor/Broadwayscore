#!/usr/bin/env node
/**
 * close-stuck-verified-cards.js — close open cards whose own check already
 * passes on main and whose fix demonstrably landed (BRO-4523). Rules and
 * why they are strict: scripts/lib/stuck-card-closer.js.
 *
 *   node scripts/close-stuck-verified-cards.js                report only
 *   node scripts/close-stuck-verified-cards.js --apply        close eligible cards until the time budget
 *                                                             runs out, 3 Done-gate refusals, or 50 closes
 *   node scripts/close-stuck-verified-cards.js --git-repo P   read commit history from a local clone
 *                                                             instead of the GitHub API
 *   node scripts/close-stuck-verified-cards.js --only BRO-N   consider just one card
 *
 * Input: data/audit/done-evidence-audit.json (written earlier the same run of
 * data-health-check.yml). Output: data/audit/stuck-card-closer.json.
 * Closes through linear-brain.js, so the Done gate re-runs the check on a
 * fresh origin/main checkout. Exit 0 on success (including nothing to do and
 * a stale audit), 2 for a shallow --git-repo, 3 when the audit, Linear or
 * GitHub could not be read.
 * Kill switch: STUCK_CARD_CLOSER_KILL_SWITCH=1 (or true).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  planCandidates, decideClosure, parseLandingRows, buildClosureComment, closeRunStopReason,
  decideBounce, buildBounceComment, MAX_BOUNCES, MAX_BOUNCES_PER_RUN, MAX_REFUSALS_PER_RUN,
  planInReviewSweep, decideSweep, buildSweepBounceComment, buildSweepClosureComment, buildSweepRefusedComment, MAX_SWEEP_PER_RUN,
} = require('./lib/stuck-card-closer.js');

const REPO = path.join(__dirname, '..');
const AUDIT = path.join(REPO, 'data', 'audit', 'done-evidence-audit.json');
const OUT = path.join(REPO, 'data', 'audit', 'stuck-card-closer.json');
const LANDINGS = path.join(REPO, 'data', 'audit', 'landings.jsonl');
const TIME_BUDGET_MS = 18 * 60 * 1000;
// One close re-runs the card's check through the Done gate; never start one
// that could outlive the workflow step (25 min) if it hits its own timeout.
const CLOSE_TIMEOUT_MS = 5 * 60 * 1000;
const GH_REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const USAGE = 'Usage: node scripts/close-stuck-verified-cards.js [--apply] [--git-repo <path>] [--only BRO-N]';

const ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) {
    identifier title priority createdAt updatedAt description
    state { name type }
    comments(first: 250) { nodes { body createdAt } }
  }
}`;

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

function gitCommitsTouching(gitRepo) {
  return async (testPath, sinceIso) => {
    const out = execFileSync('git', ['-C', gitRepo, 'log', 'HEAD', `--since=${sinceIso}`, '--format=%H%x00%B%x1e', '--', testPath],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
      const [sha, message] = s.split('\x00');
      return { sha, message };
    });
  };
}

function apiCommitsTouching() {
  const { fetchGitHubJSON } = require('./lib/gh-api-client.js');
  return async (testPath, sinceIso) => {
    const commits = [];
    for (let page = 1; page <= 5; page++) {
      const url = `https://api.github.com/repos/${GH_REPO}/commits?sha=main&path=${encodeURIComponent(testPath)}&since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`;
      const batch = await fetchGitHubJSON(url);
      if (!Array.isArray(batch)) break;
      for (const c of batch) commits.push({ sha: c.sha, message: (c.commit && c.commit.message) || '' });
      if (batch.length < 100) break;
    }
    return commits;
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  if (['1', 'true'].includes(process.env.STUCK_CARD_CLOSER_KILL_SWITCH)) {
    console.log('[close-stuck-verified-cards] STUCK_CARD_CLOSER_KILL_SWITCH set, skipping');
    return 0;
  }
  const apply = argv.includes('--apply');
  const only = argValue(argv, '--only');
  const gitRepo = argValue(argv, '--git-repo');
  const nowMs = Date.now();
  const startMs = nowMs;
  const out = { generatedAt: new Date(nowMs).toISOString(), apply, auditGeneratedAt: null, counts: {}, rows: [] };
  const count = (k) => { out.counts[k] = (out.counts[k] || 0) + 1; };
  const write = () => { if (!deps.noWrite) fs.writeFileSync(deps.outPath || OUT, `${JSON.stringify(out, null, 2)}\n`); };
  const fail = (code, msg) => {
    console.error(`[close-stuck-verified-cards] ${msg}`);
    out.error = msg;
    write();
    return code;
  };

  // A shallow clone hides older landing commits, so every card would read as
  // "no commit" and the report would quietly understate what can close.
  if (gitRepo && !deps.commitsTouching) {
    let shallow;
    try {
      shallow = execFileSync('git', ['-C', gitRepo, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
    } catch (err) {
      return fail(3, `--git-repo ${gitRepo} is not readable: ${err.message.split('\n')[0]}`);
    }
    if (shallow === 'true') return fail(2, `--git-repo ${gitRepo} is a shallow clone; drop --git-repo to use the GitHub API`);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(deps.auditPath || AUDIT, 'utf8'));
  } catch (err) {
    return fail(3, `could not read the done-evidence audit: ${err.message.split('\n')[0]}`);
  }
  out.auditGeneratedAt = report.generatedAt || null;
  const linear = deps.linear || require('./lib/linear-client.js');
  const commitsTouching = deps.commitsTouching || (gitRepo ? gitCommitsTouching(gitRepo) : apiCommitsTouching());
  const plan = planCandidates(report, nowMs);
  // Evidence for non-test commands (BRO-4814). Read once per run; a missing
  // file means no card can close on this evidence, never that all can.
  let landings = deps.landings;
  if (!landings) {
    try {
      landings = parseLandingRows(fs.readFileSync(deps.landingsPath || LANDINGS, 'utf8'));
    } catch (err) {
      // Visible, not silent: every non-test card reads "no-landing-naming-card"
      // this run, and the report says why.
      console.error(`[close-stuck-verified-cards] landings.jsonl unreadable (${err.code || err.message}); non-test cards cannot close this run`);
      count('landings-unreadable');
      landings = [];
    }
  }

  if (plan.error) {
    console.log(`[close-stuck-verified-cards] ${plan.error}; nothing to do`);
    out.error = plan.error;
    write();
    return 0;
  }
  Object.assign(out.counts, Object.fromEntries(Object.entries(plan.skipped).map(([k, v]) => [`skip:${k}`, v])));
  const candidates = only ? plan.candidates.filter((c) => c.id === only) : plan.candidates;
  let closed = 0;
  let refused = 0;
  let exitCode = 0;

  // Bounces first: each is one Linear write with no re-run of the check, so
  // ten of them cost seconds, while closes spend the time budget.
  const bounces = only ? plan.bounces.filter((b) => b.id === only) : plan.bounces;
  let bounced = 0;
  // Bounces get a third of the time budget so a slow Linear can't eat the
  // closes, and a failed read skips that one card instead of the whole run.
  for (const candidate of bounces) {
    if (Date.now() - startMs > TIME_BUDGET_MS / 3) { count('bounce:over-time-budget'); continue; }
    let issue;
    try {
      const data = await linear.graphql(ISSUE_QUERY, { id: candidate.id });
      issue = data && data.issue ? { ...data.issue, comments: (data.issue.comments && data.issue.comments.nodes) || [] } : null;
    } catch (err) {
      console.error(`[close-stuck-verified-cards] could not read ${candidate.id}: ${err.message}`);
      count('bounce:read-failed');
      out.rows.push({ id: candidate.id, action: 'read-failed', reason: err.message.slice(0, 200) });
      exitCode = 3;
      continue;
    }
    const decision = decideBounce({ candidate, issue, nowMs });
    if (!decision.bounce) {
      count(`bounce:${decision.reason}`);
      out.rows.push({ id: candidate.id, state: candidate.state, action: decision.reason === 'bounce-exhausted' ? 'bounce-exhausted' : 'leave', reason: decision.reason });
      continue;
    }
    if (!apply) {
      count('would-bounce');
      console.log(`would bounce ${candidate.id} to Todo (check fails on main; bounce ${decision.priorBounces + 1} of ${MAX_BOUNCES})`);
      out.rows.push({ id: candidate.id, state: candidate.state, action: 'would-bounce' });
      continue;
    }
    if (bounced >= MAX_BOUNCES_PER_RUN) { count('bounce:over-run-cap'); continue; }
    const comment = buildBounceComment({ candidate, priorBounces: decision.priorBounces, auditGeneratedAt: report.generatedAt });
    const r = (deps.spawn || spawnSync)('node', [path.join(__dirname, 'linear-brain.js'), 'update', candidate.id, '--state', 'Todo', '--comment', comment],
      { cwd: REPO, encoding: 'utf8', timeout: CLOSE_TIMEOUT_MS });
    if (r.status === 0) {
      bounced++;
      count('bounced');
      console.log(`bounced ${candidate.id} to Todo`);
      out.rows.push({ id: candidate.id, state: candidate.state, action: 'bounced' });
    } else {
      count('bounce-failed');
      const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
      console.error(`bounce-failed for ${candidate.id}: ${tail}`);
      out.rows.push({ id: candidate.id, state: candidate.state, action: 'bounce-failed', reason: tail });
    }
    write();
  }

  for (const candidate of candidates) {
    if (Date.now() - startMs > TIME_BUDGET_MS) { count('over-time-budget'); continue; }
    let issue;
    let commits;
    try {
      const data = await linear.graphql(ISSUE_QUERY, { id: candidate.id });
      issue = data && data.issue ? { ...data.issue, comments: (data.issue.comments && data.issue.comments.nodes) || [] } : null;
      commits = issue && candidate.testPath ? await commitsTouching(candidate.testPath, issue.createdAt) : [];
    } catch (err) {
      console.error(`[close-stuck-verified-cards] could not read ${candidate.id}: ${err.message}`);
      out.rows.push({ id: candidate.id, action: 'read-failed', reason: err.message.slice(0, 200) });
      exitCode = 3;
      break;
    }
    const decision = decideClosure({ candidate, issue, commits, landings, nowMs });
    if (!decision.close) {
      count(decision.reason);
      out.rows.push({ id: candidate.id, state: candidate.state, action: 'leave', reason: decision.reason });
      continue;
    }
    if (!apply) {
      count('would-close');
      console.log(`would close ${candidate.id} (${candidate.state}; commit ${decision.sha.slice(0, 9)}, ${decision.evidence})`);
      out.rows.push({ id: candidate.id, state: candidate.state, action: 'would-close', sha: decision.sha });
      continue;
    }
    const stop = closeRunStopReason({ closed, refused, remainingMs: TIME_BUDGET_MS - (Date.now() - startMs), closeTimeoutMs: CLOSE_TIMEOUT_MS });
    if (stop) { count(stop); continue; }
    const comment = buildClosureComment({ candidate, sha: decision.sha, auditGeneratedAt: report.generatedAt });
    const r = (deps.spawn || spawnSync)('node', [path.join(__dirname, 'linear-brain.js'), 'update', candidate.id, '--state', 'Done', '--comment', comment],
      { cwd: REPO, encoding: 'utf8', timeout: CLOSE_TIMEOUT_MS });
    if (r.status === 0) {
      closed++;
      count('closed');
      console.log(`closed ${candidate.id} (commit ${decision.sha.slice(0, 9)})`);
      out.rows.push({ id: candidate.id, state: candidate.state, action: 'closed', sha: decision.sha });
      write(); // a killed step must not lose the record of a close that already happened
    } else {
      const why = r.status === 5 ? 'gate-refused' : 'close-failed';
      refused++;
      count(why);
      const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
      console.error(`${why} for ${candidate.id}: ${tail}`);
      out.rows.push({ id: candidate.id, state: candidate.state, action: why, reason: tail });
      write();
    }
  }
  // In Review sweep (BRO-5433): technical cards the audit paths above never
  // touch. Close through the Done gate when the card carries evidence; if the
  // gate refuses, or there is none, send it back to a worker (shared bounce
  // cap) so it neither sits unseen nor reaches the owner as a decision.
  let swept = 0;
  let sweepAttempts = 0;
  let sweepRefusals = 0;
  try {
    const handled = new Set([...plan.candidates, ...plan.bounces].map((c) => c.id));
    let sweepIds = planInReviewSweep(await linear.listOpenIssues(), nowMs, handled);
    if (only) sweepIds = sweepIds.filter((id) => id === only);
    count('sweep:eligible');
    out.counts['sweep:eligible'] = sweepIds.length;
    for (const id of sweepIds) {
      // Same breaker as the audit path: when the gate keeps refusing what the
      // sweep picked, the two disagree and more closes would be guessing.
      if (sweepRefusals >= MAX_REFUSALS_PER_RUN) { count('sweep:refusal-breaker'); continue; }
      if (sweepAttempts >= MAX_SWEEP_PER_RUN) { count('sweep:over-run-cap'); continue; }
      if (Date.now() - startMs > TIME_BUDGET_MS - CLOSE_TIMEOUT_MS) { count('sweep:over-time-budget'); continue; }
      let issue;
      try {
        const data = await linear.graphql(ISSUE_QUERY, { id });
        issue = data && data.issue ? { ...data.issue, comments: (data.issue.comments && data.issue.comments.nodes) || [] } : null;
      } catch (err) {
        console.error(`[close-stuck-verified-cards] could not read ${id}: ${err.message}`);
        count('sweep:read-failed');
        out.rows.push({ id, action: 'read-failed', reason: err.message.slice(0, 200) });
        exitCode = 3;
        continue;
      }
      let decision = decideSweep({ issue, nowMs });
      if (decision.action === 'leave') {
        count(`sweep:${decision.reason}`);
        out.rows.push({ id, state: 'In Review', action: 'sweep-leave', reason: decision.reason });
        continue;
      }
      if (!apply) {
        count(`sweep:would-${decision.action}`);
        console.log(`would ${decision.action} ${id} (In Review sweep)`);
        out.rows.push({ id, state: 'In Review', action: `sweep-would-${decision.action}` });
        continue;
      }
      sweepAttempts++;
      if (decision.action === 'try-close') {
        const r = (deps.spawn || spawnSync)('node', [path.join(__dirname, 'linear-brain.js'), 'update', id, '--state', 'Done', '--comment', buildSweepClosureComment()],
          { cwd: REPO, encoding: 'utf8', timeout: CLOSE_TIMEOUT_MS });
        if (r.status === 0) {
          swept++;
          count('sweep:closed');
          console.log(`closed ${id} (In Review sweep)`);
          out.rows.push({ id, state: 'In Review', action: 'sweep-closed' });
          write();
          continue;
        }
        if (r.status !== 5) {
          // Timeout (status null), crash or Linear error: not a verdict on the card.
          count('sweep:close-failed');
          const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
          console.error(`sweep close-failed for ${id}: ${tail}`);
          out.rows.push({ id, state: 'In Review', action: 'sweep-close-failed', reason: tail });
          continue;
        }
        sweepRefusals++;
        decision = decideSweep({ issue, nowMs, gateRefused: true });
        if (decision.action !== 'bounce') {
          count(`sweep:${decision.reason}`);
          out.rows.push({ id, state: 'In Review', action: 'sweep-leave', reason: `gate-refused, ${decision.reason}` });
          // Cooldown marker (comment only, no state change) so tomorrow's run
          // does not re-run this card's check first and starve newer cards.
          (deps.spawn || spawnSync)('node', [path.join(__dirname, 'linear-brain.js'), 'update', id, '--comment', buildSweepRefusedComment()],
            { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
          continue;
        }
      }
      const r = (deps.spawn || spawnSync)('node', [path.join(__dirname, 'linear-brain.js'), 'update', id, '--state', 'Todo',
        '--comment', buildSweepBounceComment({ priorBounces: decision.priorBounces })],
      { cwd: REPO, encoding: 'utf8', timeout: CLOSE_TIMEOUT_MS });
      if (r.status === 0) {
        bounced++;
        count('sweep:bounced');
        console.log(`bounced ${id} to Todo (In Review sweep)`);
        out.rows.push({ id, state: 'In Review', action: 'sweep-bounced' });
      } else {
        count('sweep:bounce-failed');
        const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
        console.error(`sweep bounce-failed for ${id}: ${tail}`);
        out.rows.push({ id, state: 'In Review', action: 'sweep-bounce-failed', reason: tail });
      }
      write();
    }
  } catch (err) {
    console.error(`[close-stuck-verified-cards] In Review sweep skipped: ${err.message}`);
    count('sweep:list-failed');
  }
  console.log(`[close-stuck-verified-cards] candidates ${candidates.length}, bounces ${bounces.length}; ${apply ? `closed ${closed}, bounced ${bounced}, swept ${swept}; ` : ''}${JSON.stringify(out.counts)}`);
  write();
  return exitCode;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[close-stuck-verified-cards] ${err.stack || err.message}`);
    process.exitCode = 3;
  });
}

module.exports = { main };
