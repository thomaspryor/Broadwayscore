#!/usr/bin/env node
/**
 * ingest-finances.js — turn vendor receipt emails into the BWSC expense ledger.
 *
 * Sources (pick one):
 *   --from-file=PATH   Ingest pre-fetched receipts (JSON array of
 *                      { gmailMessageId, date, from, subject, body }). Used by the
 *                      MCP bootstrap and by tests — no Gmail creds needed.
 *   (default)          Gmail API (read-only) via a stored OAuth refresh token
 *                      (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN).
 *                      This is the production cron path.
 *
 * Flags:
 *   --dry-run          Classify + summarize, write nothing.
 *   --days=N           Gmail lookback window (default 45; --backfill widens to 400).
 *   --backfill         One-time historical pull.
 *   --out=DIR          Ledger dir (default data/finances). Gitignored — in CI the
 *                      caller syncs it to the private repo via the GitHub API.
 *
 * Idempotent: a receipt already in the ledger (by Gmail id OR dedupHash) is skipped,
 * so re-runs and the MCP→Gmail-API handoff never double-book.
 */
const fs = require('fs');
const path = require('path');
const { toLedgerRow, loadVendorConfig, reclassifyMonthlyDupes, applyExternallyPaid, classifyReceipt } = require('./lib/finance-matchers');
const { computeFinanceStats } = require('./lib/finance-stats');

function parseArgs(argv) {
  const a = { dryRun: false, days: 45, backfill: false, out: 'data/finances', fromFile: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--backfill') { a.backfill = true; a.days = 400; }
    else if (arg.startsWith('--days=')) a.days = parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--out=')) a.out = arg.slice(6);
    else if (arg.startsWith('--from-file=')) a.fromFile = arg.slice(12);
  }
  return a;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// --- Gmail API source (lazy-required so --from-file needs no googleapis dep) ---
async function fetchGmailReceipts(days) {
  const { google } = require('googleapis'); // eslint-disable-line
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail source needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN (or use --from-file).');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });
  const q = `newer_than:${days}d (subject:(receipt OR invoice OR payment OR subscription OR recharged OR refund) OR from:(brightdata.com OR openrouter.ai OR anthropic.com))`;
  const out = [];
  let pageToken;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    for (const { id } of list.data.messages || []) {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      out.push(normalizeGmailMessage(msg.data));
    }
    pageToken = list.data.nextPageToken;
  } while (pageToken);
  return out;
}

