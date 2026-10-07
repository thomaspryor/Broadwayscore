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

// --- Noise detection patterns ---

const NOISE_MESSAGE_PATTERNS = [
  /swal/i,
  /sweetalert/i,
  /invalid origin/i,
  /blocked a frame with origin/i,
  /@context/,
  /ResizeObserver loop/i,
  /loading chunk \d+ failed/i,
  /ChunkLoadError/i,
  /NetworkError when attempting to fetch/i,
  /Failed to fetch/i,
  /Load failed/i,
  /AbortError/i,
  /NotAllowedError/i,
  /webkit-masked-url/i,
  /Cannot read propert.*of null/i,
  /Cannot read propert.*of undefined/i,
  /Script error\.?$/i,
  /Non-Error promise rejection captured/i,
  /Unexpected token/i,
  /Object Not Found Matching Id/i,
  /a\[e\] is not a function/i,
  /instantSearchSDKJSBridgeClearHighlight/i,
  /fb_xd_fragment/i,
  /googletag/i,
  /google-analytics/i,
  /ytcfg/i,
  /vid_mate_check/i,
  /zaloJSV2/i,
  /UCShellJava/i,
];

const NOISE_URL_PATTERNS = [
  /extensions?\//i,
  /^chrome:\/\//i,
  /^chrome-extension:\/\//i,
  /^moz-extension:\/\//i,
  /^safari-extension:\/\//i,
  /^safari-web-extension:\/\//i,
  /^webkit-masked-url:\/\//i,
  /translate\.google/i,
  /googletagmanager\.com/i,
  /clarity\.ms/i,
  /google-analytics\.com/i,
  /doubleclick\.net/i,
  /facebook\.com/i,
  /connect\.facebook/i,
];

const OUR_DOMAIN_PATTERNS = [
  /broadwayscorecard\.com/,
  /broadwayscorecard-.*\.vercel\.app/,
];

// --- Sentry API helpers ---

async function sentryGet(path) {
  const res = await fetch(`${SENTRY_BASE}${path}`, {
    headers: { Authorization: `Bearer ${SENTRY_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Sentry API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function sentryPut(path, body) {
  const res = await fetch(`${SENTRY_BASE}${path}`, {
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

// --- Classification ---

function classifyIssue(issue, latestEvent) {
  const title = issue.title || '';
  const culprit = issue.culprit || '';
  const metadata = issue.metadata || {};
  const message = metadata.value || title;

  // Check message patterns
  for (const pattern of NOISE_MESSAGE_PATTERNS) {
    if (pattern.test(title) || pattern.test(message) || pattern.test(culprit)) {
      return { noise: true, reason: `Message matches noise pattern: ${pattern}` };
    }
  }

  // Check stack trace if available
  if (latestEvent) {
    const exception = latestEvent.entries?.find(e => e.type === 'exception');
    const frames = exception?.data?.values?.[0]?.stacktrace?.frames || [];

    if (frames.length === 0) {
      return { noise: true, reason: 'No stack trace (cannot attribute to our code)' };
    }

    // Check if any frame is from a noisy URL
    const allNoisy = frames.every(f => {
      const filename = f.filename || f.absPath || '';
      return NOISE_URL_PATTERNS.some(p => p.test(filename)) ||
        (!OUR_DOMAIN_PATTERNS.some(p => p.test(filename)) && filename.startsWith('http'));
    });

    if (allNoisy) {
      return { noise: true, reason: 'All stack frames from third-party/extension code' };
    }

    const hasOurCode = frames.some(f => {
      const filename = f.filename || f.absPath || '';
      return OUR_DOMAIN_PATTERNS.some(p => p.test(filename));
    });

    if (!hasOurCode) {
      return { noise: true, reason: 'No stack frames from our domain' };
    }
  }

  // Check if it's a low-frequency issue (1-2 events from a single user)
  // These are usually one-off browser quirks
  if (issue.count && parseInt(issue.count) <= 2 && issue.userCount && parseInt(issue.userCount) <= 1) {
    // Still report it, but note it's low-frequency
    return { noise: false, lowFrequency: true, reason: 'Low frequency (1-2 events, 1 user)' };
  }

  return { noise: false, reason: 'Appears to be a real issue from our code' };
}

// --- GitHub issue creation ---

async function findExistingGithubIssue(sentryIssueId) {
  const [owner, repo] = REPO.split('/');
  const res = await fetch(
    `https://api.github.com/search/issues?q=repo:${owner}/${repo}+is:issue+"sentry-${sentryIssueId}"+in:body`,
    { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
  );
  if (!res.ok) return null;
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
        const existing = await findExistingGithubIssue(issue.id);
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
