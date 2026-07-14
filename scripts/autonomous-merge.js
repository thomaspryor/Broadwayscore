#!/usr/bin/env node
/**
 * autonomous-merge.js — CI-side merge/revert executor for the autonomous
 * nightly loop (Sprint 3: S3-T1 merge, S3-T2 oscillation breaker, S3-T3
 * revert). Invoked by .github/workflows/autonomous-merge.yml via
 * workflow_dispatch — this is the ONLY place a branch the loop produced
 * reaches main; the Mac Studio executor only ever pushes `auto/*` branches.
 *
 *   node scripts/autonomous-merge.js --card <notion-id> --branch <name> --action approve|revert
 *
 * approve: rebase the branch onto origin/main → re-run tsc + colocated tests
 *   + the card's checkableDone (fetched from a Notion comment — the
 *   executor's own ledger is Mac-Studio-local, unreachable from GitHub
 *   Actions) → eligibility gate on the REBASED diff → oscillation check
 *   (git history on main, NOT the ledger — see scripts/lib/autonomous-merge-core.js)
 *   → merge via scripts/lib/push-with-retry.sh → Auto=merged, Status=Done,
 *   evidence on the card. ANY failure strips the approval (Auto→needs-approval,
 *   scripts/lib/autonomous-state.js merge.reverify-fail) — a fresh tap is
 *   required to try again; the branch itself is left untouched.
 *
 *   Re-verification is re-run (rebase + gate + checks) on EVERY merge
 *   attempt, not just the first — this repo pushes to main constantly from
 *   ~200 other workflows, so a fast-forward race is common, not theoretical
 *   (ship-check finding). The autonomous-merge.yml concurrency group is a
 *   single GLOBAL key (not per-card) so two cards' merges never run at the
 *   same time either — the remaining race is only against the rest of main's
 *   traffic, which the retry loop below re-verifies against each time.
 *
 * revert: only legal from Auto=merged. Locates the merge commit via its
 *   "Auto-merge-card: <id>" trailer and reverts the FULL range back to the
 *   "Auto-merge-base: <sha>" trailer stamped alongside it (a branch can carry
 *   more than one commit — reverting only the last one would silently leave
 *   earlier commits on main). Pushes, reopens the card.
 *
 * Tier-2 (Sprint 4, S4-T4): a data card's branch lives on a PRIVATE repo's
 * origin (~broadway-scorecard-data or broadway-review-texts), never on this
 * repo's — attemptDataCard() (scripts/autonomous-run.js) pushes there, not
 * here. approve()/revert() detect this by fetching the branch's Notion
 * evidence comment FIRST (before touching any git state) and checking for
 * evidence.repoKey — set only by the Tier-2 executor
 * (scripts/lib/autonomous-notion-evidence.js) — then delegate to
 * approveDataCard()/revertDataCard() below, which clone the private repo
 * fresh (REVIEW_TEXTS_TOKEN — the same PAT push-core-data/push-review-texts
 * already use for both private repos) and run the identical
 * rebase→gate→verify→ff-merge→push shape as the Tier-1 path, just scoped to
 * that clone instead of this repo's checkout. review-texts merges dispatch
 * "Rebuild Reviews (Fast)" afterward so the change actually reaches
 * reviews.json/the live site.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const { transition } = require('./lib/autonomous-state.js');
const { isDiffAllowed, isDataRepoDiffAllowed } = require('./lib/autonomous-eligibility.js');
const { decideChecks, cardCheckArgv } = require('./lib/autonomous-run-core.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { latestEvidenceForBranch } = require('./lib/autonomous-notion-evidence.js');
const { verifierArgvFor } = require('./lib/autonomous-data-verify.js');
const { showIdsFromReviewTextsDiff } = require('./lib/autonomous-data-workdir.js');
const {
  BASE_TRAILER_PREFIX, oscillationTrailerFor, stripTrailers, parseBaseTrailer, shouldEscalateOscillation,
  buildEscalationNote, buildMergeOutcomeNote, buildReverifyFailNote, buildRevertOutcomeNote,
} = require('./lib/autonomous-merge-core.js');

const REPO = path.join(__dirname, '..');
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_MERGE_ATTEMPTS = 2;

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) { a[t.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function gitOrNull(args, opts = {}) {
  try { return git(args, opts); } catch { return null; }
}

// Tier-2 (Sprint 4): a data card's branch lives on one of these private
// repos' own origin, never this repo's. Same repoKey vocabulary as
// scripts/lib/autonomous-eligibility.js DATA_CLASS_REPO.
const DATA_REPO_URLS = {
  'scorecard-data': 'https://github.com/thomaspryor/broadway-scorecard-data.git',
  'review-texts': 'https://github.com/thomaspryor/broadway-review-texts.git',
};

// Fresh clone per merge attempt (no local-checkout reuse across CI runs) —
// this is a one-shot workflow job, and a stale cached clone risks rebasing
// against an out-of-date origin/main for a repo other workflows commit to
// every ~30min. Mirrors the token-embed-in-remote-url pattern push-core-data
// and mirror-data-to-gitlab.yml already use for these same two repos.
// Redacts an embedded PAT out of an error message before it reaches a log or
// a Notion outcome note. Node's execFileSync puts the FULL argv (including a
// literal token in a clone/remote-set-url URL) into err.message on failure —
// confirmed live (ship-check finding, 2026-07-14): "Command failed: git
// clone https://x-access-token:<TOKEN>@github.com/..." — git's own stderr on
// an auth failure can also embed the credentialed URL. Applied at every exit
// point that could carry a raw error (the top-level fatal handler, and any
// Notion outcome note built from a caught error), not just inside
// cloneDataRepo, since the token stays live on the clone's remote for the
// rest of the run (fetch/push errors can surface it too).
function redactSecrets(text) {
  const token = process.env.REVIEW_TEXTS_TOKEN;
  const s = String(text == null ? '' : text);
  return token ? s.split(token).join('***REDACTED***') : s;
}

function cloneDataRepo(repoKey, token) {
  const url = DATA_REPO_URLS[repoKey];
  if (!url) throw new Error(`cloneDataRepo: unknown repoKey "${repoKey}"`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `auto-merge-data-${repoKey}-`));
  const authedUrl = url.replace('https://', `https://x-access-token:${token}@`);
  try {
    // --filter=blob:none (partial clone): keeps the FULL commit graph — the
    // oscillation breaker (countPriorMerges) greps origin/main history for a
    // trailer and would go blind past a shallow --depth cutoff — while
    // deferring file *content* fetch to on-demand. review-texts is a 39k-file
    // private repo; a plain full clone hung past a 2-minute timeout live
    // (ship-check finding), where a blob:none clone of the same repo
    // completed in ~40s with identical history depth.
    execFileSync('git', ['clone', '--filter=blob:none', authedUrl, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(redactSecrets(err.message));
  }
  git(['remote', 'set-url', 'origin', authedUrl], { cwd: dir });
  // A fresh clone has no committer identity — `git rebase` needs one even on
  // a clean fast-forward replay (no conflicts), unlike a plain checkout.
  // Caught live-fire (2026-07-14): the first real dispatch failed re-verify
  // with "Committer identity unknown" before ever reaching the merge step.
  git(['config', 'user.name', 'github-actions[bot]'], { cwd: dir });
  git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: dir });
  return dir;
}

function dispatchRebuildFast(cardId) {
  try {
    execFileSync('gh', ['workflow', 'run', 'Rebuild Reviews (Fast)', '-f', `reason=autonomous data-card merge ${cardId}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('[merge] dispatched Rebuild Reviews (Fast)');
  } catch (err) {
    console.error(`[merge] WARN could not dispatch Rebuild Reviews (Fast): ${String(err.message).slice(0, 200)}`);
  }
}

function notionBrain(args) {
  const out = execFileSync('node', [path.join(__dirname, 'notion-brain.js'), ...args], {
    cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  return JSON.parse(out);
}

function notionUpdate(id, flags) {
  execFileSync('node', [path.join(__dirname, 'notion-brain.js'), 'update', id, ...flags], {
    cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'], env: process.env,
  });
}

function httpsJson(method, hostname, apiPath, headers, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname, path: apiPath, method,
      headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
      timeout: 15000,
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (data) req.write(data);
    req.end();
  });
}

// Paginated: a long-lived card can accumulate more than one page of comments
// (100/page) across retries and nights — stopping at page 1 would silently
// miss the real evidence and fall back to a weaker re-verify (ship-check).
// Hard cap of 10 pages (1000 comments) as a runaway backstop.
async function fetchEvidenceForBranch(cardId, branch) {
  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) return null;
  const all = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const qs = `block_id=${encodeURIComponent(cardId)}&page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await httpsJson('GET', 'api.notion.com', `/v1/comments?${qs}`,
      { Authorization: `Bearer ${notionKey}`, 'Notion-Version': '2022-06-28' });
    if (res.status !== 200 || !res.json || !Array.isArray(res.json.results)) break;
    all.push(...res.json.results);
    if (!res.json.has_more || !res.json.next_cursor) break;
    cursor = res.json.next_cursor;
  }
  if (!all.length) return null;
  return latestEvidenceForBranch(all, branch);
}

// Rule 17: transactional only, direct POST to one explicit owner address —
// never a broadcast/audience endpoint. Fail-soft: never crashes the merge run.
async function sendEscalationEmail(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.OWNER_EMAIL;
  if (!apiKey || !to) { console.error('[merge] WARN cannot send escalation email (missing RESEND_API_KEY or OWNER_EMAIL)'); return; }
  const res = await httpsJson('POST', 'api.resend.com', '/emails', { Authorization: `Bearer ${apiKey}` }, {
    from: 'Broadway Scorecard <alerts@broadwayscorecard.com>', to: [to], subject,
    html: `<pre style="white-space:pre-wrap;font-family:-apple-system,sans-serif;">${text}</pre>`,
  });
  if (res.status < 200 || res.status >= 300) console.error(`[merge] WARN escalation email send failed: ${res.status}`);
}

// Checks execute implementer-AUTHORED code (a test file from a card the loop
// implemented) — deterministic-green diffs merge with NO human ever reading
// this content. The workflow env carries NOTION_API_KEY / RESEND_API_KEY /
// a contents:write GH token; none of that may be reachable from the check
// process. Mirrors scripts/autonomous-run.js checksEnv() (same threat, same
// fix) — ship-check P0 2026-07-14: this CI-side re-verify had inherited the
// full secret env while the Mac-side executor was already sandboxed.
function checksEnv() {
  const keep = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'NODE_ENV'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-merge-checks-home-'));
  env.HOME = fakeHome;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function runChecks(files, checkableDone) {
  const results = [];
  const checks = decideChecks(files, f => fs.existsSync(path.join(REPO, f)));
  if (checkableDone) {
    const cardArgv = cardCheckArgv(checkableDone, isSafeCheckCommand);
    if (cardArgv) checks.push({ name: `card-check (${checkableDone})`, argv: cardArgv });
    // Unsafe/invalid checkableDone must FAIL closed, not silently vanish —
    // the Mac-side executor already does this (autonomous-run.js runChecks);
    // this CI-side path had been dropping it instead (ship-check finding).
    else results.push({ name: 'card-check', pass: false, detail: `checkableDone failed safe-form validation: ${String(checkableDone).slice(0, 120)}` });
  }
  const env = checksEnv();
  for (const c of checks) {
    try {
      execFileSync(c.argv[0], c.argv.slice(1), { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT_MS, encoding: 'utf8', env });
      results.push({ name: c.name, pass: true });
    } catch (err) {
      results.push({ name: c.name, pass: false, detail: String(err.stderr || err.stdout || err.message).slice(0, 400) });
    }
  }
  return results;
}

function pushMain() {
  execFileSync('bash', [path.join(__dirname, 'lib', 'push-with-retry.sh'), '7', 'main'], { cwd: REPO, stdio: 'inherit' });
}

function countPriorMerges(cardId, cwd = REPO) {
  const trailer = oscillationTrailerFor(cardId);
  return (gitOrNull(['log', '--fixed-strings', '--grep', trailer, '--format=%H', 'origin/main'], { cwd }) || '')
    .trim().split('\n').filter(Boolean).length;
}

// Tier-2 mirror of verifyRebase(): rebases the ALREADY-CLONED private-repo
// checkout onto its own origin/main, gates the rebased diff against
// isDataRepoDiffAllowed, then runs the class's deterministic verifier(s)
// (scripts/lib/autonomous-data-verify.js — NOT checkableDone; Tier-2 has no
// LLM-authored check). Builds a scratch verification root shaped like this
// repo's data/ layout (same contract attemptDataCard() already proved out —
// see scripts/lib/autonomous-data-workdir.js), symlinked straight at `dir`
// itself: no separate worktree layer needed since `dir` IS the candidate
// tree post-rebase, unlike the executor's build-a-fresh-branch-off-main case.
function verifyRebaseData(dir, repoKey, cls, evidence) {
  try { git(['rebase', 'origin/main'], { cwd: dir }); }
  catch (err) {
    gitOrNull(['rebase', '--abort'], { cwd: dir });
    return { ok: false, reason: `branch would not rebase cleanly onto ${repoKey}'s origin/main: ${redactSecrets(String(err.message).slice(0, 300))}` };
  }
  const files = git(['diff', '--name-only', 'origin/main...HEAD'], { cwd: dir }).trim().split('\n').filter(Boolean);
  if (!files.length) return { ok: false, reason: 'rebased diff is empty — nothing to merge' };
  const gate = isDataRepoDiffAllowed(repoKey, files);
  if (!gate.allowed) return { ok: false, reason: `rebased diff touches ineligible paths in ${repoKey}: ${gate.refused.join(', ')}` };

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-merge-data-verify-'));
  const dataDir = path.join(scratchRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (repoKey === 'scorecard-data') fs.symlinkSync(path.join(dir, 'shows.json'), path.join(dataDir, 'shows.json'));
  else fs.symlinkSync(dir, path.join(dataDir, 'review-texts'));

  const showIds = repoKey === 'review-texts' ? showIdsFromReviewTextsDiff(files) : ((evidence && evidence.showIds) || []);
  const verifiers = verifierArgvFor(cls, { dataDir, showIds });
  if (!verifiers.length) return { ok: false, reason: `class "${cls}" has no verifier command for this diff (showIds: ${showIds.join(', ') || 'none'})` };

  const env = checksEnv();
  for (const v of verifiers) {
    try {
      execFileSync(v.argv[0], v.argv.slice(1), { cwd: scratchRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: CHECK_TIMEOUT_MS, encoding: 'utf8', env });
    } catch (err) {
      return { ok: false, reason: `${v.name}: ${redactSecrets(String(err.stderr || err.stdout || err.message).slice(0, 400))}` };
    }
  }
  return { ok: true, files, showIds };
}

// Rebase auto-merge-work onto the CURRENT origin/main, then re-run the full
// gate: diff eligibility + checks. Called fresh on every merge attempt (not
// just the first) so a rebase from attempt 1 can never be reused to verify
// a DIFFERENT tree after main has advanced again (ship-check finding).
function verifyRebase(evidence) {
  try { git(['rebase', 'origin/main']); }
  catch (err) {
    gitOrNull(['rebase', '--abort']);
    return { ok: false, reason: `branch would not rebase cleanly onto origin/main: ${String(err.message).slice(0, 300)}` };
  }
  const files = git(['diff', '--name-only', 'origin/main...HEAD']).trim().split('\n').filter(Boolean);
  if (!files.length) return { ok: false, reason: 'rebased diff is empty — nothing to merge' };
  const gate = isDiffAllowed(files);
  if (!gate.allowed) return { ok: false, reason: `rebased diff touches ineligible paths: ${gate.refused.join(', ')}` };
  const checks = runChecks(files, evidence ? evidence.checkableDone : null);
  const failed = checks.filter(c => !c.pass);
  if (failed.length) return { ok: false, reason: failed.map(c => `${c.name}: ${c.detail}`).join(' | ').slice(0, 500) };
  return { ok: true, files };
}

async function approve(cardId, branch) {
  const card = notionBrain(['get', cardId]);
  if (card.auto !== 'approved') {
    console.log(`[merge] card ${cardId} is Auto=${card.auto || 'none'}, not 'approved' — nothing to do (state moved underneath us, or already handled)`);
    return;
  }

  // Evidence is fetched FIRST, before any git state on THIS repo: a Tier-2
  // (data card) branch was never pushed to Broadwayscore's origin, so
  // `git fetch origin <branch>` below would fail for one. evidence.repoKey
  // (stamped only by the Tier-2 executor) is the signal — a Tier-1 evidence
  // comment or a missing one both leave repoKey null/absent.
  const evidence = await fetchEvidenceForBranch(cardId, branch);
  if (evidence && evidence.repoKey) return approveDataCard(cardId, branch, card, evidence);
  if (!evidence) console.error('[merge] WARN no Notion evidence comment found for this branch — re-verifying with tsc + colocated tests only (no card-specific check)');

  // Oscillation breaker (S3-T2): git history on main, not the (Mac-local,
  // unreachable-from-CI) ledger — see scripts/lib/autonomous-merge-core.js.
  git(['fetch', 'origin', 'main']);
  const trailer = oscillationTrailerFor(cardId);
  const priorMerges = countPriorMerges(cardId);
  if (shouldEscalateOscillation(priorMerges)) {
    transition('approved', 'merge.oscillation');
    notionUpdate(cardId, ['--auto', 'failed', '--outcome', buildEscalationNote(cardId, priorMerges)]);
    await sendEscalationEmail(`⚠️ Autonomous loop: "${card.name}" already merged ${priorMerges}x — refusing`, buildEscalationNote(cardId, priorMerges));
    console.error(`[merge] OSCILLATION: card ${cardId} already merged ${priorMerges} time(s) — refusing, escalated to owner`);
    process.exitCode = 1;
    return;
  }

  const reverifyFail = (reason) => {
    transition('approved', 'merge.reverify-fail');
    notionUpdate(cardId, ['--auto', 'needs-approval', '--outcome', buildReverifyFailNote(reason)]);
    console.error(`[merge] RE-VERIFY FAILED: ${reason}`);
    process.exitCode = 1;
  };

  git(['fetch', 'origin', branch]);
  git(['checkout', '-B', 'auto-merge-work', `origin/${branch}`]);

  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      git(['fetch', 'origin', 'main']);
      git(['checkout', 'auto-merge-work']);
    }
    const verified = verifyRebase(evidence);
    if (!verified.ok) {
      if (attempt === MAX_MERGE_ATTEMPTS) { reverifyFail(verified.reason); return; }
      console.error(`[merge] attempt ${attempt} verify failed (${verified.reason.slice(0, 120)}) — retrying against fresh origin/main`);
      continue;
    }

    // Stamp trailers on the last commit right before merging: the card id
    // (oscillation grep) and the base sha this rebase verified against (so
    // revert() can undo the FULL range, not just this one commit). Cleaned
    // first so a retry's re-stamp is idempotent (see stripTrailers above).
    const baseSha = git(['rev-parse', 'origin/main']).trim();
    const priorMsg = stripTrailers(git(['log', '-1', '--pretty=%B']).trim(), trailer);
    git(['commit', '--amend', '-m', `${priorMsg}\n\n${trailer}\n${BASE_TRAILER_PREFIX}${baseSha}`]);
    const sha = git(['rev-parse', 'HEAD']).trim();

    git(['checkout', 'main']);
    git(['reset', '--hard', 'origin/main']);
    try {
      git(['merge', '--ff-only', 'auto-merge-work']);
    } catch {
      if (attempt === MAX_MERGE_ATTEMPTS) {
        reverifyFail('main advanced repeatedly during the merge window and a clean fast-forward was not possible after retrying');
        return;
      }
      console.error(`[merge] attempt ${attempt} fast-forward lost a race against origin/main — retrying`);
      git(['checkout', 'auto-merge-work']);
      continue;
    }

    pushMain();
    transition('approved', 'merge.success');
    notionUpdate(cardId, ['--auto', 'merged', '--status', 'Done', '--outcome', buildMergeOutcomeNote({ sha, branch, files: verified.files })]);
    console.log(`[merge] MERGED card ${cardId} (${sha}) from ${branch}`);
    return;
  }
}

async function revert(cardId, branch) {
  const card = notionBrain(['get', cardId]);
  if (card.auto !== 'merged') {
    console.log(`[merge] card ${cardId} is Auto=${card.auto || 'none'}, not 'merged' — nothing to revert`);
    return;
  }

  const evidence = await fetchEvidenceForBranch(cardId, branch);
  if (evidence && evidence.repoKey) return revertDataCard(cardId, evidence);

  git(['fetch', 'origin', 'main']);
  const trailer = oscillationTrailerFor(cardId);
  const mergeSha = (gitOrNull(['log', '--fixed-strings', '--grep', trailer, '--format=%H', '-1', 'origin/main']) || '').trim();
  if (!mergeSha) {
    console.error(`[merge] REVERT FAILED: no commit on origin/main carries "${trailer}" — cannot safely locate the merge to revert`);
    process.exitCode = 1;
    return;
  }
  const mergeMsg = git(['log', '-1', '--format=%B', mergeSha]);
  const baseSha = parseBaseTrailer(mergeMsg);

  git(['checkout', 'main']);
  git(['reset', '--hard', 'origin/main']);
  let revertSha;
  try {
    if (baseSha && gitOrNull(['cat-file', '-e', baseSha])) {
      // Range revert: undoes EVERY commit the merge brought in (a branch can
      // carry more than one commit), not just the last one — a single-commit
      // revert would silently leave earlier commits on main (ship-check finding).
      git(['revert', '--no-commit', `${baseSha}..${mergeSha}`]);
      git(['commit', '-m', `Revert autonomous merge for card ${cardId} (${baseSha.slice(0, 7)}..${mergeSha.slice(0, 7)})`]);
    } else {
      console.error(`[merge] WARN no valid Auto-merge-base trailer found on ${mergeSha} — falling back to single-commit revert (older merge, or corrupted trailer)`);
      git(['revert', '--no-edit', mergeSha]);
    }
    revertSha = git(['rev-parse', 'HEAD']).trim();
  } catch (err) {
    gitOrNull(['revert', '--abort']);
    console.error(`[merge] REVERT FAILED: reverting ${mergeSha} conflicted (later commits touched the same lines): ${String(err.message).slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }
  pushMain();
  transition('merged', 'tap.revert');
  notionUpdate(cardId, ['--auto', 'reverted', '--status', 'Not started', '--outcome', buildRevertOutcomeNote({ revertSha, mergeSha })]);
  console.log(`[merge] REVERTED card ${cardId}: ${mergeSha} → ${revertSha}`);
}

// ── Tier-2 data-repo merge/revert (Sprint 4, S4-T4) ─────────────────────────
//
// Same rebase→gate→verify→ff-merge→push shape as approve()/revert() above,
// scoped to a fresh clone of the private repo (`dir`) instead of this repo's
// own checkout — see the module header comment for why a data card's branch
// can't be fetched from THIS repo's origin.
async function approveDataCard(cardId, branch, card, evidence) {
  const repoKey = evidence.repoKey;
  const cls = evidence.dataClass;
  if (!repoKey || !DATA_REPO_URLS[repoKey]) {
    transition('approved', 'merge.reverify-fail');
    notionUpdate(cardId, ['--auto', 'needs-approval', '--outcome', buildReverifyFailNote(`evidence comment names an unrecognized data repoKey "${repoKey}"`)]);
    console.error(`[merge] RE-VERIFY FAILED (data): unrecognized repoKey "${repoKey}"`);
    process.exitCode = 1;
    return;
  }
  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    transition('approved', 'merge.reverify-fail');
    notionUpdate(cardId, ['--auto', 'needs-approval', '--outcome', buildReverifyFailNote('REVIEW_TEXTS_TOKEN is not configured on this workflow — cannot reach the private data repo')]);
    console.error('[merge] RE-VERIFY FAILED (data): REVIEW_TEXTS_TOKEN missing from env');
    process.exitCode = 1;
    return;
  }

  const dir = cloneDataRepo(repoKey, token);
  git(['fetch', 'origin', 'main'], { cwd: dir });

  // Oscillation breaker, scoped to the PRIVATE repo's own history — a
  // data-card merge commit lands on scorecard-data/review-texts main, never
  // on Broadwayscore's.
  const trailer = oscillationTrailerFor(cardId);
  const priorMerges = countPriorMerges(cardId, dir);
  if (shouldEscalateOscillation(priorMerges)) {
    transition('approved', 'merge.oscillation');
    notionUpdate(cardId, ['--auto', 'failed', '--outcome', buildEscalationNote(cardId, priorMerges)]);
    await sendEscalationEmail(`⚠️ Autonomous loop: "${card.name}" already merged ${priorMerges}x — refusing`, buildEscalationNote(cardId, priorMerges));
    console.error(`[merge] OSCILLATION (data/${repoKey}): card ${cardId} already merged ${priorMerges} time(s) — refusing, escalated to owner`);
    process.exitCode = 1;
    return;
  }

  const reverifyFail = (reason) => {
    transition('approved', 'merge.reverify-fail');
    notionUpdate(cardId, ['--auto', 'needs-approval', '--outcome', buildReverifyFailNote(reason)]);
    console.error(`[merge] RE-VERIFY FAILED (data/${repoKey}): ${reason}`);
    process.exitCode = 1;
  };

  git(['fetch', 'origin', branch], { cwd: dir });
  git(['checkout', '-B', 'auto-merge-work', `origin/${branch}`], { cwd: dir });

  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      git(['fetch', 'origin', 'main'], { cwd: dir });
      git(['checkout', 'auto-merge-work'], { cwd: dir });
    }
    const verified = verifyRebaseData(dir, repoKey, cls, evidence);
    if (!verified.ok) {
      if (attempt === MAX_MERGE_ATTEMPTS) { reverifyFail(verified.reason); return; }
      console.error(`[merge] attempt ${attempt} verify failed (data/${repoKey}, ${verified.reason.slice(0, 120)}) — retrying against fresh origin/main`);
      continue;
    }

    const baseSha = git(['rev-parse', 'origin/main'], { cwd: dir }).trim();
    const priorMsg = stripTrailers(git(['log', '-1', '--pretty=%B'], { cwd: dir }).trim(), trailer);
    git(['commit', '--amend', '-m', `${priorMsg}\n\n${trailer}\n${BASE_TRAILER_PREFIX}${baseSha}`], { cwd: dir });
    const sha = git(['rev-parse', 'HEAD'], { cwd: dir }).trim();

    git(['checkout', 'main'], { cwd: dir });
    git(['reset', '--hard', 'origin/main'], { cwd: dir });
    try {
      git(['merge', '--ff-only', 'auto-merge-work'], { cwd: dir });
    } catch {
      if (attempt === MAX_MERGE_ATTEMPTS) {
        reverifyFail(`${repoKey}'s main advanced repeatedly during the merge window and a clean fast-forward was not possible after retrying`);
        return;
      }
      console.error(`[merge] attempt ${attempt} fast-forward lost a race against ${repoKey}'s origin/main — retrying`);
      git(['checkout', 'auto-merge-work'], { cwd: dir });
      continue;
    }

    try {
      git(['push', 'origin', 'main'], { cwd: dir });
    } catch (err) {
      if (attempt === MAX_MERGE_ATTEMPTS) { reverifyFail(`push to ${repoKey} failed after a clean fast-forward merge: ${redactSecrets(String(err.message).slice(0, 300))}`); return; }
      console.error(`[merge] attempt ${attempt} push race on ${repoKey} — retrying`);
      git(['checkout', 'auto-merge-work'], { cwd: dir });
      continue;
    }

    transition('approved', 'merge.success');
    notionUpdate(cardId, ['--auto', 'merged', '--status', 'Done', '--outcome', buildMergeOutcomeNote({ sha, branch, files: verified.files })]);
    console.log(`[merge] MERGED card ${cardId} (${sha}) from ${branch} → ${repoKey}`);
    if (repoKey === 'review-texts') dispatchRebuildFast(cardId);
    return;
  }
}

async function revertDataCard(cardId, evidence) {
  const repoKey = evidence.repoKey;
  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!repoKey || !DATA_REPO_URLS[repoKey] || !token) {
    console.error(`[merge] REVERT FAILED (data): missing REVIEW_TEXTS_TOKEN or unrecognized repoKey "${repoKey}"`);
    process.exitCode = 1;
    return;
  }

  const dir = cloneDataRepo(repoKey, token);
  const trailer = oscillationTrailerFor(cardId);
  // Retried, unlike a single unguarded push (ship-check finding, 2026-07-14):
  // these private repos take commits from ~200 other automated pipelines
  // roughly every 30 minutes, so a race between our reset+revert and the
  // push is plausible, not theoretical — the same reasoning that already
  // gates approveDataCard's push behind MAX_MERGE_ATTEMPTS. On a push race,
  // refetch and re-derive everything (mergeSha/baseSha/the revert commit)
  // against the NEW origin/main rather than retrying a stale push.
  for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
    git(['fetch', 'origin', 'main'], { cwd: dir });
    const mergeSha = (gitOrNull(['log', '--fixed-strings', '--grep', trailer, '--format=%H', '-1', 'origin/main'], { cwd: dir }) || '').trim();
    if (!mergeSha) {
      console.error(`[merge] REVERT FAILED (data/${repoKey}): no commit on origin/main carries "${trailer}" — cannot safely locate the merge to revert`);
      process.exitCode = 1;
      return;
    }
    const mergeMsg = git(['log', '-1', '--format=%B', mergeSha], { cwd: dir });
    const baseSha = parseBaseTrailer(mergeMsg);

    git(['checkout', 'main'], { cwd: dir });
    git(['reset', '--hard', 'origin/main'], { cwd: dir });
    let revertSha;
    try {
      if (baseSha && gitOrNull(['cat-file', '-e', baseSha], { cwd: dir })) {
        git(['revert', '--no-commit', `${baseSha}..${mergeSha}`], { cwd: dir });
        git(['commit', '-m', `Revert autonomous merge for card ${cardId} (${baseSha.slice(0, 7)}..${mergeSha.slice(0, 7)})`], { cwd: dir });
      } else {
        console.error(`[merge] WARN no valid Auto-merge-base trailer found on ${mergeSha} (data/${repoKey}) — falling back to single-commit revert`);
        git(['revert', '--no-edit', mergeSha], { cwd: dir });
      }
      revertSha = git(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    } catch (err) {
      gitOrNull(['revert', '--abort'], { cwd: dir });
      console.error(`[merge] REVERT FAILED (data/${repoKey}): reverting ${mergeSha} conflicted: ${redactSecrets(String(err.message).slice(0, 300))}`);
      process.exitCode = 1;
      return;
    }

    try {
      git(['push', 'origin', 'main'], { cwd: dir });
    } catch (err) {
      if (attempt === MAX_MERGE_ATTEMPTS) {
        console.error(`[merge] REVERT FAILED (data/${repoKey}): push failed after ${MAX_MERGE_ATTEMPTS} attempts (${repoKey}'s main kept advancing during the revert window): ${redactSecrets(String(err.message).slice(0, 300))}`);
        process.exitCode = 1;
        return;
      }
      console.error(`[merge] attempt ${attempt} revert push race on ${repoKey} — retrying against fresh origin/main`);
      continue;
    }

    transition('merged', 'tap.revert');
    notionUpdate(cardId, ['--auto', 'reverted', '--status', 'Not started', '--outcome', buildRevertOutcomeNote({ revertSha, mergeSha })]);
    console.log(`[merge] REVERTED card ${cardId} (data/${repoKey}): ${mergeSha} → ${revertSha}`);
    if (repoKey === 'review-texts') dispatchRebuildFast(cardId);
    return;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cardId = args.card;
  const branch = args.branch;
  const action = args.action;
  if (!cardId || !branch || !['approve', 'revert'].includes(action)) {
    console.error('usage: node scripts/autonomous-merge.js --card <id> --branch <name> --action approve|revert');
    process.exit(2);
  }
  if (action === 'approve') await approve(cardId, branch);
  else await revert(cardId, branch);
}

if (require.main === module) {
  main().catch(err => { console.error(`[merge] fatal: ${redactSecrets(err.message)}`); process.exit(1); });
}

module.exports = {
  approve, revert, verifyRebase, countPriorMerges, runChecks,
  approveDataCard, revertDataCard, verifyRebaseData, cloneDataRepo, dispatchRebuildFast, DATA_REPO_URLS,
  redactSecrets,
};
