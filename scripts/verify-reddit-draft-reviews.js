#!/usr/bin/env node
/**
 * verify-reddit-draft-reviews.js (BRO-5887)
 *
 * Runs right before send-reddit-post-email.js in the draft-opening-posts job
 * of reddit-engagement-digest.yml. The owner used to run a session per show
 * after every Reddit draft and always found 1-2 reviews missing and 1-2 wrong
 * or missing critic names and dates. For each draft about to be emailed (new
 * or update, at most 3 shows) this runs the same show-scoped recovery tools
 * those sessions used, then records what it did and what is still missing on
 * the draft (`verification`), which the email shows as "Reviews checked".
 *
 *   1. replay-pending-bylines   reviews stuck in _pending for want of a byline
 *   2. audit-show-review-gap    ingest aggregator-listed reviews we do not have
 *   3. backfill-unknown-critics outlet / critic names
 *   4. backfill-network-tier-dates  missing publish dates
 *
 * Nothing here waits for the site: new reviews need a rebuild, scoring and a
 * deploy (an hour or more). The workflow pushes review-texts and dispatches
 * the rebuild; the email says what is still being scored; the update email
 * (BRO-5879) sends the corrected draft when the numbers land.
 *
 * Never blocks the email: a tool that fails, a guard that trips or a crash is
 * recorded as status 'failed' and the email goes out with a banner.
 *
 * Modes (--mode, or REDDIT_REVIEW_CHECK=off to skip entirely):
 *   apply        run all four tools, write review-texts   (default)
 *   report-only  census only, nothing written, no verification recorded
 *
 * Usage:
 *   node scripts/verify-reddit-draft-reviews.js [--mode=apply|report-only] [--show=ID,ID] [--max=3]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib/reddit-review-check');
const judgeLib = require('./lib/reddit-review-judge');
const { applyReviewFieldEdit, resolveReviewPath } = require('./lib/review-field-edit');
const { safeWriteReview } = require('./lib/review-write-guard');

const ROOT = path.resolve(__dirname, '..');
const DRAFTS_PATH = path.join(ROOT, 'data', 'audit', 'reddit-post-drafts.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'show-review-gap.json');
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
// No new show starts after this. One show's tools take at most ~27 minutes plus the reader,
// so the worst case ends well inside the job's 90-minute timeout with the email still to send.
const START_BUDGET_MS = 25 * 60 * 1000;

const MIN = 60 * 1000;
// Order matters: pending strand first, then ingest (new files), then names and dates for everything.
const TOOLS = {
  apply: [
    { name: 'replay-pending-bylines', argv: id => ['scripts/replay-pending-bylines.js', `--show=${id}`], timeoutMs: 5 * MIN },
    // The targeted-run recipe of audit-aggregator-gap.yml (BRO-4592) minus --checkpoint: with it, CI runs also route
    // owner alerts and the repo-variable self-proving logic, which the hourly audit owns. Census cooldown off so a
    // show audited in the last hours is not skipped.
    { name: 'gap-ingest', argv: id => ['scripts/audit-show-review-gap.js', `--show=${id}`, '--ingest-missing', '--time-budget-min=9'], env: { SERP_CENSUS_COOLDOWN_HOURS: '0' }, timeoutMs: 10 * MIN },
    { name: 'unknown-critics', argv: id => ['scripts/backfill-unknown-critics.js', `--show=${id}`, '--limit=25', '--time-budget-min=5'], timeoutMs: 6 * MIN },
    { name: 'missing-dates', argv: id => ['scripts/backfill-network-tier-dates.js', `--show=${id}`, '--limit=25'], timeoutMs: 6 * MIN },
  ],
  'report-only': [
    { name: 'census', argv: id => ['scripts/audit-show-review-gap.js', `--show=${id}`, '--time-budget-min=8'], env: { SERP_CENSUS_COOLDOWN_HOURS: '0' }, timeoutMs: 10 * MIN },
  ],
};

/**
 * One show's check. `deps` is injected so the logic runs without spawning
 * tools: { snapshot(showId), runTool(tool, showId) -> {ok, secs, note},
 * readAudit(), guard(showIds) -> {ok, violations}, revert(paths), allowedShows,
 * judge?({draft, showId, census, snapshot, dryRun}) -> {asked, applied, rejected, error?} }.
 * Returns the verification record and whether review data changed.
 */
