/**
 * overnight-digest.js — plain-English "what changed while you slept" section
 * for the morning email (owner request 2026-07-22: "a system that tells me
 * every day what was changed or fixed overnight … and an assurance that
 * things finished, didn't get half finished").
 *
 * Two halves:
 *   1. summarize*() — pure functions over git-log lines / cmux output /
 *      worktree state, unit-tested in overnight-digest.test.mjs.
 *   2. gatherDigest() — the impure collector the email calls. EVERY source
 *      fails soft: a broken cmux socket or git hiccup yields a "couldn't
 *      check" line, never a crashed email.
 *
 * The stuck-work section exists because of the 2026-07-22 audit: three dead
 * auto-dispatched workspaces on one card, six worktrees holding unmerged
 * finished work for up to 5 weeks, and a -152 review drop nobody saw. The
 * digest makes those states visible within 24h instead of on-demand.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
// Done-marker detection is a known bug class (cmux prepends activity glyphs
// before ✅) — reuse the hardened predicate instead of reimplementing it.
const { isDoneTitle } = require('./cmux-workspaces.js');

const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Pure: commit-log → plain-English lines ──────────────────────────────────

// Input: array of "author\tsubject" lines from origin/main, newest first.
// Output: { lines: [plain-English strings], mergedWork: [subjects] }.
// The categories mirror what the pipelines actually emit — counts roll up so
// 300 churn commits become 6 readable sentences.
function summarizeCommits(logLines) {
  const c = {
    newShows: 0, textCollections: 0, scoringRuns: 0, scoredShows: new Set(), reviewDelta: 0,
    rebuilds: 0, autoFixed: 0,
  };
  const mergedWork = [];
  const ROUTINE = /^(chore: (Update deploy watermark|Checkpoint|opening-night completeness|Record indexing|update drift-state|Update feedback|Update Show Score|Auto-fetch)|checkpoint: |Merge |audit: |health: |data: (Opening night poller|Reconcile Resend|Update health))/;

  for (const line of logLines) {
    const tab = line.indexOf('\t');
    const author = tab === -1 ? '' : line.slice(0, tab);
    const s = tab === -1 ? line : line.slice(tab + 1);

    let m;
    if ((m = s.match(/^chore: Update shows - added (\d+) new show/))) { c.newShows += Number(m[1]); continue; }
    if (/^feat: Collect review texts/.test(s)) { c.textCollections++; continue; }
    // Most scoring commits are the bare form with NO show suffix (real ratio
    // ~479 bare : 40 suffixed — QA review 2026-07-22); count every run, name
    // the shows only when the subject names them.
    if ((m = s.match(/^feat: Ensemble LLM score reviews(?: for (.+))?$/))) { c.scoringRuns++; if (m[1]) c.scoredShows.add(m[1]); continue; }
    if ((m = s.match(/^data: (?:Rebuild reviews\.json|Fast rebuild|Auto-rebuild reviews\.json)(?:.*?\(([+-]\d+) reviews?\))?/))) {
      c.rebuilds++;
      if (m[1]) c.reviewDelta += Number(m[1]);
      continue;
    }
    if ((m = s.match(/^chore: Auto-maintain show data - fixed (\d+) issues/))) { c.autoFixed += Number(m[1]); continue; }
    if (/^chore: Auto-fetch and archive show images/.test(s)) continue;
    if (/^data: RSS poller — recoupment scan/.test(s)) continue;
    if (ROUTINE.test(s)) continue;
    // Anything left is real merged work (a fix/feature a session or human
    // landed) — surface the subject itself. Checkpoint-style bot bookkeeping
    // ("feat: Wayback recovery checkpoint …") is progress noise, not work.
    if (!/\[skip ci\]/.test(s) && !/checkpoint/i.test(s)) mergedWork.push(s);
  }

  const lines = [];
  if (c.newShows) lines.push(`${c.newShows} new show${c.newShows > 1 ? 's' : ''} added to the site`);
  if (c.scoringRuns) lines.push(`${c.scoringRuns} review-scoring run${c.scoringRuns > 1 ? 's' : ''} completed${c.scoredShows.size ? ` (incl. ${[...c.scoredShows].slice(0, 3).join(', ')}${c.scoredShows.size > 3 ? ` +${c.scoredShows.size - 3} more` : ''})` : ''}`);
  if (c.textCollections) lines.push(`${c.textCollections} review-collection run${c.textCollections > 1 ? 's' : ''} completed`);
  if (c.rebuilds) lines.push(`Site review data rebuilt ${c.rebuilds}× (net ${c.reviewDelta >= 0 ? '+' : ''}${c.reviewDelta} review${Math.abs(c.reviewDelta) === 1 ? '' : 's'})`);
  if (c.autoFixed) lines.push(`${c.autoFixed} data issue${c.autoFixed > 1 ? 's' : ''} auto-fixed by maintenance`);
  return { lines, mergedWork: mergedWork.slice(0, 8), reviewDelta: c.reviewDelta };
}

// ── Pure: cmux list-workspaces output → open/finished automated sessions ────

// Lines look like: "  workspace:227  🤖🔮 Data·T1-retrieval Sprint 2: …"
// (a leading "*" marks the selected workspace; ✅ prefix = finished).
function parseWorkspaces(rawText) {
  const auto = [];
  let autoDone = 0;
  for (const raw of String(rawText || '').split('\n')) {
    const m = raw.match(/^\*?\s*workspace:(\d+)\s+(.*)$/);
    if (!m) continue;
    const title = m[2].trim();
    if (!title.includes('🤖')) continue;
    if (isDoneTitle(title)) { autoDone++; continue; }
    auto.push({ ref: `workspace:${m[1]}`, title });
  }
  // Duplicate titles = the same card dispatched more than once (the exact
  // failure mode from the 2026-07-22 audit) — call it out explicitly.
  const seen = new Map();
  for (const w of auto) {
    const key = w.title.replace(/^[^A-Za-z0-9]+/, '');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([t, n]) => `${n}× "${t.slice(0, 70)}"`);
  return { autoOpen: auto, autoDone, duplicates };
}

// ── Pure: worktree state → stranded-work lines ──────────────────────────────

function summarizeWorktrees(entries) {
  return entries
    .filter(e => e.ahead > 0)
    .map(e => `${e.name}: ${e.ahead} unmerged commit${e.ahead > 1 ? 's' : ''}${e.lastCommitDays != null ? ` (last touched ${e.lastCommitDays}d ago)` : ''}`);
}

// ── Impure gatherer — every source fails soft ───────────────────────────────

function gatherDigest({ repo, hours = 24 } = {}) {
  const digest = { generatedAt: new Date().toISOString(), hours, commits: null, stuck: {}, errors: [] };
  // timeoutMs param: worktree-scan git calls run up to ~3× per worktree ×
  // ~20 worktrees — cap them at 5s each so a wedged repo can't stall the
  // morning email for minutes (codex ship-check). Coarse calls keep 30s.
  const run = (cmd, args, cwd, timeoutMs = 30000) => execFileSync(cmd, args, { cwd: cwd || repo, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });

  // 1. What landed on origin/main (fetch first so we see CI's commits, not
  //    the possibly-stale local main).
  try {
    try { run('git', ['fetch', 'origin', 'main', '--quiet']); } catch { digest.errors.push('git fetch failed — commit summary may be stale'); }
    const log = run('git', ['log', 'origin/main', `--since=${hours} hours ago`, '--pretty=%an\t%s']);
    digest.commits = summarizeCommits(log.split('\n').filter(Boolean));
  } catch (err) {
    digest.errors.push(`couldn't read git history (${String(err.message).slice(0, 80)})`);
  }

  // 2. Stranded worktrees (unmerged finished work).
  try {
    const wtRoot = path.join(repo, '.claude', 'worktrees');
    const entries = [];
    for (const name of fs.existsSync(wtRoot) ? fs.readdirSync(wtRoot) : []) {
      const wt = path.join(wtRoot, name);
      try {
        const branch = run('git', ['branch', '--show-current'], wt, 5000).trim();
        if (!branch || branch === 'main') continue;
        const ahead = Number(run('git', ['rev-list', '--count', `origin/main..${branch}`], wt, 5000).trim());
        let lastCommitDays = null;
        try {
          const ts = Number(run('git', ['log', '-1', '--format=%ct'], wt, 5000).trim()) * 1000;
          lastCommitDays = Math.floor((Date.now() - ts) / 86400000);
        } catch { /* cosmetic only */ }
        entries.push({ name, ahead, lastCommitDays });
      } catch { /* not a live worktree — skip */ }
    }
    digest.stuck.worktrees = summarizeWorktrees(entries);
  } catch (err) {
    digest.errors.push(`couldn't scan worktrees (${String(err.message).slice(0, 80)})`);
  }

  // 3. Automated cmux sessions still open (and duplicate dispatches).
  try {
    if (fs.existsSync(CMUX_BIN)) {
      digest.stuck.workspaces = parseWorkspaces(run(CMUX_BIN, ['list-workspaces']));
    }
  } catch (err) {
    digest.errors.push(`couldn't reach cmux (${String(err.message).slice(0, 80)})`);
  }

  // 4. Review-count regressions the rebuild guard recorded in the window —
  //    the -152-drop class. File is rewritten each rebuild; only report a
  //    fresh one.
  try {
    const regPath = path.join(repo, 'data', 'audit', 'rebuild-regression.json');
    if (fs.existsSync(regPath)) {
      const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
      const fresh = reg.timestamp && (Date.now() - new Date(reg.timestamp).getTime()) < hours * 3600000;
      if (fresh && Array.isArray(reg.regressions) && reg.regressions.length) {
        digest.stuck.reviewRegressions = reg.regressions.slice(0, 5).map(r => `${r.showId}: ${r.oldCount}→${r.newCount} reviews (${r.reason})`);
      }
    }
  } catch (err) {
    digest.errors.push(`couldn't read rebuild-regression.json (${String(err.message).slice(0, 80)})`);
  }

  return digest;
}

