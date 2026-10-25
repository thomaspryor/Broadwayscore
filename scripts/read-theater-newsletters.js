#!/usr/bin/env node
/**
 * read-theater-newsletters.js — weekly reader for three theater newsletters (BRO-6214).
 *
 * Reads ONLY mail from the three senders in scripts/lib/newsletter-facts.js SENDERS
 * (owner approval 2026-10-25, BRO-6156), extracts Broadway show-level business facts
 * (capitalization, weekly running cost, recoupment, profit/loss, investor returns,
 * closing for financial reasons) that come with the issue's public web URL, diffs them
 * against data/commercial.json and routes new or conflicting ones to a person with one
 * routeAlert card. Nothing is written to commercial data, and no email body or quote is
 * stored anywhere: bodies live in memory for the length of one LLM call.
 *
 * Source (pick one):
 *   (default)          Gmail API read-only via GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
 *                      GMAIL_REFRESH_TOKEN (same secrets as finance-ingest.yml).
 *   --from-file=PATH   JSON array of { id, date, from, subject, authResults, text }.
 *                      Tests and local runs, no Gmail credentials needed.
 *
 * Flags:
 *   --dry-run          List the issues and facts, send no alert.
 *   --days=N           Gmail query window (default 8).
 *   --window-days=N    Drop issues older than this many days after the query (default 7),
 *                      so the one-day query overlap never reports an issue twice.
 *
 * Needs ANTHROPIC_API_KEY for extraction. Alerts need LINEAR_API_KEY (+ RESEND_API_KEY /
 * OWNER_EMAIL) like every routeAlert caller.
 */
'use strict';

const fs = require('fs');
const path = require('path');
require('./lib/cli-help').exitOnHelp(module);
const nf = require('./lib/newsletter-facts');
const { CLAUDE_SONNET } = require('./lib/models');
const { finalResponseText } = require('./lib/anthropic-response-text');
const { runMain } = require('./lib/run-main');

function parseArgs(argv) {
  const a = { dryRun: false, days: nf.DEFAULT_DAYS, windowDays: 7, fromFile: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg.startsWith('--days=')) a.days = parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--window-days=')) a.windowDays = parseInt(arg.slice(14), 10);
    else if (arg.startsWith('--from-file=')) a.fromFile = arg.slice(12);
  }
  return a;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function b64(data) { return Buffer.from(String(data || ''), 'base64url').toString('utf8'); }

function collectParts(payload, mime, out = []) {
  if (!payload) return out;
  if (payload.mimeType === mime && payload.body && payload.body.data) out.push(b64(payload.body.data));
  for (const p of payload.parts || []) collectParts(p, mime, out);
  return out;
}

function htmlToText(html) {
  const withLinks = html.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, ' $2 ($1) ');
  return withLinks.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ');
}

function normalizeGmailMessage(m) {
  const headers = m.payload?.headers || [];
  const get = (n) => headers.find((h) => h.name.toLowerCase() === n)?.value || '';
  const plain = collectParts(m.payload, 'text/plain').join('\n');
  const html = collectParts(m.payload, 'text/html').join('\n');
  return {
    id: m.id,
    date: new Date(Number(m.internalDate)).toISOString(),
    from: get('from'),
    subject: get('subject'),
    authResults: headers.filter((h) => h.name.toLowerCase() === 'authentication-results').map((h) => h.value),
    text: plain || htmlToText(html),
    html,
  };
}

async function fetchGmail(days) {
  const { google } = require('googleapis'); // eslint-disable-line
  const { withGmailRetry } = require('./lib/gmail-quota-retry');
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail source needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN (or use --from-file).');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });
  const q = nf.buildQuery(days);
  const out = [];
  let pageToken;
  do {
    const list = await withGmailRetry(() => gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken }));
    for (const { id } of list.data.messages || []) {
      const msg = await withGmailRetry(() => gmail.users.messages.get({ userId: 'me', id, format: 'full' }));
      out.push(normalizeGmailMessage(msg.data));
    }
    pageToken = list.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function callAnthropic(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set (needed for fact extraction).');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ model: CLAUDE_SONNET, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);
  const data = await res.json();
  return finalResponseText(data.content);
}

/**
 * Process fetched messages into issue reports and accepted facts.
 * `extract(prompt) -> responseText` and `shows`/`commercial` are injected.
 */
