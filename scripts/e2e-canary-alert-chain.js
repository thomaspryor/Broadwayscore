#!/usr/bin/env node
/**
 * Daily E2E canary for the alert→card→dispatch chain (Notion card #374).
 *
 * Root-cause postmortem (2026-07-24): disposition='auto' alerts were dead
 * for days because data-health-check.yml never ran `npm ci`, so
 * notion-brain.js crashed on a missing @notionhq/client — and the crash was
 * misreported as a NOTION_API_KEY problem, sending every triage session down
 * the wrong path. Unit tests (owner-alert-router.test.mjs) can't catch this
 * class of bug because they deliberately stub execFileSync/sendAlert. This
 * script does NOT stub anything: it routes two synthetic alerts through the
 * REAL owner-alert-router → notion-brain.js CLI → Notion API path, verifies
 * the resulting card actually exists via a real `get`, exercises the ledger
 * dedup guard for real, then cleans up after itself.
 *
 * On any failure: try routeAlert(disposition='human') first — that path
 * calls sendAlert() (Resend) directly and never shells out to
 * notion-brain.js, so it stays reachable even when the exact thing this
 * canary checks (the notion-brain shell-out) is what's broken. If even that
 * throws, exit nonzero so the workflow's own `notify-failure` step — which
 * depends on neither owner-alert-router.js nor notion-brain.js — still
 * fires as the last-resort backstop.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { routeAlert, resolveCondition, deleteCondition } = require('./lib/owner-alert-router.js');

const REPO_ROOT = path.join(__dirname, '..');
const NOTION_BRAIN = path.join(__dirname, 'notion-brain.js');

// Fixed (not date-suffixed) conditionKeys — deleteCondition() clears them at
// the top and bottom of every run, so the ledger never accumulates canary
// rows and each run always exercises the real "new incident" dispatch path
// instead of going silent under the normal 7-day cooldown.
const MAIN_KEY = 'e2e-canary:main';
const DEDUP_KEY = 'e2e-canary:dedup';
const FAILURE_KEY = 'e2e-canary:chain-broken';

function getCardViaCli(pageId) {
  const out = execFileSync('node', [NOTION_BRAIN, 'get', pageId], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  return JSON.parse(out);
}

function archiveCardViaCli(pageId) {
  execFileSync('node', [NOTION_BRAIN, 'archive', pageId], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
}

async function testFullChain() {
  const title = `[E2E Canary] alert chain check ${new Date().toISOString()}`;
  const result = await routeAlert({
    conditionKey: MAIN_KEY,
    title,
    description:
      'Synthetic alert from scripts/e2e-canary-alert-chain.js — verifies the ' +
      'disposition=auto path actually files and reads back a real Notion card. ' +
      'Safe to ignore; auto-archived at the end of the run.',
    severity: 'error',
    disposition: 'auto',
    cardAction: 'Investigate',
  });

  if (result.action !== 'auto' || !result.dispatchOk || !result.cardId) {
    throw new Error(
      `full-chain dispatch failed — action=${result.action} dispatchOk=${result.dispatchOk} ` +
      `cardId=${result.cardId} underlyingError=${result.dispatchError || '(none captured)'}`
    );
  }

  const card = getCardViaCli(result.cardId);
  if (!card || card.id !== result.cardId) {
    throw new Error(`card verification failed — get(${result.cardId}) did not return a matching card`);
  }
  if (card.name !== title) {
    throw new Error(`card verification failed — title mismatch: wrote "${title}", read back "${card.name}"`);
  }

  return result.cardId;
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
  if (first.action !== 'auto' || !first.dispatchOk || !first.cardId) {
    throw new Error(`dedup test: first call did not dispatch cleanly — ${JSON.stringify(first)}`);
  }

  const second = await routeAlert({
    conditionKey: DEDUP_KEY,
    title,
    description: 'second fire — should be silent (no new card)',
    severity: 'error',
    disposition: 'auto',
  });
  if (second.action !== 'silent' || second.cardId !== first.cardId) {
    throw new Error(
      `dedup test: expected a silent re-fire reusing cardId=${first.cardId}, ` +
      `got action=${second.action} cardId=${second.cardId}`
    );
  }

  return first.cardId;
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

async function cleanup(cardIds) {
  resetLedgerState();
  for (const id of cardIds) {
    if (!id) continue;
    try {
      archiveCardViaCli(id);
      console.log(`[e2e-canary] archived card ${id}`);
    } catch (err) {
      console.error(`[e2e-canary] warning: failed to archive card ${id} — ${err.message}`);
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

    process.exitCode = 1;
  }
}

main();
