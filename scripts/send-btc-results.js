#!/usr/bin/env node
/**
 * Beat the Critics — results email sender
 *
 * Run after the Tony ceremony (June 7, 2026) once you have:
 *   1. data/beat-the-critics-winners.json  — actual Tony winners
 *   2. data/beat-the-critics-critic-picks.json — each panelist's picks
 *   3. data/beat-the-critics-submissions.jsonl — user submissions (auto-populated)
 *
 * Usage:
 *   node scripts/send-btc-results.js --dry-run          # preview, no emails sent
 *   node scripts/send-btc-results.js --send-to=me@email.com  # test to one address
 *   node scripts/send-btc-results.js                    # send to all submissions
 */

'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { applyUtm } = require('./lib/email-utm');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Broadway Scorecard <noreply@broadwayscorecard.com>';
const CEREMONY_YEAR = 2026;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SEND_TO = args.find(a => a.startsWith('--send-to='))?.split('=')[1] ?? null;

// ─── Load data ───

const WINNERS_PATH = path.join(__dirname, '../data/beat-the-critics-winners.json');
const CRITIC_PICKS_PATH = path.join(__dirname, '../data/beat-the-critics-critic-picks.json');
const SUBMISSIONS_PATH = path.join(__dirname, '../data/beat-the-critics-submissions.jsonl');