function normalizeGmailMessage(m) {
  const headers = Object.fromEntries((m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  return {
    gmailMessageId: m.id,
    date: new Date(Number(m.internalDate)).toISOString(),
    from: headers.from || '',
    subject: headers.subject || '',
    body: decodeBody(m.payload),
  };
}

function decodeBody(payload) {
  if (!payload) return '';
  const parts = [];
  const walk = (p) => {
    if (p.body?.data) parts.push(Buffer.from(p.body.data, 'base64').toString('utf8'));
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return parts.join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadVendorConfig();

  const receipts = args.fromFile
    ? readJson(args.fromFile, [])
    : await fetchGmailReceipts(args.days);

  const ledgerPath = path.join(args.out, 'expense-ledger.json');
  const queuePath = path.join(args.out, 'review-queue.json');
  const ledger = readJson(ledgerPath, []);
  let queue = readJson(queuePath, []);

  const seenIds = new Set(ledger.map((r) => r.id).filter(Boolean));
  const rowByHash = new Map(ledger.filter((r) => r.dedupHash).map((r) => [r.dedupHash, r]));
  const seenQueue = new Set(queue.map((q) => q.gmailMessageId).filter(Boolean));

  const stats = { booked: 0, duplicate: 0, personal: 0, ignore: 0, needsReview: 0, unparsed: 0 };

  // The dedupHash (vendor|date|amount|receiptNo) is a FALLBACK for rows whose
  // Gmail id form changed across the MCP→API switch. When BOTH rows carry Gmail
  // ids and they differ, the ids are authoritative proof of distinct charges —
  // e.g. two $50 Bright Data recharges on the same day (no receiptNo) must both
  // book (ship-check finding: hash-only dedup silently dropped the second).
  const isDuplicate = (row) => {
    if (row.id && seenIds.has(row.id)) return true;
    const existing = rowByHash.get(row.dedupHash);
    if (!existing) return false;
    return !(row.id && existing.id && row.id !== existing.id);
  };

  for (const receipt of receipts) {
    const { row, disposition } = toLedgerRow(receipt, config);
    if (disposition === 'booked') {
      if (isDuplicate(row)) { stats.duplicate++; continue; }
      ledger.push(row);
      if (row.id) seenIds.add(row.id);
      if (!rowByHash.has(row.dedupHash)) rowByHash.set(row.dedupHash, row);
      stats.booked++;
    } else if (disposition === 'personal') stats.personal++;
    else if (disposition === 'ignore') stats.ignore++;
    else { // needs-review | amount-unparsed
      disposition === 'amount-unparsed' ? stats.unparsed++ : stats.needsReview++;
      if (receipt.gmailMessageId && !seenQueue.has(receipt.gmailMessageId)) {
        queue.push({ gmailMessageId: receipt.gmailMessageId, date: receipt.date, from: receipt.from, subject: receipt.subject, reason: disposition });
        seenQueue.add(receipt.gmailMessageId);
      }
    }
  }

  ledger.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Whole-ledger post-passes (both idempotent): split same-month duplicate
  // subscription charges into 'extra-topup', then re-mark externally-paid rows.
  const retyped = reclassifyMonthlyDupes(ledger);
  const ext = applyExternallyPaid(ledger, config);

  // Drain queue entries whose message has since booked (a matcher fix can turn
  // yesterday's needs-review into today's booking — the stale entry would sit
  // in the dashboard's review count forever otherwise), then re-classify the
  // remainder against the CURRENT config so new personalExclude/ignore rules
  // retroactively clear old entries (bodies aren't stored in the queue, but
  // personal + ignore rules only need from/subject).
  const bookedIds = new Set(ledger.map((r) => r.id).filter(Boolean));
  const queueBefore = queue.length;
  queue = queue.filter((q) => !bookedIds.has(`gmail-${q.gmailMessageId}`));
  queue = queue.filter((q) => {
    const cls = classifyReceipt({ from: q.from, subject: q.subject, body: '' }, config);
    return cls.disposition !== 'personal' && cls.disposition !== 'ignore';
  });
  const drained = queueBefore - queue.length;

  console.log(`Receipts in: ${receipts.length}`);
  console.log(`  booked ${stats.booked} · duplicate ${stats.duplicate} · personal ${stats.personal} · ignored ${stats.ignore} · needs-review ${stats.needsReview} · amount-unparsed ${stats.unparsed}`);
  console.log(`  extra-topup retyped ${retyped} · externally-paid marked ${ext.excluded} / cleared ${ext.cleared} (total excluded ${ledger.filter((r) => r.excluded).length}) · queue drained ${drained}`);

  const revenue = readJson(path.join(args.out, 'revenue-ledger.json'), []);
  const pnl = computeFinanceStats({ expenses: ledger, revenue, monthsBack: 6 });
  if (pnl.current) {
    console.log(`\nCurrent month ${pnl.current.month}: expense $${pnl.current.expense} · revenue $${pnl.current.revenue} · net $${pnl.current.net}`);
    console.log('By category:', pnl.byCategory.map((c) => `${c.category} $${c.amount}`).join(' · '));
  }

  if (args.dryRun) { console.log('\n[dry-run] nothing written.'); return; }
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  console.log(`\nWrote ${ledger.length} ledger rows → ${ledgerPath}; ${queue.length} review-queue items.`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { parseArgs, normalizeGmailMessage, decodeBody };