// ── Render (HTML block for the morning email) ───────────────────────────────

function renderDigestBlock(digest) {
  if (!digest) return '';
  const parts = [];
  parts.push(`<h3 style="font-size:15px;margin:20px 0 8px;border-top:1px solid #e5e5e5;padding-top:16px;">What changed in the last 24h</h3>`);

  const lines = digest.commits?.lines || [];
  if (lines.length) {
    parts.push(`<ul style="font-size:13px;margin:0 0 10px;padding-left:18px;color:#333;">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`);
  } else {
    parts.push(`<p style="font-size:13px;color:#666;margin:0 0 10px;">No pipeline activity recorded${digest.errors.length ? '' : ' — unusually quiet, worth a look'}.</p>`);
  }
  if (digest.commits?.mergedWork?.length) {
    parts.push(`<p style="font-size:12px;color:#555;margin:0 0 10px;"><strong>Fixes & features merged:</strong> ${digest.commits.mergedWork.map(esc).join(' · ')}</p>`);
  }

  const stuck = [];
  if (digest.stuck?.workspaces?.duplicates?.length) {
    stuck.push(`Same task dispatched more than once: ${digest.stuck.workspaces.duplicates.map(esc).join('; ')}`);
  }
  // Threshold −100, not −25: normal flag/unflag churn sums to ±25 over
  // hundreds of daily rebuilds (QA review 2026-07-22); the real incident
  // class (−152) clears −100 easily, and per-show detail comes from
  // rebuild-regression.json below anyway.
  if (digest.commits && digest.commits.reviewDelta <= -100) {
    stuck.push(`Net review count dropped ${digest.commits.reviewDelta} in 24h — check the flaggers`);
  }
  if (digest.stuck?.reviewRegressions?.length) {
    stuck.push(`Shows losing scored reviews: ${digest.stuck.reviewRegressions.map(esc).join('; ')}`);
  }
  if (digest.stuck?.worktrees?.length) {
    stuck.push(`Finished-but-unmerged work sitting in ${digest.stuck.worktrees.length} worktree${digest.stuck.worktrees.length > 1 ? 's' : ''}: ${digest.stuck.worktrees.slice(0, 4).map(esc).join('; ')}`);
  }
  if (stuck.length) {
    parts.push(`<p style="font-size:13px;margin:0 0 4px;font-weight:700;color:#b45309;">⚠️ Possibly stuck / needs a look</p>`);
    parts.push(`<ul style="font-size:12px;margin:0 0 10px;padding-left:18px;color:#7c4a03;">${stuck.map(l => `<li>${l}</li>`).join('')}</ul>`);
  } else {
    parts.push(`<p style="font-size:13px;color:#15803d;margin:0 0 10px;">✅ Nothing looks stuck: no duplicate dispatches, no stranded worktrees, no review-count regressions.</p>`);
  }

  const openAuto = digest.stuck?.workspaces?.autoOpen?.length ?? null;
  if (openAuto != null) {
    parts.push(`<p style="font-size:12px;color:#666;margin:0 0 6px;">${openAuto} automated session${openAuto === 1 ? '' : 's'} currently open in cmux (🤖 tabs — none need you).</p>`);
  }
  if (digest.errors.length) {
    parts.push(`<p style="font-size:11px;color:#999;margin:0;">Couldn't check: ${digest.errors.map(esc).join(' · ')}</p>`);
  }
  return parts.join('\n');
}

module.exports = { summarizeCommits, parseWorkspaces, summarizeWorktrees, gatherDigest, renderDigestBlock };
