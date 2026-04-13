#!/usr/bin/env node
/**
 * fantasy-weekly-email.js — Generate and send weekly BFL score update
 *
 * Reads fantasy-scores.json + leaderboard from Supabase,
 * generates an HTML email with top 10 shows + leaderboard standings.
 *
 * Usage:
 *   node scripts/fantasy-weekly-email.js --dry-run     # preview HTML, send nothing
 *   node scripts/fantasy-weekly-email.js --preview     # send to Tom only (via Resend)
 *   node scripts/fantasy-weekly-email.js --draft       # create Buttondown draft for review
 *
 * SAFETY: Default is --dry-run. --draft creates a Buttondown draft that the owner
 * reviews and sends manually. Code never pushes the Send button.
 */

const fs = require('fs');
const path = require('path');
const { postJSON } = require('./lib/email-templates');
const { acquireSendLock, releaseSendLock } = require('./lib/send-lock');
const { fetchFantasyEntries, computeLeaderboard } = require('./lib/fantasy-helpers');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BUTTONDOWN_API_KEY = process.env.BUTTONDOWN_API_KEY;
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'tom@broadwayscorecard.com';
const FROM_EMAIL = 'Broadway Fantasy League <fantasy@broadwayscorecard.com>';

// ── Parse args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run') || (!args.includes('--preview') && !args.includes('--draft'));
const isPreview = args.includes('--preview');
const isDraft = args.includes('--draft');

if (isPreview && !RESEND_API_KEY) {
  console.error('ERROR: RESEND_API_KEY required for --preview');
  process.exit(1);
}
if (isDraft && !BUTTONDOWN_API_KEY) {
  console.error('ERROR: BUTTONDOWN_API_KEY required for --draft');
  process.exit(1);
}

// ── Load data ───────────────────────────────────────────────────────
const dataDir = path.join(__dirname, '..', 'data');
const scoresData = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-scores.json'), 'utf8'));
const leagueData = JSON.parse(fs.readFileSync(path.join(dataDir, 'fantasy-league.json'), 'utf8'));

