#!/usr/bin/env node
/**
 * analyze-rebuild-drops.js
 *
 * Runs after a successful rebuild. If significant review drops occurred, calls Claude
 * Sonnet to produce a qualitative analysis of whether the drops look routine or suspicious,
 * then sends a focused email with the verdict and details.
 *
 * Fires when: total dropped > 30 OR any single show > 10 reviews
 * 48h cooldown per verdict type to avoid spamming during multi-day operations.
 *
 * Usage:
 *   node scripts/analyze-rebuild-drops.js
 *   node scripts/analyze-rebuild-drops.js --dry-run   (print without sending)
 *   node scripts/analyze-rebuild-drops.js --force     (bypass 48h cooldown)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { CLAUDE_SONNET } = require('./lib/models');

const { isPrematureReviewForUnopenedShow } = require('./lib/review-guards');
const { hasValidScore, passesFlagFilters } = require('./lib/review-text-scoreable');

// BSC_DATA_ROOT: worktree sessions point at the main checkout's data/ (the
// private review-texts clone only exists there).
const DATA_DIR = path.join(process.env.BSC_DATA_ROOT || path.join(__dirname, '..'), 'data');
const AUDIT_DIR = path.join(DATA_DIR, 'audit');
const TRIAGE_DIR = path.join(AUDIT_DIR, 'triage');
const PIPELINE_DIR = path.join(AUDIT_DIR, 'pipeline-health');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// --expect-add=N — bulk-import inverse-drop guard. When set, the script ALSO
// fires if the actual added review count is less than EXPECT_ADD_TOLERANCE
// (70%) of the expected. Wired by run-bulk-historical-import.js. The
// expect/actual comparison rides on rebuild-show-drift.json's existing
// per-show delta (positive = added). See scripts/lib/bulk-import-summary.js
// for the parallel non-blocking summary path used by the orchestrator.
const expectAddArg = process.argv.find(a => a.startsWith('--expect-add='));
const EXPECT_ADD = expectAddArg ? parseInt(expectAddArg.split('=')[1], 10) : 0;
const EXPECT_ADD_TOLERANCE = 0.7;

// Thresholds: fire if total dropped > 30 OR any single show > 10
const TOTAL_DROP_THRESHOLD = 30;
const SINGLE_SHOW_THRESHOLD = 10;

// ─── Load audit files ─────────────────────────────────────────────────────────

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

const regressionData = loadJSON(path.join(AUDIT_DIR, 'rebuild-regression.json'));
const driftData = loadJSON(path.join(AUDIT_DIR, 'rebuild-show-drift.json'));
const lastSuccessRaw = fs.existsSync(path.join(PIPELINE_DIR, 'rebuild-reviews.last-success'))
  ? fs.readFileSync(path.join(PIPELINE_DIR, 'rebuild-reviews.last-success'), 'utf8').trim()
  : null;

// Only analyze drops that happened in THIS rebuild (newer than last-success)
// last-success is written AFTER the script, so guard files from same run are older.
// We use a 2-hour window instead of strict comparison to handle timing edge cases.
const now = Date.now();
const twoHoursAgo = now - 2 * 60 * 60 * 1000;

function isFromThisRun(data) {
  if (!data?.timestamp) return false;
  return new Date(data.timestamp).getTime() > twoHoursAgo;
}

const regressions = (regressionData && isFromThisRun(regressionData)) ? (regressionData.regressions || []) : [];
const drifts = (driftData && isFromThisRun(driftData)) ? (driftData.shows || []) : [];

// ─── Guard-explained drops (unopened-show prior-run exclusions) ───────────────
//
// The pre-opening temporal gate in review-guards.js excludes prior-production
// reviews filed under a never-opened show (announced/upcoming/previews, no
// priorRuns). Those drops are the guard WORKING — but they carry zero quality
// flags, so they read as "unexplained" and paged 4 identical NEEDS_REVIEW
// emails in 2h on 2026-07-21 (orlando/burnt-up-love/soldiers-of-tomorrow
// off-west-end-2026). Count them with the canonical predicate so they explain
// their show's drop the same way quality flags do.

const showsById = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.shows || [];
    return new Map(list.map(s => [s.id, s]));
  } catch { return new Map(); }
})();

function countGuardExcluded(showId) {
  const show = showsById.get(showId);
  if (!show) return 0;
  let n = 0;
  try {
    for (const f of fs.readdirSync(path.join(REVIEW_TEXTS_DIR, showId))) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, showId, f), 'utf8'));
        // Only SCORED, UNFLAGGED premature files can explain a drop:
        //  - a regression counts scored reviews that vanished, so an unscored
        //    premature husk never contributed to the old count (Codex finding)
        //  - a file already carrying wrongProduction/wrongShow/etc. is counted
        //    by the rebuild's own flaggedScored — counting it here too would
        //    double-credit one file (ship-check finding); passesFlagFilters is
        //    the canonical flag gate.
        if (isPrematureReviewForUnopenedShow(d, show) && hasValidScore(d) && passesFlagFilters(d, show)) n++;
      } catch { /* unreadable file — not evidence either way */ }
    }
  } catch { return 0; }
  return n;
}

