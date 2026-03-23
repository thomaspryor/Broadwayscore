#!/usr/bin/env node
/**
 * posthog-weekly-insights.js — Query PostHog API and create a GitHub issue summary.
 *
 * Env: POSTHOG_PERSONAL_API_KEY, GITHUB_TOKEN (auto-provided in CI)
 * Usage: node scripts/posthog-weekly-insights.js
 */

const API_BASE = 'https://us.posthog.com';
const PROJECT_ID = '332742';
const API_KEY = process.env.POSTHOG_PERSONAL_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = 'thomaspryor/Broadwayscore';

async function phQuery(hogql) {
  const res = await fetch(`${API_BASE}/api/projects/${PROJECT_ID}/query/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
  });
  if (!res.ok) throw new Error(`PostHog API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results || [];
}

async function getTopPages() {
  return phQuery(`
    SELECT properties.$pathname AS page, count() AS views, count(DISTINCT person_id) AS users
    FROM events
    WHERE event = '$pageview' AND timestamp > now() - interval 7 day
    GROUP BY page ORDER BY views DESC LIMIT 20
  `);
}

async function getTopEvents() {
  return phQuery(`
    SELECT event, count() AS total, count(DISTINCT person_id) AS users
    FROM events
    WHERE timestamp > now() - interval 7 day
      AND event NOT IN ('$pageview', '$pageleave', '$autocapture', '$rageclick', '$feature_flag_called')
    GROUP BY event ORDER BY total DESC LIMIT 15
  `);
}

async function getTrafficSummary() {
  return phQuery(`
    SELECT
      count(DISTINCT person_id) AS unique_users,
      countIf(event = '$pageview') AS pageviews,
      countIf(event = '$session_start') AS sessions
    FROM events
    WHERE timestamp > now() - interval 7 day
  `);
}

async function getRageClicks() {
  return phQuery(`
    SELECT properties.$pathname AS page, count() AS rage_clicks
    FROM events
    WHERE event = '$rageclick' AND timestamp > now() - interval 7 day
    GROUP BY page ORDER BY rage_clicks DESC LIMIT 10
  `);
}

async function getSearchTerms() {
  return phQuery(`
    SELECT properties.query AS term, count() AS searches
    FROM events
    WHERE event = 'search_performed' AND timestamp > now() - interval 7 day
      AND properties.query IS NOT NULL AND properties.query != ''
    GROUP BY term ORDER BY searches DESC LIMIT 15
  `);
}

async function getTicketClicks() {
  return phQuery(`
    SELECT properties.show_name AS show, properties.platform AS platform, count() AS clicks
    FROM events
    WHERE event = 'ticket_link_click' AND timestamp > now() - interval 7 day
    GROUP BY show, platform ORDER BY clicks DESC LIMIT 15
  `);
}

function mdTable(headers, rows) {
  if (!rows || rows.length === 0) return '_No data_\n';
  const lines = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${row.map(v => String(v ?? '—')).join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

async function authCheck() {
  const res = await fetch(`${API_BASE}/api/projects/${PROJECT_ID}/`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`PostHog auth check failed (${res.status}): ${body}`);
    console.error('The POSTHOG_PERSONAL_API_KEY GitHub secret is likely expired or invalid.');
    process.exit(1);
  }
  console.log('PostHog auth OK');
}

async function main() {
  if (!API_KEY) { console.error('POSTHOG_PERSONAL_API_KEY not set'); process.exit(1); }

  await authCheck();

  console.log('Querying PostHog...');

  const errors = [];
  function tracked(name, fn) {
    return fn().catch(e => { errors.push(`${name}: ${e.message}`); return []; });
  }

  const [traffic, topPages, topEvents, rageClicks, searchTerms, ticketClicks] = await Promise.all([
    tracked('Traffic', getTrafficSummary),
    tracked('Top pages', getTopPages),
    tracked('Events', getTopEvents),
    tracked('Rage clicks', getRageClicks),
    tracked('Search terms', getSearchTerms),
    tracked('Ticket clicks', getTicketClicks),
  ]);

  if (errors.length > 0) {
    console.error(`${errors.length} queries failed:\n  ${errors.join('\n  ')}`);
  }
  if (errors.length === 6) {
    console.error('ALL queries failed — aborting instead of creating empty report.');
    process.exit(1);
  }

  const now = new Date();
  const weekAgo = new Date(now - 7 * 86400000);
  const dateRange = `${weekAgo.toISOString().slice(0, 10)} to ${now.toISOString().slice(0, 10)}`;

  let body = `## Weekly Analytics Summary\n**Period:** ${dateRange}\n\n`;

  // Traffic overview
  if (traffic.length > 0) {
    const [users, pageviews, sessions] = traffic[0];
    body += `### Traffic Overview\n`;
    body += `- **Unique Users:** ${Number(users).toLocaleString()}\n`;
    body += `- **Pageviews:** ${Number(pageviews).toLocaleString()}\n`;
    body += `- **Sessions:** ${Number(sessions).toLocaleString()}\n\n`;
  }

  body += `### Top Pages\n${mdTable(['Page', 'Views', 'Users'], topPages)}\n`;
  body += `### Custom Events\n${mdTable(['Event', 'Count', 'Users'], topEvents)}\n`;
  body += `### Ticket Clicks\n${mdTable(['Show', 'Platform', 'Clicks'], ticketClicks)}\n`;
  body += `### Search Terms\n${mdTable(['Query', 'Searches'], searchTerms)}\n`;
  body += `### Rage Clicks (UX friction)\n${mdTable(['Page', 'Rage Clicks'], rageClicks)}\n`;
  body += `---\n🤖 Auto-generated by PostHog Weekly Insights\n`;

  console.log('\n' + body);

  // Create GitHub issue
  if (GITHUB_TOKEN) {
    const title = `PostHog Weekly Insights — ${now.toISOString().slice(0, 10)}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title,
        body,
        labels: ['analytics', 'automated'],
      }),
    });
    if (res.ok) {
      const issue = await res.json();
      console.log(`Created issue: ${issue.html_url}`);
    } else {
      console.error(`GitHub issue creation failed: ${res.status} ${await res.text()}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