async function processMessages(messages, { extract, shows, commercial, windowDays, now = Date.now() }) {
  const issues = [];
  const items = [];
  const skipped = {};
  const bump = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  const cutoff = now - windowDays * 86400000;
  for (const m of messages) {
    const sender = nf.senderFor(m.from);
    if (!sender) { bump('sender-not-allowlisted'); continue; }
    if (Date.parse(m.date) < cutoff) { bump('older-than-window'); continue; }
    const dkim = nf.dkimPassesFor(sender, m.authResults);
    const links = [...nf.extractLinks(m.text), ...nf.extractLinks(m.html || '')];
    const issueUrl = nf.pickIssueUrl(sender, links);
    if (process.env.NEWSLETTER_LINK_SHAPES === '1') {
      // Diagnostic: host + first path segment only (no query, no body text).
      const shapes = {};
      for (const l of links) { try { const u = new URL(l); const k = `${u.hostname}/${u.pathname.split('/')[1] || ''}`; shapes[k] = (shapes[k] || 0) + 1; } catch { /* skip */ } }
      console.log(`  link shapes ${sender.label} ${m.date.slice(0, 10)}: ${JSON.stringify(shapes)}`);
    }
    const issue = { sender: sender.label, date: m.date.slice(0, 10), subject: m.subject, issueUrl, dkim, facts: 0, accepted: 0 };
    issues.push(issue);
    if (!dkim) { bump('dkim-not-verified'); continue; }
    if (!issueUrl) { bump('issue-has-no-public-url'); continue; }
    let raw;
    try {
      raw = nf.parseFacts(await extract(nf.buildExtractionPrompt({ senderLabel: sender.label, subject: m.subject, date: m.date, text: m.text })));
    } catch (err) {
      console.error(`Extraction failed for ${sender.label} ${issue.date}: ${err.message}`);
      bump('extraction-failed');
      continue;
    }
    issue.facts = raw.length;
    for (const r of raw) {
      const v = nf.validateFact(r, issueUrl);
      if (!v.ok) { bump(v.reason); continue; }
      const match = nf.matchShow(v.fact.show, shows, commercial && commercial.shows);
      const diff = nf.diffFact(v.fact, match && match.record);
      if (diff.status === 'known') { bump('already-in-commercial'); continue; }
      issue.accepted++;
      items.push({ fact: v.fact, slug: match ? match.slug : null, status: diff.status, existing: diff.existing });
    }
  }
  return { issues, items, skipped };
}

async function main() {
  const args = parseArgs(process.argv);
  const dataDir = path.join(__dirname, '..', 'data');
  const shows = (readJson(path.join(dataDir, 'shows.json'), { shows: [] }).shows) || [];
  const commercial = readJson(path.join(dataDir, 'commercial.json'), { shows: {} });
  if (!shows.length) console.warn('WARN: data/shows.json not found; facts cannot be matched to commercial records.');

  let messages;
  try {
    messages = args.fromFile ? readJson(args.fromFile, []) : await fetchGmail(args.days);
  } catch (err) {
    console.error(`Gmail fetch failed: ${err.message}`);
    if (!args.dryRun) {
      const { routeAlert } = require('./lib/owner-alert-router');
      await routeAlert(nf.buildFetchFailureAlertOpts(err.message)).catch((e) => console.error(`routeAlert failed: ${e.message}`));
    }
    process.exitCode = 1;
    return;
  }

  const { issues, items, skipped } = await processMessages(messages, { extract: callAnthropic, shows, commercial, windowDays: args.windowDays });

  console.log(`Issues from the three senders in the last ${args.windowDays} days: ${issues.length}`);
  for (const i of issues) {
    console.log(`  ${i.date} | ${i.sender} | dkim=${i.dkim ? 'pass' : 'NO'} | url=${i.issueUrl || 'none'} | facts ${i.accepted}/${i.facts} | ${i.subject}`);
  }
  console.log(`Skipped: ${JSON.stringify(skipped)}`);
  for (const sd of nf.SENDERS) {
    const mine = issues.filter((i) => i.sender === sd.label);
    if (mine.length && mine.every((i) => !i.dkim || !i.issueUrl)) {
      console.warn(`::warning::All ${mine.length} ${sd.label} issue(s) were skipped (dkim or public URL); check the sender's signing domain and link shape.`);
    }
  }
  if (issues.length && skipped['extraction-failed'] === issues.length) process.exitCode = 1;
  console.log(`Facts for review: ${items.length}`);
  for (const it of items) console.log(`  ${it.status.toUpperCase()} ${it.slug || it.fact.show} ${it.fact.field} = ${JSON.stringify(it.fact.value)} ${it.fact.issueUrl}${it.status === 'conflict' ? ` (record: ${JSON.stringify(it.existing)})` : ''}`);

  const opts = nf.buildAlertOpts(items);
  if (!opts) { console.log('Nothing new for a person to review.'); return; }
  if (args.dryRun) { console.log('[dry-run] would route one review card; not sending.'); return; }
  const { routeAlert } = require('./lib/owner-alert-router');
  const res = await routeAlert(opts);
  console.log(`routeAlert: ${JSON.stringify({ action: res && res.action, dispatchOk: res && res.dispatchOk })}`);
  if (res && res.dispatchOk === false) process.exitCode = 1;
}

if (require.main === module) runMain(main);

module.exports = { processMessages, normalizeGmailMessage, htmlToText, parseArgs };
