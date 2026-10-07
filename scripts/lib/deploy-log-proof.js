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
 *                                      READY. That is the token path's test too
 *                                      (latest READY production deployment);
 *                                      neither sees a failed domain assignment.
 *   `Deployed to production: https://…` the workflow's own echo, reached only
 *                                      after that READY
 * The retry loop stops at the first READY, so a log has at most one; earlier
 * attempts print canceled/timeout/error lines. The READY host should equal the
 * echoed one, but the two read $URL differently (the wait script takes its last
 * https line, the echo shows the first), so a lone READY before the echo also
 * counts and names the deployment. The workflow source is also echoed into the
 * log (`echo "Deployed to production: $URL"`), so a match must be a real https
 * URL, not `$URL`. Logs from before BRO-2067 (2026-10-05) have no READY line
 * and are proven by the Vercel CLI's `Aliased: https://…` instead.
 *
 * Weaker than the Vercel API: it only sees deploys this workflow made, so a
 * rollback or promote from the Vercel dashboard is invisible to it, and the
 * READY time is when a 10 s poll saw it, so two overlapping deploys that go
 * READY within a poll of each other can be ordered wrongly. The test
 * pins DEPLOY_JOB, DEPLOY_ECHO, WAIT_CALL and the wait script's READY line to
 * their sources, so changing how the deploy reports fails CI instead of
 * silently breaking the fallback (BRO-4778: going --no-wait dropped the
 * `Aliased:` line and every cloud check came back empty for a day).
 */

const DEPLOY_JOB = 'deploy';
const DEPLOY_ECHO = 'echo "Deployed to production: $URL"';
const WAIT_CALL = 'node scripts/vercel-wait-deployment.js';
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
  const readies = []; // { host, at, n } in log order
  let echoed = null; // { host, n }
  String(log || '').split('\n').forEach((raw, n) => {
    const line = raw.replace(ANSI, '');
    const ts = (line.match(TS) || [])[1];
    // Pre-BRO-2067 logs only (one Aliased: per run). Those logs expire from
    // GitHub by 2027-01-04; this branch and its test can go then.
    const alias = line.match(/\bAliased: https:\/\/\S+/);
    if (alias && ts) aliasedAt = Date.parse(ts);
    const ready = line.match(READY);
    if (ready && ts) readies.push({ host: ready[1], at: Date.parse(ts), n });
    const dep = line.match(/\bDeployed to production: https:\/\/([^\s"]+)/);
    if (dep) echoed = { host: dep[1], n };
  });
  if (!echoed) return null;
  if (readies.length === 0) {
    return aliasedAt == null ? null : { url: echoed.host, provenAtMs: aliasedAt };
  }
  const match = readies.find((r) => r.host === echoed.host)
    || (readies.length === 1 && readies[0].n < echoed.n ? readies[0] : null);
  return match ? { url: match.host, provenAtMs: match.at } : null;
}

function listingLooksStale(runs, nowMs, maxAgeMs = STALE_LISTING_MS) {
  const newest = Math.max(...(runs || []).map((r) => Date.parse(r.created_at)).filter(Number.isFinite));
  return !Number.isFinite(newest) || nowMs - newest > maxAgeMs;
}

module.exports = { prodProofFromLog, listingLooksStale, DEPLOY_JOB, DEPLOY_ECHO, WAIT_CALL, READY, STALE_LISTING_MS };
