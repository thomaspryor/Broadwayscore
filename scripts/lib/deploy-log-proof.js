'use strict';

/**
 * deploy-log-proof.js — pure: does a vercel-deploy.yml `deploy` job log prove
 * that run's build was aliased to production?
 *
 * check-prod-deploy.js reads Vercel's latest READY production deployment, which
 * needs VERCEL_TOKEN. Cloud sessions don't have it, so they improvised (twice
 * on 2026-10-05) by reading the deploy job's log by hand. This encodes that.
 *
 * A green run alone is not proof (2026-06-26: green runs whose Vercel deploys
 * were CANCELED). The proof is two lines the run printed itself:
 *   `Aliased: https://…`               the Vercel CLI, only after the deployment
 *                                      is READY and the production alias moved
 *   `Deployed to production: https://…` the workflow's own echo, reached only
 *                                      when `vercel deploy --prod` exited 0
 * The workflow source is also echoed into the log (`echo "Deployed to
 * production: $URL"`), so a match must be a real https URL, not `$URL`.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

function prodAliasFromLog(log) {
  let aliasedAt = null;
  let url = null;
  for (const raw of String(log || '').split('\n')) {
    const line = raw.replace(ANSI, '');
    const ts = (line.match(TS) || [])[1];
    const alias = line.match(/\bAliased: https:\/\/\S+/);
    if (alias && ts) aliasedAt = Date.parse(ts);
    const dep = line.match(/\bDeployed to production: (https:\/\/[^\s"]+)/);
    if (dep) url = dep[1];
  }
  if (aliasedAt == null || !url) return null;
  return { url: url.replace(/^https:\/\//, ''), aliasedAtMs: aliasedAt };
}

module.exports = { prodAliasFromLog };
