#!/usr/bin/env node
/**
 * Read-only Sentry issue report: the top issues of the last N days (any status,
 * including the ones scripts/triage-sentry.js auto-ignored) with the latest
 * event's in-app stack frames, page path, browser and last breadcrumbs.
 *
 * Why: the weekly Sentry digest only names an issue and a count. Judging
 * whether it is our bug needs the stack. Cloud sessions have no Sentry token,
 * so run it with `node scripts/cloud-run-script.js scripts/sentry-issue-report.js`.
 *
 * Usage:
 *   node scripts/sentry-issue-report.js [--days=14] [--limit=15] [--query="TypeError"] [--issue=<id>]
 *
 * Env: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT (default broadway-scorecard).
 * Never writes to Sentry. Prints no user ids, emails or IPs, and strips URL
 * queries/hashes and private share tokens from every path it prints.
 */
require('./lib/cli-help').exitOnHelp(module);

const SENTRY_BASE = 'https://sentry.io/api/0';

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const { safeText, summarizeEvent } = require('./lib/sentry-report-format');

async function sentryGet(path, token) {
  const res = await fetch(`${SENTRY_BASE}${path}`, {
    signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sentry API ${res.status} on ${path.split('?')[0]}`);
  return res.json();
}

async function main() {
  const token = process.env.SENTRY_AUTH_TOKEN;
  const org = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT || 'broadway-scorecard';
  if (!token || !org) {
    console.error('SENTRY_AUTH_TOKEN and SENTRY_ORG are required (run via scripts/cloud-run-script.js).');
    process.exit(2);
  }
  const stray = process.argv.slice(2).filter(a => !/^--(days|limit|query|issue)=/.test(a));
  if (stray.length) {
    console.error(`Unknown argument(s): ${stray.join(' ')} (flags are --days=N --limit=N --query=... --issue=ID).`);
    process.exit(2);
  }
  const days = Number(arg('days', '14'));
  const limit = Number(arg('limit', '15'));
  if (!Number.isInteger(days) || days < 1 || !Number.isInteger(limit) || limit < 1) {
    console.error('--days and --limit must be positive integers, written --days=7 (no space).');
    process.exit(2);
  }
  const query = arg('query', '');
  const only = arg('issue', '');

  let issues;
  if (only) {
    issues = [await sentryGet(`/issues/${encodeURIComponent(only)}/`, token)];
  } else {
    // The project endpoint's statsPeriod only shapes the stats graph, so the
    // window is applied here on lastSeen. Empty query = every status.
    const qs = new URLSearchParams({ sort: 'freq', limit: '100', query });
    const all = await sentryGet(`/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?${qs}`, token);
    const since = Date.now() - days * 86400000;
    issues = all.filter(i => Date.parse(i.lastSeen) >= since).slice(0, limit);
  }
  console.log(`${issues.length} issue(s)${only ? '' : ` seen in the last ${days}d`}, project ${project} (counts are lifetime)\n`);

  for (const issue of issues) {
    console.log(`=== ${issue.shortId || issue.id} [${issue.status}] ${safeText(issue.title, 120)}`);
    console.log(`  id ${issue.id} | events ${issue.count} | users ${issue.userCount} | first ${issue.firstSeen} | last ${issue.lastSeen}`);
    console.log(`  culprit: ${safeText(issue.culprit, 100)} | level: ${issue.level}`);
    try {
      const ev = await sentryGet(`/issues/${issue.id}/events/latest/`, token);
      console.log(summarizeEvent(ev));
    } catch (e) {
      console.log(`  (no event: ${e.message})`);
    }
    console.log('');
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

