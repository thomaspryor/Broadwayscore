#!/usr/bin/env node

/**
 * Check every open user content request against the LIVE site and email the
 * owner the moment it is actually visible there.
 *
 * WHY (2026-08-05, owner request): "auto-dispatched" is not "fixed". The
 * pipeline's notifications all stopped at intent — a workflow was triggered —
 * and nothing ever confirmed the show appeared on broadwayscorecard.com. The
 * owner asked for two things this script provides:
 *   1. An email when a request is FULLY fixed, meaning live on the site.
 *   2. Confirmation of whether a systematic fix came with it — i.e. whether
 *      this ask shape now routes itself, or was a one-off.
 *
 * It also reports requests that have been open too long (STALE_AFTER_DAYS).
 * Those are never auto-closed: a request whose workflow silently failed is
 * precisely what used to disappear, so it gets louder, not quieter.
 *
 * Usage:
 *   node scripts/verify-feedback-requests-live.js [--dry-run] [--base=URL]
 *
 * Env: GH_TOKEN / GITHUB_TOKEN (optional — closes the tracking issue when live).
 *      RESEND_API_KEY / OWNER_EMAIL are only consulted if the router pages.
 *
 * DELIVERY (2026-08-05): reported via routeAlert(), not a direct Resend call.
 * Card #611 is the owner's standing mandate that senders do not email them
 * directly unless their conditionKey is listed in scripts/lib/page-worthy-
 * alerts.js; everything else reaches them through the daily digest. "A request
 * went live" / "a request is stuck" is not site-down, opening-night-dead, or
 * data-loss, so it is digest-tier — the owner is still told, within a day.
 * Promoting either to an immediate email is one line in page-worthy-alerts.js.
 *
 * Exit 0 when there is nothing to report. Exit 1 only on a delivery failure: an
 * alerting path that fails silently is the thing this replaces.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { postJSON } = require('./lib/email-templates.js'); // GitHub issue comments only
const { routeAlert } = require('./lib/owner-alert-router.js');
const {
  evaluateEntry,
  staleEntries,
  daysSince,
  STALE_AFTER_DAYS,
} = require('./lib/feedback-request-ledger.js');

const LEDGER_PATH = path.join(__dirname, '../data/audit/feedback-request-ledger.json');
const REPO = 'thomaspryor/Broadwayscore';

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `verify-feedback-requests-live.js — confirm open content requests are LIVE on the site

Usage:
  node scripts/verify-feedback-requests-live.js [--dry-run] [--base=URL]

  --dry-run    evaluate + print, never report and never close a tracking issue
  --base=URL   site to check against (default https://broadwayscorecard.com)

Reports through routeAlert() (digest-tier by default — see the header).
Env: GH_TOKEN / GITHUB_TOKEN (optional — closes the tracking issue when live)
`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BASE = (args.find((a) => a.startsWith('--base=')) || '--base=https://broadwayscorecard.com').split('=')[1];

function getJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
}

/**
 * Resolve an entry to a show ID. missing-show entries have none at request time
 * (the show did not exist yet), so they are matched against the catalog by
 * title + market — the same market scoping the router uses, so a Broadway entry
 * never closes a request for the regional tryout.
 */
function resolveEntryShowId(entry, shows) {
  if (entry.showId) return entry.showId;
  if (!entry.title || !Array.isArray(shows)) return null;
  const { resolveShowMatches } = require('./lib/resolve-show.js');
  let matches = resolveShowMatches(entry.title, shows);
  if (entry.market) matches = matches.filter((s) => s && s.category === entry.market);
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) =>
    String(b.openingDate || '').localeCompare(String(a.openingDate || ''))
  )[0].id;
}

/**
 * The show's page on the live site.
 *
 * The route is /show/{slug} — SINGULAR. This said /shows/ until 2026-08-05 and
 * every "see the page" link the owner was sent 404'd, which is worse than no
 * link: it reads as "your fix didn't ship" for a request that had shipped.
 * There is no /shows/[slug] route in src/app — only src/app/show/[slug].
 */
function showUrl(entry, showId, shows) {
  const show = (shows || []).find((s) => s && s.id === showId);
  const slug = show?.slug || showId;
  return `${BASE}/show/${slug}`;
}

