#!/usr/bin/env node
/**
 * route-workflow-alerts.js — routes four scheduled workflows' alerts through
 * routeAlert() instead of `gh issue create` (BRO-6397).
 *
 * Those GitHub issues were never read. Each alert now has a stable
 * conditionKey, so a repeat of one open incident is silent and a clear run
 * resolves it (same pattern as route-cost-report-alerts.js, BRO-6391).
 *
 *   lighthouse-regression   auto + dispatchAtFiling (technical regression)
 *   opening-night-stage     auto + dispatchAtFiling (data-flow race)
 *   tony-ibdb-scraper       digest (needs a headed browser on the owner's Mac)
 *   gitlab-token-failed     auto + dispatchAtFiling (rotation step broke)
 *   gitlab-token-expired    human (a person must mint a new token; reaches the morning digest, not a page, since it is not in page-worthy-alerts.js)
 *
 * Usage: node scripts/route-workflow-alerts.js route|resolve <kind>
 * Env: GITHUB_RUN_ID, GITHUB_SERVER_URL, GITHUB_REPOSITORY, plus per kind
 *   LIGHTHOUSE_BODY_FILE, INPUT_YEAR.
 * Exit: 0 ok · 2 usage · 3 no card was filed (check LINEAR_API_KEY).
 */
'use strict';

const fs = require('fs');

const KINDS = Object.freeze({
  'lighthouse-regression': 'workflow-alert:lighthouse-regression',
  'opening-night-stage': 'workflow-alert:opening-night-stage-latency',
  'tony-ibdb-scraper': 'workflow-alert:tony-ibdb-scraper',
  'gitlab-token-failed': 'workflow-alert:gitlab-token-rotation-failed',
  'gitlab-token-expired': 'workflow-alert:gitlab-token-expired',
});

