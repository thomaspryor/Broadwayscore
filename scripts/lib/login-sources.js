'use strict';

/**
 * login-sources.js (BRO-5669): data sources that stop updating when an
 * owner-held login (session token, refresh token, outlet cookies) expires.
 *
 * Mezzanine audience data sat frozen for 14 days (401 on every run) and the
 * morning digest showed it only as a decision line under a subject that said
 * "all with automation". Only the owner can renew a login, so a source whose
 * workflow has stopped succeeding is a visitors-affected item: it goes in the
 * subject and the top block with a days-frozen count and a fix link, and no
 * autofix row can mark it handled (autonomous-email-render.js buildOwnerView).
 *
 * Add a new owner-login-dependent source by adding one entry to LOGIN_SOURCES.
 */

const LOGIN_SOURCES = [
  {
    id: 'mezzanine',
    name: 'Mezzanine ratings',
    workflow: 'update-mezzanine.yml',
    // The nightly cron only runs the resolver job: the scrape job is skipped
    // and the run still concludes "success" (ghFetchRuns marks those
    // scrapeSkipped), so such runs say nothing about the token.
    scrapeJob: 'scrape-mezzanine',
    countsRun: (r) => !r.scrapeSkipped,
    fixUrl: 'https://linear.app/broadway-scorecard/issue/BRO-5235',
  },
  {
    id: 'theatr',
    name: 'Theatr ratings',
    workflow: 'update-theatr.yml',
    fixUrl: 'https://github.com/thomaspryor/Broadwayscore/actions/workflows/rotate-theatr-token.yml',
  },
  {
    id: 'outlet-cookies',
    name: 'Review outlet logins',
    workflow: 'check-cookie-health.yml',
    fixUrl: 'https://github.com/thomaspryor/Broadwayscore/actions/workflows/check-cookie-health.yml',
  },
];

const DEFAULT_MAX_STALE_DAYS = 3;
const DAY_MS = 86400000;

// runs: [{ conclusion, createdAt, event? }] newest first (gh run list --json).
// Frozen = the newest completed run failed AND nothing has succeeded for more
// than maxStaleDays (or ever, within the window). A failure after a recent
// success is a transient blip, not a login problem.
function assessLoginSource(source, runs, now = new Date(), { maxStaleDays = DEFAULT_MAX_STALE_DAYS } = {}) {
  const counts = typeof source.countsRun === 'function' ? source.countsRun : () => true;
  const done = (Array.isArray(runs) ? runs : []).filter((r) => r && r.conclusion && r.createdAt && counts(r));
  if (!done.length) return null; // no evidence: not claimed either way
  const latest = done[0];
  if (latest.conclusion !== 'failure') return null; // success, or cancelled/skipped: not an auth signal
  // Two failed runs in a row: one failure is as likely a network blip.
  if (done[1] && done[1].conclusion !== 'failure') return null;
  if (!done[1]) return null;
  const lastOk = done.find((r) => r.conclusion === 'success');
  const since = lastOk ? new Date(lastOk.createdAt) : new Date(done[done.length - 1].createdAt);
  const days = Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  if (days <= maxStaleDays) return null;
  return {
    id: source.id,
    name: `Login expired: ${source.name} frozen ${days} day${days === 1 ? '' : 's'}`,
    message: `${source.name}: ${source.workflow} has failed on every run for ${days} days; the stored login needs renewing by the owner.`,
    hint: source.fixUrl,
    fixUrl: source.fixUrl,
    loginSource: true,
    days,
  };
}

// fetchRuns(workflow, source) -> runs[] or throws. Fail-soft per source.
function findFrozenLoginSources({ fetchRuns, now = new Date(), sources = LOGIN_SOURCES } = {}) {
  const out = [];
  const errors = [];
  for (const src of sources) {
    try {
      const row = assessLoginSource(src, fetchRuns(src.workflow, src), now, { maxStaleDays: src.maxStaleDays });
      if (row) out.push(row);
    } catch (err) {
      errors.push(`${src.id}: ${String(err.message).slice(0, 100)}`);
    }
  }
  // Longest-frozen first so the subject names the worst one.
  out.sort((a, b) => b.days - a.days);
  return { rows: out, errors };
}

function ghFetchRuns(workflow, source = {}) {
  const { execFileSync } = require('child_process');
  const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const runs = gh(['run', 'list', '--workflow', workflow, '--limit', '100', '--json', 'conclusion,createdAt,databaseId']);
  if (source.scrapeJob) {
    // Successful runs only: a failed run did run the job. Cap the calls (one lookup per run, stops at the first real success); the
    // verdict needs two counted runs, so a short walk is enough.
    let looked = 0;
    for (const r of runs) {
      if (r.conclusion !== 'success' || looked >= 40) continue;
      looked++;
      const jobs = gh(['run', 'view', String(r.databaseId), '--json', 'jobs']).jobs || [];
      const j = jobs.find((x) => x.name === source.scrapeJob);
      if (j && j.conclusion === 'skipped') r.scrapeSkipped = true;
      else break; // first real success found; older runs cannot change the verdict
    }
  }
  return runs;
}

// Folds frozen rows into sections.health.errors, ahead of every other error.
function injectLoginRows(sections, rows) {
  if (!rows.length) return sections;
  if (!sections.health) sections.health = {};
  if (!Array.isArray(sections.health.errors)) sections.health.errors = [];
  sections.health.errors = [
    ...rows.map(({ name, message, hint, fixUrl, loginSource }) => ({ name, message, hint, fixUrl, loginSource })),
    ...sections.health.errors.filter((e) => !rows.some((r) => r.name === e.name)),
  ];
  return sections;
}

module.exports = { LOGIN_SOURCES, assessLoginSource, findFrozenLoginSources, ghFetchRuns, injectLoginRows, DEFAULT_MAX_STALE_DAYS };