for (const r of regressions) {
  r.guardExcluded = countGuardExcluded(r.showId);
}

// ─── Check thresholds ─────────────────────────────────────────────────────────

const explainedFor = (r) => (r.flaggedScored || 0) + (r.guardExcluded || 0);
const unexplainedDropFor = (r) => Math.max(0, r.dropped - explainedFor(r));

const totalDropped = regressions.reduce((sum, r) => sum + r.dropped, 0);
// Thresholds fire on the UNEXPLAINED portion only — flag-explained and
// guard-explained drops are intentional exclusions, not incidents.
const totalUnexplained = regressions.reduce((sum, r) => sum + unexplainedDropFor(r), 0);
const maxSingleDrop = regressions.length > 0 ? Math.max(...regressions.map(r => unexplainedDropFor(r))) : 0;
const significantDrift = drifts.filter(d => Math.abs(d.delta) > 8); // only flag large drifts

// Inverse-drop check: when --expect-add=N is set, sum positive per-show deltas
// from rebuild-show-drift.json and fire if too few reviews actually landed.
// Bulk-import orchestrator passes the expected count; rebuild reports the actual.
let inverseDropFired = false;
let actualAdded = 0;
let inverseRatio = null;
if (EXPECT_ADD > 0) {
  actualAdded = drifts.reduce((sum, d) => sum + (d.delta > 0 ? d.delta : 0), 0);
  inverseRatio = actualAdded / EXPECT_ADD;
  if (inverseRatio < EXPECT_ADD_TOLERANCE) {
    inverseDropFired = true;
    console.log(`[Drop Analysis] INVERSE-DROP: expected ${EXPECT_ADD} adds, got ${actualAdded} (${(inverseRatio * 100).toFixed(1)}%, threshold ${(EXPECT_ADD_TOLERANCE * 100).toFixed(0)}%)`);
  }
}

const hasSignificantDrops = totalUnexplained > TOTAL_DROP_THRESHOLD || maxSingleDrop > SINGLE_SHOW_THRESHOLD;
const hasSignificantDrift = significantDrift.length >= 5;

if (!hasSignificantDrops && !hasSignificantDrift && !inverseDropFired) {
  const inverseNote = EXPECT_ADD > 0
    ? `, expect-add: ${actualAdded}/${EXPECT_ADD} ratio=${(inverseRatio * 100).toFixed(1)}%`
    : '';
  console.log(`[Drop Analysis] No significant drops (total: ${totalDropped}, unexplained: ${totalUnexplained}, max single unexplained: ${maxSingleDrop}, drift: ${drifts.length}${inverseNote}). Skipping.`);
  process.exit(0);
}

console.log(`[Drop Analysis] Significant drops detected: ${totalDropped} total, ${regressions.length} shows, ${drifts.length} drifted shows.`);

// ─── 48h cooldown ─────────────────────────────────────────────────────────────

