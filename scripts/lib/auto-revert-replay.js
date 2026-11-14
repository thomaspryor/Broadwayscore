'use strict';
/**
 * scripts/lib/auto-revert-replay.js — BRO-7102 item 2 (engine; CLI is scripts/auto-revert-replay.js): replay scripts/lib/auto-revert.js
 * over the last N days of main test.yml runs and count what it WOULD have done.
 * Read-only: it never reverts, pushes or comments. Arming auto-revert needs a
 * replay with zero false reverts (a separate card).
 *
 * Usage: node scripts/auto-revert-replay.js [--days 30] [--json out.json]
 * Needs: GH_TOKEN. Reads the runs API (one call per day), then the commits API
 * only inside each green->red window and its fix window, plus one call per
 * person-authored commit in them for its files.
 *
 * Confirmation, as the live system would see it: a re-run attempt of the red
 * sha when one exists, else the next run on a later sha whose window holds only
 * data-bot/docs commits (the same code run again). Anything else is unconfirmable.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const { decideAutoRevert, classifyReplayOutcome, classifyCommit } = require('./auto-revert.js');

const REPO = 'thomaspryor/Broadwayscore';

// A 30-day replay makes a few hundred API calls; one dropped connection must not
// throw the whole run away. Three tries, 2s then 4s apart.
function retry(fn, tries = 3, sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  for (let i = 1; ; i++) {
    try { return fn(); } catch (e) { if (i >= tries) throw e; sleepMs(2000 * i); }
  }
}

function ghRunsForDay(day, exec = execFileSync) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const raw = retry(() => exec('gh',['api', `repos/${REPO}/actions/workflows/test.yml/runs?branch=main&event=push&created=${day}&per_page=100&page=${page}`,
      '--jq', '{total: .total_count, runs: [.workflow_runs[] | {id, sha: .head_sha, time: .created_at, conclusion, attempt: .run_attempt}]}'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const j = JSON.parse(raw);
    out.push(...j.runs);
    if (j.runs.length < 100 || out.length >= j.total) break;
  }
  // The list shows each run once, at its LATEST attempt. A re-run run hides the
  // first attempt's verdict (what main showed), so read attempt 1 for those.
  for (const r of out.filter((x) => x.attempt > 1)) {
    const c = JSON.parse(retry(() => exec('gh', ['api', `repos/${REPO}/actions/runs/${r.id}/attempts/1`, '--jq', '{conclusion}'], { encoding: 'utf8' }))).conclusion;
    out.push({ ...r, attempt: 1, conclusion: c });
  }
  return out;
}

/**
 * Commits after `aSha` up to and including `bSha`, oldest first, from the commits
 * API (a deep clone of this data-heavy repo is too slow; main gets ~70 commits an
 * hour). Files are read for person-authored commits, and for bot commits only
 * when a decision depends on them (windowOf.fill), one call each, cached.
 */
function makeWindowFetcher(exec = execFileSync, maxPages = 25, { cachePath = null } = {}) {
  const fileCache = new Map();
  // Every call here reads commit history by a fixed sha, which never changes, so a
  // disk cache is safe: a killed 30-day run resumes instead of starting over.
  const disk = new Map();
  if (cachePath && fs.existsSync(cachePath)) {
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cachePath, 'utf8')))) disk.set(k, v); } catch { /* a torn cache is rebuilt */ }
  }
  let unsaved = 0;
  const save = () => { if (cachePath && unsaved) { fs.writeFileSync(`${cachePath}.tmp`, JSON.stringify(Object.fromEntries(disk))); fs.renameSync(`${cachePath}.tmp`, cachePath); unsaved = 0; } };
  const gh = (path, jq) => {
    const key = `${path} ${jq}`;
    if (disk.has(key)) return disk.get(key);
    const v = JSON.parse(retry(() => exec('gh', ['api', path, '--jq', jq], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })));
    if (cachePath) { disk.set(key, v); if (++unsaved >= 25) save(); }
    return v;
  };
  function windowOf(a, b) {
    const sinceIso = new Date(Date.parse(a.time) - 2 * 3600000).toISOString();
    const out = [];
    let found = false;
    for (let page = 1; page <= maxPages && !found; page++) {
      const rows = gh(`repos/${REPO}/commits?sha=${b.sha}&since=${sinceIso}&per_page=100&page=${page}`,
        '[.[] | {sha, authorName: .commit.author.name, message: .commit.message, parents: (.parents | length)}]');
      for (const r of rows) { if (r.sha === a.sha) { found = true; break; } out.push({ ...r }); }
      if (rows.length < 100) break;
    }
    if (!found) return null; // window too long or history rewritten: unknown, never guessed
    out.reverse();
    for (const c of out) {
      const [subject, ...rest] = String(c.message || '').split('\n');
      c.subject = subject; c.body = rest.join('\n'); delete c.message;
      // A bot's files are read only when a decision depends on them (fill below):
      // bots are most of main's commits and most windows never need them.
      if (['data-bot', 'merge'].includes(classifyCommit({ ...c, files: null }))) { c.files = null; continue; }
      c.files = filesOf(c.sha);
    }
    return out;
  }
  function filesOf(sha) {
    if (!fileCache.has(sha)) fileCache.set(sha, gh(`repos/${REPO}/commits/${sha}`, '[.files[].filename]'));
    return fileCache.get(sha);
  }
  // Read the files of the bot commits in a window, so a bot that edits code (a
  // dependency bump) classifies as bot-code, not data.
  windowOf.fill = (commits) => {
    for (const c of commits || []) if (c.files == null && classifyCommit(c) !== 'merge') c.files = filesOf(c.sha);
    return commits;
  };
  windowOf.save = save;
  return windowOf;
}

