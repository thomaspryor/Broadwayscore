#!/usr/bin/env node
/**
 * send-reddit-post-email.js (BRO-4360)
 *
 * Emails the owner each new Reddit "reviews are in" draft as its OWN email
 * (owner ask 2026-09-29: "Send it as a separate email, not an existing one").
 * Drafts come from scripts/draft-reddit-opening-posts.js via
 * data/audit/reddit-post-drafts.json; this runs right after it in the
 * draft-opening-posts job of reddit-engagement-digest.yml.
 *
 * Per draft:
 *   - status 'ready' and never emailed   → "Reddit post ready: <show> ..." email
 *   - emailed 20h+ ago, still not posted  → one "Still ready" reminder
 *   - posted, stale (past DRAFT_TTL_DAYS) → nothing
 * Sends stamp emailedAt / reminderAt on the draft so nothing sends twice; the
 * job's commit step persists that. Sends go out BEFORE that commit (outputs
 * before state), so a failed commit can at worst repeat an email, never drop one.
 *
 * RULE 17: transactional, one explicit recipient, never a broadcast.
 *
 * Usage:
 *   node scripts/send-reddit-post-email.js                 # send due emails
 *   node scripts/send-reddit-post-email.js --dry-run       # print, send nothing, save nothing
 *   node scripts/send-reddit-post-email.js --send-to=EMAIL # override recipient
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { TOKENS, esc } = require('./lib/email-components');
const { activeDrafts } = require('./lib/reddit-opening-post');

const DRAFTS_PATH = path.join(__dirname, '..', 'data', 'audit', 'reddit-post-drafts.json');
const FROM = 'Broadway Scorecard <updates@broadwayscorecard.com>';
const DEFAULT_RECIPIENT = 'thomas.pryor@gmail.com';
const REMIND_AFTER_HOURS = 20;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SEND_TO = (args.find(a => a.startsWith('--send-to=')) || '').split('=')[1] || DEFAULT_RECIPIENT;

const USAGE = `send-reddit-post-email.js: email each new Reddit opening-post draft on its own (BRO-4360).
  --dry-run          print subjects + HTML, send and save nothing
  --send-to=EMAIL    override recipient (default: owner)`;

// ── Pure builders (exported for tests) ──────────────────────────────────────

function isComplete(d) {
  return !!(d && d.title && d.body && d.subreddit && d.submitUrl && d.showTitle && typeof d.score === 'number');
}

/** Which drafts get an email now, and which kind. */
function dueEmails(drafts, nowMs) {
  const out = [];
  for (const d of activeDrafts(drafts, nowMs)) {
    if (!isComplete(d)) continue;
    if (!d.emailedAt) out.push({ draft: d, kind: 'new' });
    else if (!d.reminderAt && (nowMs - Date.parse(d.emailedAt)) / 3600000 >= REMIND_AFTER_HOURS) out.push({ draft: d, kind: 'reminder' });
  }
  return out;
}

function buildSubject(d, kind) {
  const lead = kind === 'reminder' ? 'Still ready to post' : 'Reddit post ready';
  return `${lead}: ${d.showTitle} (${d.score}/100) for r/${d.subreddit}`;
}

function textBlock(s) {
  return esc(s).replace(/\n/g, '<br>');
}

