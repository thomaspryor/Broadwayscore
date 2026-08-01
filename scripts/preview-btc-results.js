#!/usr/bin/env node
/**
 * Beat the Critics — results preview generator
 *
 * Reads the three data files, computes scores, and writes:
 *   data/beat-the-critics-results-preview.md   — Markdown summary for Tom's review
 *   data/beat-the-critics-sample-email.html    — Sample results email (winner's data)
 *
 * Does NOT send any emails. Run locally or via btc-results-preview.yml.
 *
 * Usage:
 *   node scripts/preview-btc-results.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const WINNERS_PATH    = path.join(ROOT, 'data/beat-the-critics-winners.json');
const CRITIC_PATH     = path.join(ROOT, 'data/beat-the-critics-critic-picks.json');
const SUBMISSIONS_PATH = path.join(ROOT, 'data/beat-the-critics-submissions.jsonl');
const PREVIEW_OUT     = path.join(ROOT, 'data/beat-the-critics-results-preview.md');
const SAMPLE_HTML_OUT = path.join(ROOT, 'data/beat-the-critics-sample-email.html');

const CEREMONY_YEAR = 2026;

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Loaders ───────────────────────────────────────────────────────────────

function loadJson(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${label}: ${p}`);
    console.error('Create this file before running. See data/*.template.json for the format.');
    process.exit(1);
  }
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  // Strip the _instructions meta key
  const { _instructions, ...rest } = parsed;
  return rest;
}

function loadSubmissions() {
  if (!fs.existsSync(SUBMISSIONS_PATH)) {
    if (DRY_RUN) {
      console.log(`(dry run) No submissions file at ${SUBMISSIONS_PATH} — scoring with an empty submission set.`);
      return [];
    }
    console.error(`No submissions file at ${SUBMISSIONS_PATH}`);
    process.exit(1);
  }
  return fs.readFileSync(SUBMISSIONS_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ─── Scoring ───────────────────────────────────────────────────────────────

function scoreSubmission(picks, winners) {
  let correct = 0;
  const details = {};
  for (const [cat, winner] of Object.entries(winners)) {
    const userPick = picks[cat];
    const isCorrect = userPick === winner;
    if (isCorrect) correct++;
    details[cat] = { userPick: userPick ?? '(no pick)', winner, correct: isCorrect };
  }
  return { correct, total: Object.keys(winners).length, details };
}

function scoreCritic(criticPicks, winners) {
  let correct = 0;
  for (const [cat, winner] of Object.entries(winners)) {
    if (criticPicks[cat] === winner) correct++;
  }
  return correct;
}

// ─── Score distribution ─────────────────────────────────────────────────────

function buildDistribution(scored, total) {
  const buckets = Array(total + 1).fill(0);
  for (const s of scored) buckets[s.score.correct]++;
  return buckets;
}

// ─── Markdown preview ──────────────────────────────────────────────────────

function buildMarkdown({ submissions, scored, winners, criticScores, topScore, topScorers, distribution }) {
  const categories = Object.keys(winners);
  const total = categories.length;

  // Critic comparison table
  const criticRows = Object.entries(criticScores)
    .map(([name, { correct, outlet }]) => {
      const beaters = scored.filter(s => s.score.correct > correct).length;
      const tiers = scored.filter(s => s.score.correct === correct).length;
      return `| ${name} | ${outlet} | ${correct}/${total} | ${beaters} beat / ${tiers} tied |`;
    })
    .join('\n');

  // Score distribution histogram
  const histRows = distribution
    .map((count, score) => {
      const bar = '█'.repeat(Math.min(count, 40));
      const pct = submissions.length > 0 ? ((count / submissions.length) * 100).toFixed(1) : '0.0';
      return `| ${score}/${total} | ${count} | ${pct}% | ${bar} |`;
    })
    .filter((_, i) => distribution[i] > 0)
    .join('\n');

  // Category accuracy
  const catRows = categories.map(cat => {
    const pick = winners[cat];
    const correct = scored.filter(s => s.picks[cat] === pick).length;
    const pct = submissions.length > 0 ? ((correct / submissions.length) * 100).toFixed(1) : '0.0';
    return `| ${cat} | ${pick} | ${correct} | ${pct}% |`;
  }).join('\n');

  // Top scorers list
  const topList = topScorers.slice(0, 10).map((s, i) =>
    `${i + 1}. ${s.email} — **${s.score.correct}/${total}**`
  ).join('\n');

  const winnerSection = topScorers.length === 1
    ? `\n**Winner: ${topScorers[0].email}** with ${topScore}/${total} correct\n`
    : `\n**${topScorers.length} tied at ${topScore}/${total}** — need tiebreaker\n\n${topList}\n`;

  return `# Beat the Critics — Results Preview
Tony Awards ${CEREMONY_YEAR}
Generated: ${new Date().toISOString()}

---

## Summary

- **Total submissions:** ${submissions.length}
- **Top score:** ${topScore}/${total}
- **Top scorers:** ${topScorers.length} ${topScorers.length === 1 ? 'winner' : 'tied'}
- **Median score:** ${median(scored.map(s => s.score.correct))}/${total}
- **Mean score:** ${(scored.reduce((a, s) => a + s.score.correct, 0) / (scored.length || 1)).toFixed(1)}/${total}
${winnerSection}
---

## Score Distribution

| Score | Count | % | Distribution |
|-------|-------|---|--------------|
${histRows}

---

## Critic Scores

| Critic | Outlet | Score | Users |
|--------|--------|-------|-------|
${criticRows}

---

## Category-by-Category Accuracy

| Category | Tony Winner | Users Correct | % Correct |
|----------|-------------|---------------|-----------|
${catRows}

---

## Top 10 Scorers

${topList}

---

## Send Command

When ready to send results emails, run locally:

\`\`\`bash
node scripts/send-btc-results.js --dry-run
node scripts/send-btc-results.js --send-to=thomas.pryor@gmail.com
node scripts/send-btc-results.js
\`\`\`

Or via GitHub Actions:
\`\`\`bash
gh workflow run send-btc-results.yml
\`\`\`
`;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ─── Sample email HTML (reused from send-btc-results.js logic) ─────────────

function buildSampleHtml({ submission, score, criticScores, winners }) {
  const categoriesHtml = Object.entries(winners).map(([cat, winner]) => {
    const userPick = submission.picks[cat] ?? '(no pick)';
    const correct = userPick === winner;
    const icon = correct ? '✓' : '✗';
    const iconColor = correct ? '#22c55e' : '#ef4444';
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #1f1f1f;vertical-align:top;">
          <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px;">${cat.replace('Best ', '')}</div>
          <div style="font-size:13px;font-weight:700;color:${correct ? '#ffffff' : '#9ca3af'};">${userPick}</div>
          ${!correct ? `<div style="font-size:11px;color:#6b7280;margin-top:1px;">Winner: ${winner}</div>` : ''}
        </td>
        <td style="padding:10px 0 10px 12px;border-bottom:1px solid #1f1f1f;text-align:right;vertical-align:middle;">
          <span style="font-size:16px;font-weight:700;color:${iconColor};">${icon}</span>
        </td>
      </tr>`;
  }).join('');

  const criticsHtml = Object.entries(criticScores).map(([name, { correct: cCorrect, outlet }]) => {
    const beat = score.correct > cCorrect;
    const tied = score.correct === cCorrect;
    const label = beat ? 'You beat them!' : tied ? 'Tied' : 'They beat you';
    const labelColor = beat ? '#22c55e' : tied ? '#f59e0b' : '#6b7280';
    return `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #1f1f1f;">
          <div style="font-size:13px;font-weight:700;color:#ffffff;">${name}</div>
          <div style="font-size:11px;color:#6b7280;">${outlet} &middot; ${cCorrect}/${score.total} correct</div>
        </td>
        <td style="padding:8px 0 8px 12px;border-bottom:1px solid #1f1f1f;text-align:right;">
          <span style="font-size:11px;font-weight:700;color:${labelColor};">${label}</span>
        </td>
      </tr>`;
  }).join('');

  const winnerBanner = `
    <div style="background:linear-gradient(135deg,rgba(245,158,11,0.15),rgba(245,158,11,0.08));border:1px solid rgba(245,158,11,0.3);border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
      <div style="font-size:28px;margin-bottom:8px;">🎉🏆🎟️</div>
      <div style="font-size:16px;font-weight:900;color:#f59e0b;margin-bottom:6px;">SAMPLE — Winner Banner</div>
      <div style="font-size:13px;color:#d97706;">This is what the winner's email looks like. Your $100 TodayTix voucher is on its way.</div>
    </div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Beat the Critics — Sample Results Email</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <!-- SAMPLE EMAIL PREVIEW — Not sent to users -->
  <div style="background:#f59e0b;color:#000;padding:8px;text-align:center;font-size:12px;font-weight:700;">
    PREVIEW ONLY — This is a sample of what the winner's email will look like
  </div>
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="background:#111111;border:1px solid #1f1f1f;border-radius:16px;overflow:hidden;">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,rgba(255,19,104,0.12),rgba(0,85,255,0.06));padding:28px 28px 20px;border-bottom:1px solid #1f1f1f;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Broadway Scorecard</div>
        <div style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.02em;">Beat the Critics — Results</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px;">Tony Awards ${CEREMONY_YEAR}</div>
      </div>

      <!-- Score hero -->
      <div style="padding:28px;text-align:center;border-bottom:1px solid #1f1f1f;">
        ${winnerBanner}
        <div style="font-size:48px;font-weight:900;color:#ff1368;letter-spacing:-0.03em;">${score.correct}<span style="font-size:24px;color:#4b5563;">/${score.total}</span></div>
        <div style="font-size:14px;color:#9ca3af;margin-top:6px;">categories correct</div>
      </div>

      <!-- Your ballot -->
      <div style="padding:20px 28px;border-bottom:1px solid #1f1f1f;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">Your Picks</div>
        <table style="width:100%;border-collapse:collapse;">
          ${categoriesHtml}
        </table>
      </div>

      <!-- Critics comparison -->
      <div style="padding:20px 28px;border-bottom:1px solid #1f1f1f;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;">How You Compared</div>
        <table style="width:100%;border-collapse:collapse;">
          ${criticsHtml}
        </table>
      </div>

      <!-- Footer CTA -->
      <div style="padding:20px 28px;text-align:center;">
        <a href="https://broadwayscorecard.com/beat-the-critics" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#ff1368,#d4106a);color:#ffffff;text-decoration:none;border-radius:10px;font-size:13px;font-weight:700;">See Full Results →</a>
        <div style="font-size:11px;color:#374151;margin-top:16px;"><a href="https://broadwayscorecard.com" style="color:#4b5563;text-decoration:none;">broadwayscorecard.com</a></div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

// ─── Main ──────────────────────────────────────────────────────────────────

function main() {
  console.log('=== Beat the Critics — Results Preview ===\n');

  const winners = loadJson(WINNERS_PATH, 'winners');
  const criticPicksData = loadJson(CRITIC_PATH, 'critic picks');
  const allSubmissions = loadSubmissions();

  // Validate winners are filled in
  const emptyCategories = Object.entries(winners).filter(([, v]) => !v);
  if (emptyCategories.length > 0) {
    console.error(`ERROR: ${emptyCategories.length} categories have no winner set:`);
    for (const [cat] of emptyCategories) console.error(`  - ${cat}`);
    console.error('\nFill in data/beat-the-critics-winners.json before running preview.');
    process.exit(1);
  }

  // De-duplicate submissions by email — keep most recent
  const byEmail = new Map();
  for (const s of allSubmissions) {
    byEmail.set(s.email.toLowerCase(), s);
  }
  const submissions = Array.from(byEmail.values());
  console.log(`${submissions.length} unique submissions (${allSubmissions.length} total lines)`);

  // Score critics
  const criticScores = {};
  for (const [name, { outlet, picks: cPicks }] of Object.entries(criticPicksData)) {
    criticScores[name] = { correct: scoreCritic(cPicks || {}, winners), outlet };
  }
  console.log('\nCritic scores:');
  for (const [name, { correct, outlet }] of Object.entries(criticScores)) {
    console.log(`  ${name} (${outlet}): ${correct}/${Object.keys(winners).length}`);
  }

  // Score all submissions
  const scored = submissions.map(s => ({
    ...s,
    score: scoreSubmission(s.picks || {}, winners),
  }));
  scored.sort((a, b) => b.score.correct - a.score.correct);

  const topScore = scored[0]?.score.correct ?? 0;
  const topScorers = scored.filter(s => s.score.correct === topScore);
  const distribution = buildDistribution(scored, Object.keys(winners).length);

  console.log(`\nTop score: ${topScore}/${Object.keys(winners).length} (${topScorers.length} tied)`);

  // Build sample email using the top scorer's data (or a synthetic submission if no scores yet)
  const sampleSubmission = topScorers[0] ?? {
    email: 'winner@example.com',
    picks: Object.fromEntries(Object.entries(winners).map(([cat, win]) => [cat, win])),
  };
  const sampleScore = sampleSubmission.score ?? scoreSubmission(sampleSubmission.picks, winners);

  if (DRY_RUN) {
    // Smoke-test lane (task #737): proves the load -> score -> render path
    // runs end-to-end without writing the real preview files or triggering
    // a commit/email downstream. Exercises buildMarkdown/buildSampleHtml so
    // a template regression still surfaces here, just never touches disk.
    buildMarkdown({ submissions, scored, winners, criticScores, topScore, topScorers, distribution });
    buildSampleHtml({ submission: sampleSubmission, score: sampleScore, criticScores, winners });
    console.log(`\n(dry run) Preview generation succeeded — skipped writing ${PREVIEW_OUT} and ${SAMPLE_HTML_OUT}.`);
    return;
  }

  // Write preview markdown
  const markdown = buildMarkdown({ submissions, scored, winners, criticScores, topScore, topScorers, distribution });
  fs.writeFileSync(PREVIEW_OUT, markdown, 'utf8');
  console.log(`\nPreview written to: ${PREVIEW_OUT}`);

  const sampleHtml = buildSampleHtml({
    submission: sampleSubmission,
    score: sampleScore,
    criticScores,
    winners,
  });
  fs.writeFileSync(SAMPLE_HTML_OUT, sampleHtml, 'utf8');
  console.log(`Sample email written to: ${SAMPLE_HTML_OUT}`);

  console.log('\nDone. Review the preview, then send results with:');
  console.log('  node scripts/send-btc-results.js --dry-run');
  console.log('  node scripts/send-btc-results.js --send-to=thomas.pryor@gmail.com');
  console.log('  node scripts/send-btc-results.js');
}

main();
