#!/usr/bin/env node
/**
 * fantasy-weekly-email.js — Generate and send weekly BFL score update
 *
 * Reads fantasy-scores.json + leaderboard from Supabase,
 * generates an HTML email with top 10 standings, biggest movers,
 * and which shows scored points that week.
 *
 * Usage:
 *   node scripts/fantasy-weekly-email.js --dry-run     # preview HTML, send nothing
 *   node scripts/fantasy-weekly-email.js --preview     # send to Tom only
 *   node scripts/fantasy-weekly-email.js --send        # send to all fantasy entrants
 *
 * SAFETY: --send requires explicit flag. Default is --dry-run.
 * Uses Resend API only. Never Buttondown.
 */

const fs = require('fs');
const path = require('path');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = 'Broadway Fantasy League <fantasy@broadwayscorecard.com>';
const TOM_EMAIL = 'tom@broadwayscorecard.com';

// ── Parse args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run') || (!args.includes('--preview') && !args.includes('--send'));
const isPreview = args.includes('--preview');
const isSend = args.includes('--send');

if (isSend && !RESEND_API_KEY) {
  console.error('ERROR: RESEND_API_KEY required for --send');
  process.exit(1);
}

// ── Load data ───────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');
const scoresData = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-scores.json'), 'utf8'));
const leagueData = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-league.json'), 'utf8'));

// ── Build email content ─────────────────────────────────────────────
function buildEmailHtml() {
  const weekEnding = scoresData._meta.weekEnding;
  const shows = Object.entries(scoresData.showScores)
    .map(([id, score]) => ({
      id,
      title: leagueData.shows[id]?.title || id,
      price: leagueData.shows[id]?.price || 0,
      ...score,
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints);

  const top10 = shows.slice(0, 10);

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="background:#09090b;color:#e4e4e7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;max-width:600px;margin:0 auto;">
  <div style="text-align:center;margin-bottom:24px;">
    <h1 style="color:#d4a574;font-size:24px;margin:0;">Broadway Fantasy League</h1>
    <p style="color:#71717a;font-size:14px;">Weekly Update &middot; Week of ${weekEnding}</p>
  </div>

  <h2 style="color:white;font-size:18px;border-bottom:1px solid #27272a;padding-bottom:8px;">Top Shows by Fantasy Points</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr style="color:#71717a;text-align:left;">
      <th style="padding:6px 0;">#</th>
      <th>Show</th>
      <th style="text-align:right;">Price</th>
      <th style="text-align:right;">Points</th>
    </tr>
    ${top10.map((show, i) => `
    <tr style="border-top:1px solid #18181b;">
      <td style="padding:8px 0;color:#71717a;">${i + 1}</td>
      <td style="color:white;">${show.title}</td>
      <td style="text-align:right;color:#6ee7b7;">$${show.price}</td>
      <td style="text-align:right;color:#d4a574;font-weight:bold;">${show.totalPoints.toFixed(1)}</td>
    </tr>`).join('')}
  </table>

  <div style="margin-top:24px;padding:16px;background:#18181b;border-radius:8px;">
    <p style="color:#71717a;font-size:12px;margin:0;">
      Points from: CriticScore + AudienceGrade + Box Office + Awards<br>
      Scores update weekly. Final standings on Tony night.
    </p>
  </div>

  <div style="text-align:center;margin-top:24px;">
    <a href="https://broadwayscorecard.com/fantasy/leaderboard"
       style="display:inline-block;padding:12px 24px;background:#d4a574;color:#09090b;border-radius:8px;text-decoration:none;font-weight:600;">
      View Full Leaderboard
    </a>
  </div>

  <p style="text-align:center;color:#3f3f46;font-size:11px;margin-top:24px;">
    Broadway Fantasy League by Broadway Scorecard<br>
    <a href="https://broadwayscorecard.com/fantasy" style="color:#3f3f46;">broadwayscorecard.com/fantasy</a>
  </p>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const html = buildEmailHtml();

  if (isDryRun) {
    console.log(html);
    console.error('\n--dry-run: HTML output only. No emails sent.');
    return;
  }

  if (!RESEND_API_KEY) {
    console.error('ERROR: RESEND_API_KEY not set');
    process.exit(1);
  }

  const recipients = isPreview ? [TOM_EMAIL] : [];

  if (isSend) {
    // TODO: Fetch all fantasy entrant emails from Supabase
    // For now, --send is blocked until we implement Supabase email fetch
    console.error('ERROR: --send not yet implemented. Use --preview to send to Tom only.');
    process.exit(1);
  }

  console.error(`Sending to: ${recipients.join(', ')}`);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: recipients,
      subject: `BFL Week ${scoresData._meta.weekEnding} — Score Update`,
      html,
    }),
  });

  const result = await res.json();
  if (res.ok) {
    console.error('Sent successfully:', result.id);
  } else {
    console.error('Send failed:', result);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