function buildHtml(d, kind) {
  const intro = kind === 'reminder'
    ? `Reviews for ${esc(d.showTitle)} are still fresh. Here's the draft again in case yesterday got away from you. This is the last nudge for this one.`
    : `Reviews are in for ${esc(d.showTitle)}. Tap the button, give it a read, hit Post. These stop once your post shows up on Reddit.`;
  const note = (label, text) => text
    ? `<div style="margin-top:12px;color:${TOKENS.textMuted};font-size:14px;line-height:1.5;"><strong style="color:${TOKENS.text};">${label}</strong> ${text}</div>`
    : '';
  const personal = (d.personalLines || []).length
    ? note('Want it more personal?', `Paste one of these in, only if it's true:<br>${d.personalLines.map(l => `&bull; ${esc(l)}`).join('<br>')}`)
    : '';
  const pushback = d.expectedPushback
    ? note('If someone says:', `${esc(d.expectedPushback)}<br><strong style="color:${TOKENS.text};">You could reply:</strong> ${esc(d.suggestedReply)}`)
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${TOKENS.surface};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${TOKENS.text};">
  <div style="max-width:600px;margin:0 auto;padding:24px 18px;background:${TOKENS.surfaceRaised};border:1px solid ${TOKENS.border};">
    <div style="font-size:11px;letter-spacing:0.10em;text-transform:uppercase;color:${TOKENS.brand};font-weight:600;">Reddit post ready · r/${esc(d.subreddit)}</div>
    <h1 style="margin:6px 0 8px 0;font-size:22px;line-height:1.25;color:${TOKENS.text};">${esc(d.showTitle)} · ${esc(d.score)}/100 from ${esc(d.reviewCount)} reviews</h1>
    <div style="color:${TOKENS.textMuted};font-size:14px;line-height:1.5;">${intro}</div>
    <div style="margin:18px 0 6px 0;">
      <a href="${esc(d.submitUrl)}" style="display:inline-block;background:${TOKENS.brand};color:#1a1a1a;text-decoration:none;font-weight:800;font-size:16px;padding:13px 20px;border-radius:8px;">Open Reddit with this post filled in</a>
    </div>
    <div style="color:${TOKENS.textDim};font-size:12px;">Form comes up empty? Try the <a href="${esc(d.oldRedditSubmitUrl)}" style="color:${TOKENS.textMuted};">old Reddit version</a>, or copy the text below.</div>
    <div style="margin-top:16px;padding:14px 16px;background:${TOKENS.surface};border-radius:8px;border:1px solid ${TOKENS.borderSubtle};">
      <div style="color:${TOKENS.text};font-size:16px;font-weight:700;line-height:1.35;">${esc(d.title)}</div>
      <div style="margin-top:10px;color:${TOKENS.text};font-size:15px;line-height:1.55;">${textBlock(d.body)}</div>
    </div>
    ${note('Why it should land:', esc(d.why))}
    ${pushback}
    ${personal}
  </div>
</body></html>`;
}

// ── Send ────────────────────────────────────────────────────────────────────

function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 15000,
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Resend request timed out after 15s')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(args)) { console.log(USAGE); return; }

  let drafts;
  try {
    drafts = JSON.parse(fs.readFileSync(DRAFTS_PATH, 'utf8'));
  } catch (e) {
    console.log(`No readable drafts file (${e.code || e.message}); nothing to send.`);
    return;
  }
  const due = dueEmails(drafts, Date.now());
  console.log(`${due.length} Reddit draft email(s) due`);
  if (!due.length) return;

  if (!DRY_RUN && !process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set.');
    process.exit(1);
  }

  let failed = 0;
  for (const { draft, kind } of due) {
    const subject = buildSubject(draft, kind);
    const html = buildHtml(draft, kind);
    if (DRY_RUN) {
      console.log(`\nSubject: ${subject}\nRecipient: ${SEND_TO}\n---HTML---\n${html}`);
      continue;
    }
    try {
      const res = await postJSON('https://api.resend.com/emails', { from: FROM, to: [SEND_TO], subject, html },
        { Authorization: `Bearer ${process.env.RESEND_API_KEY}` });
      const stamp = new Date().toISOString();
      drafts.drafts[draft.showId] = { ...drafts.drafts[draft.showId], [kind === 'new' ? 'emailedAt' : 'reminderAt']: stamp };
      console.log(`Sent: ${subject} (id ${res && res.id || '?'})`);
    } catch (e) {
      failed++;
      console.error(`Send failed for ${draft.showId}: ${e.message}`);
    }
  }

  if (!DRY_RUN) fs.writeFileSync(DRAFTS_PATH, JSON.stringify(drafts, null, 2) + '\n');
  if (failed) process.exit(1);
}

module.exports = { dueEmails, buildSubject, buildHtml, REMIND_AFTER_HOURS };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