async function runShowCheck({ draft, mode, deps, nowIso, startedMs = Date.now() }) {
  const showId = draft.showId;
  const before = deps.snapshot(showId);
  const tools = [];
  let error = null;
  let judge = null;
  try {
    for (const tool of TOOLS[mode]) {
      const r = deps.runTool(tool, showId);
      tools.push({ name: tool.name, ok: r.ok, secs: r.secs });
    }
    if (tools.every(t => !t.ok)) error = 'every recovery tool failed or timed out';
    // The reader: held-back reviews, unnamed critics and undated files that the tools left.
    // A model failure never fails the check; it is recorded and the tools' results stand.
    if (!error && deps.judge) {
      const t0 = Date.now();
      try {
        judge = await deps.judge({ draft, showId, census: lib.censusFromAudit(deps.readAudit(), showId), snapshot: deps.snapshot(showId), dryRun: mode !== 'apply' });
      } catch (e) {
        judge = { asked: 0, applied: [], rejected: [], error: e && e.message ? e.message : String(e) };
      }
      tools.push({ name: 'judge', ok: !judge.error, secs: Math.round((Date.now() - t0) / 1000) });
    }
    if (mode === 'apply') {
      const g = deps.guard([...deps.allowedShows, showId]);
      if (!g.ok) {
        deps.revert(g.violations);
        error = `a tool wrote outside this show's folder (${g.violations.slice(0, 3).join(', ')}); reverted`;
      }
    }
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  const after = deps.snapshot(showId);
  const census = lib.censusFromAudit(deps.readAudit(), showId);
  const verification = lib.buildVerification({
    draft, nowIso, mode, snapshotBefore: before, snapshotAfter: after, census, error, tools, judge, previous: draft.verification, durationMs: Date.now() - startedMs,
  });
  // What gets pushed is whatever the tools left in the working tree (unreported metadata, _pending files and all),
  // not just what the owner-facing summary names; a failed check can still have written good files.
  const changed = mode === 'apply' && (deps.dirty ? deps.dirty([...deps.allowedShows, showId]) : lib.summarizeChanges(before, after).changed);
  return { verification, changed, judge };
}

// ── The reader: one Sonnet call per show, every edit checked by code ─────────

/**
 * Builds the `deps.judge` function. `callModel(system, user) -> text` and
 * `loadShow(id)` are injected. With dryRun the edits are verified and chained
 * in memory but never written (report-only mode logs what would happen).
 */
function makeJudge({ reviewTexts, loadShow, callModel, todayIso, fixId = 'reddit-review-check' }) {
  return async function judge({ showId, census, snapshot, dryRun }) {
    const show = loadShow(showId);
    if (!show) return { asked: 0, applied: [], rejected: [], error: `show ${showId} not in shows.json` };
    // The production this one follows (a transfer or revival) played elsewhere: reviews that name its venue are not ours.
    const original = show.originalProductionId && show.originalProductionId !== show.id ? loadShow(show.originalProductionId) : null;
    const facts = judgeLib.identityFacts(show, todayIso, original ? [original] : []);
    const records = judgeLib.readRecords(reviewTexts, showId, [...snapshot.keys()]);
    const items = judgeLib.selectJudgeItems(records, census, facts);
    if (!items.length) return { asked: 0, applied: [], rejected: [] };
    const { system, user } = judgeLib.buildPrompt(facts, items);
    const parsed = judgeLib.parseReply(await callModel(system, user), items);
    if (!parsed.ok) return { asked: items.length, applied: [], rejected: [], error: parsed.problem };
    const siblings = [...snapshot.entries()].filter(([f]) => !f.startsWith('_pending/')).map(([file, r]) => ({ file, outletId: r.outletId, criticName: r.criticName }));
    const byId = new Map(items.map(i => [i.id, i]));
    const stamp = { fixId, at: new Date().toISOString() };
    const applied = [];
    const rejected = [];
    for (const d of parsed.decisions) {
      const it = byId.get(d.id);
      const v = judgeLib.verifyDecision(it, d, records.get(d.id), facts, siblings);
      rejected.push(...v.rejected.map(x => ({ id: d.id, ...x })));
      if (!v.edits.length) continue;
      // The whole chain is validated in memory, then written in ONE write: a half-applied chain
      // (the manual-clear marker without the flag change) can never reach disk.
      const chain = chainEdits(records.get(d.id), v.edits, v.extra, stamp, showId, d.id);
      if (!chain.ok) { rejected.push({ id: d.id, check: 'apply', why: chain.reason }); continue; }
      if (dryRun) { applied.push({ id: d.id, checks: v.accepted, dryRun: true }); continue; }
      const w = writeRecordAtomically(reviewTexts, showId, d.id, chain.record, v.edits);
      if (!w.ok) { rejected.push({ id: d.id, check: 'apply', why: w.reason }); continue; }
      // Later decisions in this run see the name just given, so two files cannot take the same critic.
      for (const e of v.edits) {
        if (e.field !== 'criticName') continue;
        const sib = siblings.find(x => x.file === d.id);
        if (sib) sib.criticName = e.newValue;
      }
      applied.push({ id: d.id, checks: v.accepted });
    }
    return { asked: items.length, applied, rejected };
  };
}

/** Apply the edits one after another in memory (each is validated by review-field-edit), then the extra stamps. */
function chainEdits(record, edits, extra, stamp, showId, file) {
  let rec = record;
  for (const e of edits) {
    const r = applyReviewFieldEdit(rec, e, stamp, { folder: showId, file });
    if (!r.ok) return { ok: false, reason: r.reason };
    rec = r.record;
  }
  return { ok: true, record: extra ? { ...rec, ...extra } : rec };
}

/**
 * One safeWriteReview, then read it back: every edited field must hold. If the write guard
 * changed anything or the write threw, the file's original text is put back byte for byte.
 */
function writeRecordAtomically(reviewTexts, showId, file, record, edits) {
  const abs = resolveReviewPath(reviewTexts, `${showId}/${file}`);
  if (!abs) return { ok: false, reason: `bad review path ${showId}/${file}` };
  const original = fs.readFileSync(abs, 'utf8');
  try {
    safeWriteReview(abs, { ...record }, {});
    const after = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const lost = edits.filter(e => JSON.stringify(after[e.field] === undefined ? null : after[e.field]) !== JSON.stringify(e.newValue)).map(e => e.field);
    if (lost.length) { fs.writeFileSync(abs, original); return { ok: false, reason: `the write guard kept ${lost.join(', ')}; file restored` }; }
    return { ok: true };
  } catch (e) {
    try { fs.writeFileSync(abs, original); } catch { /* the original is still what we report */ }
    return { ok: false, reason: `write failed (${e.message}); file restored` };
  }
}

async function callSonnet(system, user) {
  const Anthropic = require('@anthropic-ai/sdk');
  const { REDDIT_SONNET } = require('./lib/models.js');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 });
  const msg = await client.messages.create({ model: REDDIT_SONNET, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] });
  return msg.content.filter(c => c.type === 'text').map(c => c.text).join('');
}

