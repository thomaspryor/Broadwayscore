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

/** Path only: no query/hash (OAuth tokens live there), share tokens masked. */
function safePath(url) {
  if (!url) return '';
  let p = String(url);
  try { p = new URL(p).pathname; } catch { p = p.split(/[?#]/)[0]; }
  return p.replace(/\/(plans|seen)\/[^/]+/g, '/$1/:token');
}

function safeText(s, max = 160) {
  return String(s ?? '')
    .replace(/\/(plans|seen)\/[^/?#\s"'<>]+/g, '/$1/:token')
    .replace(/\b(access_token|refresh_token|provider_token|provider_refresh_token|id_token|code|token|state)=[^&#\s"']+/gi, '$1=:redacted')
    .replace(/(https?:\/\/[^\s?#"']+)[?#]\S*/g, '$1')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, ':jwt')
    .replace(/\bBearer\s+\S+/gi, 'Bearer :redacted')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ':email')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function frameLine(f) {
  const file = safePath(f.filename || f.absPath || '?').replace(/^\/_next\/static\//, '');
  const where = `${file}:${f.lineNo ?? f.lineno ?? '?'}:${f.colNo ?? f.colno ?? '?'}`;
  return `${f.inApp ? '*' : ' '} ${safeText(f.function || '?', 60)}  ${where}`;
}

function summarizeEvent(ev) {
  const out = [];
  const exc = ev.entries?.find(e => e.type === 'exception')?.data?.values || [];
  // values are cause-first; the exception actually thrown is last.
  for (const v of exc.slice(-2).reverse()) {
    out.push(`  exception: ${v.type}: ${safeText(v.value)}`);
    const frames = v.stacktrace?.frames || [];
    // Sentry orders oldest-first; the crash site is the end.
    const top = frames.slice(-10).reverse();
    out.push(`  frames (${frames.length} total, newest first, * = in-app):`);
    for (const f of top) out.push(`    ${frameLine(f)}`);
    // Recursion: show the repeating pair rather than 10 identical frames.
    if (/call stack|too much recursion/i.test(v.value || '') && frames.length) {
      const counts = {};
      for (const f of frames) {
        const k = `${f.function || '?'} @ ${safePath(f.filename || f.absPath)}:${f.lineNo ?? f.lineno ?? '?'}`;
        counts[k] = (counts[k] || 0) + 1;
      }
      const rep = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
      out.push('  most repeated frames:');
      for (const [k, n] of rep) out.push(`    x${n}  ${k}`);
    }
  }
  const tag = k => ev.tags?.find(t => t.key === k)?.value;
  const req = ev.entries?.find(e => e.type === 'request')?.data;
  out.push(`  page: ${safePath(req?.url || ev.tags?.find(t => t.key === 'url')?.value)}`);
  out.push(`  browser: ${tag('browser') || '?'} | os: ${tag('os') || '?'} | device: ${tag('device') || tag('device.family') || '?'} | release: ${tag('release') || '?'}`);
  const crumbs = ev.entries?.find(e => e.type === 'breadcrumbs')?.data?.values || [];
  if (crumbs.length) {
    out.push('  last breadcrumbs:');
    for (const b of crumbs.slice(-6)) {
      const msg = b.message || safePath(b.data?.url) || safePath(b.data?.to) || '';
      out.push(`    ${b.category || b.type}: ${safeText(msg, 100)}`);
    }
  }
  const ctx = ev.contexts || {};
  if (ev.tags?.length) {
    const ugc = ev.tags.filter(t => t.key.startsWith('ugc_')).map(t => `${t.key}=${t.value}`);
    if (ugc.length) out.push(`  ugc tags: ${safeText(ugc.join(' '))}`);
  }
  if (ctx.browser?.name === undefined && !tag('browser')) out.push('  (no browser context)');
  return out.join('\n');
}

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

module.exports = { safePath, safeText, summarizeEvent };
