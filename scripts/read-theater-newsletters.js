#!/usr/bin/env node
/**
 * read-theater-newsletters.js — weekly reader for three theater newsletters (BRO-6214, BRO-6265).
 *
 * Sources (owner approval 2026-10-25, BRO-6156):
 *   Chromolume    public blog (chromolume.io/blog composite-* posts), cited by post URL.
 *   Abroad/Way    public RSS (gordoncox.substack.com/feed), then the Substack archive API, then
 *                 (GitHub runners are refused by Substack) the email copy from Gmail, read-only,
 *                 exact sender + DKIM. Always cited by the canonical post URL.
 *   Broadway Briefing  Gmail (read-only, exact sender + DKIM). It has no web archive, so each
 *                 bway.ly short link next to a money/closing item is resolved to the ORIGINAL
 *                 article, and facts are extracted from and cited to that article.
 * Extracts Broadway show-level business facts (capitalization, weekly running cost,
 * recoupment, profit/loss, investor returns, closing for financial reasons), diffs them
 * against data/commercial.json and routes new or conflicting ones to a person with one
 * routeAlert card. Nothing is written to commercial data, and no email body or quote is
 * stored anywhere: text lives in memory for the length of one LLM call. The only file
 * written is the state file (URLs and message IDs already read + counters).
 *
 * Health: a run where more than half of a source's issues were skipped, or a source with
 * nothing readable 2 runs in a row, routes an advisory alert (evaluateSkipHealth).
 *
 * Briefing source (pick one):
 *   (default)          Gmail API read-only via GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
 *                      GMAIL_REFRESH_TOKEN (same secrets as finance-ingest.yml).
 *   --from-file=PATH   JSON array of { id, date, from, subject, authResults, text, html }.
 *
 * Flags:
 *   --dry-run          Read the newest posts regardless of state, print issues and facts,
 *                      send no alert, write no state.
 *   --source=KEY       chromolume | abroadway | broadway-briefing | all (default all).
 *   --max-new=N        Web posts read per source per run (default 2).
 *   --days=N           Gmail query window (default 14).
 *   --window-days=N    Drop Briefing emails older than this many days (default 14).
 *   --state=PATH       State file (default data/audit/newsletter-reader-state.json).
 *
 * Needs ANTHROPIC_API_KEY for extraction. Alerts need LINEAR_API_KEY (+ RESEND_API_KEY /
 * OWNER_EMAIL) like every routeAlert caller.
 */
'use strict';

const fs = require('fs');
const path = require('path');
require('./lib/cli-help').exitOnHelp(module);
const nf = require('./lib/newsletter-facts');
const src = require('./lib/newsletter-sources');
const { CLAUDE_SONNET } = require('./lib/models');
const { finalResponseText } = require('./lib/anthropic-response-text');
const { runMain } = require('./lib/run-main');

const SOURCE_KEYS = [...nf.WEB_SOURCES.map((w) => w.key), ...nf.EMAIL_SENDERS.map((e) => e.key)];
const DEFAULT_STATE = path.join(__dirname, '..', 'data', 'audit', 'newsletter-reader-state.json');

function parseArgs(argv) {
  const a = { dryRun: false, days: nf.DEFAULT_DAYS, windowDays: nf.DEFAULT_DAYS, fromFile: null, source: 'all', maxNew: 2, state: DEFAULT_STATE };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg.startsWith('--days=')) a.days = parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--window-days=')) a.windowDays = parseInt(arg.slice(14), 10);
    else if (arg.startsWith('--from-file=')) a.fromFile = arg.slice(12);
    else if (arg.startsWith('--source=')) a.source = arg.slice(9);
    else if (arg.startsWith('--max-new=')) a.maxNew = parseInt(arg.slice(10), 10);
    else if (arg.startsWith('--state=')) a.state = arg.slice(8);
  }
  if (a.source !== 'all' && !SOURCE_KEYS.includes(a.source)) throw new Error(`--source must be one of ${SOURCE_KEYS.join(', ')}, all`);
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

const { htmlToText } = src;

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

