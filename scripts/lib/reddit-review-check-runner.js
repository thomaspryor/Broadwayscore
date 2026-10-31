/**
 * reddit-review-check-runner.js (BRO-5887): the orchestration core of the pre-send
 * review check, kept in scripts/lib so its tests (and test.yml's path coverage)
 * depend only on lib files; scripts/verify-reddit-draft-reviews.js is the thin CLI.
 *
 * runShowCheck runs the show-scoped recovery tools and the Sonnet reader for one
 * draft with injected dependencies; makeJudge is the reader (one model call, every
 * edit verified by code and written atomically); realDeps spawns the real tools
 * and inspects the review-texts git tree.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./reddit-review-check');
const judgeLib = require('./reddit-review-judge');
const { applyReviewFieldEdit, resolveReviewPath } = require('./review-field-edit');
const { safeWriteReview } = require('./review-write-guard');

const ROOT = path.resolve(__dirname, '..', '..');
const DRAFTS_PATH = path.join(ROOT, 'data', 'audit', 'reddit-post-drafts.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'show-review-gap.json');
const REVIEW_TEXTS = path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
// No new show starts after this. One show's tools take at most ~27 minutes plus the reader, so the
// worst case (start at 35, finish by ~65) ends inside the job's 90-minute timeout with the email still to send.
const START_BUDGET_MS = 35 * 60 * 1000;

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
    ownerOf: deps.ownerOf ? url => deps.ownerOf(url, showId) : null,
    facts: deps.facts ? deps.facts(showId) : null,
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
      if (dryRun) { applied.push({ id: d.id, checks: v.accepted, dryRun: true, changes: describeEdits(v.edits) }); continue; }
      const w = writeRecordAtomically(reviewTexts, showId, d.id, chain.record, v.edits, v.extra);
      if (!w.ok) { rejected.push({ id: d.id, check: 'apply', why: w.reason }); continue; }
      // Later decisions in this run see the name just given, so two files cannot take the same critic.
      for (const e of v.edits) {
        if (e.field !== 'criticName') continue;
        const sib = siblings.find(x => x.file === d.id);
        if (sib) sib.criticName = e.newValue;
      }
      applied.push({ id: d.id, checks: v.accepted, changes: describeEdits(v.edits) });
    }
    return { asked: items.length, applied, rejected };
  };
}

/** "criticName: Unknown -> Kyle Torrence; publishDate: null -> 2026-10-16" for the log: the audit trail of what the reader changed. */
function describeEdits(edits) {
  return edits.map(e => `${e.field}: ${JSON.stringify(e.oldValue)} -> ${JSON.stringify(e.newValue)}`).join('; ');
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
function writeRecordAtomically(reviewTexts, showId, file, record, edits, extra = null) {
  const abs = resolveReviewPath(reviewTexts, `${showId}/${file}`);
  if (!abs) return { ok: false, reason: `bad review path ${showId}/${file}` };
  const original = fs.readFileSync(abs, 'utf8');
  try {
    safeWriteReview(abs, { ...record }, {});
    const after = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const lost = edits.filter(e => JSON.stringify(after[e.field] === undefined ? null : after[e.field]) !== JSON.stringify(e.newValue)).map(e => e.field);
    // The machine-clear stamp rides along as `extra`: without it a clear reads as a human verdict that later flag plans refuse to overrule.
    for (const [k, val] of Object.entries(extra || {})) if (JSON.stringify(after[k] === undefined ? null : after[k]) !== JSON.stringify(val)) lost.push(k);
    if (lost.length) { fs.writeFileSync(abs, original); return { ok: false, reason: `the write guard kept ${lost.join(', ')}; file restored` }; }
    return { ok: true };
  } catch (e) {
    try { fs.writeFileSync(abs, original); } catch { /* the original is still what we report */ }
    return { ok: false, reason: `write failed (${e.message}); file restored` };
  }
}

async function callSonnet(system, user) {
  const Anthropic = require('@anthropic-ai/sdk');
  const { REDDIT_SONNET } = require('./models.js');
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
    // The show's opening date and category, so pre-opening features drop out of "still not counted" (BRO-6634).
    facts(showId) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
        const show = (Array.isArray(d) ? d : d.shows).find(x => x.id === showId);
        return show ? judgeLib.identityFacts(show, new Date().toISOString().slice(0, 10)) : null;
      } catch { return null; }
    },
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
    // Another show's folder that already holds this URL (one article reviewing two shows).
    ownerOf(url, showId) {
      try {
        const owners = require('./url-ownership').findCrossShowOwners(url, showId, reviewTexts);
        const real = owners.find((o) => o.blocking);
        return real ? real.showId : null;
      } catch { return null; }
    },
    readAudit() {
      try { return JSON.parse(fs.readFileSync(auditPath, 'utf8')); } catch { return null; }
    },
    guard(showIds) {
      if (!hasGit) return { ok: true, violations: [] };
      // -uall: an untracked directory must list its files, not collapse to "?? _pending/" (which reads as a violation and reverts every show's pending strand).
      const r = spawnSync('git', ['-C', reviewTexts, 'status', '--porcelain', '-uall'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) return { ok: false, violations: ['git status failed in data/review-texts'] };
      return lib.guardChangedPaths(showIds, r.stdout.split('\n').filter(Boolean));
    },
    dirty(showIds) {
      if (!hasGit) return false;
      const r = spawnSync('git', ['-C', reviewTexts, 'status', '--porcelain', '-uall'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

module.exports = {
  ROOT, DRAFTS_PATH, AUDIT_PATH, REVIEW_TEXTS, SHOWS_PATH, START_BUDGET_MS,
  TOOLS, runShowCheck, makeJudge, describeEdits, chainEdits, writeRecordAtomically, callSonnet, realDeps,
};
