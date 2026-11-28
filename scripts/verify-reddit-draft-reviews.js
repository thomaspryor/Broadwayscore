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
const lib = require('./lib/reddit-review-check');
const { DRAFTS_PATH, REVIEW_TEXTS, SHOWS_PATH, START_BUDGET_MS, TOOLS, runShowCheck, makeJudge, callSonnet, realDeps } = require('./lib/reddit-review-check-runner');

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
      for (const a of result.judge.applied) console.log(`  reader ${a.dryRun ? 'would apply' : 'applied'}: ${a.id} (${a.checks.join(', ')}) ${a.changes || ''}`);
      for (const r of result.judge.rejected) console.log(`  reader refused ${r.id} ${r.check}: ${r.why}`);
      if (result.judge.error) console.log(`::warning::the Sonnet reader failed for ${draft.showId}: ${result.judge.error}`);
    }
    console.log(`  => ${v.status}${v.error ? ` (${v.error})` : ''}: added ${v.added ? v.added.length : 0}, named ${v.named ? v.named.length : 0}, dated ${v.dated ? v.dated.length : 0}, still not counted ${v.gaps ? v.gaps.length : 0}`);
    if (v.status === 'failed') console.log(`::warning::review check failed for ${draft.showId}: ${v.error}`);
    changedAny = changedAny || result.changed;
    // Publish it now, not only at the end: a crash or a step timeout later in this run must still push what is already on disk,
    // because the checkpointed verification below already says those fixes exist.
    if (result.changed && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=true\n');
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

