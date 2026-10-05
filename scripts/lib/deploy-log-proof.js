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
 *
 * Weaker than the Vercel API: it only sees deploys this workflow made, so a
 * rollback or promote from the Vercel dashboard is invisible to it. The test
 * pins DEPLOY_JOB and DEPLOY_ECHO to vercel-deploy.yml so a rename fails CI
 * instead of silently breaking the fallback.
 */

const DEPLOY_JOB = 'deploy';
const DEPLOY_ECHO = 'echo "Deployed to production: $URL"';
// The deploy cron fires every 5 min; a listing whose newest run is older than
// this is a stale page (seen 2026-10-05: the same request returned September
// runs, then current ones seconds later).
const STALE_LISTING_MS = 60 * 60_000;

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

function listingLooksStale(runs, nowMs, maxAgeMs = STALE_LISTING_MS) {
  const newest = Math.max(...(runs || []).map((r) => Date.parse(r.created_at)).filter(Number.isFinite));
  return !Number.isFinite(newest) || nowMs - newest > maxAgeMs;
}

module.exports = { prodAliasFromLog, listingLooksStale, DEPLOY_JOB, DEPLOY_ECHO, STALE_LISTING_MS };