// NOTE: this state file must be COMMITTED by the calling workflow or the
// cooldown is a no-op — each CI run starts from a fresh checkout (2026-07-21:
// 4 identical NEEDS_REVIEW emails in 2h because the file was written but
// never staged; rebuild-reviews.yml's `git add data/audit/*.json` glob does
// not descend into triage/).
const cooldownFile = path.join(TRIAGE_DIR, 'drop-analysis-alert.json');
// Same-incident signature: the set of affected shows and their drop counts.
// A repeat of an already-emailed incident stays silent for 7 days even after
// the 48h global cooldown lapses; a DIFFERENT drop pattern emails normally.
// Unexplained total is part of the signature: the same raw drop pattern whose
// explained portion shrinks (drops turn unexplained) is a NEW incident.
const dropSignature = regressions
  .map(r => `${r.showId}:-${r.dropped}`)
  .sort()
  .join('|') + `|u${totalUnexplained}`;
if (!FORCE && !DRY_RUN) {
  const cooldown = loadJSON(cooldownFile);
  if (cooldown?.lastSent) {
    const hoursSince = (now - new Date(cooldown.lastSent).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 48) {
      console.log(`[Drop Analysis] Cooldown active — last sent ${Math.round(hoursSince)}h ago. Use --force to bypass.`);
      process.exit(0);
    }
    if (cooldown.signature && cooldown.signature === dropSignature && hoursSince < 7 * 24) {
      console.log(`[Drop Analysis] Identical drop signature already emailed ${Math.round(hoursSince)}h ago — suppressing repeat. Use --force to bypass.`);
      process.exit(0);
    }
  }
}

// ─── Recent pipeline context (last 24h workflow runs) ─────────────────────────

