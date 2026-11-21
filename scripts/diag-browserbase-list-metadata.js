#!/usr/bin/env node
/**
 * diag-browserbase-list-metadata.js — does Browserbase's session LIST echo
 * userMetadata? (read-only, creates no session, spends nothing)
 *
 * The per-caller allowance (browserbase-caps.js CALLER_ALLOWANCES) counts a
 * caller's trailing-24h sessions from that list by userMetadata.caller, and
 * refuses when the list carries none. Run from a cloud session:
 *   node scripts/cloud-run-script.js scripts/diag-browserbase-list-metadata.js
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { fetchLiveBrowserbaseSessionList, countRecentSessionsForCaller } = require('./lib/browserbase-live-usage');

const USAGE = 'Usage: node scripts/diag-browserbase-list-metadata.js';
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

async function main() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    console.log('no BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID in this environment');
    process.exit(2);
  }
  const data = await fetchLiveBrowserbaseSessionList(apiKey, projectId);
  if (data === null) { console.log('session list request failed'); process.exit(1); }
  const items = Array.isArray(data) ? data : (data && data.data) || [];
  const withMeta = items.filter(s => s && s.userMetadata && typeof s.userMetadata === 'object');
  const byCaller = {};
  for (const s of withMeta) byCaller[s.userMetadata.caller || '(none)'] = (byCaller[s.userMetadata.caller || '(none)'] || 0) + 1;
  console.log(`sessions in list: ${items.length}; with userMetadata: ${withMeta.length}`);
  console.log(`item keys: ${items[0] ? Object.keys(items[0]).sort().join(',') : '(empty)'}`);
  console.log(`by caller: ${JSON.stringify(byCaller)}`);
  console.log(`probe sessions last 24h: ${countRecentSessionsForCaller(data, 'probe-talkinbroadway-browserbase.js')}`);
  process.exit(withMeta.length > 0 || items.length === 0 ? 0 : 1);
}

main().catch(err => { console.log(`error: ${err.message}`); process.exit(1); });
