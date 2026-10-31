const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'data', 'seo-search-landings.json');
const ENGINES = ['google', 'bing', 'duckduckgo', 'yahoo', 'ecosia', 'brave', 'baidu', 'yandex'];

// Used by the weekly SEO health workflow through the CLI wrapper. Keep the
// fetch and destination injectable so tests exercise the real snapshot writer.
async function refreshSearchLandings({
  env = process.env,
  fetch: doFetch = globalThis.fetch,
  outputFile = OUT,
  now = new Date(),
} = {}) {
  const key = env.POSTHOG_PERSONAL_API_KEY;
  const project = env.POSTHOG_PROJECT_ID;
  if (!key || !project) throw new Error('POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set');
  const like = ENGINES.map(e => `$entry_referring_domain like '%${e}%'`).join(' or ');
  const query = `select $entry_pathname, count() c from sessions where $start_timestamp > now() - interval 90 day and (${like}) group by 1 order by c desc limit 100000`;
  const res = await doFetch(`https://us.posthog.com/api/projects/${project}/query/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}`);
  const rows = (await res.json()).results || [];
  const paths = rows.map(r => r[0]).filter(p => /^\/(show|cast|critics)\//.test(p || ''))
    .map(p => p.replace(/\/+$/, '')).sort();
  if (paths.length === 0) throw new Error('no search-landing paths returned; keeping existing snapshot');
  const out = { generated: now.toISOString().slice(0, 10), windowDays: 90, paths: [...new Set(paths)] };
  fs.writeFileSync(outputFile, JSON.stringify(out, null, 1) + '\n');
  return out;
}

module.exports = { refreshSearchLandings };
