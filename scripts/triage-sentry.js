#!/usr/bin/env node
/**
 * Automated Sentry issue triage.
 *
 * Fetches unresolved issues from Sentry, classifies them as noise vs real,
 * auto-resolves noise, and files Linear cards for real bugs (BRO-5593; it used
 * to file GitHub issues, which nobody watched).
 *
 * Required env vars:
 *   SENTRY_AUTH_TOKEN - Sentry API auth token (project:read, event:read, event:admin)
 *   SENTRY_ORG       - Sentry organization slug
 *   SENTRY_PROJECT   - Sentry project slug (default: broadway-scorecard)
 *   LINEAR_API_KEY   - Linear API key (for filing cards on the board)
 */

const SENTRY_BASE = 'https://sentry.io/api/0';
const ORG = process.env.SENTRY_ORG;
const PROJECT = process.env.SENTRY_PROJECT || 'broadway-scorecard';
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const DRY_RUN = process.argv.includes('--dry-run');

const { classifyIssue } = require('./lib/sentry-triage-classify');
const { fileSentryIssue, MAX_NEW_CARDS_PER_RUN } = require('./lib/sentry-linear-filing');

// --- Sentry API helpers ---

async function sentryGet(path) {
  const res = await fetch(`${SENTRY_BASE}${path}`, {
    signal: AbortSignal.timeout(60000),
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Sentry API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function sentryPut(path, body) {
  const res = await fetch(`${SENTRY_BASE}${path}`, {
    signal: AbortSignal.timeout(60000),
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${SENTRY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Sentry PUT ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// --- Main ---

async function main() {
  if (!SENTRY_TOKEN) {
    console.error('SENTRY_AUTH_TOKEN is required');
    process.exit(1);
  }
  if (!ORG) {
    console.error('SENTRY_ORG is required');
    process.exit(1);
  }

  console.log(`Triaging Sentry issues for ${ORG}/${PROJECT}...`);
  if (DRY_RUN) console.log('DRY RUN — no changes will be made\n');

  // Fetch unresolved issues (last 24 hours by default, up to 100)
  const issues = await sentryGet(
    `/projects/${ORG}/${PROJECT}/issues/?query=is:unresolved&sort=date&limit=100`
  );

  console.log(`Found ${issues.length} unresolved issues\n`);

  const stats = { noise: 0, real: 0, existingCards: 0, newCards: 0, deferred: 0, notTracked: 0 };
  const hasLinearKey = !!process.env.LINEAR_API_KEY;
  const deps = hasLinearKey && !DRY_RUN ? {
    listIssuesByProvenance: require('./lib/linear-client').listIssuesByProvenance,
    createLinearIssue: require('./lib/linear-issue-create').createLinearIssue,
  } : null;

  for (const issue of issues) {
    // Fetch latest event for stack trace analysis
    let latestEvent = null;
    try {
      latestEvent = await sentryGet(`/issues/${issue.id}/events/latest/`);
    } catch (e) {
      // Some issues may not have accessible events
    }

    const classification = classifyIssue(issue, latestEvent);

    if (classification.noise) {
      stats.noise++;
      console.log(`NOISE: ${issue.title}`);
      console.log(`  Reason: ${classification.reason}`);

      if (!DRY_RUN) {
        try {
          await sentryPut(`/issues/${issue.id}/`, { status: 'ignored' });
          console.log('  → Ignored in Sentry\n');
        } catch (e) {
          console.error(`  → Failed to ignore: ${e.message}\n`);
        }
      } else {
        console.log('  → Would ignore in Sentry (dry run)\n');
      }
    } else {
      stats.real++;
      console.log(`REAL: ${issue.title}`);
      console.log(`  Reason: ${classification.reason}`);
      console.log(`  Events: ${issue.count}, Users: ${issue.userCount}`);

      if (DRY_RUN) {
        console.log('  → Would file a Linear card (dry run)\n');
      } else if (!deps) {
        stats.notTracked++;
        console.error('  → LINEAR_API_KEY is not set; this real error is NOT on the board\n');
      } else {
        const r = await fileSentryIssue(
          { issue, classification, org: ORG, canCreate: stats.newCards < MAX_NEW_CARDS_PER_RUN },
          deps,
        );
        if (r.action === 'existing') {
          stats.existingCards++;
          console.log(`  → Linear card already exists: ${r.card.identifier || r.card.url}\n`);
        } else if (r.action === 'filed') {
          stats.newCards++;
          console.log(`  → Filed Linear card: ${r.card.identifier} ${r.card.url || ''}\n`);
        } else if (r.action === 'deferred') {
          stats.deferred++;
          console.log(`  → ${r.reason}\n`);
        } else {
          stats.notTracked++;
          console.error(`  → ${r.reason}\n`);
        }
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Total issues: ${issues.length}`);
  console.log(`Noise (auto-ignored): ${stats.noise}`);
  console.log(`Real issues: ${stats.real}`);
  console.log(`New Linear cards filed: ${stats.newCards}`);
  console.log(`Already on the board: ${stats.existingCards}`);
  console.log(`Deferred to a later run (cap): ${stats.deferred}`);
  console.log(`Real errors NOT on the board: ${stats.notTracked}`);

  // A real error that could not reach the board must fail the run, so the
  // workflow's failure alert fires instead of the error sitting unseen.
  if (stats.notTracked > 0) {
    console.error(`${stats.notTracked} real Sentry error(s) could not be filed to Linear`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
