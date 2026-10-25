#!/usr/bin/env node
/**
 * Automated Sentry issue triage.
 *
 * Fetches unresolved issues from Sentry, classifies them as noise vs real,
 * auto-resolves noise, and creates GitHub issues for real bugs.
 *
 * Required env vars:
 *   SENTRY_AUTH_TOKEN - Sentry API auth token (project:read, event:read, event:admin)
 *   SENTRY_ORG       - Sentry organization slug
 *   SENTRY_PROJECT   - Sentry project slug (default: broadway-scorecard)
 *   GITHUB_TOKEN     - GitHub token (for creating issues, provided by Actions)
 */

const SENTRY_BASE = 'https://sentry.io/api/0';
const ORG = process.env.SENTRY_ORG;
const PROJECT = process.env.SENTRY_PROJECT || 'broadway-scorecard';
const SENTRY_TOKEN = process.env.SENTRY_AUTH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'thomaspryor/Broadwayscore';
const DRY_RUN = process.argv.includes('--dry-run');

const { classifyIssue } = require('./lib/sentry-triage-classify');

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

// --- GitHub issue creation ---

async function findExistingGithubIssue(sentryIssueId) {
  const [owner, repo] = REPO.split('/');
  const res = await fetch(
    `https://api.github.com/search/issues?q=repo:${owner}/${repo}+is:issue+"sentry-${sentryIssueId}"+in:body`,
    { signal: AbortSignal.timeout(60000), headers: { Authorization: `token ${GITHUB_TOKEN}` } }
  );
  // A failed search must not read as "no existing issue": that files a duplicate
  // (GitHub search is rate limited at ~30/min and eventually consistent).
  if (!res.ok) throw new Error(`GitHub search ${res.status}`);
  const data = await res.json();
  return data.total_count > 0 ? data.items[0] : null;
}

async function createGithubIssue(issue, classification) {
  const [owner, repo] = REPO.split('/');
  const sentryLink = issue.permalink || `https://sentry.io/organizations/${ORG}/issues/${issue.id}/`;
  const frequency = classification.lowFrequency ? ' (low frequency)' : '';

  const body = `## Sentry Error${frequency}

**Error:** ${issue.title}
**Culprit:** ${issue.culprit || 'Unknown'}
**First seen:** ${issue.firstSeen}
**Events:** ${issue.count} | **Users affected:** ${issue.userCount}
**Sentry link:** ${sentryLink}

<!-- sentry-${issue.id} -->

---
*Auto-created by Sentry triage. Classification: ${classification.reason}*`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    signal: AbortSignal.timeout(60000),
    method: 'POST',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: `[Sentry] ${issue.title.substring(0, 80)}`,
      body,
      labels: ['bug', 'sentry-auto'],
    }),
  });

  if (!res.ok) {
    console.error(`Failed to create GitHub issue: ${res.status} ${await res.text()}`);
    return null;
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

  const stats = { noise: 0, real: 0, existingGithub: 0, newGithub: 0 };

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

      if (GITHUB_TOKEN && !DRY_RUN) {
        let existing;
        try {
          existing = await findExistingGithubIssue(issue.id);
        } catch (e) {
          console.error(`  → Could not check for an existing GitHub issue (${e.message}); not filing a possible duplicate\n`);
          continue;
        }
        if (existing) {
          stats.existingGithub++;
          console.log(`  → GitHub issue already exists: ${existing.html_url}\n`);
        } else {
          const ghIssue = await createGithubIssue(issue, classification);
          if (ghIssue) {
            stats.newGithub++;
            console.log(`  → Created GitHub issue: ${ghIssue.html_url}\n`);
          }
        }
      } else if (DRY_RUN) {
        console.log('  → Would create GitHub issue (dry run)\n');
      }
    }
  }

  console.log('\n--- Summary ---');
  console.log(`Total issues: ${issues.length}`);
  console.log(`Noise (auto-ignored): ${stats.noise}`);
  console.log(`Real issues: ${stats.real}`);
  console.log(`New GitHub issues created: ${stats.newGithub}`);
  console.log(`Existing GitHub issues: ${stats.existingGithub}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