// ── Build email content ─────────────────────────────────────────────
function buildEmailHtml(leaderboard) {
  const weekEnding = scoresData._meta.weekEnding;
  const shows = Object.entries(scoresData.showScores)
    .map(([id, score]) => ({
      id,
      title: leagueData.shows[id]?.title || id,
      price: leagueData.shows[id]?.price || 0,
      ...score,
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints);

  const top10Shows = shows.slice(0, 10);

  // Leaderboard section (only if entries exist)
  let leaderboardHtml = '';
  if (leaderboard && leaderboard.length > 0) {
    const top10Teams = leaderboard.slice(0, 10);
    leaderboardHtml = `
  <h2 style="color:white;font-size:18px;border-bottom:1px solid #27272a;padding-bottom:8px;margin-top:32px;">Leaderboard Standings</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr style="color:#71717a;text-align:left;">
      <th style="padding:6px 0;">#</th>
      <th>Team</th>
      <th style="text-align:right;">Points</th>
    </tr>
    ${top10Teams.map(entry => `
    <tr style="border-top:1px solid #18181b;">
      <td style="padding:8px 0;color:#71717a;">${entry.rank}</td>
      <td style="color:white;">${escapeHtml(entry.displayName)}</td>
      <td style="text-align:right;color:#d4a574;font-weight:bold;">${entry.totalPoints.toFixed(1)}</td>
    </tr>`).join('')}
  </table>
  <p style="color:#71717a;font-size:12px;margin-top:8px;">${leaderboard.length} teams total</p>`;
  }

  // Buttondown unsubscribe variable (only for draft mode, ignored by Resend)
  const unsubscribeHtml = isDraft
    ? `<p style="text-align:center;color:#3f3f46;font-size:11px;margin-top:8px;"><a href="{{ unsubscribe_url }}" style="color:#3f3f46;">Unsubscribe</a></p>`
    : '';

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
    ${top10Shows.map((show, i) => `
    <tr style="border-top:1px solid #18181b;">
      <td style="padding:8px 0;color:#71717a;">${i + 1}</td>
      <td style="color:white;">${escapeHtml(show.title)}</td>
      <td style="text-align:right;color:#6ee7b7;">$${show.price}</td>
      <td style="text-align:right;color:#d4a574;font-weight:bold;">${show.totalPoints.toFixed(1)}</td>
    </tr>`).join('')}
  </table>

  ${leaderboardHtml}

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
  ${unsubscribeHtml}
</body>
</html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  // Fetch leaderboard entries (for all modes — dry-run shows what email would look like)
  let leaderboard = [];
  try {
    const entries = await fetchFantasyEntries({ season: leagueData._meta.season });
    if (entries.length > 0) {
      leaderboard = computeLeaderboard(entries, scoresData.showScores, leagueData.shows);
    }
  } catch (err) {
    console.error(`Warning: Could not fetch leaderboard: ${err.message}`);
    // Continue without leaderboard — top shows section is still valuable
  }

  const html = buildEmailHtml(leaderboard);
  const weekEnding = scoresData._meta.weekEnding;
  const subject = `BFL Week ${weekEnding} — Score Update`;

  if (isDryRun) {
    console.log(html);
    console.error(`\n--dry-run: HTML output only. No emails sent.`);
    console.error(`Leaderboard entries: ${leaderboard.length}`);
    return;
  }

  if (isPreview) {
    console.error(`Sending preview to: ${OWNER_EMAIL}`);
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [OWNER_EMAIL],
        subject: `[Preview] ${subject}`,
        html,
      }),
    });

    const result = await res.json();
    if (res.ok) {
      console.error(`Preview sent: ${result.id}`);
    } else {
      console.error('Preview send failed:', result);
      process.exit(1);
    }
    return;
  }

  if (isDraft) {
    // Create Buttondown draft — same pattern as send-opening-night-broadcast.js
    console.error(`Creating Buttondown draft: "${subject}"`);
    console.error(`Leaderboard entries: ${leaderboard.length}`);

    const lock = acquireSendLock({
      purpose: `fantasy-weekly-${weekEnding}`,
    });
    if (!lock.acquired) {
      console.error(`\nSEND LOCK REFUSED: ${lock.reason}`);
      console.error('Another session is creating a draft right now.');
      process.exit(1);
    }
    console.error(`  Send lock acquired: ${lock.sessionId.slice(0, 8)}`);

    try {
      const result = await postJSON('https://api.buttondown.com/v1/emails', {
        subject,
        body: html,
        status: 'draft',
      }, {
        'Authorization': `Token ${BUTTONDOWN_API_KEY}`,
      });

      const draftId = result.id;
      const draftUrl = `https://buttondown.com/emails/${draftId}`;
      console.error(`  Draft created: ${draftId}`);
      console.error(`  Review at: ${draftUrl}`);

      // Notify owner via Resend transactional email
      if (RESEND_API_KEY) {
        const notificationHtml = `
<p>A weekly fantasy league email draft is ready for your review in Buttondown.</p>
<table style="margin:16px 0;border-collapse:collapse;">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Week</td><td><strong>${weekEnding}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Teams</td><td><strong>${leaderboard.length}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Subject</td><td>${subject}</td></tr>
</table>
<p><a href="${draftUrl}" style="background:#0066cc;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block;font-weight:bold;">Review &amp; Send Draft in Buttondown &rarr;</a></p>
<p style="color:#888;font-size:12px;margin-top:16px;">Direct link: ${draftUrl}</p>`;

        await postJSON('https://api.resend.com/emails', {
          from: `Broadway Scorecard <${OWNER_EMAIL}>`,
          to: [OWNER_EMAIL],
          subject: `[Action Required] Fantasy weekly draft ready — ${weekEnding}`,
          html: notificationHtml,
        }, { 'Authorization': `Bearer ${RESEND_API_KEY}` });
        console.error(`  Owner notification sent to ${OWNER_EMAIL}`);
      }

      console.error(`\nDraft ready — log into Buttondown to send: ${draftUrl}`);
    } finally {
      const rel = releaseSendLock(lock);
      if (!rel.released) console.error(`  WARNING: lock release failed: ${rel.reason}`);
      else console.error(`  Send lock released`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
