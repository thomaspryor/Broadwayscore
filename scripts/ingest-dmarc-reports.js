#!/usr/bin/env node
/**
 * ingest-dmarc-reports.js — read DMARC aggregate reports out of Gmail and turn
 * them into a deliverability verdict.
 *
 * WHY: broadwayscorecard.com publishes a DMARC record whose rua= points at the
 * owner's Gmail. Google, Microsoft and Zoho have been delivering a report a day
 * since March 2026; before this script, 233 of them had arrived and none had
 * ever been opened. An unread DMARC report is worse than no DMARC record — it
 * is the alerting channel for domain spoofing, wired to nobody.
 *
 * Sources (pick one):
 *   --from-dir=DIR     Parse report attachments already on disk (.zip/.gz/.xml).
 *                      No Gmail creds needed — used by tests and for local runs
 *                      against `gmail attachments --out DIR`.
 *   (default)          Gmail API (read-only) via the stored OAuth refresh token
 *                      (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
 *                      GMAIL_REFRESH_TOKEN). This is the production cron path,
 *                      reusing the same secrets as ingest-finances.js.
 *
 * Flags:
 *   --days=N           Gmail lookback window (default 30; --backfill widens to 400).
 *   --backfill         One-time historical pull.
 *   --out=DIR          Output dir (default data/audit).
 *   --domain=D         Only summarize reports whose policy_published domain is D
 *                      (default broadwayscorecard.com; --domain=all disables).
 *                      The Gmail query matches "Report Domain" by subject, so
 *                      the day a second domain is added to this mailbox its
 *                      reports would otherwise be blended into one verdict.
 *   --dry-run          Parse + summarize, write nothing, send nothing.
 *   --alert            Route 'action'-severity findings to the owner alert router.
 *   --quiet            Suppress the human-readable digest on stdout.
 *
 * Exit codes: 0 = ingested (findings may exist), 1 = fatal error.
 * A finding is NOT a non-zero exit: this runs on a cron whose failure signal
 * should mean "the ingest broke", not "the domain has a finding" — the finding
 * has its own delivery path via --alert.
 *
 * PRIVACY (repo is public): Microsoft's reports carry <envelope_to>, i.e. the
 * recipient's domain — subscriber and press-contact domains. Nothing derived
 * from envelope_to is ever persisted; see stripForPersistence().
 *
 * Idempotent: a report already in the ledger (reporter + report_id) is skipped,
 * so re-runs and overlapping lookback windows never double-count.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { unpackReport, parseAggregateReport } = require('./lib/dmarc-report-parser');
const { summarizeReports, formatSummary, worstSeverity, reportKey } = require('./lib/dmarc-analysis');

const REPORT_QUERY = 'subject:"Report Domain" OR from:noreply-dmarc-support@google.com OR from:dmarcreport@microsoft.com OR from:noreply-dmarc@zoho.com';

function parseArgs(argv) {
  const a = { days: 30, backfill: false, out: 'data/audit', fromDir: null, dryRun: false, alert: false, quiet: false, domain: 'broadwayscorecard.com' };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--backfill') { a.backfill = true; a.days = 400; }
    else if (arg === '--alert') a.alert = true;
    else if (arg === '--quiet') a.quiet = true;
    else if (arg.startsWith('--days=')) a.days = parseInt(arg.slice(7), 10);
    else if (arg.startsWith('--out=')) a.out = arg.slice(6);
    else if (arg.startsWith('--from-dir=')) a.fromDir = arg.slice(11);
    else if (arg.startsWith('--domain=')) a.domain = arg.slice(9).toLowerCase();
  }
  return a;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/**
 * The ledger is append-only JSONL, matching the ~20 other data/audit/*.jsonl
 * ledgers in this repo (scraper-spend-ledger.jsonl, stage-latency.jsonl). A
 * daily append to a single JSON array would rewrite the whole file every run,
 * which is what makes those diffs unreviewable and their merges conflict.
 */