// ── Real dependencies ───────────────────────────────────────────────────────

function realDeps({ root = ROOT, reviewTexts = REVIEW_TEXTS, auditPath = AUDIT_PATH, quiet = false } = {}) {
  const hasGit = fs.existsSync(path.join(reviewTexts, '.git'));
  return {
    hasGit,
    allowedShows: [],
    snapshot: id => lib.snapshotShow(reviewTexts, id),
    runTool(tool, showId) {
      const started = Date.now();
      const r = spawnSync(process.execPath, tool.argv(showId), {
        cwd: root, env: { ...process.env, ...(tool.env || {}) }, encoding: 'utf8', timeout: tool.timeoutMs, maxBuffer: 64 * 1024 * 1024,
      });
      const secs = Math.round((Date.now() - started) / 1000);
      const ok = r.status === 0 && !r.error;
      const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
      if (!quiet) console.log(`  [${tool.name}] ${ok ? 'ok' : `FAILED (${r.error ? r.error.code || r.error.message : `exit ${r.status}`})`} in ${secs}s\n${tail.replace(/^/gm, '    ')}`);
      return { ok, secs };
    },
    readAudit() {
      try { return JSON.parse(fs.readFileSync(auditPath, 'utf8')); } catch { return null; }
    },
    guard(showIds) {
      if (!hasGit) return { ok: true, violations: [] };
      const r = spawnSync('git', ['-C', reviewTexts, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) return { ok: false, violations: ['git status failed in data/review-texts'] };
      return lib.guardChangedPaths(showIds, r.stdout.split('\n').filter(Boolean));
    },
    dirty(showIds) {
      if (!hasGit) return false;
      const r = spawnSync('git', ['-C', reviewTexts, 'status', '--porcelain'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      return r.status === 0 && r.stdout.split('\n').filter(Boolean).length > 0;
    },
    revert(paths) {
      if (!hasGit) return;
      // A rename arrives as "old -> new": undo both ends.
      for (const p of paths.flatMap(x => String(x).split(' -> '))) {
        if (!p || p.includes('git status failed')) continue;
        spawnSync('git', ['-C', reviewTexts, 'checkout', '--', p], { encoding: 'utf8' });
        spawnSync('git', ['-C', reviewTexts, 'clean', '-fd', '--', p], { encoding: 'utf8' });
      }
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `verify-reddit-draft-reviews.js: pre-send review check for Reddit drafts (BRO-5887)
  --mode=apply|report-only   apply runs the recovery tools and writes review-texts (default apply)
  --show=ID,ID               check these drafts (the owner's resend list) whatever their email state
  --max=N                    at most N shows per run (default ${lib.MAX_SHOWS_PER_RUN})
  --judge=off                skip the Sonnet reader (it also needs ANTHROPIC_API_KEY)
  --mark-push-failed         the workflow's push failed: mark this run's drafts so the email says so
  REDDIT_REVIEW_CHECK=off    skip entirely`;

async function main() {
  const args = process.argv.slice(2);
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  if (args.includes('--mark-push-failed')) {
    // Run by the workflow when the review-texts push failed: the fixes are not saved, so the emails must not say "being scored".
    const file = JSON.parse(fs.readFileSync(DRAFTS_PATH, 'utf8'));
    const ids = lib.markPushFailed(file, Date.now());
    if (ids.length) fs.writeFileSync(DRAFTS_PATH, JSON.stringify(file, null, 2) + '\n');
    console.log(`::warning::review-texts push failed; marked ${ids.length} draft(s): ${ids.join(', ') || 'none'}`);
    return;
  }
  const arg = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
  const mode = arg('mode') || 'apply';
  if (!TOOLS[mode]) { console.error(`unknown --mode=${mode}`); process.exit(2); }
  if (String(process.env.REDDIT_REVIEW_CHECK || '').toLowerCase() === 'off') { console.log('REDDIT_REVIEW_CHECK=off: skipping the review check'); return; }

  let file;
  try { file = JSON.parse(fs.readFileSync(DRAFTS_PATH, 'utf8')); } catch (e) { console.log(`no readable drafts file (${e.code || e.message}); nothing to check`); return; }
  const only = (arg('show') || '').split(',').map(x => x.trim()).filter(Boolean);
  const max = Number(arg('max')) || lib.MAX_SHOWS_PER_RUN;
  const due = lib.selectDueChecks(file, Date.now(), { only, max });
  console.log(`${due.length} Reddit draft(s) to check before emailing (mode ${mode})`);

  const deps = realDeps();
  if (arg('judge') !== 'off' && process.env.ANTHROPIC_API_KEY) {
    const loadShow = id => { try { const d = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')); return (Array.isArray(d) ? d : d.shows).find(x => x.id === id); } catch { return null; } };
    deps.judge = makeJudge({ reviewTexts: REVIEW_TEXTS, loadShow, callModel: callSonnet, todayIso: new Date().toISOString().slice(0, 10) });
  } else {
    console.log('the Sonnet reader is off (no ANTHROPIC_API_KEY or --judge=off): recovery tools only');
  }
  const started = Date.now();
  let changedAny = false;
  for (const { draft, kind } of due) {
    if (Date.now() - started > START_BUDGET_MS) { console.log(`::warning::check budget spent; ${draft.showId} goes out unchecked`); continue; }
    console.log(`\n── ${draft.showId} (${kind} email)`);
    let result;
    if (mode === 'apply' && !deps.hasGit) {
      result = { verification: lib.buildVerification({ draft, nowIso: new Date().toISOString(), mode, snapshotBefore: new Map(), snapshotAfter: new Map(), census: null, error: 'data/review-texts is not a git checkout' }), changed: false };
    } else {
      result = await runShowCheck({ draft, mode, deps, nowIso: new Date().toISOString() });
    }
    deps.allowedShows.push(draft.showId);
    const v = result.verification;
    if (result.judge) {
      for (const a of result.judge.applied) console.log(`  reader ${a.dryRun ? 'would apply' : 'applied'}: ${a.id} (${a.checks.join(', ')})`);
      for (const r of result.judge.rejected) console.log(`  reader refused ${r.id} ${r.check}: ${r.why}`);
      if (result.judge.error) console.log(`::warning::the Sonnet reader failed for ${draft.showId}: ${result.judge.error}`);
    }
    console.log(`  => ${v.status}${v.error ? ` (${v.error})` : ''}: added ${v.added ? v.added.length : 0}, named ${v.named ? v.named.length : 0}, dated ${v.dated ? v.dated.length : 0}, still not counted ${v.gaps ? v.gaps.length : 0}`);
    if (v.status === 'failed') console.log(`::warning::review check failed for ${draft.showId}: ${v.error}`);
    changedAny = changedAny || result.changed;
    if (mode === 'apply') {
      file.drafts[draft.showId] = { ...file.drafts[draft.showId], verification: v };
      fs.writeFileSync(DRAFTS_PATH, JSON.stringify(file, null, 2) + '\n'); // checkpoint
    }
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changedAny}\n`);
  console.log(`\nreview data changed: ${changedAny}`);
}

if (require.main === module) {
  main().catch(e => { console.error(`::warning::verify-reddit-draft-reviews crashed: ${e.stack || e}`); /* never block the email */ });
}

module.exports = { runShowCheck, makeJudge, writeRecordAtomically, realDeps, TOOLS };
