#!/usr/bin/env node
/**
 * Daily E2E canary for the alert→card→dispatch chain (Notion card #374).
 *
 * Root-cause postmortem (2026-07-24): disposition='auto' alerts were dead
 * for days because data-health-check.yml never ran `npm ci`, so
 * notion-brain.js crashed on a missing @notionhq/client — and the crash was
 * misreported as a NOTION_API_KEY problem, sending every triage session down
 * the wrong path. Unit tests (owner-alert-router.test.mjs) can't catch this
 * class of bug because they deliberately stub createLinearIssue()/sendAlert.
 * This script does NOT stub anything: it routes two synthetic alerts through
 * the REAL owner-alert-router → createLinearIssue() (scripts/lib/linear-
 * issue-create.js, via the injectable client in scripts/lib/linear.js —
 * BRO-375 repointed this in-process, 2026-08-19; before that it shelled out
 * to linear-brain.js) → Linear API path, verifies the resulting issue
 * actually exists via a real getIssue, exercises the ledger dedup guard for
 * real, then archives its issues.
 *
 * On any failure: try routeAlert(disposition='human') first — that path
 * calls sendAlert() (Resend) directly and never touches Linear issue
 * creation, so it stays reachable even when the exact thing this canary
 * checks (the issue-filing call) is what's broken. If even that throws, exit
 * nonzero so the workflow's own `notify-failure` step — which depends on
 * neither owner-alert-router.js nor linear-issue-create.js — still fires as
 * the last-resort backstop.
 *
 * DEV/CI GUARD (added after a local test-fire paged the owner at midnight,
 * 2026-07-24): disposition='human' actually emails the owner in real time —
 * it must never fire from a session/worktree just exercising this script.
 * Only page when IS_LIVE is true (real CI, or an explicit --live opt-in);
 * everything else prints the would-be alert to console and still exits 1,
 * so a local run still fails loudly without paging anyone.
 */
const { routeAlert, resolveCondition, deleteCondition } = require('./lib/owner-alert-router.js');
const IS_LIVE = process.env.GITHUB_ACTIONS === 'true' || process.env.CI === 'true' || process.argv.includes('--live');

// Fixed (not date-suffixed) conditionKeys — deleteCondition() clears them at
// the top and bottom of every run, so the ledger never accumulates canary
// rows and each run always exercises the real "new incident" dispatch path
// instead of going silent under the normal 7-day cooldown.
const MAIN_KEY = 'e2e-canary:main';
const DEDUP_KEY = 'e2e-canary:dedup';
const FAILURE_KEY = 'e2e-canary:chain-broken';

// BRO-286: the chain now files LINEAR issues — read-back and cleanup go
// through linear-client (getIssue by identifier; archiveIssue by UUID).
const linearClient = require('./lib/linear-client.js');

async function getIssueByIdentifier(identifier) {
  return linearClient.getIssue(identifier);
}

async function archiveIssueByIdentifier(identifier) {
  const issue = await linearClient.getIssue(identifier);
  if (issue) await linearClient.archiveIssue(issue.id);
}

async function testFullChain() {
  const title = `[E2E Canary] alert chain check ${new Date().toISOString()}`;
  const result = await routeAlert({
    conditionKey: MAIN_KEY,
    title,
    description:
      'Synthetic alert from scripts/e2e-canary-alert-chain.js — verifies the ' +
      'disposition=auto path actually files and reads back a real Linear issue. ' +
      'Safe to ignore; auto-archived at the end of the run.',
    severity: 'error',
    disposition: 'auto',
    cardAction: 'Investigate',
  });

  // BRO-286: the tracker is a Linear issue — linearIdentifier is the proof
  // of filing (cardId is always null on this path).
  if (result.action !== 'auto' || !result.dispatchOk || !result.linearIdentifier) {
    // action='silent' with an identifier means the rail-2 dedupe matched an
    // EXISTING open issue carrying this canary's conditionKey — almost always
    // a leaked issue from a prior run whose archive step failed, not a broken
    // dispatch chain. Name that so the page doesn't send triage down the
    // wrong path (verify-pass finding, 2026-08-12).
    const leakHint = (result.action === 'silent' && result.linearIdentifier)
      ? ` HINT: dedupe matched open issue ${result.linearIdentifier} — likely a leaked canary issue from a failed cleanup; archive it and rerun.`
      : '';
    throw new Error(
      `full-chain dispatch failed — action=${result.action} dispatchOk=${result.dispatchOk} ` +
      `linearIdentifier=${result.linearIdentifier} underlyingError=${result.dispatchError || '(none captured)'}${leakHint}`
    );
  }

  const issue = await getIssueByIdentifier(result.linearIdentifier);
  if (!issue || issue.identifier !== result.linearIdentifier) {
    throw new Error(`issue verification failed — getIssue(${result.linearIdentifier}) did not return a matching issue`);
  }
  if (issue.title !== title) {
    throw new Error(`issue verification failed — title mismatch: wrote "${title}", read back "${issue.title}"`);
  }

  return result.linearIdentifier;
}

