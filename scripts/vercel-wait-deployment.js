#!/usr/bin/env node
/**
 * Wait for a Vercel deployment to reach a terminal state (BRO-2067).
 * Usage: VERCEL_TOKEN=... node scripts/vercel-wait-deployment.js <url|dpl_id> [--timeout=480]
 * Exit: 0 READY, 1 ERROR/API failure, 3 CANCELED, 4 timeout, 5 CANCELED but a newer production deployment exists (superseded). Logic: scripts/lib/vercel-deploy-wait.js
 */
const { hasHelpFlag } = require('./lib/cli-help.js');
const { waitForDeployment, hasNewerLiveDeployment, exitCodeFor, EXIT } = require('./lib/vercel-deploy-wait.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('usage: VERCEL_TOKEN=... vercel-wait-deployment.js <url|id> [--timeout=SECS]');
  process.exit(0);
}
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
if (!urlLine.trim()) { console.error('empty deployment url'); process.exit(1); }
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
  meta = { createdAt: j.createdAt, projectId: j.projectId };
  return j.readyState || j.status;
}

let meta = {};
async function newerLiveExists() {
  if (!meta.createdAt || !meta.projectId) return false;
  const res = await fetch(`https://api.vercel.com/v6/deployments?projectId=${meta.projectId}&target=production&limit=10`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  const j = await res.json();
  return hasNewerLiveDeployment(meta.createdAt, j.deployments);
}

waitForDeployment({
  fetchState,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  timeoutMs,
}).then(async r => {
  let code = exitCodeFor(r.outcome);
  if (r.outcome === 'canceled' && await newerLiveExists().catch(() => false)) code = EXIT.CANCELED_SUPERSEDED;
  console.log(`deployment ${id}: ${r.outcome} (state=${r.state}, polls=${r.polls}, exit=${code})`);
  process.exit(code);
});
