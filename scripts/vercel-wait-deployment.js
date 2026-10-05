#!/usr/bin/env node
/**
 * Wait for a Vercel deployment to reach a terminal state (BRO-2067).
 * Usage: VERCEL_TOKEN=... node scripts/vercel-wait-deployment.js <url|dpl_id> [--timeout=480]
 * Exit: 0 READY, 1 ERROR/API failure, 3 CANCELED, 4 timeout. Logic: scripts/lib/vercel-deploy-wait.js
 */
const { waitForDeployment, exitCodeFor } = require('./lib/vercel-deploy-wait.js');

const arg = process.argv.slice(2).find(a => !a.startsWith('--'));
const tArg = process.argv.find(a => a.startsWith('--timeout='));
const timeoutMs = (tArg ? parseInt(tArg.slice(10), 10) : 480) * 1000;
const token = process.env.VERCEL_TOKEN;
if (!arg || !token) {
  console.error('usage: VERCEL_TOKEN=... vercel-wait-deployment.js <url|id> [--timeout=SECS]');
  process.exit(1);
}
// --no-wait should print only the URL; take the last https:// line defensively.
const urlLine = arg.split(/\s+/).filter(l => /^https?:\/\//.test(l)).pop() || arg.trim();
const id = urlLine.replace(/^https?:\/\//, '');

async function fetchState() {
  const res = await fetch(`https://api.vercel.com/v13/deployments/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const e = new Error(`Vercel API ${res.status}`);
    e.status = res.status;
    e.fatal = res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429;
    throw e;
  }
  const j = await res.json();
  return j.readyState || j.status;
}

waitForDeployment({
  fetchState,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  timeoutMs,
}).then(r => {
  console.log(`deployment ${id}: ${r.outcome} (state=${r.state}, polls=${r.polls})`);
  process.exit(exitCodeFor(r.outcome));
});
