#!/usr/bin/env node
/**
 * Live check of the digest "Fix this" endpoint (BRO-5170): builds a correctly
 * signed dispatch link and POSTs it, the same request the confirm button sends.
 * Prints the page title the site returned; exits 1 on "Configuration Error"
 * (APPROVAL_HMAC_SECRET or LINEAR_API_KEY missing from the deployment) or on
 * "Invalid Link" (this job's secret does not match the site's).
 *
 * A POST that gets past the config checks files a Linear issue unless an open
 * one already carries the condition anchor. So the probe first asks Linear for
 * an open issue whose description holds "[conditionKey:<key>]" and refuses to
 * POST without one; the route then answers "Already Being Fixed", which proves
 * both keys work. Create that anchor issue parked, cancel it afterwards.
 *
 * Usage: APPROVAL_HMAC_SECRET=... LINEAR_API_KEY=... node scripts/lib/probe-dispatch-link.js --condition-key=<key>
 *          [--base-url=https://broadwayscorecard.com] [--expect="Already Being Fixed"]
 */

'use strict';

require('./cli-help').exitOnHelp(module);

const { buildDispatchUrl } = require('./dispatch-link.js');
const { graphql } = require('./linear-client.js');
const { TEAM_KEY, TERMINAL_STATE_TYPES, conditionAnchor, conditionSearchPrefix, hasConditionAnchor } = require('../../src/lib/linear-dispatch-issue.js');

// Same filter the route's dedup uses (route.ts queryConditionIssues).
async function openAnchorIssues(conditionKey) {
  const data = await graphql(
    `query($teamKey: String!, $anchor: String!, $terminal: [String!]) {
      issues(first: 5, filter: { team: { key: { eq: $teamKey } }, description: { contains: $anchor }, state: { type: { nin: $terminal } } }) {
        nodes { identifier description }
      }
    }`,
    { teamKey: TEAM_KEY, anchor: conditionSearchPrefix(conditionKey), terminal: TERMINAL_STATE_TYPES },
  );
  return (data?.issues?.nodes || [])
    .filter(n => hasConditionAnchor(n.description, conditionKey))
    .map(n => n.identifier);
}

function arg(argv, name, fallback) {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : fallback;
}

function pageTitle(html) {
  const m = /<title>([^<]*?)(?: - Broadway Scorecard)?<\/title>/i.exec(html || '');
  return m ? m[1].trim() : '';
}

async function main(argv = process.argv.slice(2)) {
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('APPROVAL_HMAC_SECRET is not set'); return 1; }
  const conditionKey = arg(argv, 'condition-key');
  if (!conditionKey) { console.error('--condition-key is required'); return 1; }
  const baseUrl = arg(argv, 'base-url', 'https://broadwayscorecard.com');
  const expect = arg(argv, 'expect', '');
  if (!process.env.LINEAR_API_KEY) { console.error('LINEAR_API_KEY is not set (needed to confirm the anchor issue)'); return 1; }
  const anchors = await openAnchorIssues(conditionKey);
  if (!anchors.length) {
    console.error(`no open Linear issue holds ${conditionAnchor(conditionKey)}; refusing to POST (it would file real work)`);
    return 1;
  }
  console.log(`anchor issue(s): ${anchors.join(', ')}`);
  const url = buildDispatchUrl({
    conditionKey,
    title: `Live probe ${conditionKey} (safe to ignore)`,
    description: 'Automated check that the Fix-this endpoint is configured. Not real work.',
    exp: Math.floor(Date.now() / 1000) + 600,
    secret,
    baseUrl,
  });
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), method: 'POST', redirect: 'manual' });
  const title = pageTitle(await res.text());
  console.log(`POST /api/autonomous-action -> HTTP ${res.status}, page title "${title}"`);
  // Invalid Link means this job's secret differs from the site's, so the probe
  // proved nothing; treat it as a failure too.
  if (['Configuration Error', 'Invalid Link', 'Link Expired', ''].includes(title)) return 1;
  if (expect && title !== expect) {
    console.log(`expected "${expect}"`);
    return 1;
  }
  return 0;
}

module.exports = { pageTitle };

if (require.main === module) {
  main().then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
}
