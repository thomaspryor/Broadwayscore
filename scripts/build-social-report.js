#!/usr/bin/env node
/**
 * build-social-report.js — gather the Monday email's Social section (BRO-6377).
 *
 * Usage: node scripts/build-social-report.js [--out=traffic-analysis/social-report.json] [--days=35]
 *
 * Reads Buffer's posts with their metrics (one paged GraphQL query per
 * organization; covers the image autopost lane and hand-posted videos alike),
 * posts still waiting to go out, the autopost ledger and show data (for the
 * score posts due this week and why others did not post), and PostHog visits
 * that came from a post, then writes
 * the report from scripts/lib/social-report.js.
 *
 * Never fails the workflow: on any error it writes {generatedAt, error} and
 * exits 0, and the email says the social numbers are unavailable this week.
 *
 * Env: BUFFER_API_KEY, POSTHOG_PERSONAL_API_KEY
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
require('./lib/load-env').loadEnv();
const { gql, rateLimit } = require('./social-autopost/buffer');
const { phQuery, REAL_USERS_WHERE } = require('./lib/posthog-query');
const { buildSocialReport } = require('./lib/social-report');
const { loadContext } = require('./social-autopost/run');

const PAGE_SIZE = 100;
const MAX_PAGES = 15; // 1500 posts; the account sends ~25 a day at most

async function fetchOrgIds() {
  const data = await gql('query { account { organizations { id } } }');
  return data.account.organizations.map((o) => o.id);
}

// Not yet sent: scheduled, queued or awaiting approval. Filtered by what it is
// not, because sent, error and draft are the only statuses checked live.
const NOT_PENDING = new Set(['sent', 'error', 'draft']);

/**
 * Every post created since sinceIso, in one paged query per organization, split
 * into sent (with metrics) and still to go out. One query for both keeps the
 * report to ~20 calls of the 250-a-day Buffer allowance the autopost shares.
 */
async function fetchPosts(orgIds, sinceIso) {
  const sent = [];
  const pending = [];
  for (const orgId of orgIds) {
    let after = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await gql(`query Posts($input: PostsInput!, $after: String) {
        posts(input: $input, first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { id text status sentAt dueAt externalLink channel { service } assets { __typename } metrics { type value } } }
        }
      }`, { input: { organizationId: orgId, filter: { createdAt: { start: sinceIso } } }, after });
      for (const { node } of d.posts.edges) {
        const status = String(node.status || '').toLowerCase();
        const service = node.channel && node.channel.service;
        if (status === 'sent' && node.sentAt) {
          sent.push({
            id: node.id,
            text: node.text,
            sentAt: node.sentAt,
            externalLink: node.externalLink,
            service,
            isVideo: (node.assets || []).some((x) => x.__typename === 'VideoAsset'),
            metrics: node.metrics || [],
          });
        } else if (!NOT_PENDING.has(status)) {
          pending.push({ id: node.id, text: node.text, dueAt: node.dueAt, service });
        }
      }
      if (!d.posts.pageInfo.hasNextPage) break;
      if (page === MAX_PAGES - 1) console.log(`::warning::Buffer has more than ${MAX_PAGES * PAGE_SIZE} posts in the window; the report counts the first ${MAX_PAGES * PAGE_SIZE} only`);
      after = d.posts.pageInfo.endCursor;
    }
  }
  return { sent, pending };
}

async function fetchVisits(days) {
  const base = `event = '$pageview' AND timestamp > now() - INTERVAL ${days} DAY AND ${REAL_USERS_WHERE}`;
  // Explicit LIMITs: HogQL silently caps GROUP BY results at ~100 rows.
  // Days in UTC to match Buffer's sentAt (the PostHog project clock is not UTC).
  const day = "toString(toDate(toTimeZone(timestamp, 'UTC')))";
  const utm = await phQuery(`SELECT properties.utm_source, properties.$pathname, ${day}, properties.utm_campaign, count()
    FROM events WHERE ${base} AND properties.utm_campaign IN ('autopost', 'brief') AND properties.$pathname LIKE '/show/%'
    GROUP BY 1, 2, 3, 4 LIMIT 5000`);
  // A click from /links to a show page, with the network tag the visitor reached
  // /links with in the same session (each profile's bio link has its own).
  const bio = await phQuery(`SELECT s.path, s.day, coalesce(l.src, 'none'), count()
    FROM (SELECT $session_id AS sid, properties.$pathname AS path, ${day} AS day
      FROM events WHERE ${base} AND properties.$prev_pageview_pathname = '/links' AND properties.$pathname LIKE '/show/%') AS s
    LEFT JOIN (SELECT $session_id AS sid, max(properties.utm_source) AS src
      FROM events WHERE ${base} AND properties.$pathname = '/links' GROUP BY sid) AS l ON s.sid = l.sid
    GROUP BY 1, 2, 3 LIMIT 5000`);
  const page = await phQuery(`SELECT coalesce(properties.utm_source, 'none'), count()
    FROM events WHERE event = '$pageview' AND timestamp > now() - INTERVAL 7 DAY AND ${REAL_USERS_WHERE} AND properties.$pathname = '/links'
    GROUP BY 1 LIMIT 100`);
  return {
    utmRows: utm.map(([source, p, day, campaign, views]) => ({ source, path: p, day, campaign, views })),
    bioRows: bio.map(([p, d, source, views]) => ({ source, path: p, day: d, views })),
    bioPageViews: page.map(([source, views]) => ({ source, views })),
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
  const out = typeof args.out === 'string' ? args.out : 'traffic-analysis/social-report.json';
  const days = Number(args.days) || 35;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const now = Date.now();
  let report;
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'social-autopost-ledger.json'), 'utf8'));
    const orgIds = await fetchOrgIds();
    const { sent: bufferPosts, pending: scheduled } = await fetchPosts(orgIds, new Date(now - days * 86400000).toISOString());
    const visits = await fetchVisits(days);
    // Shows, reviews and the site's scores, for the score posts due this week
    // and the reasons others did not post. Without core data those two lists
    // are left out and the rest of the section still goes out.
    let ctx = null;
    try { ctx = loadContext(); } catch (e) { console.log(`::warning::social report: no show data (${e.message}); leaving out upcoming score posts and skips`); }
    report = buildSocialReport({ bufferPosts, ledger, ...visits, scheduled, ctx, now });
    const w = report.weekly;
    console.log(`[social] ${bufferPosts.length} sent posts in ${days} days, ${w.posts.length} this week; ${w.takeaway}`);
    console.log(`[social] ${scheduled.length} not yet sent in Buffer; ${w.upcoming.length} coming up, ${w.skipped.length} skipped or waiting; timing: ${w.timing[0]}`);
  } catch (e) {
    console.log(`::warning::social report unavailable: ${e.message}`);
    report = { generatedAt: new Date(now).toISOString(), error: e.message.slice(0, 300) };
  }
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const q = rateLimit();
  if (q && q.remaining != null) console.log(`[social] Buffer quota left: ${q.remaining} calls (shared with the autopost job)`);
  console.log(`[social] wrote ${out}`);
}

main();