async function testDedup() {
  const title = `[E2E Canary] dedup check ${new Date().toISOString()}`;
  const first = await routeAlert({
    conditionKey: DEDUP_KEY,
    title,
    description:
      'Synthetic alert from scripts/e2e-canary-alert-chain.js — verifies a second ' +
      'routeAlert() call for the same open conditionKey does NOT file a second card. ' +
      'Safe to ignore; auto-archived at the end of the run.',
    severity: 'error',
    disposition: 'auto',
  });
  if (first.action !== 'auto' || !first.dispatchOk || !first.linearIdentifier) {
    throw new Error(`dedup test: first call did not dispatch cleanly — ${JSON.stringify(first)}`);
  }

  const second = await routeAlert({
    conditionKey: DEDUP_KEY,
    title,
    description: 'second fire — should be silent (no new issue)',
    severity: 'error',
    disposition: 'auto',
  });
  if (second.action !== 'silent' || second.linearIdentifier !== first.linearIdentifier) {
    throw new Error(
      `dedup test: expected a silent re-fire reusing linearIdentifier=${first.linearIdentifier}, ` +
      `got action=${second.action} linearIdentifier=${second.linearIdentifier}`
    );
  }

  return first.linearIdentifier;
}

function resetLedgerState() {
  for (const key of [MAIN_KEY, DEDUP_KEY]) {
    try {
      deleteCondition(key);
    } catch (err) {
      console.error(`[e2e-canary] warning: failed to clear ledger state for ${key}: ${err.message}`);
    }
  }
}

async function cleanup(issueIdentifiers) {
  resetLedgerState();
  for (const id of issueIdentifiers) {
    if (!id) continue;
    try {
      await archiveIssueByIdentifier(id);
      console.log(`[e2e-canary] archived issue ${id}`);
    } catch (err) {
      console.error(`[e2e-canary] warning: failed to archive issue ${id} — ${err.message}`);
    }
  }
}

async function main() {
  // Defensive: clear any state a previous crashed run left behind, so this
  // run always exercises the real "new incident" dispatch path.
  resetLedgerState();

  const cardIds = [];
  try {
    cardIds.push(await testFullChain());
    console.log('[e2e-canary] full-chain dispatch + real get() verification: OK');

    cardIds.push(await testDedup());
    console.log('[e2e-canary] ledger dedup guard against the real chain: OK');

    await cleanup(cardIds);
    // Clear any open "chain is broken" incident from a prior failed run now
    // that a real, unmocked dispatch just succeeded — matches routeAlert's
    // own "resolve the moment the check goes green" convention.
    resolveCondition(FAILURE_KEY);
    console.log('[e2e-canary] PASS');
  } catch (err) {
    console.error(`[e2e-canary] FAILED: ${err.stack || err.message}`);
    await cleanup(cardIds);

    if (IS_LIVE) {
      try {
        await routeAlert({
          conditionKey: FAILURE_KEY,
          title: 'E2E Canary: alert→card→dispatch chain is broken',
          description:
            'The alert-router E2E canary failed against the REAL chain (no mocks). ' +
            'This is the same failure class as the 2026-07-24 npm-ci incident — ' +
            "disposition='auto' alerts may be silently failing again.\n\n" +
            `Underlying error:\n${err.stack || err.message}`,
          severity: 'critical',
          disposition: 'human',
          cooldownHours: 24,
        });
      } catch (alertErr) {
        console.error(`[e2e-canary] human-disposition fallback alert ALSO failed: ${alertErr.stack || alertErr.message}`);
      }
    } else {
      const looksLikeLocalDepsGap = /Cannot find module/.test(String(err.stack || err.message));
      console.error(
        '[e2e-canary] DEV RUN — suppressing the owner-facing disposition=human alert ' +
        '(no GITHUB_ACTIONS/CI env, no --live flag). In real CI this failure would page ' +
        'the owner immediately. Re-run with --live to test the paging path for real.' +
        (looksLikeLocalDepsGap
          ? ' NOTE: this looks like a missing-dependency error, which is the exact class ' +
            'this canary hunts in CI — but CI always runs `npm ci` before this step, so a ' +
            'local "Cannot find module" is far more likely your own dev environment (or a ' +
            "worktree) missing `npm install`, not a real regression. Run `npm ci` here before " +
            're-testing.'
          : '')
      );
    }

    process.exitCode = 1;
  }
}

main();