function readLedgerJsonl(p) {
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Lifetime totals across every report ever ingested.
 *
 * This is why the ledger exists and is read rather than merely written: the
 * cron fetches a bounded recent window, so without the ledger the record of
 * "no failure has EVER been seen" is only ever as long as that window, and
 * the evidence for a policy upgrade could never accumulate.
 */
function lifetimeStats(ledger) {
  if (!ledger.length) return null;
  const sorted = [...ledger].sort((a, b) => String(a.dateBegin).localeCompare(String(b.dateBegin)));
  const messages = ledger.reduce((n, r) => n + (r.messageCount || 0), 0);
  const failures = ledger.reduce((n, r) => n + (r.failCount || 0), 0);
  const first = sorted[0].dateBegin;
  const last = sorted.reduce((acc, r) => (String(r.dateEnd) > String(acc) ? r.dateEnd : acc), sorted[0].dateEnd);
  const spanDays = (Date.parse(last) - Date.parse(first)) / 86400000;
  return {
    reportCount: ledger.length,
    messages,
    failures,
    passRate: messages > 0 ? (messages - failures) / messages : null,
    firstReport: first,
    lastReport: last,
    spanDays: Number.isFinite(spanDays) ? Math.round(spanDays) : null,
  };
}

/**
 * True when the summary changed in a way worth committing.
 *
 * generatedAt moves every run by construction, so comparing whole files would
 * commit a no-op diff daily forever — noise that trains everyone to ignore
 * this file's diffs, which is exactly when a real change gets missed.
 */
function summaryChanged(previous, next) {
  if (!previous) return true;
  const strip = (o) => { const { generatedAt, ...rest } = o || {}; return JSON.stringify(rest); };
  return strip(previous) !== strip(next);
}

/**
 * Drop everything that identifies a recipient before anything is written to
 * disk. The summary itself is recipient-free by construction; this guards the
 * per-report ledger, which is the only place raw record fields could leak.
 */
function stripForPersistence(report) {
  return {
    orgName: report.orgName,
    reportId: report.reportId,
    dateBegin: report.dateBegin,
    dateEnd: report.dateEnd,
    policy: report.policy,
    messageCount: report.messageCount,
    recordCount: report.records.length,
    failCount: report.records.filter((r) => r.evaluatedDkim !== 'pass' && r.evaluatedSpf !== 'pass')
      .reduce((n, r) => n + r.count, 0),
    ingestedAt: new Date().toISOString(),
  };
}

// --- Gmail API source (lazy-required so --from-dir needs no googleapis dep) ---
async function fetchGmailReports(days) {
  const { google } = require('googleapis'); // eslint-disable-line
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail source needs GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN (or use --from-dir).');
  }
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });
  const q = `newer_than:${days}d has:attachment (${REPORT_QUERY})`;

  const payloads = [];
  let pageToken;
  do {
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    for (const { id } of list.data.messages || []) {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
      for (const part of walkParts(msg.data.payload)) {
        const filename = part.filename || '';
        if (!/\.(zip|gz|xml)$/i.test(filename)) continue;
        const attachmentId = part.body && part.body.attachmentId;
        if (!attachmentId) continue;
        const att = await gmail.users.messages.attachments.get({ userId: 'me', messageId: id, id: attachmentId });
        payloads.push({ filename, buffer: Buffer.from(att.data.data, 'base64url') });
      }
    }
    pageToken = list.data.nextPageToken;
  } while (pageToken);
  return payloads;
}

function* walkParts(payload) {
  if (!payload) return;
  yield payload;
  for (const p of payload.parts || []) yield* walkParts(p);
}

/**
 * Keep only reports about the domain we own. A report for someone else's
 * domain landing in this mailbox (a forwarded report, a second domain added
 * later) must not be averaged into this domain's pass rate.
 */
function filterByDomain(reports, domain) {
  if (!domain || domain === 'all') return reports;
  return reports.filter((r) => r.policy.domain === domain);
}