/**
 * Replay the decision over main's runs.
 * @param {Array} runs - test.yml push runs on main ({ sha, time, conclusion, attempt })
 * @param {function} windowOf - (a, b) => commits after run a's sha up to run b's sha, or null
 */
function replay(runs, windowOf) {
  // Per sha: the first attempt's conclusion is what main showed; a later attempt is the re-run.
  const bySha = new Map();
  for (const r of runs) {
    if (!['success', 'failure'].includes(r.conclusion)) continue;
    const e = bySha.get(r.sha) || { sha: r.sha, time: r.time, attempts: {} };
    e.attempts[r.attempt] = r.conclusion;
    if (Date.parse(r.time) < Date.parse(e.time)) e.time = r.time;
    bySha.set(r.sha, e);
  }
  const shas = [...bySha.values()].sort((x, y) => Date.parse(x.time) - Date.parse(y.time));
  const first = (e) => e.attempts[Math.min(...Object.keys(e.attempts).map(Number))];
  const quiet = (w) => Array.isArray(w) && w.every((c) => ['data-bot', 'docs-only'].includes(classifyCommit(c)));
  const rows = [];
  for (let i = 1; i < shas.length; i++) {
    if (!(first(shas[i - 1]) === 'success' && first(shas[i]) === 'failure')) continue;
    const red = shas[i];
    const window = windowOf(shas[i - 1], red);
    const row = { redSha: red.sha.slice(0, 9), greenSha: shas[i - 1].sha.slice(0, 9), at: red.time };
    if (!window) { rows.push({ ...row, reason: 'window-unknown' }); continue; }
    const fill = (w) => (windowOf.fill && Array.isArray(w) ? windowOf.fill(w) : w);
    // One landing among bots: whether a bot edited code decides it, so read their files.
    if (window.filter((c) => classifyCommit(c) === 'landing').length === 1) fill(window);
    // Confirm: a re-run of the red sha, else the next run on the same code.
    let confirm = null;
    let confirmVia = 'none';
    const rerun = Object.keys(red.attempts).map(Number).filter((n) => n > 1).sort((x, y) => x - y)[0];
    if (rerun) { confirm = red.attempts[rerun]; confirmVia = `rerun-attempt-${rerun}`; } else if (shas[i + 1]) {
      const w2 = windowOf(red, shas[i + 1]);
      if (quiet(w2) && quiet(fill(w2))) { confirm = first(shas[i + 1]); confirmVia = 'next-run-same-code'; }
    }
    const d = decideAutoRevert({ commits: window, confirm, env: {} });
    Object.assign(row, { window: window.length, reason: d.reason, confirmVia, candidate: d.sha ? d.sha.slice(0, 9) : null });
    // A would-revert gets its real outcome. A single-landing red that history never
    // re-ran (awaiting-confirm) gets the outcome it WOULD have had if the live
    // re-run had failed too: the upper bound on false reverts, since the live
    // system re-runs every red and only a failing re-run reverts.
    if (d.revert || d.reason === 'awaiting-confirm') {
      const cand = window.find((c) => c.sha === d.sha);
      const nextGreen = shas.slice(i + 1).find((e) => first(e) === 'success');
      const fix = nextGreen ? fill(windowOf(red, nextGreen)) : [];
      const outcome = fix == null ? 'fix-window-unknown' : classifyReplayOutcome({ candidate: cand, fixWindow: fix, cleared: !!nextGreen });
      row[d.revert ? 'outcome' : 'ifConfirmed'] = outcome;
      row.subject = String(cand.subject).slice(0, 90);
    }
    rows.push(row);
  }
  const count = (k, v) => rows.filter((r) => r[k] === v).length;
  return {
    transitions: rows.length,
    wouldRevert: count('reason', 'confirmed-breaking-landing'),
    falseReverts: count('outcome', 'false-revert'),
    trueBreakages: count('outcome', 'true-breakage'),
    otherFix: count('outcome', 'other-fix'),
    unknown: count('reason', 'window-unknown') + count('outcome', 'fix-window-unknown'),
    // Upper bound: single-landing reds history never re-ran, by what cleared them.
    ifConfirmed: rows.filter((r) => r.ifConfirmed).reduce((m, r) => ({ ...m, [r.ifConfirmed]: (m[r.ifConfirmed] || 0) + 1 }), {}),
    reasons: rows.reduce((m, r) => ({ ...m, [r.reason]: (m[r.reason] || 0) + 1 }), {}),
    rows,
  };
}

module.exports = { replay, makeWindowFetcher, ghRunsForDay, retry, REPO };