async function fetchGmail(days, query = nf.buildQuery(days)) {
  const { google } = require('googleapis'); // eslint-disable-line
  const { withGmailRetry } = require('./lib/gmail-quota-retry');
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail source needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN (or use --from-file).');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });
  const q = query;
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

const outletOf = (url) => require('./lib/review-normalization').resolveOutletFromUrl(url);

/**
 * Extract, validate and diff one document (an article or post). `extract(prompt) -> text` is
 * injected. Returns { facts, accepted, status, reason } and pushes accepted items.
 */
async function processDocument(doc, { extract, shows, commercial, items, bump }) {
  let raw;
  try {
    raw = nf.parseFacts(await extract(nf.buildExtractionPrompt({ senderLabel: doc.label, subject: doc.subject, date: doc.date, text: doc.text, kind: doc.kind })));
  } catch (err) {
    console.error(`Extraction failed for ${doc.label} ${doc.date}: ${err.message}`);
    bump('extraction-failed');
    return { facts: 0, accepted: 0, status: 'skipped', reason: 'extraction-failed' };
  }
  let accepted = 0;
  for (const r of raw) {
    const v = nf.validateFact(r, doc.citeUrl);
    if (!v.ok) { bump(v.reason); continue; }
    const match = nf.matchShow(v.fact.show, shows, commercial && commercial.shows);
    const diff = nf.diffFact(v.fact, match && match.record);
    if (diff.status === 'known') { bump('already-in-commercial'); continue; }
    accepted++;
    items.push({ fact: v.fact, slug: match ? match.slug : null, status: diff.status, existing: diff.existing });
  }
  return { facts: raw.length, accepted, status: 'read', reason: null };
}

/**
 * Broadway Briefing emails -> issues. Facts come from the destination article of each
 * bway.ly link that sits next to a money/closing item, and are cited to that article.
 * `resolveLink(url)` and `fetchArticle(url)` are injected (see newsletter-sources.js).
 */
async function processMessages(messages, { extract, shows, commercial, windowDays = nf.DEFAULT_DAYS, resolveLink, fetchArticle, now = Date.now(), state = {}, dryRun = false }) {
  const issues = [];
  const items = [];
  const skipped = {};
  const bump = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  const cutoff = now - windowDays * 86400000;
  const seenArticles = new Set();
  const processed = new Set(dryRun ? [] : (state.processed?.['broadway-briefing'] || []));
  for (const m of messages) {
    const sender = nf.senderFor(m.from);
    if (!sender) { bump('sender-not-allowlisted'); continue; }
    if (m.id && processed.has(m.id)) { bump('already-processed'); continue; }
    if (Date.parse(m.date) < cutoff) { bump('older-than-window'); continue; }
    const issue = { messageId: m.id, source: sender.key, sender: sender.label, date: m.date.slice(0, 10), subject: m.subject, dkim: nf.dkimPassesFor(sender, m.authResults), status: 'skipped', reason: null, facts: 0, accepted: 0, links: 0, candidates: 0, articlesRead: 0, citations: [] };
    issues.push(issue);
    if (!issue.dkim) { issue.reason = 'dkim-not-verified'; bump(issue.reason); continue; }
    const { linksFound, candidates } = src.splitBriefingItems(m.html, m.text);
    issue.links = linksFound;
    issue.candidates = candidates.length;
    let unresolved = 0;
    for (const c of candidates) {
      const r = await resolveLink(c.link);
      if (!r.ok) { bump(`link-${r.reason}`); unresolved++; continue; }
      if (seenArticles.has(r.url)) { issue.articlesRead++; continue; }
      const page = await fetchArticle(r.url);
      if (!page.ok) { bump(`article-${page.reason}`); unresolved++; continue; }
      const text = src.articleText(page.body);
      if (text.length < src.MIN_ARTICLE_CHARS) { bump('article-body-too-short'); unresolved++; continue; }
      issue.articlesRead++;
      issue.citations.push(r.url);
      const doc = { label: sender.label, subject: m.subject, date: issue.date, text, citeUrl: r.url, kind: 'article' };
      const d = await processDocument(doc, { extract, shows, commercial, items, bump });
      issue.facts += d.facts;
      issue.accepted += d.accepted;
      if (d.status !== 'read') { issue.articlesRead--; issue.extractFailed = (issue.extractFailed || 0) + 1; }
      else seenArticles.add(r.url);
    }
    // An issue with no money/closing item is read (nothing to extract). One whose items could
    // not be resolved or fetched is a skip, which feeds the health check.
    if (!linksFound) { issue.reason = 'no-bway-links'; bump(issue.reason); continue; }
    if (candidates.length && !issue.articlesRead) { issue.reason = issue.extractFailed ? 'extraction-failed' : 'no-item-resolvable'; if (!issue.extractFailed) bump(issue.reason); continue; }
    issue.status = 'read';
    issue.unresolved = unresolved;
    if (m.id && !unresolved && !issue.extractFailed && !dryRun) processed.add(m.id);
  }
  return { issues, items, skipped };
}

/** Public-web posts (Chromolume, Abroad/Way) -> issues, same shape as processMessages. */
async function processPosts(source, posts, { extract, shows, commercial, items, bump }) {
  const issues = [];
  for (const p of posts) {
    const issue = { source: source.key, sender: source.label, date: p.date, subject: p.title || p.url, citeUrl: p.url, status: 'skipped', reason: null, facts: 0, accepted: 0 };
    issues.push(issue);
    const citeUrl = nf.pickIssueUrl(source, [p.url]);
    if (!citeUrl) { issue.reason = 'issue-has-no-public-url'; bump(issue.reason); continue; }
    issue.citeUrl = citeUrl;
    if (p.error) { issue.reason = p.error; bump(p.error); continue; }
    if (!p.text || p.text.length < src.MIN_ARTICLE_CHARS) { issue.reason = 'body-too-short'; bump(issue.reason); continue; }
    const d = await processDocument({ label: source.label, subject: issue.subject, date: p.date, text: p.text, citeUrl, kind: 'issue' }, { extract, shows, commercial, items, bump });
    Object.assign(issue, { facts: d.facts, accepted: d.accepted, status: d.status, reason: d.reason });
  }
  return issues;
}

// Substack refuses GitHub runner IPs on the feed and the archive API alike, but the same
// posts reach the owner's inbox, so the email copy is the last listing provider.
const EMAIL_FALLBACK_SENDER = { abroadway: 'gordoncox@substack.com' };

/** gordoncox.substack.com/p/<slug> for any accepted post URL (open.substack.com, /comments...). */
function canonicalPostUrl(url) {
  const m = /\/p\/([^/?#]+)/.exec(String(url || ''));
  return m ? `https://gordoncox.substack.com/p/${m[1]}` : null;
}

/** Gmail messages -> posts: exact sender, DKIM-verified, full issue body, canonical post URL. */
function emailPosts(source, messages) {
  const sender = EMAIL_FALLBACK_SENDER[source.key];
  const posts = [];
  for (const m of messages || []) {
    if (!sender || nf.parseFromAddress(m.from) !== sender) continue;
    if (!nf.dkimPassesFor(source, m.authResults)) continue;
    // Comment and reply notifications from the same sender are short; they are not issues.
    if (!m.text || m.text.length < src.MIN_ARTICLE_CHARS) continue;
    // The plain-text part names the issue's own link ("View this post on the web at ...") first.
    const url = canonicalPostUrl(nf.pickIssueUrl(source, [...nf.extractLinks(m.text), ...nf.extractLinks(m.html || '')]));
    if (!url) continue;
    posts.push({ url, date: String(m.date).slice(0, 10), title: m.subject, text: m.text });
  }
  return posts;
}

const ABROADWAY_ARCHIVE = 'https://gordoncox.substack.com/api/v1/archive?sort=new&limit=10';

const allowSourceUrl = (source) => (url) => {
  try { return nf.pickIssueUrl(source, [url]) !== null; } catch { return false; }
};

/** Read the public listing for one web source. Returns { posts, listingEmpty }. */
async function readWebSource(source, { fetchImpl, args, state, readEmail }) {
  const processed = (state.processed && state.processed[source.key]) || [];
  let listing = [];
  let listingEmpty = false;
  let viaApi = false;
  let viaEmail = false;
  if (source.key === 'chromolume') {
    const idx = await src.fetchPublicText(src.CHROMOLUME_INDEX, { fetchImpl, isAllowed: (u) => /^https:\/\/(?:www\.)?chromolume\.io\/blog\/?$/.test(u) });
    if (!idx.ok) console.error(`Chromolume index unreadable: ${idx.reason}`);
    else listing = src.parseChromolumeIndex(idx.body);
  } else {
    const feed = await src.fetchPublicText(src.ABROADWAY_FEED, { fetchImpl, isAllowed: (u) => /^https:\/\/gordoncox\.substack\.com\/feed\/?$/.test(u) });
    if (feed.ok) listing = src.parseFeedItems(feed.body).filter((i) => allowSourceUrl(source)(i.url));
    else {
      // GitHub runner IPs get 403 on /feed; the archive JSON API is a separate path on the same host.
      console.error(`Abroad/Way feed unreadable: ${feed.reason}; trying the archive API`);
      const arch = await src.fetchPublicText(ABROADWAY_ARCHIVE, { fetchImpl, types: /json|text/i, isAllowed: (u) => u === ABROADWAY_ARCHIVE });
      if (!arch.ok) console.error(`Abroad/Way archive API unreadable: ${arch.reason}`);
      else { viaApi = true; listing = src.parseArchiveJson(arch.body).filter((i) => allowSourceUrl(source)(i.url)); }
    }
    const sender = EMAIL_FALLBACK_SENDER[source.key];
    if (!listing.length && sender && readEmail) {
      try {
        listing = emailPosts(source, await readEmail(`newer_than:${args.days}d from:${sender}`));
        viaEmail = true;
        console.log(`  ${source.label}: web listing unreachable, ${listing.length} issue(s) from email.`);
      } catch (err) {
        console.error(`${source.label} email fallback failed: ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
  if (!listing.length) listingEmpty = true;
  const { toRead, unreadOlder } = src.pickPosts(listing, processed, { maxNew: args.maxNew, dryRun: args.dryRun });
  if (unreadOlder) console.log(`  ${source.label}: ${unreadOlder} older unread post(s) beyond --max-new=${args.maxNew} are not read.`);
  const posts = [];
  for (const p of toRead) {
    if (source.key === 'chromolume') {
      const page = await src.fetchPublicText(p.url, { fetchImpl, isAllowed: allowSourceUrl(source) });
      posts.push(page.ok ? { ...p, title: p.url.split('/').pop(), text: src.articleText(page.body) } : { ...p, title: p.url.split('/').pop(), error: `post-${page.reason}` });
    } else if (viaEmail) {
      posts.push(p);
    } else if (viaApi) {
      const page = await src.fetchPublicText(`https://gordoncox.substack.com/api/v1/posts/${encodeURIComponent(p.slug)}`, { fetchImpl, types: /json|text/i, isAllowed: (u) => /^https:\/\/gordoncox\.substack\.com\/api\/v1\/posts\/[A-Za-z0-9_-]+$/.test(u) });
      posts.push(page.ok ? { ...p, text: src.postBodyFromJson(page.body) } : { ...p, error: `post-${page.reason}` });
    } else {
      posts.push(p);
    }
  }
  return { posts, listing, listingEmpty };
}

function summarize(issues, listingEmptyBy = {}) {
  const per = {};
  const keys = [...nf.WEB_SOURCES, ...nf.EMAIL_SENDERS];
  for (const k of keys) per[k.key] = { label: k.label, found: 0, read: 0, skipped: {}, listingEmpty: !!listingEmptyBy[k.key] };
  for (const i of issues) {
    const s = per[i.source];
    if (!s) continue;
    s.found++;
    if (i.status === 'read') s.read++;
    else s.skipped[i.reason] = (s.skipped[i.reason] || 0) + 1;
  }
  return per;
}

async function main() {
  const args = parseArgs(process.argv);
  const dataDir = path.join(__dirname, '..', 'data');
  const shows = (readJson(path.join(dataDir, 'shows.json'), { shows: [] }).shows) || [];
  const commercial = readJson(path.join(dataDir, 'commercial.json'), { shows: {} });
  if (!shows.length) console.warn('WARN: data/shows.json not found; facts cannot be matched to commercial records.');
  const stateExists = fs.existsSync(args.state);
  const state = readJson(args.state, { processed: {}, zeroRuns: {} });
  let gmailFailed = false;
  const want = (key) => (args.source === 'all' || args.source === key) && !(gmailFailed && key === 'broadway-briefing');
  const items = [];
  const skipped = {};
  const bump = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  const issues = [];
  const listingEmptyBy = {};
  const listings = {};
  const shared = { extract: callAnthropic, shows, commercial, items, bump };

  for (const source of nf.WEB_SOURCES) {
    if (!want(source.key)) continue;
    const r = await readWebSource(source, { fetchImpl: fetch, args, state, readEmail: args.fromFile ? null : (q) => fetchGmail(args.days, q) });
    listingEmptyBy[source.key] = r.listingEmpty;
    listings[source.key] = r.listing;
    issues.push(...await processPosts(source, r.posts, shared));
  }

  const briefing = nf.EMAIL_SENDERS[0];
  if (want(briefing.key)) {
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
      gmailFailed = true;
    }
    const r = gmailFailed ? { issues: [], items: [], skipped: {} } : await processMessages(messages, {
      ...shared,
      windowDays: args.windowDays,
      state,
      dryRun: args.dryRun,
      resolveLink: (u) => src.resolveBwayLink(u, { resolveOutlet: outletOf }),
      fetchArticle: (u) => src.fetchPublicText(u, { isAllowed: (x) => { try { return new URL(x).protocol === 'https:' && !!outletOf(x); } catch { return false; } } }),
    });
    issues.push(...r.issues);
    for (const [k, n] of Object.entries(r.skipped)) skipped[k] = (skipped[k] || 0) + n;
    items.push(...r.items);
    listingEmptyBy[briefing.key] = r.issues.length === 0 && !r.skipped['already-processed'];
  }

  console.log(`Issues found: ${issues.length}`);
  for (const i of issues) {
    const extra = i.source === 'broadway-briefing' ? ` | links ${i.links} candidates ${i.candidates} articles read ${i.articlesRead}` : '';
    console.log(`  ${i.date} | ${i.sender} | ${i.status.toUpperCase()}${i.reason ? ` (${i.reason})` : ''}${extra} | facts ${i.accepted}/${i.facts} | ${i.citeUrl || (i.citations && i.citations.join(' ')) || 'none'} | ${i.subject}`);
  }
  console.log(`Skipped: ${JSON.stringify(skipped)}`);
  const per = summarize(issues.filter((i) => want(i.source)), listingEmptyBy);
  console.log('Per source (issues found / read / skipped):');
  for (const [k, s] of Object.entries(per)) {
    if (!want(k)) continue;
    console.log(`  ${s.label}: found ${s.found}, read ${s.read}, skipped ${s.found - s.read}${s.listingEmpty ? ' (listing empty or unreachable)' : ''}${s.found - s.read ? ` ${JSON.stringify(s.skipped)}` : ''}`);
  }
  if (issues.length && issues.every((i) => i.status !== 'read' && i.reason === 'extraction-failed')) process.exitCode = 1;
  console.log(`Facts for review: ${items.length}`);
  for (const it of items) console.log(`  ${it.status.toUpperCase()} ${it.slug || it.fact.show} ${it.fact.field} = ${JSON.stringify(it.fact.value)} ${it.fact.issueUrl}${it.status === 'conflict' ? ` (record: ${JSON.stringify(it.existing)})` : ''}`);

  const health = src.evaluateSkipHealth(Object.fromEntries(Object.entries(per).filter(([k]) => want(k))), state.zeroRuns || {});
  for (const a of health.alerts) console.log(`HEALTH ALERT: ${a.title}`);

  const opts = nf.buildAlertOpts(items);
  if (args.dryRun) {
    if (!opts) console.log('Nothing new for a person to review.');
    console.log(`[dry-run] would route ${health.alerts.length + (opts ? 1 : 0)} alert card(s) and update state; not sending or writing.`);
    return;
  }
  const { routeAlert } = require('./lib/owner-alert-router');
  let allOk = true;
  for (const a of [...(opts ? [opts] : []), ...health.alerts]) {
    const res = await routeAlert(a).catch((e) => { console.error(`routeAlert failed: ${e.message}`); return null; });
    console.log(`routeAlert ${a.conditionKey}: ${JSON.stringify({ action: res && res.action, dispatchOk: res && res.dispatchOk })}`);
    if (!res || res.dispatchOk === false) allOk = false;
  }
  if (!opts) console.log('Nothing new for a person to review.');
  // State moves only after the alerts went out, so a failed alert re-reads the same posts next run.
  // First run: seed the whole listing as seen so the backlog is never dumped into one card.
  if (allOk) {
    const next = { processed: { ...(state.processed || {}) }, zeroRuns: { ...(state.zeroRuns || {}), ...health.zeroRuns }, updated: new Date().toISOString().slice(0, 10) };
    for (const [k, listing] of Object.entries(listings)) {
      const seen = new Set(next.processed[k] || []);
      const readNow = issues.filter((i) => i.source === k && i.status === 'read').map((i) => i.citeUrl);
      // Listings are newest-first and the cap keeps the tail, so seed oldest-first.
      for (const u of (stateExists ? readNow : [...listing].reverse().map((l) => l.url))) seen.add(u);
      next.processed[k] = [...seen].slice(-200);
    }
    if (want(briefing.key)) next.processed[briefing.key] = nf.processedBriefingIds(next.processed[briefing.key], issues);
    fs.mkdirSync(path.dirname(args.state), { recursive: true });
    fs.writeFileSync(args.state, `${JSON.stringify(next, null, 2)}\n`);
  } else {
    process.exitCode = 1;
  }
}

if (require.main === module) runMain(main);

module.exports = { processMessages, processPosts, emailPosts, canonicalPostUrl, readWebSource, normalizeGmailMessage, htmlToText, parseArgs, summarize };