function readReportsFromDir(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(zip|gz|xml)$/i.test(name)) continue;
    out.push({ filename: name, buffer: fs.readFileSync(path.join(dir, name)) });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  const payloads = args.fromDir
    ? readReportsFromDir(args.fromDir)
    : await fetchGmailReports(args.days);

  const reports = [];
  const failures = [];
  for (const { filename, buffer } of payloads) {
    try {
      reports.push(parseAggregateReport(unpackReport(buffer)));
    } catch (err) {
      // One malformed attachment must not sink the run — record and continue.
      failures.push({ filename, error: err.message });
    }
  }

  if (failures.length) {
    console.error(`[dmarc] ${failures.length} attachment(s) failed to parse:`);
    failures.slice(0, 10).forEach((f) => console.error(`  ${f.filename}: ${f.error}`));
  }

  const inScope = filterByDomain(reports, args.domain);
  if (inScope.length !== reports.length) {
    console.log(`[dmarc] ignored ${reports.length - inScope.length} report(s) for other domains (--domain=${args.domain})`);
  }
  reports.length = 0;
  reports.push(...inScope);

  if (!reports.length) {
    console.error('[dmarc] no DMARC reports parsed — nothing to summarize.');
    // An empty window is a real signal, not a crash: reporters send daily, so
    // silence means the rua path broke. Surface it as a finding, exit clean.
  }

  const ledgerPath = path.join(args.out, 'dmarc-report-ledger.jsonl');
  const summaryPath = path.join(args.out, 'dmarc-summary.json');

  // The ledger is read and the new rows computed BEFORE anything is printed,
  // so a --dry-run reports exactly the findings a real run would write.
  const ledger = readLedgerJsonl(ledgerPath);
  const seen = new Set(ledger.map(reportKey));
  const fresh = [];
  for (const r of reports) {
    const key = reportKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(stripForPersistence(r));
  }

  // Eligibility for a policy upgrade is a question about the whole record, not
  // about this fetch — so findings are evaluated against lifetime history.
  const lifetime = lifetimeStats(ledger.concat(fresh));
  const summary = summarizeReports(reports, { now: new Date().toISOString(), lifetime });

  if (!args.quiet) console.log(formatSummary(summary));
  if (lifetime) {
    console.log(`  lifetime: ${lifetime.messages} messages, ${lifetime.failures} failures over ${lifetime.spanDays} days (${lifetime.reportCount} reports)`);
  }

  if (args.dryRun) {
    console.log(`\n[dmarc] --dry-run: ${fresh.length} report(s) would be appended; nothing written, nothing sent.`);
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });
  if (fresh.length) {
    fs.appendFileSync(ledgerPath, `${fresh.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }

  const next = { ...summary, lifetime };
  const previous = readJson(summaryPath, null);
  const changed = summaryChanged(previous, next);
  if (changed) {
    fs.writeFileSync(summaryPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...next }, null, 2)}\n`);
  }

  console.log(`\n[dmarc] ${fresh.length} new report(s) appended (${ledger.length + fresh.length} in ledger) → ${ledgerPath}`);
  console.log(`[dmarc] summary ${changed ? 'updated' : 'unchanged (not rewritten)'} → ${summaryPath}`);

  const actionable = summary.findings.filter((f) => f.severity === 'action');
  if (args.alert && actionable.length) {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    const crypto = require('crypto');
    const signature = actionable.map((f) => `${f.code}:${JSON.stringify(f.evidence || {})}`).join('|');
    const conditionKey = `dmarc:${crypto.createHash('sha1').update(signature).digest('hex').slice(0, 12)}`;
    try {
      await routeAlert({
        conditionKey,
        title: `DMARC: ${actionable[0].code} on ${summary.policy ? summary.policy.domain : 'broadwayscorecard.com'}`,
        description: `${actionable.map((f) => `- ${f.message}`).join('\n')}\n\n${formatSummary(summary)}\n\nFull detail: data/audit/dmarc-summary.json`,
        severity: 'error',
        disposition: 'digest',
        fields: [
          { name: 'Messages', value: String(summary.messages.total) },
          { name: 'Failing', value: String(summary.messages.fail) },
          { name: 'Policy', value: summary.policy ? `p=${summary.policy.p}` : 'unknown' },
        ],
      });
      console.log(`[dmarc] routed ${actionable.length} actionable finding(s)`);
    } catch (err) {
      console.error('[dmarc] alert routing failed:', err.message);
    }
  } else if (args.alert) {
    console.log('[dmarc] no actionable findings to route.');
  }

  console.log(`[dmarc] worst severity: ${worstSeverity(summary.findings)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[dmarc] Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  stripForPersistence,
  filterByDomain,
  lifetimeStats,
  summaryChanged,
  readLedgerJsonl,
  readReportsFromDir,
  walkParts,
  REPORT_QUERY,
};
