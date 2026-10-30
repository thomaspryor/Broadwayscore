#!/usr/bin/env node
/**
 * remind-unsent-broadcast-draft.js (BRO-6634)
 *
 * Owner ask 2026-10-30: "a reminder so I don't forget to send the broadcast".
 * For every opening-night Resend draft that is still unsent REMINDER_GAP_HOURS
 * after it was created (or last reminded), email the owner one transactional
 * reminder with the draft link and today's numbers, up to MAX_REMINDERS per
 * draft. A live Resend GET must still say `draft` first, so a draft the owner
 * already sent (or deleted) is never nagged about. Stamps draftReminderAt /
 * draftReminderCount on the draft record and its per-show mirrors; the
 * workflow's commit + push-core-data steps persist that.
 *
 * Complements check-missed-broadcasts.js, which pages for drafts 3 to 30 days
 * old (broadcast:draft-unsent:<draftId>). This covers the first day.
 *
 * RULE 17: one transactional email to OWNER_EMAIL. Never a broadcast, never
 * POST /broadcasts/{id}/send.
 *
 * Usage:
 *   node scripts/remind-unsent-broadcast-draft.js            # send due reminders
 *   node scripts/remind-unsent-broadcast-draft.js --dry-run  # print, send and save nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { remindersDue, stampReminder, readShowNumbers, MAX_REMINDERS } = require('./lib/broadcast-refresh');

const SENT_PATH = path.join(__dirname, '..', 'data', 'opening-night-sent.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const FROM = 'Broadway Scorecard <updates@broadwayscorecard.com>';
const DRY_RUN = process.argv.includes('--dry-run');

const USAGE = `remind-unsent-broadcast-draft.js: remind the owner about an unsent opening-night draft (BRO-6634).
  --dry-run   print the reminders, send and save nothing`;

function postJSON(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${apiKey}` },
    }, res => {
      let chunks = '';
      res.on('data', c => { chunks += c; });
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(chunks) : reject(new Error(`HTTP ${res.statusCode}: ${chunks.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildReminder(entry, titles, numbers, nth) {
  const names = entry.ids.map(id => titles[id] || id);
  const market = entry.market === 'west-end' ? 'West End' : 'Broadway';
  const url = `https://resend.com/broadcasts/${entry.record.draftId}`;
  const rows = entry.ids.map(id => {
    const n = numbers[id];
    const line = n ? `${n.score != null ? `${n.score}/100` : 'no score yet'}, ${n.reviewCount} reviews` : 'numbers unavailable';
    return `<tr><td style="padding:4px 12px 4px 0;color:#666">${esc(titles[id] || id)}</td><td><strong>${esc(line)}</strong></td></tr>`;
  }).join('');
  const subject = `[Reminder] ${market} opening-night email not sent yet: ${names.join(', ')}`;
  const html = `
<p>The opening-night email for <strong>${esc(names.join(', '))}</strong> is still a draft in Resend (made ${Math.round(entry.hoursSince)} hours ago). Subscribers have not received it.</p>
<table style="margin:16px 0;border-collapse:collapse;">${rows}</table>
<p><a href="${url}" style="background:#0066cc;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block;font-weight:bold;">Open the draft in Resend →</a></p>
<p style="color:#888;font-size:12px;margin-top:16px;">Reminder ${nth} of ${MAX_REMINDERS}. If the numbers change, the draft is updated in place and you get an email saying so.</p>`;
  return { subject, html };
}

async function main() {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  let sent;
  try { sent = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8')); } catch (e) {
    console.log(`No readable tracker (${e.code || e.message}); nothing to remind.`);
    return;
  }
  const due = remindersDue(sent.shows || {});
  console.log(`${due.length} unsent draft(s) due a reminder`);
  if (!due.length) return;

  const apiKey = process.env.RESEND_API_KEY;
  const owner = process.env.OWNER_EMAIL;
  if (!DRY_RUN && (!apiKey || !owner)) {
    console.error('RESEND_API_KEY and OWNER_EMAIL are required.');
    process.exit(1);
  }
  let titles = {};
  try { for (const s of JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows) titles[s.id] = s.title; } catch { titles = {}; }

  let failed = 0;
  for (const entry of due) {
    const draftId = entry.record.draftId;
    if (apiKey) {
      const { getBroadcastWithRetry } = require('./reconcile-broadcast-state');
      const live = await getBroadcastWithRetry(draftId);
      const status = live && live.ok && live.data ? live.data.status : null;
      if (status !== 'draft') {
        // Sent, scheduled, deleted or unreadable: reconcile-broadcast-state.js
        // owns that record; a reminder now could nag about a sent email.
        console.log(`  ${entry.broadcastKey}: live status ${status || `unknown (${live && live.error})`}, no reminder`);
        continue;
      }
    }
    // Quote what the draft shows (stamped on create/update), so the reminder
    // never names numbers the linked draft does not carry. Older drafts have
    // no stamp: fall back to the live numbers.
    const stamped = entry.record.draftNumbers || {};
    const numbers = {};
    for (const id of entry.ids) numbers[id] = stamped[id] || readShowNumbers(id);
    const nth = (entry.record.draftReminderCount || 0) + 1;
    const { subject, html } = buildReminder(entry, titles, numbers, nth);
    if (DRY_RUN) {
      console.log(`\n[DRY RUN] Would email the owner: ${subject}\n${html}`);
      continue;
    }
    try {
      await postJSON('https://api.resend.com/emails', { from: FROM, to: [owner], subject, html }, apiKey);
      stampReminder(sent.shows, entry.broadcastKey, new Date().toISOString());
      // Stamp right away so a run killed later never repeats this reminder.
      fs.writeFileSync(SENT_PATH, JSON.stringify(sent, null, 2) + '\n');
      console.log(`  Sent: ${subject}`);
    } catch (e) {
      failed++;
      console.error(`  Reminder failed for ${entry.broadcastKey}: ${e.message}`);
    }
  }
  if (failed) process.exit(1);
}

module.exports = { buildReminder };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
