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
 *   node scripts/send-reddit-post-email.js --resend=a,b     # send these drafts again now
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DRAFTS_PATH = path.join(__dirname, '..', 'data', 'audit', 'reddit-post-drafts.json');
const FROM = 'Broadway Scorecard <updates@broadwayscorecard.com>';
const DEFAULT_RECIPIENT = 'thomas.pryor@gmail.com';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_SCREENSHOTS = args.includes('--no-screenshots');
const SCREENSHOT_BUDGET_MS = 4 * 60_000; // all captures in one run; emails after that go without
// Owner-requested resend: these drafts only, whatever their age or stamps.
const RESEND = ((args.find(a => a.startsWith('--resend=')) || '').split('=')[1] || '').split(',').map(x => x.trim()).filter(Boolean);
const SEND_TO = (args.find(a => a.startsWith('--send-to=')) || '').split('=')[1] || DEFAULT_RECIPIENT;

const USAGE = `send-reddit-post-email.js: email each new Reddit opening-post draft on its own (BRO-4360).
  --dry-run          print subjects + HTML, send and save nothing
  --send-to=EMAIL    override recipient (default: owner)
  --no-screenshots   skip the phone-width page screenshots
  --resend=ID,ID     send these unposted drafts again now (ignores age and earlier sends)`;

const os = require('os');
const { dueEmails, resendEmails, buildSubject, buildHtml } = require('./lib/reddit-post-email');
const { captureShowImages } = require('./lib/reddit-post-screenshots');

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
      timeout: 45000, // two inline screenshots ride along (~350KB)
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
        try { resolve(JSON.parse(chunks)); } catch { resolve(chunks); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Resend request timed out after 45s')); });
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
  let due;
  if (RESEND.length) {
    const r = resendEmails(drafts, RESEND);
    // A typo in the dispatch input should show on the run, not pass as green.
    for (const sk of r.skipped) console.log(`${sk.reason === 'already posted' ? '' : '::warning::'}Not resending ${sk.showId}: ${sk.reason}`);
    due = r.due;
  } else {
    due = dueEmails(drafts, Date.now());
  }
  console.log(`${due.length} Reddit draft email(s) ${RESEND.length ? 'to resend' : 'due'}`);
  if (!due.length) return;

  if (!DRY_RUN && !process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY not set.');
    process.exit(1);
  }

  let failed = 0;
  const started = Date.now();
  for (const { draft, kind } of due) {
    const subject = buildSubject(draft, kind);
    // Phone-shaped screenshots of the live page, so the owner doesn't take
    // them by hand (BRO-4597). Never blocks the email: no images on failure,
    // and none once the run's screenshot budget is spent (the job has a
    // hard timeout, and a killed job would re-send everything unstamped).
    // A resend is a handful of shows the owner asked for by name: give each
    // its images (the job timeout allows for this; see the workflow).
    const budget = RESEND.length ? Math.max(SCREENSHOT_BUDGET_MS, RESEND.length * 90_000) : SCREENSHOT_BUDGET_MS;
    const withinBudget = Date.now() - started < budget;
    const shots = NO_SCREENSHOTS || !withinBudget ? [] : await captureShowImages(draft.url, path.join(os.tmpdir(), 'reddit-post-images', draft.showId));
    let images = [];
    let attachments = [];
    try {
      images = shots.map((sh, i) => ({ cid: `shot${i + 1}`, label: sh.label, filename: `${draft.showId}-${sh.name}`, file: sh.file }));
      attachments = images.map(im => ({ filename: im.filename, content: fs.readFileSync(im.file).toString('base64'), content_id: im.cid }));
    } catch (e) {
      console.log(`  screenshots dropped for ${draft.showId} (${e.message})`);
      images = [];
      attachments = [];
    }
    const html = buildHtml(draft, kind, images);
    if (DRY_RUN) {
      console.log(`\nSubject: ${subject}\nRecipient: ${SEND_TO}\nImages: ${shots.map(sh => sh.file).join(', ') || 'none'}\n---HTML---\n${html}`);
      continue;
    }
    try {
      const res = await postJSON('https://api.resend.com/emails', { from: FROM, to: [SEND_TO], subject, html, ...(attachments.length ? { attachments } : {}) },
        { Authorization: `Bearer ${process.env.RESEND_API_KEY}` });
      const stamp = new Date().toISOString();
      // A resend stamps both, so tomorrow's run doesn't follow it with a reminder.
      const stamps = RESEND.length ? { emailedAt: stamp, reminderAt: stamp } : { [kind === 'new' ? 'emailedAt' : 'reminderAt']: stamp };
      drafts.drafts[draft.showId] = { ...drafts.drafts[draft.showId], ...stamps };
      // The resend is now the email the owner has: later "numbers moved"
      // notes measure from it, not from the first one.
      if (RESEND.length) for (const k of ['refreshedAt', 'previousReviewCount', 'previousScore']) delete drafts.drafts[draft.showId][k];
      // Stamp right away: a run killed later in the loop must not re-send this one.
      fs.writeFileSync(DRAFTS_PATH, JSON.stringify(drafts, null, 2) + '\n');
      console.log(`Sent: ${subject} (id ${res && res.id || '?'})`);
    } catch (e) {
      failed++;
      console.error(`Send failed for ${draft.showId}: ${e.message}`);
    }
  }

  if (!DRY_RUN) fs.writeFileSync(DRAFTS_PATH, JSON.stringify(drafts, null, 2) + '\n');
  if (failed) process.exit(1);
}


if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