let recentActivity = 'Unable to retrieve recent workflow activity.';
try {
  const runs = JSON.parse(execSync(
    'gh run list --limit=20 --json workflowName,conclusion,createdAt,displayTitle --jq \'[.[] | select(.createdAt > (now - 86400 | todate))]\'',
    { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim() || '[]');
  if (runs.length > 0) {
    recentActivity = runs.map(r =>
      `- ${r.workflowName}: ${r.conclusion || 'running'} (${new Date(r.createdAt).toISOString().slice(11, 16)} UTC)${r.displayTitle && r.displayTitle !== r.workflowName ? ` — "${r.displayTitle}"` : ''}`
    ).join('\n');
  } else {
    recentActivity = 'No workflow runs in last 24h.';
  }
} catch { /* gh CLI unavailable — skip */ }

// ─── Pattern analysis ─────────────────────────────────────────────────────────

// Classify drops: explained (quality flags + unopened-show guard) vs unexplained
let flagExplained = 0;
let unexplained = 0;
for (const r of regressions) {
  if (explainedFor(r) >= r.dropped) {
    flagExplained++;
  } else {
    unexplained++;
  }
}

// Era distribution
const eraPattern = {};
for (const r of regressions) {
  const year = r.showId.match(/-(\d{4})$/)?.[1] || r.showId.match(/-(\d{4})-/)?.[1] || 'unknown';
  eraPattern[year] = (eraPattern[year] || 0) + 1;
}
const topEras = Object.entries(eraPattern).sort((a, b) => b[1] - a[1]).slice(0, 5)
  .map(([y, n]) => `${y}: ${n}`).join(', ');

// ─── Build Claude prompt ───────────────────────────────────────────────────────

const top10 = regressions.slice(0, 10).map(r =>
  `  - ${r.showId}: ${r.oldCount}→${r.newCount} (-${r.dropped})` +
  (r.scoredOnDisk != null ? `, scored on disk: ${r.scoredOnDisk}` : '') +
  (r.flaggedScored ? `, quality-flagged: ${r.flaggedScored}` : '') +
  (r.guardExcluded ? `, unopened-show guard-excluded: ${r.guardExcluded}` : '') +
  (r.reason ? ` [${r.reason}]` : '')
).join('\n');

const driftTop5 = significantDrift.slice(0, 5).map(d =>
  `  - ${d.showId}: ${d.oldMean}→${d.newMean} (Δ${d.delta}pts, ${d.oldCount}→${d.newCount} reviews)`
).join('\n') || '  None above 8pt threshold.';

const prompt = `A Broadway Scorecard reviews rebuild just completed and review counts changed significantly. Analyze whether this looks routine or suspicious.

SUMMARY:
- Total reviews dropped: ${totalDropped} across ${regressions.length} shows
- Largest single-show drop: ${maxSingleDrop} reviews
- Drop classification: ${flagExplained} shows fully explained (quality flags and/or the unopened-show prior-run guard), ${unexplained} shows with unexplained drops (${totalUnexplained} unexplained reviews total)
- Era distribution of affected shows: ${topEras || 'unknown'}
- Score drift (>8pt shift without new reviews): ${significantDrift.length} shows

TOP AFFECTED SHOWS (by reviews dropped):
${top10}${regressions.length > 10 ? `\n  ...and ${regressions.length - 10} more` : ''}

SCORE DRIFT (shows with large score shifts):
${driftTop5}

RECENT PIPELINE ACTIVITY (last 24h):
${recentActivity}

CONTEXT:
- "scored files exist but being dropped" = files have scores on disk but rebuild excluded them (dedup, cross-market guard, URL-year mismatch, or isScoreable=false)
- "quality-flagged" = files marked wrongShow/wrongProduction/isRoundupArticle (intentional exclusions)
- "unopened-show guard-excluded" = the pre-opening temporal gate correctly excluding prior-production reviews filed under a never-opened show (intentional, systematic — NOT a bug)
- Flag-explained and guard-explained drops are almost always routine data quality work
- Unexplained drops (scored files on disk but not in output) can indicate a logic change or bug

Please respond in exactly this format:
VERDICT: ROUTINE | NEEDS_REVIEW | SUSPICIOUS
ANALYSIS: [2-3 sentences. What most likely caused these drops? Is the pattern consistent with routine pipeline work or does something look off?]
ACTION: [One sentence. What should the user do, if anything?]`;

// ─── Call Claude Sonnet ───────────────────────────────────────────────────────

async function callClaude(userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 300,
      messages: [{ role: 'user', content: userPrompt }],
      system: 'You are a data pipeline analyst for Broadway Scorecard, a review aggregator. You understand that review drops are usually caused by: (1) quality flags (wrongShow, wrongProduction, duplicate) being applied to review files, (2) deduplication runs, (3) cross-market guard corrections, (4) pipeline logic changes that re-classify reviews. Genuine data corruption — a scraper bug silently deleting valid reviews — is rare. Be concise and direct. Never hedge with "could be" when the evidence points clearly in one direction.',
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || 'Analysis unavailable.');
        } catch { reject(new Error('Failed to parse Claude response')); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ─── Send email via Resend ────────────────────────────────────────────────────

async function sendEmail(subject, htmlBody) {
  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!apiKey || !ownerEmail) throw new Error('RESEND_API_KEY or OWNER_EMAIL not set');

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      from: 'Broadway Scorecard <alerts@broadwayscorecard.com>',
      to: [ownerEmail],
      subject,
      html: htmlBody,
    });
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error(`Resend error: ${res.statusCode} ${body}`));
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Get Claude's analysis
  let verdict = 'NEEDS_REVIEW';
  let analysis = 'Analysis unavailable — ANTHROPIC_API_KEY not set or API error.';
  let action = 'Review data/audit/rebuild-regression.json for details.';

  try {
    const response = await callClaude(prompt);
    console.log('[Drop Analysis] Claude response:\n' + response);

    const verdictMatch = response.match(/^VERDICT:\s*(ROUTINE|NEEDS_REVIEW|SUSPICIOUS)/m);
    const analysisMatch = response.match(/^ANALYSIS:\s*(.+?)(?=\nACTION:|$)/ms);
    const actionMatch = response.match(/^ACTION:\s*(.+)/m);

    if (verdictMatch) verdict = verdictMatch[1];
    if (analysisMatch) analysis = analysisMatch[1].trim();
    if (actionMatch) action = actionMatch[1].trim();
  } catch (err) {
    console.error('[Drop Analysis] Claude call failed:', err.message);
  }

  // Verdict styling
  const verdictStyle = {
    ROUTINE:      { color: '#2ecc71', bg: '#0d2b1a', label: 'ROUTINE',      emoji: '✅' },
    NEEDS_REVIEW: { color: '#f39c12', bg: '#2b1e0d', label: 'NEEDS REVIEW', emoji: '⚠️' },
    SUSPICIOUS:   { color: '#e74c3c', bg: '#2b0d0d', label: 'SUSPICIOUS',   emoji: '🚨' },
  }[verdict] || { color: '#aaa', bg: '#222', label: verdict, emoji: '❓' };

  // Build top-10 table
  const tableRows = regressions.slice(0, 15).map(r => {
    const explained = explainedFor(r);
    const explainedPct = explained ? Math.round((explained / r.dropped) * 100) : 0;
    const guardNote = r.guardExcluded ? ' (unopened-show guard)' : '';
    const explainedNote = explained >= r.dropped
      ? `<span style="color:#2ecc71">fully explained${guardNote}</span>`
      : explained > 0
        ? `<span style="color:#f39c12">${explainedPct}% explained${guardNote}</span>`
        : `<span style="color:#e74c3c">unexplained</span>`;
    return `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid #333;color:#ccc;font-size:12px;">${r.showId}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #333;color:#e74c3c;text-align:center;font-size:12px;">-${r.dropped}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #333;font-size:11px;">${explainedNote}</td>
    </tr>`;
  }).join('');

  const driftRows = significantDrift.slice(0, 8).map(d =>
    `<tr>
      <td style="padding:5px 10px;border-bottom:1px solid #333;color:#ccc;font-size:12px;">${d.showId}</td>
      <td style="padding:5px 10px;border-bottom:1px solid #333;color:#f39c12;text-align:center;font-size:12px;">${d.delta > 0 ? '+' : ''}${d.delta}pts</td>
      <td style="padding:5px 10px;border-bottom:1px solid #333;color:#888;font-size:11px;">${d.oldMean}→${d.newMean} (${d.oldCount}→${d.newCount} reviews)</td>
    </tr>`
  ).join('');

  const claudePromptForEmail = `The Broadway Scorecard rebuild dropped ${totalDropped} reviews across ${regressions.length} shows. ${analysis} Is this safe to leave, or should I investigate?

To see details: check data/audit/rebuild-regression.json
To investigate: open Claude Code and paste this message`;

  const html = `<!DOCTYPE html><html><body style="background:#1a1a1a;color:#ddd;font-family:sans-serif;padding:24px;max-width:640px;margin:0 auto;">

<h2 style="margin:0 0 4px;color:#fff;">Broadway Scorecard — Rebuild Drop Analysis</h2>
<p style="color:#888;margin:0 0 20px;font-size:13px;">${totalDropped} reviews dropped across ${regressions.length} shows · ${new Date().toUTCString()}</p>

<!-- Verdict -->
<div style="background:${verdictStyle.bg};border-left:4px solid ${verdictStyle.color};padding:16px 20px;border-radius:4px;margin-bottom:20px;">
  <span style="display:inline-block;background:${verdictStyle.color};color:#fff;font-weight:bold;font-size:13px;padding:3px 10px;border-radius:3px;letter-spacing:1px;">${verdictStyle.emoji} ${verdictStyle.label}</span>
  <p style="margin:10px 0 6px;color:#ddd;font-size:14px;line-height:1.5;">${analysis}</p>
  <p style="margin:0;color:#aaa;font-size:13px;font-style:italic;">${action}</p>
</div>

<!-- Stats row -->
<div style="display:flex;gap:12px;margin-bottom:20px;">
  <div style="flex:1;background:#222;padding:12px;border-radius:4px;text-align:center;">
    <div style="font-size:24px;font-weight:bold;color:#e74c3c;">${totalDropped}</div>
    <div style="font-size:11px;color:#888;margin-top:2px;">reviews dropped</div>
  </div>
  <div style="flex:1;background:#222;padding:12px;border-radius:4px;text-align:center;">
    <div style="font-size:24px;font-weight:bold;color:#f39c12;">${regressions.length}</div>
    <div style="font-size:11px;color:#888;margin-top:2px;">shows affected</div>
  </div>
  <div style="flex:1;background:#222;padding:12px;border-radius:4px;text-align:center;">
    <div style="font-size:24px;font-weight:bold;color:${unexplained > 0 ? '#e74c3c' : '#2ecc71'};">${unexplained}</div>
    <div style="font-size:11px;color:#888;margin-top:2px;">unexplained drops</div>
  </div>
  <div style="flex:1;background:#222;padding:12px;border-radius:4px;text-align:center;">
    <div style="font-size:24px;font-weight:bold;color:#9b59b6;">${drifts.length}</div>
    <div style="font-size:11px;color:#888;margin-top:2px;">score shifts</div>
  </div>
</div>

<!-- Drop table -->
${regressions.length > 0 ? `
<h3 style="margin:0 0 8px;font-size:13px;color:#aaa;text-transform:uppercase;letter-spacing:1px;">Affected Shows</h3>
<table style="width:100%;border-collapse:collapse;background:#222;border-radius:4px;margin-bottom:20px;">
  <thead><tr>
    <th style="padding:8px 10px;text-align:left;color:#888;font-size:11px;border-bottom:1px solid #444;">Show</th>
    <th style="padding:8px 10px;text-align:center;color:#888;font-size:11px;border-bottom:1px solid #444;">Dropped</th>
    <th style="padding:8px 10px;text-align:left;color:#888;font-size:11px;border-bottom:1px solid #444;">Explanation</th>
  </tr></thead>
  <tbody>${tableRows}</tbody>
  ${regressions.length > 15 ? `<tfoot><tr><td colspan="3" style="padding:6px 10px;color:#666;font-size:11px;">...and ${regressions.length - 15} more shows</td></tr></tfoot>` : ''}
