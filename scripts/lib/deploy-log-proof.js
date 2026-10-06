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
 *   `deployment <host>: ready (state=READY, …)`
 *                                      scripts/vercel-wait-deployment.js, once
 *                                      the `--prod --no-wait` deployment is
 *                                      READY (Vercel moves the production
 *                                      domains to a --prod deployment then).
 *                                      Logs from before BRO-2067 (2026-10-05)
 *                                      have the Vercel CLI's `Aliased: https://…`
 *                                      instead; that still counts.
 *   `Deployed to production: https://…` the workflow's own echo, reached only
 *                                      when that deployment reached READY
 * The READY line must name the same host as the echoed URL: a retried deploy
 * logs one line per attempt. The workflow source is also echoed into the log
 * (`echo "Deployed to production: $URL"`), so a match must be a real https
 * URL, not `$URL`.
 *
 * Weaker than the Vercel API: it only sees deploys this workflow made, so a
 * rollback or promote from the Vercel dashboard is invisible to it. The test
 * pins DEPLOY_JOB, DEPLOY_ECHO, WAIT_CALL and the wait script's READY line to
 * their sources, so changing how the deploy reports fails CI instead of
 * silently breaking the fallback (BRO-4778: going --no-wait dropped the
 * `Aliased:` line and every cloud check came back empty for a day).
 */

const DEPLOY_JOB = 'deploy';
const DEPLOY_ECHO = 'echo "Deployed to production: $URL"';
const WAIT_CALL = 'node scripts/vercel-wait-deployment.js "$URL"';
const READY = /\bdeployment (\S+): ready \(state=READY\b/;
// The deploy cron fires every 5 min; a listing whose newest run is older than
// this is a stale page (seen 2026-10-05: the same request returned September
// runs, then current ones seconds later).
const STALE_LISTING_MS = 60 * 60_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) /;

function prodProofFromLog(log) {
  let aliasedAt = null;
  const readyAt = new Map(); // host -> when the wait script saw it READY
  let url = null;
  for (const raw of String(log || '').split('\n')) {
    const line = raw.replace(ANSI, '');
    const ts = (line.match(TS) || [])[1];
    // Pre-BRO-2067 logs only (one Aliased: per run). Those logs expire from
    // GitHub by 2027-01-04; this branch and its test can go then.
    const alias = line.match(/\bAliased: https:\/\/\S+/);
    if (alias && ts) aliasedAt = Date.parse(ts);
    const ready = line.match(READY);
    if (ready && ts) readyAt.set(ready[1], Date.parse(ts));
    const dep = line.match(/\bDeployed to production: (https:\/\/[^\s"]+)/);
    if (dep) url = dep[1];
  }
  if (!url) return null;
  const host = url.replace(/^https:\/\//, '');
  const provenAt = readyAt.has(host) ? readyAt.get(host) : aliasedAt;
  if (provenAt == null) return null;
  return { url: host, provenAtMs: provenAt };
}

function listingLooksStale(runs, nowMs, maxAgeMs = STALE_LISTING_MS) {
  const newest = Math.max(...(runs || []).map((r) => Date.parse(r.created_at)).filter(Number.isFinite));
  return !Number.isFinite(newest) || nowMs - newest > maxAgeMs;
}

module.exports = { prodProofFromLog, listingLooksStale, DEPLOY_JOB, DEPLOY_ECHO, WAIT_CALL, READY, STALE_LISTING_MS };