function loadJson(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${label}: ${p}`);
    console.error(`Create this file before running. See data/*.template.json for the format.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadSubmissions() {
  if (!fs.existsSync(SUBMISSIONS_PATH)) {
    console.error(`No submissions file found at ${SUBMISSIONS_PATH}`);
    process.exit(1);
  }
  return fs.readFileSync(SUBMISSIONS_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ─── Scoring ───

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

// ─── Email HTML ───

function buildResultsHtml({ submission, score, criticScores, criticPicks, winners, isWinner }) {
  const { email, picks } = submission;

  const categoriesHtml = Object.entries(winners).map(([cat, winner]) => {
    const userPick = picks[cat] ?? '(no pick)';
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
    const label = beat ? 'You beat them!' : tied ? 'Tied' : `They beat you`;
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

  const winnerBanner = isWinner ? `
    <div style="background:linear-gradient(135deg,rgba(245,158,11,0.15),rgba(245,158,11,0.08));border:1px solid rgba(245,158,11,0.3);border-radius:12px;padding:20px;text-align:center;margin-bottom:24px;">
      <div style="font-size:28px;margin-bottom:8px;">🎉🏆🎟️</div>
      <div style="font-size:16px;font-weight:900;color:#f59e0b;margin-bottom:6px;">You won the prize draw!</div>
      <div style="font-size:13px;color:#d97706;">You beat at least one critic and were selected in our random draw. Your $100 TodayTix voucher is on its way — we'll be in touch shortly.</div>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
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

// ─── Send via Resend ───

async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── Main ───

async function main() {
  if (!RESEND_API_KEY && !DRY_RUN) {
    console.error('RESEND_API_KEY not set. Use --dry-run to preview without sending.');
    process.exit(1);
  }

  const winners = loadJson(WINNERS_PATH, 'winners');
  const criticPicksData = loadJson(CRITIC_PICKS_PATH, 'critic picks');
  const allSubmissions = loadSubmissions();

  // Ballots submitted at/after ceremony start aren't predictions — score and
  // email them, but exclude from leaderboard stats and the "beat the critics"
  // winner pool so post-hoc entries can't claim perfect scores.
  const CEREMONY_START = '2026-06-08T00:00:00Z'; // 8 PM ET June 7
  const isLate = (s) => (s.submittedAt ?? '') >= CEREMONY_START;

  // De-duplicate by email — keep most recent submission. Skip malformed rows
  // with no email (early test entries) rather than crashing.
  const byEmail = new Map();
  let skippedNoEmail = 0;
  for (const s of allSubmissions) {
    if (!s.email || typeof s.email !== 'string') { skippedNoEmail++; continue; }
    byEmail.set(s.email.toLowerCase(), s);
  }
  const submissions = Array.from(byEmail.values());
  const lateCount = submissions.filter(isLate).length;
  if (skippedNoEmail) console.log(`(skipped ${skippedNoEmail} submission(s) with no email)`);
  if (lateCount) console.log(`(${lateCount} submission(s) arrived after ceremony start — excluded from winner pool)`);

  console.log(`\n=== Beat the Critics Results ${CEREMONY_YEAR} ===`);
  console.log(`${submissions.length} unique submissions`);
  console.log(`Winners file: ${Object.keys(winners).length} categories\n`);

  // Score each critic
  const criticScores = {};
  for (const [name, { outlet, picks: cPicks }] of Object.entries(criticPicksData)) {
    criticScores[name] = { correct: scoreCritic(cPicks, winners), outlet };
  }

  console.log('Critic scores:');
  for (const [name, { correct, outlet }] of Object.entries(criticScores)) {
    console.log(`  ${name} (${outlet}): ${correct}/${Object.keys(winners).length}`);
  }

  // Score all submissions
  const scored = submissions.map(s => ({
    ...s,
    score: scoreSubmission(s.picks, winners),
  }));
  scored.sort((a, b) => b.score.correct - a.score.correct);

  const topScore = scored[0]?.score.correct ?? 0;
  console.log(`\nTop score: ${topScore}/${Object.keys(winners).length}`);

  // Winner selection: random draw from users who beat ≥1 critic.
  // Fallback if no one beats a critic: random draw from top scorers.
  const minCriticScore = Math.min(...Object.values(criticScores).map(c => c.correct));
  const eligible = scored.filter(s => !isLate(s));
  const eligibleTop = eligible[0]?.score.correct ?? 0;
  const qualifyingPool = eligible.filter(s => s.score.correct > minCriticScore);
  const fallbackPool = eligible.filter(s => s.score.correct === eligibleTop);
  const prizePool = qualifyingPool.length > 0 ? qualifyingPool : fallbackPool;

  // Deterministic draw: FNV-1a hash over the sorted pool emails picks the
  // index, so re-runs (and --dry-run vs the real send) always select the
  // same winner. Math.random() here would re-draw a different winner per run.
  const prizePoolSorted = [...prizePool].sort((a, b) =>
    new Date(a.submittedAt ?? 0) - new Date(b.submittedAt ?? 0)
  );
  let seed = 0x811c9dc5;
  for (const ch of prizePoolSorted.map(s => s.email.toLowerCase()).sort().join('|')) {
    seed ^= ch.charCodeAt(0);
    seed = Math.imul(seed, 0x01000193) >>> 0;
  }
  const randomIndex = prizePoolSorted.length ? seed % prizePoolSorted.length : 0;
  const prizeWinner = prizePoolSorted[randomIndex];

  console.log(`Qualifying pool (beat ≥1 critic): ${qualifyingPool.length}`);
  console.log(`Prize winner: ${prizeWinner?.email ?? 'none'} (${prizeWinner?.score.correct ?? 0} correct)`);
  if (qualifyingPool.length === 0) console.log('  (fallback: no one beat a critic — drawing from top scorers)');

  // Filter if --send-to
  const toSend = SEND_TO
    ? scored.filter(s => s.email.toLowerCase() === SEND_TO.toLowerCase())
    : scored;

  if (SEND_TO && toSend.length === 0) {
    // Allow test send to any address with sample data
    console.log(`No submission found for ${SEND_TO} — sending sample results email`);
    toSend.push({
      email: SEND_TO,
      picks: Object.fromEntries(Object.entries(winners).map(([cat]) => [cat, 'Test Pick'])),
      score: { correct: 0, total: Object.keys(winners).length, details: {} },
      ceremonyYear: CEREMONY_YEAR,
    });
  }

  console.log(`\nSending to ${toSend.length} recipient${toSend.length === 1 ? '' : 's'}${DRY_RUN ? ' (DRY RUN — no emails sent)' : ''}...\n`);

  let sent = 0, failed = 0;
  for (const sub of toSend) {
    const isWinner = !SEND_TO && prizeWinner && sub.email.toLowerCase() === prizeWinner.email.toLowerCase();
    // Tag first-party links for GA4/PostHog attribution (idempotent — see scripts/lib/email-utm.js).
    const html = applyUtm(buildResultsHtml({
      submission: sub,
      score: sub.score,
      criticScores,
      criticPicks: criticPicksData,
      winners,
      isWinner,
    }), { source: 'beat-the-critics', campaign: `btc-results-${CEREMONY_YEAR}` });

    const subject = `Your Tony results: ${sub.score.correct}/${Object.keys(winners).length} correct — Beat the Critics`;

    if (DRY_RUN) {
      console.log(`[DRY RUN] ${sub.email} — ${sub.score.correct}/${Object.keys(winners).length} correct${isWinner ? ' 🏆 WINNER' : ''}`);
      sent++;
      continue;
    }

    try {
      await sendEmail({ to: sub.email, subject, html });
      console.log(`✓ ${sub.email} — ${sub.score.correct}/${Object.keys(winners).length} correct${isWinner ? ' 🏆 WINNER' : ''}`);
      sent++;
      // 300ms spacing to stay within Resend rate limits
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`✗ ${sub.email}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ${sent} sent, ${failed} failed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
