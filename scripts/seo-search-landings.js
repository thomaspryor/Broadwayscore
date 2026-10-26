#!/usr/bin/env node
/**
 * Refreshes data/seo-search-landings.json: the /show, /cast and /critics paths
 * that had a search-engine entry session in the last 90 days (PostHog sessions
 * table, $entry_referring_domain). The indexability rules (scripts/lib/
 * seo-indexability.js) keep any page listed here indexable (BRO-5969).
 * Needs POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'data', 'seo-search-landings.json');
const ENGINES = ['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave', 'baidu', 'yandex'];

async function main() {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const project = process.env.POSTHOG_PROJECT_ID;
  if (!key || !project) { console.error('POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set'); process.exit(1); }
  const like = ENGINES.map(e => `$entry_referring_domain like '%${e}%'`).join(' or ');
  const query = `select $entry_pathname, count() c from sessions where $start_timestamp > now() - interval 90 day and (${like}) group by 1 order by c desc limit 100000`;
  const res = await fetch(`https://us.posthog.com/api/projects/${project}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) { console.error('PostHog', res.status); process.exit(1); }
  const rows = (await res.json()).results || [];
  const paths = rows.map(r => r[0]).filter(p => /^\/(show|cast|critics)\//.test(p || ''))
    .map(p => p.replace(/\/+$/, '')).sort();
  if (paths.length === 0) { console.error('no search-landing paths returned; keeping existing snapshot'); process.exit(1); }
  const out = { generated: new Date().toISOString().slice(0, 10), windowDays: 90, paths: [...new Set(paths)] };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`wrote ${out.paths.length} paths to ${path.relative(process.cwd(), OUT)}`);
}
main();