</table>` : ''}

<!-- Drift table -->
${significantDrift.length > 0 ? `
<h3 style="margin:0 0 8px;font-size:13px;color:#aaa;text-transform:uppercase;letter-spacing:1px;">Score Drift (>8pts)</h3>
<table style="width:100%;border-collapse:collapse;background:#222;border-radius:4px;margin-bottom:20px;">
  <thead><tr>
    <th style="padding:8px 10px;text-align:left;color:#888;font-size:11px;border-bottom:1px solid #444;">Show</th>
    <th style="padding:8px 10px;text-align:center;color:#888;font-size:11px;border-bottom:1px solid #444;">Shift</th>
    <th style="padding:8px 10px;text-align:left;color:#888;font-size:11px;border-bottom:1px solid #444;">Detail</th>
  </tr></thead>
  <tbody>${driftRows}</tbody>
</table>` : ''}

<!-- Claude prompt -->
<h3 style="margin:0 0 8px;font-size:13px;color:#aaa;text-transform:uppercase;letter-spacing:1px;">To Investigate: Paste into Claude Code</h3>
<div style="background:#111;border:1px solid #444;border-radius:4px;padding:12px;margin-bottom:16px;">
  <pre style="margin:0;white-space:pre-wrap;font-size:12px;color:#adf;line-height:1.5;">${claudePromptForEmail}</pre>
</div>

<p style="color:#555;font-size:11px;margin:0;">Broadway Scorecard · 48h cooldown · <a href="https://github.com/thomaspryor/Broadwayscore/actions" style="color:#555;">View Actions</a></p>
</body></html>`;

  const subjectEmoji = { ROUTINE: '✅', NEEDS_REVIEW: '⚠️', SUSPICIOUS: '🚨' }[verdict] || '❓';
  const subject = `${subjectEmoji} BSC Rebuild: ${totalDropped} reviews dropped [${verdict}]`;

  if (DRY_RUN) {
    console.log('\n[Drop Analysis] DRY RUN — would send:');
    console.log('Subject:', subject);
    console.log('Verdict:', verdict);
    console.log('Analysis:', analysis);
    console.log('Action:', action);
    process.exit(0);
  }

  try {
    await sendEmail(subject, html);
    console.log('[Drop Analysis] Email sent:', subject);
    // Record send time for cooldown
    fs.mkdirSync(TRIAGE_DIR, { recursive: true });
    fs.writeFileSync(cooldownFile, JSON.stringify({ lastSent: new Date().toISOString(), verdict, totalDropped, shows: regressions.length, signature: dropSignature }) + '\n');
  } catch (err) {
    console.error('[Drop Analysis] Email failed:', err.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[Drop Analysis] Fatal:', err.message);
  process.exit(1);
});