function runUrlFromEnv(env) {
  if (!env.GITHUB_RUN_ID || !env.GITHUB_REPOSITORY) return null;
  return `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

/**
 * PURE. The routeAlert() options for one kind (without dispatchAtFiling).
 * `readFile` is injectable so the Lighthouse body can be tested.
 */
function buildAlert(kind, env = {}, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const conditionKey = KINDS[kind];
  if (!conditionKey) throw new Error(`unknown alert kind "${kind}"`);
  const runUrl = runUrlFromEnv(env);
  const runLine = runUrl ? `\n\nRun: ${runUrl}` : '';
  const base = { conditionKey, severity: 'error', cooldownHours: 24, ...(runUrl ? { url: runUrl } : {}) };
  switch (kind) {
    case 'lighthouse-regression': {
      let body = '';
      try { body = env.LIGHTHOUSE_BODY_FILE ? readFile(env.LIGHTHOUSE_BODY_FILE) : ''; } catch { body = ''; }
      return {
        ...base,
        title: 'Lighthouse regression detected on broadwayscorecard.com',
        description: `${body.trim() || 'Lighthouse scores fell below thresholds (Perf 70, A11y 90, BP 80, SEO 90).'}${runLine}`,
        hint: 'Find the page and category below threshold in the table, then the change that caused it.',
        disposition: 'auto',
        cardAction: 'Investigate',
        dispatchAtFiling: true,
      };
    }
    case 'opening-night-stage':
      return {
        ...base,
        title: 'Opening-night stage-latency alert: scored entries missing',
        description: 'Shows opened in the last 48h have no `scored` entry in data/audit/stage-latency.jsonl (bucket D data-flow race). Broadcasts likely fired against stale data. The workflow log names the show IDs. '
          + 'Fix options: re-dispatch opening-night-orchestrator.yml with the affected show_id; check rebuild-reviews.yml completed and emitted stage entries; run node scripts/rebuild-all-reviews.js and push.'
          + runLine,
        disposition: 'auto',
        cardAction: 'Investigate',
        dispatchAtFiling: true,
      };
    case 'tony-ibdb-scraper': {
      const year = env.INPUT_YEAR || String(new Date().getUTCFullYear());
      return {
        ...base,
        severity: 'warning',
        title: `Run Tony nominations IBDB scraper for ${year}`,
        description: 'The Wikipedia Tony scraper committed new data to awards.json. The IBDB person-level scraper needs a headed Playwright browser (IBDB is behind Cloudflare), so it runs on the Mac: '
          + '`git pull`, `node scripts/scrape-tony-nominees.js --missing`, `node scripts/verify-tony-data.js`, then commit data/tony-nominations.json.' + runLine,
        disposition: 'digest',
      };
    }
    case 'gitlab-token-failed':
      return {
        ...base,
        title: 'GitLab mirror token rotation failed',
        description: 'rotate-gitlab-token.yml failed. The GitLab mirror may stop syncing when the current token expires. If rotation succeeded but the secret update failed, the old token is dead and a new one must be minted by hand (see the GitLab token expired alert).' + runLine,
        disposition: 'auto',
        cardAction: 'Investigate',
        dispatchAtFiling: true,
      };
    case 'gitlab-token-expired':
      return {
        ...base,
        title: 'GitLab mirror token has expired',
        description: 'GITLAB_MIRROR_TOKEN is expired or invalid; automatic rotation cannot help and the GitLab mirror is NOT syncing. Owner action: create a token at https://gitlab.com/-/user_settings/personal_access_tokens with api scope and 1 year expiry, and save it as the repository secret GITLAB_MIRROR_TOKEN.' + runLine,
        disposition: 'human',
        cardAction: 'Rotate token',
      };
    default:
      throw new Error(`unknown alert kind "${kind}"`);
  }
}

/**
 * Route or resolve one kind. Injectable `router` ({ routeAlert,
 * resolveCondition }); routeAlert resolves { linearIdentifier, dispatchOk }
 * and does not throw on a dispatch failure.
 * @returns {Promise<{ok:boolean, result?:object}>}
 */
async function run({ mode, kind, env = {}, router, log = console.log, readFile }) {
  const conditionKey = KINDS[kind];
  if (!conditionKey) throw new Error(`unknown alert kind "${kind}"`);
  if (mode === 'resolve') {
    try {
      const done = router.resolveCondition(conditionKey, { reason: 'clear in latest run' });
      log(`[workflow-alerts] ${kind}: ${done ? 'resolved' : 'nothing open'}`);
    } catch (err) {
      log(`[workflow-alerts] resolve ${kind} failed: ${err.message}`);
    }
    return { ok: true };
  }
  const opts = buildAlert(kind, env, readFile);
  if (opts.dispatchAtFiling) {
    opts.dispatchAtFiling = env.GITHUB_RUN_ID ? { runId: env.GITHUB_RUN_ID, runUrl: runUrlFromEnv(env) } : true;
  }
  let r;
  try {
    r = await router.routeAlert(opts);
  } catch (err) {
    log(`[workflow-alerts] routeAlert threw for ${kind}: ${err.message}`);
    return { ok: false };
  }
  log(`[workflow-alerts] ${kind}: ${r && r.action} ${(r && r.linearIdentifier) || '(no card)'}`);
  // 'digest' and 'human' file no card; only 'auto' must come back with one.
  const needsCard = opts.disposition === 'auto';
  const ok = !!r && (!needsCard || (!!r.linearIdentifier && r.dispatchOk !== false));
  return { ok, result: r };
}

const USAGE = 'usage: node scripts/route-workflow-alerts.js route|resolve <' + Object.keys(KINDS).join('|') + '>';

async function main(argv = process.argv.slice(2), env = process.env) {
  const [mode, kind] = argv;
  if (!['route', 'resolve'].includes(mode) || !KINDS[kind]) {
    console.error(USAGE);
    return 2;
  }
  const { ok } = await run({ mode, kind, env, router: require('./lib/owner-alert-router.js') });
  if (!ok) {
    console.error(`::error::${kind} alert has no worker card (check LINEAR_API_KEY)`);
    return 3;
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(3); });
}

module.exports = { KINDS, buildAlert, run, main };
