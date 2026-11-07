#!/usr/bin/env node
'use strict';
// Read-only: how many email signups carry a city tag (BRO-6912). Counts only, no emails.
// Usage: node scripts/signup-city-report.js [--days=30] [--min=N]
//   --min=N  exit 1 unless at least N tagged signups were found (post-deploy recheck).
// Env: FORMSPREE_TOKEN, FORMSPREE_SUBSCRIBER_FORM_ID, FORMSPREE_FOLLOW_FORM_ID
const { fetchAllSubmissions } = require('./sync-followers');
const { countByCity } = require('./lib/signup-city-counts');

const arg = (n, d) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=')[1] : d; };

async function main() {
  const token = process.env.FORMSPREE_TOKEN;
  const forms = { subscriber: process.env.FORMSPREE_SUBSCRIBER_FORM_ID, follow: process.env.FORMSPREE_FOLLOW_FORM_ID };
  if (!token) { console.error('FORMSPREE_TOKEN is not set'); process.exit(2); }
  const since = new Date(Date.now() - Number(arg('days', 30)) * 864e5).toISOString();
  let tagged = 0;
  for (const [label, id] of Object.entries(forms)) {
    if (!id) { console.log(`${label}: form id not set, skipped`); continue; }
    const r = await fetchAllSubmissions(id, token, since);
    if (!r) { console.log(`${label}: fetch failed`); process.exit(2); }
    const c = countByCity(r.items);
    tagged += c.tagged;
    console.log(`${label}: ${c.total} signups since ${since.slice(0, 10)}, ${c.tagged} with a city ${JSON.stringify(c.byCity)}${r.complete ? '' : ' (partial)'}`);
  }
  const min = Number(arg('min', 0));
  if (min && tagged < min) { console.log(`FAIL: ${tagged} city-tagged signups, expected at least ${min}`); process.exit(1); }
}
main().catch(e => { console.error(e.message); process.exit(2); });