function githubJSON(apiPath) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  return new Promise((resolve) => {
    const headers = {
      'User-Agent': 'broadwayscorecard-feedback-verifier',
      Accept: 'application/vnd.github+json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.get(`https://api.github.com${apiPath}`, { headers, timeout: 20000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Recent runs of one workflow, newest first.
 *
 * The old report said "the workflow likely failed" — a guess the owner could
 * not act on. Ask GitHub instead. One API call per distinct stuck workflow,
 * so a handful per run at most.
 *
 * Returns {ok:false} when the workflow is unknown or GitHub was unreachable,
 * and {ok:true, runs:[]} when it genuinely has never run. Those are different
 * facts and the report says which one it is — collapsing both to null is how
 * "we could not check" gets reported as "nothing happened".
 */
const RUNS_PAGE_SIZE = 20;

async function fetchWorkflowRuns(workflowFile) {
  if (!workflowFile) return { ok: false };
  const body = await githubJSON(
    `/repos/${REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${RUNS_PAGE_SIZE}`
  );
  if (!body || !Array.isArray(body.workflow_runs)) return { ok: false };
  return {
    ok: true,
    // A full page means there are probably older runs we did not fetch. That
    // matters: on a busy shared workflow the run that served this request can
    // sit past the page boundary, and without this flag the report would state
    // a count and a verdict as if it had seen everything.
    truncated: body.workflow_runs.length >= RUNS_PAGE_SIZE,
    runs: body.workflow_runs.map((r) => ({
      status: r.status,
      conclusion: r.conclusion,
      startedAt: r.run_started_at || r.created_at,
      url: r.html_url,
    })),
  };
}

/**
 * The run that could plausibly have served THIS request.
 *
 * A shared workflow — add-requested-show.yml, gather-reviews.yml — runs for
 * every request that routes to it, so "the workflow's most recent run" is
 * usually somebody else's. Reporting that run's verdict as this request's is
 * exactly the confident-but-wrong diagnosis this whole change exists to kill:
 * on 2026-08-05 the two newest add-requested-show runs were green for other
 * shows while The Outsiders' own run had failed hours earlier, so the naive
 * version would have told the owner "it SUCCEEDED, re-running will not help".
 *
 * A run that started BEFORE the request cannot have served it, so only runs
 * at-or-after requestedAt are considered. No such run is itself the finding:
 * the dispatch never fired.
 */
function pickRunForRequest(fetched, requestedAt) {
  if (!fetched || !fetched.ok) return { state: 'unknown' };
  const asked = Date.parse(requestedAt);
  // An unparseable requestedAt means we cannot tell which runs came after the
  // request — and the ONLY safe answer is to say so. Falling back to "use all
  // runs" here is precisely how the shared-workflow misattribution this
  // function exists to prevent would sneak back in through a bad timestamp.
  if (Number.isNaN(asked)) return { state: 'unknown' };
  const candidates = fetched.runs.filter((r) => {
    const started = Date.parse(r.startedAt);
    return !Number.isNaN(started) && started >= asked;
  });
  // Every run we fetched is post-request AND the page was full: there are
  // almost certainly more we never saw, so the count is a floor, not a total.
  const partial = Boolean(fetched.truncated) && candidates.length === fetched.runs.length;
  if (candidates.length === 0) {
    // Only a NON-truncated page proves the workflow never ran. A full page of
    // pre-request runs would mean we simply did not page back far enough.
    return fetched.truncated ? { state: 'unknown' } : { state: 'never-ran' };
  }
  // Newest first is what GitHub returns; take the newest that qualifies.
  return { state: 'ran', run: candidates[0], count: candidates.length, partial };
}

function describeRun(picked) {
  if (!picked || picked.state === 'unknown') {
    return 'We could not establish what its workflow did, so this is unexplained rather than diagnosed.';
  }
  if (picked.state === 'never-ran') {
    // The most actionable verdict of the three: nothing was even attempted.
    return 'That workflow has not run at all since the request came in — the job was never actually started.';
  }
  const { run, count, partial } = picked;
  const when = run.startedAt ? ` on ${String(run.startedAt).slice(0, 10)}` : '';
  const many = partial ? `at least ${count}` : String(count);
  const scope = count > 1 ? ` (the most recent of ${many} runs since the request)` : '';
  // Never "its last run" — see pickRunForRequest. This run is the newest that
  // COULD have served the request; the workflow is shared, so it may have been
  // doing something else entirely.
  const status = run.status || 'in an unknown state';
  if (status !== 'completed') return `Its most recent run since then${when}${scope} is still ${status}.`;
  if (run.conclusion === 'success') {
    // A green run that produced nothing is the WORSE case, and the one the old
    // "likely failed" wording actively hid: the fault is in the script's own
    // matching/gating, not in CI, so re-running it changes nothing.
    return `Its most recent run since then${when}${scope} SUCCEEDED, and the change still is not live — so re-running it will not help; the fault is in what it decided to do, not in CI.`;
  }
  return `Its most recent run since then${when}${scope} ended as ${run.conclusion || 'an unreported conclusion'}.`;
}

/**
 * Does this entry's kind ever have named reviews to report? Only these two
 * shapes can produce a non-empty `reviews` array from evaluateEntry() — every
 * other kind (missing-show, missing-image, and every content-fix type except
 * single-review) legitimately has nothing to name, so the "no readable review
 * rows" caveat below must not fire for them. An allowlist here (not the old
 * `!== 'missing-image'` denylist) is deliberate: a new kind defaults to no
 * caveat instead of silently gaining a wrong one.
 */
function entryNamesReviews(entry) {
  return entry.kind === 'missing-reviews' ||
    (entry.kind === 'content-fix' && entry.contentErrorType === 'single-review');
}

/**
 * Deduped + sorted conditionKey. A repeated entry must not reorder the key and
 * slip past the router's cooldown as a fresh incident.
 */
function conditionKeyFor(prefix, keys) {
  return `${prefix}:${[...new Set(keys)].sort().join(',')}`;
}

/**
 * "These shipped" — good news, nothing for anyone to do.
 *
 * Named reviews (2026-08-05, owner request): the old body said "0 → 1
 * review(s) live" and linked a 404. A count the owner cannot check is not
 * evidence, so every report now names the reviews it is claiming — critic,
 * outlet, date — and links the page they are on.
 *
 * `decision: true` keeps digest-autofix from spending a session on a row where
 * nothing is broken; see queueDigestLine() in owner-alert-router.js.
 */
function buildLiveAlert(nowLive) {
  const blocks = nowLive.map((r) => {
    const named = r.reviews || [];
    // Front-loaded: the digest clips a queued row's description at 200 chars,
    // so the show, the verdict and the first named review all land inside them.
    const lead = named.length
      ? `"${r.entry.title || r.showId}" is now on the site — ${r.evidence}: ${named.map((x) => x.text).join('; ')}.`
      : `"${r.entry.title || r.showId}" is now on the site — ${r.evidence}.`;
    const lines = [lead, `  See it: ${r.url}`];
    if (!named.length && entryNamesReviews(r.entry)) {
      // Never let a review request report a bare count again. If the reviews
      // could not be read out of the live payload, say that outright — silence
      // here is what made "0 → 1 review(s) live" unverifiable.
      lines.push('  (no individual reviews to name — the live payload had no readable review rows)');
    }
    for (const rev of named) {
      if (rev.url) lines.push(`  ${rev.text} — ${rev.url}`);
    }
    lines.push(`  They asked: "${r.entry.requestedMessage || '(no message)'}"`);
    lines.push(`  ${r.entry.systematicFix?.note || 'One-off — no standing route for this ask shape yet.'}`);
    lines.push(`  Asked ${Math.round(daysSince(r.entry.requestedAt) * 10) / 10} day(s) ago${r.entry.issueNumber ? ` — https://github.com/${REPO}/issues/${r.entry.issueNumber}` : ''}`);
    return lines.join('\n');
  });

  return {
    conditionKey: conditionKeyFor('feedback-requests-live', nowLive.map((r) => r.entry.key || r.showId)),
    title: `${nowLive.length} user request(s) now live on the site`,
    description: blocks.join('\n\n'),
    severity: 'info',
    // `decision` here means only one thing to the machinery: do NOT auto-fix
    // this row (digest-autofix.js spends a whole agent session on every queued
    // row that lacks the flag). There is no "FYI" bucket in the digest, and a
    // session spent on "the thing you asked for shipped" is pure waste — so the
    // flag is set and decisionPrompt says outright that there is nothing to do,
    // rather than leaving the owner to work out why good news has a button.
    decision: true,
    decisionPrompt: 'Nothing to do — this is a receipt. The request shipped and was checked against the live site.',
    url: nowLive[0]?.url,
    fields: [{ name: 'Now live', value: String(nowLive.length) }],
  };
}

/**
 * "These are stuck" — the half the owner called useless (2026-08-05): "the
 * failed one has nothing actionable for me... it needs something for me to
 * click to get an agent/session working on it".
 *
 * Two things make it actionable:
 *
 *   1. It says what the workflow ACTUALLY did, from the GitHub API — not "the
 *      workflow likely failed", which was a guess the owner could not act on.
 *      A run that went GREEN and still shipped nothing is called out as such,
 *      because re-running it is then pointless.
 *   2. The row carries NO `decision` flag, which is what makes it clickable —
 *      digest-autofix.js auto-dispatches every non-decision queued row, so a
 *      stuck request gets a card and a workspace with no click at all, and
 *      send-morning-digest.js hangs its signed one-click "Dispatch a fix"
 *      link on whatever is left. That is the owner's own standing mandate
 *      (2026-08-02): "Why do I need to hit 'Fix this'... Just have a Claude
 *      session fix them."
 *
 * FRONT-LOADED ON PURPOSE: the digest renders a queued row as
 * `clip(description, 200)`. The first 200 characters are the whole message for
 * most readers, so the show, the age and the verdict all land inside them —
 * and a long mailto: or context dump would be sliced into unreadable noise,
 * which is the exact failure being fixed here.
 */
function buildStuckAlert(stale, runsByWorkflow) {
  const picks = new Map(
    stale.map((e) => [e.key, pickRunForRequest(runsByWorkflow.get(e.workflow), e.requestedAt)])
  );
  const blocks = stale.map((e) => {
    const days = Math.round(daysSince(e.requestedAt));
    const issueUrl = e.issueNumber ? `https://github.com/${REPO}/issues/${e.issueNumber}` : null;
    const picked = picks.get(e.key);
    const lines = [
      `"${e.title || e.showId}" was asked for ${days} day(s) ago and is still not on the site. ${describeRun(picked)}`,
      `  They asked: "${e.requestedMessage || '(no message)'}"`,
    ];
    if (picked?.run?.url) lines.push(`  That run: ${picked.run.url}`);
    if (issueUrl) lines.push(`  Tracking issue: ${issueUrl}`);
    return lines.join('\n');
  });

  // The digest's "view" link. Point it at the run when there is one — that is
  // where the reason lives — and fall back to the tracking issue.
  const firstRun = stale.map((e) => picks.get(e.key)?.run).find((r) => r && r.url);
  const firstIssue = stale.find((e) => e.issueNumber);

  return {
    conditionKey: conditionKeyFor('feedback-requests-stuck', stale.map((e) => e.key || e.showId)),
    title: `${stale.length} user request(s) stuck — not live after ${STALE_AFTER_DAYS} days`,
    description: blocks.join('\n\n'),
    severity: 'error',
    url: firstRun?.url || (firstIssue ? `https://github.com/${REPO}/issues/${firstIssue.issueNumber}` : undefined),
    fields: [{ name: 'Stuck', value: String(stale.length) }],
  };
}

async function closeIssue(issueNumber, evidence, url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || !issueNumber) return;
  try {
    await postJSON(`https://api.github.com/repos/${REPO}/issues/${issueNumber}/comments`, {
      body: `Now live on the site: ${evidence}\n\n${url}\n\n_Verified against production by scripts/verify-feedback-requests-live.js._`,
    }, { Authorization: `Bearer ${token}`, 'User-Agent': 'broadwayscorecard-feedback-verifier' });
  } catch (err) {
    console.log(`  Could not comment on #${issueNumber}: ${err.message}`);
  }
}

async function main() {
  const ledger = loadLedger();
  const open = ledger.entries.filter((e) => e.status === 'open');
  if (open.length === 0) {
    console.log('No open user requests to verify.');
    return;
  }

  let shows = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
    shows = raw.shows || raw;
  } catch (err) {
    // Without the catalog, missing-show entries cannot be resolved to an ID.
    // Say so rather than reporting them as "not live yet", which would read as
    // a failed request when it is really a missing checkout.
    console.error(`::warning::Could not read shows.json (${err.message}) — missing-show entries cannot be resolved this run.`);
  }

  const nowLive = [];
  for (const entry of open) {
    const showId = resolveEntryShowId(entry, shows);
    if (!showId) {
      console.log(`  ${entry.key}: not in the catalog yet`);
      continue;
    }
    const live = await getJSON(`${BASE}/data/shows/${showId}.json`);
    const { satisfied, evidence, reviews } = evaluateEntry(entry, live);
    console.log(`  ${entry.key}: ${satisfied ? 'LIVE' : 'waiting'} — ${evidence}`);
    if (!satisfied) continue;

    entry.status = 'live';
    entry.satisfiedAt = new Date().toISOString();
    entry.showId = showId;
    nowLive.push({ entry, showId, evidence, reviews, url: showUrl(entry, showId, shows) });
  }

  const stale = staleEntries(ledger);

  if (nowLive.length === 0 && stale.length === 0) {
    console.log('Nothing newly live, nothing stuck.');
    saveLedger(ledger);
    return;
  }

  // Shipped and stuck are reported SEPARATELY (2026-08-05). One combined alert
  // forced one severity and one auto-dispatch decision onto two opposite
  // things: good news that needs no session, and a failure that needs one.
  // Split, the stuck row can be an auto-dispatchable error while the live row
  // stays an FYI, and neither is silenced by the other's cooldown.
  const alerts = [];
  if (nowLive.length > 0) alerts.push(buildLiveAlert(nowLive));
  if (stale.length > 0) {
    // One API call per distinct workflow, not per entry — several stuck
    // requests routinely share one workflow. The per-request pick then happens
    // in memory, against each entry's own requestedAt.
    const runsByWorkflow = new Map();
    for (const wf of new Set(stale.map((e) => e.workflow).filter(Boolean))) {
      runsByWorkflow.set(wf, await fetchWorkflowRuns(wf));
    }
    alerts.push(buildStuckAlert(stale, runsByWorkflow));
  }

  if (DRY_RUN) {
    for (const a of alerts) {
      console.log(`[dry-run] would report: "${a.title}"`);
      console.log(a.description);
    }
    console.log(`[dry-run] ${nowLive.length} live, ${stale.length} stale`);
    return; // deliberately does NOT persist — a dry run must not mark things notified
  }

  for (const alert of alerts) {
    let result;
    try {
      // See the header: routed, not sent directly (card #611). Do NOT persist
      // the status flips if routing threw — an unreported flip must be retried
      // next run, not silently marked delivered.
      result = await routeAlert({ ...alert, disposition: 'human' });
    } catch (err) {
      console.error(`::error::Failed to report "${alert.title}": ${err.message}`);
      process.exit(1);
    }
    // result.action === 'digest' means the page-worthy gate (card #611)
    // folded this into tomorrow's digest instead of emailing — the owner
    // WILL see it there, so only a 'human' request that failed to deliver
    // counts as failure here.
    if (result.action === 'human' && result.delivered === false) {
      console.error(`::error::Owner alert delivery FAILED for "${alert.title}" — nobody was told.`);
      process.exit(1);
    }
    console.log(
      result.action === 'silent'
        ? `Already reported, not repeating: "${alert.title}"`
        : `Owner notified (${result.action}): "${alert.title}"`
    );
  }

  for (const r of nowLive) await closeIssue(r.entry.issueNumber, r.evidence, r.url);

  saveLedger(ledger);
  console.log(`Ledger updated: ${nowLive.length} marked live, ${stale.length} still stuck.`);
}

module.exports = {
  buildLiveAlert,
  buildStuckAlert,
  describeRun,
  pickRunForRequest,
  showUrl,
  resolveEntryShowId,
  entryNamesReviews,
};

if (require.main === module) {
  // --help must short-circuit BEFORE main() does any network calls, ledger
  // reads, email sends, or GitHub issue closes (task #498 class).
  if (hasHelpFlag(args)) {
    console.log(USAGE);
  } else {
    main().catch((err) => {
      console.error(`::error::verify-feedback-requests-live crashed: ${err.message}`);
      process.exit(1);
    });
  }
}
