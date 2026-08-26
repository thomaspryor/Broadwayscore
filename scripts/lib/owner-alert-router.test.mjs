import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

// Captured once, before loadRouterWithFakes() ever touches require.cache for
// scripts/lib/linear.js — the real ISSUE_CREATE_MUTATION text, so the BRO-375
// wiring test below can assert the actual GraphQL query dispatchCard()
// triggers matches what linear.js owns, not a hand-copied second string
// (CLAUDE.md rule 15).
const { ISSUE_CREATE_MUTATION: REAL_ISSUE_CREATE_MUTATION } = require('./linear.js');

// The router calls createLinearIssue() (scripts/lib/linear-issue-create.js,
// BRO-375 Phase 1 — formerly an execFileSync shell-out to linear-brain.js)
// for disposition='auto' and calls sendAlert() (Resend) for
// disposition='human'. Neither should ever fire in a unit test — override
// both dependencies via a throwaway module cache entry pointed at a fake
// createLinearIssue/sendAlert, and isolate the ledger/digest-queue files to a
// temp dir so runs don't touch data/audit/ or leave test residue for the
// real project.
// `ledgerEnvPath` pins the ledger to a real on-disk file via ALERT_LEDGER_PATH
// instead of the fs remap below — used by the git-checkout-wipe tests, which
// need the ledger and the (fake) git-tracked ledger to be genuinely different
// files so one can be wiped without touching the other.
// `useRealLinearIssueCreate` skips the createLinearIssue stub entirely and
// exercises the REAL scripts/lib/linear-issue-create.js — used by the one
// test that proves a routed alert reaches Linear through the injectable
// client in scripts/lib/linear.js (BRO-374), with only the network layer
// (linear.js's graphql executor + linear-client's getTeam) stubbed below it.
function loadRouterWithFakes({
  createLinearIssueImpl,
  sendAlertImpl,
  ledgerEnvPath,
  linearSearchIssuesImpl,
  useRealLinearIssueCreate,
  linearGetTeamImpl,
  linearGraphqlImpl,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-router-test-'));
  const priorLedgerEnv = process.env.ALERT_LEDGER_PATH;
  // Default to a per-load temp ledger. Loading bare used to resolve to the
  // REAL ledger (tracked in CI, ~/.broadwayscore-state locally): this exact
  // file's synthetic conditions were found committed to main inside
  // data/audit/alert-ledger.json on 2026-08-02, and the router now refuses
  // real-ledger writes under node:test (saveLedger guard). Pass
  // `ledgerEnvPath: null` explicitly for read-only tests of the bare-env
  // path-resolution logic.
  if (ledgerEnvPath === undefined) ledgerEnvPath = path.join(tmpDir, 'alert-ledger.json');
  if (ledgerEnvPath) process.env.ALERT_LEDGER_PATH = ledgerEnvPath;
  else delete process.env.ALERT_LEDGER_PATH;
  // Mirrors ALERT_LEDGER_PATH above (BRO-1699 what-else finding): the digest
  // queue is now overridable + write-guarded the same way the ledger is, so
  // this must be set BEFORE require() resolves DIGEST_QUEUE_PATH — computed
  // here (not lower, alongside the other tmpDir-relative paths) specifically
  // so it's available this early.
  const priorDigestQueueEnv = process.env.ALERT_DIGEST_QUEUE_PATH;
  const digestPath = path.join(tmpDir, 'alert-digest-queue.json');
  process.env.ALERT_DIGEST_QUEUE_PATH = digestPath;
  // Same treatment for the attempts log (BRO-1699 systematic pass) — kept in
  // the returned object below since several tests write attempts-log fixture
  // rows directly via this path, outside logDispatchAttempt().
  const priorAttemptsLogEnv = process.env.ALERT_ATTEMPTS_LOG_PATH;
  const attemptsPath = path.join(tmpDir, 'alert-router-attempts.jsonl');
  process.env.ALERT_ATTEMPTS_LOG_PATH = attemptsPath;
  const modulePath = require.resolve('./owner-alert-router.js');
  const discordNotifyPath = require.resolve('./discord-notify.js');
  const linearClientPath = require.resolve('./linear-client.js');
  const linearIssueCreatePath = require.resolve('./linear-issue-create.js');
  const linearPath = require.resolve('./linear.js');

  delete require.cache[modulePath];
  delete require.cache[discordNotifyPath];
  delete require.cache[linearClientPath];
  delete require.cache[linearIssueCreatePath];
  delete require.cache[linearPath];

  const calls = { createLinearIssue: [], sendAlert: [], linearSearchIssues: [], linearGraphql: [] };

  // Stub linear-issue-create's createLinearIssue so card dispatch never
  // shells out or touches the network — default mirrors a real park-mode
  // create (`.issue.identifier` is what dispatchCard reads). Skipped under
  // useRealLinearIssueCreate: see header comment above.
  if (!useRealLinearIssueCreate) {
    require.cache[linearIssueCreatePath] = {
      id: linearIssueCreatePath,
      filename: linearIssueCreatePath,
      loaded: true,
      exports: {
        createLinearIssue: async (opts) => {
          calls.createLinearIssue.push(opts);
          if (createLinearIssueImpl) return createLinearIssueImpl(opts);
          return { issue: { id: 'uuid-opaque', identifier: 'BRO-999', title: opts.title }, mode: 'park', stateName: 'Backlog' };
        },
      },
    };
  }

  // Stub discord-notify's sendAlert so the human path never calls Resend.
  require.cache[discordNotifyPath] = {
    id: discordNotifyPath,
    filename: discordNotifyPath,
    loaded: true,
    exports: {
      sendAlert: async (opts) => {
        calls.sendAlert.push(opts);
        return sendAlertImpl ? sendAlertImpl(opts) : true;
      },
    },
  };

  // Stub linear-client's searchIssues (Phase 0 rail 2) so the router's
  // cross-system dedupe never makes a real GraphQL call in a test — default
  // is "no match found" (findLinearDuplicate treats a real Linear outage the
  // same way, via its own try/catch, but a test must never depend on network
  // or LINEAR_API_KEY being set on the machine running it). getTeam and
  // graphql are only actually exercised under useRealLinearIssueCreate (the
  // real chokepoint calls getTeam to resolve a backlog/unstarted state id,
  // then builds a LinearClient — scripts/lib/linear.js — around THIS
  // stubbed graphql executor, not linear.js's own network transport: see
  // linear-issue-create.js's header for why it reuses linear-client.js's
  // retry-aware graphql() as the injected executor).
  const DEFAULT_TEAM = {
    id: 'team-uuid',
    states: [
      { id: 'backlog-1', name: 'Backlog', type: 'backlog' },
      { id: 'todo-1', name: 'Todo', type: 'unstarted' },
    ],
  };
  require.cache[linearClientPath] = {
    id: linearClientPath,
    filename: linearClientPath,
    loaded: true,
    exports: {
      searchIssues: async (term) => {
        calls.linearSearchIssues.push(term);
        if (linearSearchIssuesImpl) return linearSearchIssuesImpl(term);
        return null;
      },
      getTeam: async () => (linearGetTeamImpl ? linearGetTeamImpl() : DEFAULT_TEAM),
      TEAM_KEY: 'BRO',
      graphql: async (query, variables) => {
        calls.linearGraphql.push({ query, variables });
        if (linearGraphqlImpl) return linearGraphqlImpl(query, variables);
        return {
          issueCreate: {
            success: true,
            issue: {
              id: 'uuid-opaque',
              identifier: 'BRO-999',
              title: variables?.input?.title,
              url: 'https://linear.app/broadway-scorecard/issue/BRO-999',
            },
          },
        };
      },
    },
  };

  const router = require(modulePath);
  // Point the ledger at the temp dir (module already resolved its paths at
  // require time — the ledger, digest queue, and attempts log are all
  // env-var overridable (set above, before require()) so their *_PATH
  // constants already resolve straight to the temp dir; only
  // TRACKED_LEDGER_PATH has no override, so it still needs the fs-remap
  // fallback below.
  const ledgerPath = path.join(tmpDir, 'alert-ledger.json');

  const realReadFileSync = fs.readFileSync;
  const realWriteFileSync = fs.writeFileSync;
  const realRenameSync = fs.renameSync;
  const realMkdirSync = fs.mkdirSync;

  function remap(p) {
    if (typeof p !== 'string') return p;
    if (!ledgerEnvPath && (p === router._LEDGER_PATH || p.startsWith(`${router._LEDGER_PATH}.tmp`))) {
      return p.replace(router._LEDGER_PATH, ledgerPath);
    }
    // loadLedger() seeds a local ledger from the git-tracked one on its first
    // run (card #693). Redirect the tracked path into the temp dir too, or a
    // local test run would read the repo's REAL alert-ledger.json while a CI
    // run (LEDGER_PATH === tracked path) would not — same test, two answers.
    if (p === router._TRACKED_LEDGER_PATH) return path.join(tmpDir, 'tracked-alert-ledger.json');
    return p;
  }

  fs.readFileSync = (p, ...rest) => realReadFileSync(remap(p), ...rest);
  fs.writeFileSync = (p, ...rest) => realWriteFileSync(remap(p), ...rest);
  fs.renameSync = (from, to) => realRenameSync(remap(from), remap(to));
  fs.mkdirSync = (p, ...rest) => realMkdirSync(remap(p), ...rest);

  function restore() {
    fs.readFileSync = realReadFileSync;
    fs.writeFileSync = realWriteFileSync;
    fs.renameSync = realRenameSync;
    fs.mkdirSync = realMkdirSync;
    delete require.cache[discordNotifyPath];
    delete require.cache[linearClientPath];
    delete require.cache[linearIssueCreatePath];
    delete require.cache[linearPath];
    delete require.cache[modulePath];
    if (priorLedgerEnv === undefined) delete process.env.ALERT_LEDGER_PATH;
    else process.env.ALERT_LEDGER_PATH = priorLedgerEnv;
    if (priorDigestQueueEnv === undefined) delete process.env.ALERT_DIGEST_QUEUE_PATH;
    else process.env.ALERT_DIGEST_QUEUE_PATH = priorDigestQueueEnv;
    if (priorAttemptsLogEnv === undefined) delete process.env.ALERT_ATTEMPTS_LOG_PATH;
    else process.env.ALERT_ATTEMPTS_LOG_PATH = priorAttemptsLogEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { router, calls, restore, attemptsPath, tmpDir, trackedLedgerPath: path.join(tmpDir, 'tracked-alert-ledger.json') };
}

// ── Rail 2: cross-system Linear dedupe (Phase 0, plan 2026-08-12, task #1341) ─
// findLinearDuplicate() gates dispatchCard()'s Notion filing on an OPEN
// Linear issue that already tracks the same conditionKey. See
// scripts/lib/linear-client.js's searchIssues (the only place that talks to
// Linear's GraphQL API) and scripts/lib/linear-dispatch.js's
// findOpenIssueForTerm (the pure match, tested separately in
// tests/unit/linear-next.test.mjs).

test('routeAlert: disposition=auto skips filing when Linear already tracks the conditionKey — no card, action:silent, identifier surfaced', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    linearSearchIssuesImpl: async () => ({ identifier: 'BRO-777', title: 'Already tracked' }),
  });
  const origLog = console.log;
  const logs = [];
  console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:linear-dup',
      title: 'Test alert',
      description: 'Something needs attention.',
      disposition: 'auto',
    });
    assert.equal(result.action, 'silent');
    assert.equal(result.cardId, null);
    assert.equal(result.linearIdentifier, 'BRO-777');
    assert.equal(calls.createLinearIssue.length, 0, 'must never file a Notion card once Linear already tracks it');
    assert.ok(logs.some(l => /conditionKey test:linear-dup already tracked as BRO-777 — not double-filing/.test(l)));

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:linear-dup'].status, 'open');
    assert.equal(ledger.conditions['test:linear-dup'].cardId, null);
    assert.equal(ledger.conditions['test:linear-dup'].linearIdentifier, 'BRO-777');
  } finally {
    console.log = origLog;
    restore();
  }
});

test('routeAlert: a Linear-deduped condition still gets ledger-cooldown protection — the 2nd call never re-queries Linear', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    linearSearchIssuesImpl: async () => ({ identifier: 'BRO-778', title: 'Already tracked' }),
  });
  try {
    await router.routeAlert({ conditionKey: 'test:linear-dup-cooldown', title: 't', description: 'd', disposition: 'auto' });
    await router.routeAlert({ conditionKey: 'test:linear-dup-cooldown', title: 't', description: 'd', disposition: 'auto' });
    assert.equal(calls.linearSearchIssues.length, 1, 'the 2nd call must be caught by the top-of-function ledger cooldown, not re-hit Linear');
    assert.equal(calls.createLinearIssue.length, 0);
  } finally {
    restore();
  }
});

test('routeAlert: rail-2 dedupe keeps the tracker reference — a Linear match means "no NEW tracker", and the ledger carries the matched identifier', async () => {
  let searchCalls = 0;
  const { router, restore } = loadRouterWithFakes({
    // 1st call: no Linear match → FILES a Linear issue (BRO-999, the default
    // stub, BRO-286). 2nd call (cooldown expired via cooldownHours:0): the
    // dedupe now matches (in production it would match the very issue the
    // 1st call filed) → rail-2 short-circuit, no second filing.
    linearSearchIssuesImpl: async () => (++searchCalls === 1 ? null : { identifier: 'BRO-999', title: 'Now tracked' }),
  });
  try {
    const first = await router.routeAlert({ conditionKey: 'test:cardid-preserved', title: 't', description: 'd', disposition: 'auto', cooldownHours: 0 });
    assert.equal(first.linearIdentifier, 'BRO-999', 'filing must surface the created issue identifier');
    assert.equal(first.cardId, null, 'no Notion card exists on the Linear path');
    const second = await router.routeAlert({ conditionKey: 'test:cardid-preserved', title: 't', description: 'd', disposition: 'auto', cooldownHours: 0 });
    assert.equal(second.action, 'silent');
    assert.equal(second.linearIdentifier, 'BRO-999');
    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:cardid-preserved'].linearIdentifier, 'BRO-999');
  } finally {
    restore();
  }
});

test('routeAlert: the cooldown short-circuit carries linearIdentifier on every silent refire — digest consumers stay truthful past the first call', async () => {
  const { router, restore } = loadRouterWithFakes({
    linearSearchIssuesImpl: async () => ({ identifier: 'BRO-779', title: 'Already tracked' }),
  });
  try {
    await router.routeAlert({ conditionKey: 'test:cooldown-linear-id', title: 't', description: 'd', disposition: 'auto' });
    const second = await router.routeAlert({ conditionKey: 'test:cooldown-linear-id', title: 't', description: 'd', disposition: 'auto' });
    assert.equal(second.action, 'silent');
    assert.equal(second.linearIdentifier, 'BRO-779', 'the 2nd+ silent call must surface WHERE the tracker lives, not just that it exists');
  } finally {
    restore();
  }
});

test('routeAlert: a Linear API failure FAILS OPEN — files the card as before, logs the fallback, never suppresses the alert', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    linearSearchIssuesImpl: async () => { throw new Error('LINEAR_API_KEY not set in .env or environment'); },
  });
  const origError = console.error;
  const errors = [];
  console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:linear-outage',
      title: 'Test alert',
      description: 'Something needs attention.',
      disposition: 'auto',
    });
    assert.equal(result.action, 'auto');
    assert.equal(result.linearIdentifier, 'BRO-999', 'the issue must still be filed — a Linear DEDUPE outage must never suppress the filing attempt');
    assert.equal(calls.createLinearIssue.length, 1);
    assert.ok(errors.some(e => /Linear dedupe check failed.*failing open/.test(e)));
  } finally {
    console.error = origError;
    restore();
  }
});

test('routeAlert: disposition=digest and disposition=human never query Linear (only "auto" files a new tracker)', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    await router.routeAlert({ conditionKey: 'test:linear-digest', title: 't', description: 'd', disposition: 'digest' });
    await router.routeAlert({
      conditionKey: 'alert-router:deadman', title: 't', description: 'd', disposition: 'human',
    });
    assert.equal(calls.linearSearchIssues.length, 0);
  } finally {
    restore();
  }
});

test("routeAlert: a filed card's notes embed a greppable [conditionKey:...] marker for future dedupe matching", async () => {
  const { router, restore } = loadRouterWithFakes({
    createLinearIssueImpl: (opts) => {
      assert.match(opts.description, /\[conditionKey:test:marker-check\]/);
      return { issue: { id: 'fake-uuid', identifier: 'BRO-999', title: opts.title }, mode: 'park', stateName: 'Backlog' };
    },
  });
  try {
    await router.routeAlert({ conditionKey: 'test:marker-check', title: 't', description: 'd', disposition: 'auto' });
  } finally {
    restore();
  }
});

test('findLinearDuplicate: matched:true + identifier when searchIssuesFn resolves an issue', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const result = await router.findLinearDuplicate('any-key', {
      searchIssuesFn: async () => ({ identifier: 'BRO-1', title: 'x' }),
    });
    assert.deepEqual(result, { matched: true, identifier: 'BRO-1' });
  } finally {
    restore();
  }
});

test('findLinearDuplicate: matched:false when searchIssuesFn resolves null', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const result = await router.findLinearDuplicate('any-key', { searchIssuesFn: async () => null });
    assert.deepEqual(result, { matched: false, identifier: null });
  } finally {
    restore();
  }
});

test('findLinearDuplicate: fails open (matched:false) and surfaces the real error when searchIssuesFn throws', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const result = await router.findLinearDuplicate('any-key', {
      searchIssuesFn: async () => { throw new Error('network down'); },
    });
    assert.equal(result.matched, false);
    assert.equal(result.identifier, null);
    assert.match(result.error, /network down/);
  } finally {
    restore();
  }
});

test('routeAlert: new incident with disposition=auto dispatches exactly one card', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:new-incident',
      title: 'Test alert',
      description: 'Something needs attention.',
      disposition: 'auto',
    });
    assert.equal(result.action, 'auto');
    assert.equal(result.linearIdentifier, 'BRO-999');
    assert.equal(result.cardId, null, 'Linear path files no Notion card (BRO-286)');
    assert.equal(calls.createLinearIssue.length, 1);
    // The filed issue must be parked, never auto-dispatched, with the
    // conditionKey embedded in the description it passes.
    const opts = calls.createLinearIssue[0];
    assert.ok(opts.park, 'alert filings are parked, never auto-dispatched');
    assert.equal(opts.dispatch, undefined);
    assert.match(opts.description, /\[conditionKey:test:new-incident\]/);
    assert.equal(calls.sendAlert.length, 0);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:new-incident'].status, 'open');
    assert.equal(ledger.conditions['test:new-incident'].notifyCount, 1);
    assert.equal(ledger.conditions['test:new-incident'].linearIdentifier, 'BRO-999');
  } finally {
    restore();
  }
});

// BRO-375 (Phase 1): dispatchCard() no longer shells out to linear-brain.js —
// it calls the REAL scripts/lib/linear-issue-create.js in-process, which
// creates the issue through scripts/lib/linear.js's injectable LinearClient
// (BRO-374). This is the one test in the file that does NOT stub
// createLinearIssue() itself (useRealLinearIssueCreate) — it stubs only the
// network layer underneath linear.js (a fake `graphql` executor) and
// linear-client's getTeam, then asserts the real chokepoint sent the exact
// ISSUE_CREATE_MUTATION text linear.js owns, with no Notion and no execFileSync
// anywhere in the path.
test('routeAlert: disposition=auto creates the Linear issue via the injectable client in scripts/lib/linear.js (BRO-374/BRO-375)', async () => {
  const { router, calls, restore } = loadRouterWithFakes({ useRealLinearIssueCreate: true });
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:linear-js-wiring',
      title: 'Real chokepoint wiring check',
      description: 'Something needs attention.',
      severity: 'error',
      disposition: 'auto',
    });
    assert.equal(result.action, 'auto');
    assert.equal(result.cardId, null, 'no Notion card — Linear is the only tracker');
    assert.equal(result.linearIdentifier, 'BRO-999');

    // Exactly one GraphQL round trip, and it went through linear.js's own
    // mutation text — not a hand-rolled query, not linear-client.js's.
    assert.equal(calls.linearGraphql.length, 1);
    assert.equal(calls.linearGraphql[0].query, REAL_ISSUE_CREATE_MUTATION);
    const { input } = calls.linearGraphql[0].variables;
    assert.equal(input.title, 'Real chokepoint wiring check');
    assert.equal(input.teamId, 'team-uuid');
    assert.equal(input.stateId, 'backlog-1', 'alert filings are parked (backlog state), never dispatched');
    assert.equal(input.priority, 2, 'severity:error maps to Linear priority 2 (High)');
    assert.match(input.description, /\[conditionKey:test:linear-js-wiring\]/);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:linear-js-wiring'].linearIdentifier, 'BRO-999');
  } finally {
    restore();
  }
});

test('routeAlert: a failed card dispatch is NOT recorded as notified — retries next call', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    createLinearIssueImpl: () => { throw new Error('Notion API down'); },
  });
  try {
    const first = await router.routeAlert({
      conditionKey: 'test:dispatch-fails',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    assert.equal(first.dispatchOk, false);
    // The real underlying error must be propagated, not just a boolean —
    // callers (health-check.js's digest instruction text, the E2E canary)
    // need it to avoid re-guessing a cause (2026-07-24 npm-ci postmortem).
    assert.match(first.dispatchError, /Notion API down/);
    // Ledger must NOT show this as an open/notified incident — otherwise the
    // silent-refire guard would suppress the real alert for a full cooldown
    // window even though nobody was ever actually told.
    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:dispatch-fails'], undefined);

    // A second call (e.g. next run, Notion recovered) must retry, not go silent.
    const second = await router.routeAlert({
      conditionKey: 'test:dispatch-fails',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    assert.equal(second.action, 'auto');
    assert.equal(calls.createLinearIssue.length, 2);
  } finally {
    restore();
  }
});

test('routeAlert: re-fire of an open incident within cooldown is silent (no second card)', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    await router.routeAlert({
      conditionKey: 'test:refire',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    const second = await router.routeAlert({
      conditionKey: 'test:refire',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    assert.equal(second.action, 'silent');
    // Only the first call actually dispatched a card.
    assert.equal(calls.createLinearIssue.length, 1);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:refire'].silentRefires, 1);
    assert.equal(ledger.conditions['test:refire'].notifyCount, 1);
  } finally {
    restore();
  }
});

test('routeAlert: resolveCondition then re-fire notifies again immediately (state change)', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    await router.routeAlert({
      conditionKey: 'test:state-change',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    const resolved = router.resolveCondition('test:state-change');
    assert.equal(resolved, true);

    const third = await router.routeAlert({
      conditionKey: 'test:state-change',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    assert.equal(third.action, 'auto');
    // Both the original incident and the reoccurrence dispatched cards.
    assert.equal(calls.createLinearIssue.length, 2);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:state-change'].status, 'open');
    assert.equal(ledger.conditions['test:state-change'].notifyCount, 2);
  } finally {
    restore();
  }
});

test('routeAlert: disposition=human on a page-worthy conditionKey calls sendAlert with email:true, never shells out', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    // 'alert-router:deadman' is on the page-worthy allowlist
    // (scripts/lib/page-worthy-alerts.js) — the router's own self-test must
    // always be able to page.
    const result = await router.routeAlert({
      conditionKey: 'alert-router:deadman',
      title: 'Needs a human',
      description: 'Owner judgment required',
      severity: 'critical',
      disposition: 'human',
    });
    assert.equal(result.action, 'human');
    assert.equal(result.delivered, true);
    assert.equal(calls.sendAlert.length, 1);
    assert.equal(calls.sendAlert[0].email, true);
    assert.equal(calls.createLinearIssue.length, 0);
  } finally {
    restore();
  }
});

test('routeAlert: disposition=human on a non-allowlisted conditionKey is downgraded to digest (card #611)', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:not-page-worthy',
      title: 'Needs a human, allegedly',
      description: 'Some sender asked for disposition human',
      severity: 'error',
      disposition: 'human',
    });
    // Downgraded — no email sent, effective action is 'digest'.
    assert.equal(result.action, 'digest');
    assert.equal(result.requestedDisposition, 'human');
    assert.equal(calls.sendAlert.length, 0);
    assert.equal(calls.createLinearIssue.length, 0);

    const queue = router.peekDigestQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].conditionKey, 'test:not-page-worthy');
    assert.equal(queue[0].title, 'Needs a human, allegedly');

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:not-page-worthy'].disposition, 'digest');
    assert.equal(ledger.conditions['test:not-page-worthy'].requestedDisposition, 'human');
  } finally {
    restore();
  }
});

test('isPageWorthy: allowlist matches exact keys and documented prefixes, rejects everything else', () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    assert.equal(router.isPageWorthy('alert-router:deadman'), true);
    assert.equal(router.isPageWorthy('e2e-canary:chain-broken'), true);
    assert.equal(router.isPageWorthy('on-monitor-launch-failed-2026-07-28'), true);
    assert.equal(router.isPageWorthy('broadcast:draft-creation-failed:broadway'), true);
    // opening-night-sla.js only advances its re-notify "peak" on disposition
    // 'human' — this MUST stay allowlisted or SLA breaches silently stop
    // re-paging after the first downgrade (ship-check adversarial finding).
    assert.equal(router.isPageWorthy('opening-night-sla:pages-stuck'), true);
    assert.equal(router.isPageWorthy('t1-coverage:new-gaps-24h'), false);
    assert.equal(router.isPageWorthy('secrets-health:Vercel'), false);
    assert.equal(router.isPageWorthy(''), false);
    assert.equal(router.isPageWorthy(undefined), false);
  } finally {
    restore();
  }
});

test('routeAlert: disposition=digest queues a line, no card, no email', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:digest',
      title: 'Digest item',
      description: 'fold into daily digest',
      disposition: 'digest',
    });
    assert.equal(result.action, 'digest');
    assert.equal(calls.createLinearIssue.length, 0);
    assert.equal(calls.sendAlert.length, 0);

    const drained = router.drainDigestQueue();
    assert.equal(drained.length, 1);
    assert.equal(drained[0].conditionKey, 'test:digest');
    // Draining clears the queue.
    const drainedAgain = router.drainDigestQueue();
    assert.equal(drainedAgain.length, 0);
  } finally {
    restore();
  }
});

test('peekDigestQueue does NOT clear — a consumer that throws before persisting keeps the lines', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    await router.routeAlert({
      conditionKey: 'regional-go-live:the-family-album-regional-2026',
      title: 'The Family Album @ La Jolla Playhouse — regional tryout live and scoring',
      url: 'https://broadwayscorecard.com/show/the-family-album-regional-2026',
      disposition: 'digest',
      severity: 'info',
    });

    // Peek twice: the line survives, because nothing has persisted it yet.
    const first = router.peekDigestQueue();
    assert.equal(first.length, 1);
    assert.equal(first[0].url, 'https://broadwayscorecard.com/show/the-family-album-regional-2026');
    const second = router.peekDigestQueue();
    assert.equal(second.length, 1, 'peek must be non-destructive — a drain here loses the line permanently');

    // Explicit clear (what the consumer does AFTER writing its snapshot).
    router.clearDigestQueue();
    assert.equal(router.peekDigestQueue().length, 0);
  } finally {
    restore();
  }
});

test('routeAlert: two regional go-lives in the same week both queue (per-show conditionKey, not a shared key)', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    for (const id of ['the-family-album-regional-2026', 'grim-regional-2026']) {
      await router.routeAlert({
        conditionKey: `regional-go-live:${id}`,
        title: `${id} live`,
        disposition: 'digest',
        severity: 'info',
      });
    }
    const queued = router.peekDigestQueue();
    assert.equal(queued.length, 2, 'a shared conditionKey would swallow the second show inside the 7-day cooldown');
    assert.equal(new Set(queued.map(q => q.conditionKey)).size, 2);
  } finally {
    restore();
  }
});

test('removeDigestLines + deleteCondition retract a queued go-live so the NEXT real one still notifies', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const key = 'regional-go-live:the-family-album-regional-2026';
    const queueOne = () => router.routeAlert({
      conditionKey: key, title: 'The Family Album live', disposition: 'digest', severity: 'info',
    });

    await queueOne();
    assert.equal(router.peekDigestQueue().length, 1);

    // Simulate the validate-data rollback: retract the line AND the ledger entry.
    assert.equal(router.removeDigestLines([key]), 1, 'the queued line is removed');
    assert.equal(router.peekDigestQueue().length, 0);
    router.deleteCondition(key);

    // The critical assertion: tomorrow's REAL promotion must not be swallowed by
    // the 7-day cooldown. Without deleteCondition this re-queues nothing.
    await queueOne();
    assert.equal(router.peekDigestQueue().length, 1, 'the next real go-live still reaches the digest');
  } finally {
    restore();
  }
});

test('removeDigestLines leaves unrelated queued lines alone and tolerates a corrupt entry', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    await router.routeAlert({ conditionKey: 'regional-go-live:a', title: 'A', disposition: 'digest', severity: 'info' });
    await router.routeAlert({ conditionKey: 'other:condition', title: 'B', disposition: 'digest', severity: 'info' });
    assert.equal(router.removeDigestLines(['regional-go-live:a']), 1);
    const left = router.peekDigestQueue();
    assert.equal(left.length, 1);
    assert.equal(left[0].conditionKey, 'other:condition');
    // A no-op removal must not rewrite or throw.
    assert.equal(router.removeDigestLines(['regional-go-live:does-not-exist']), 0);
    assert.equal(router.peekDigestQueue().length, 1);
  } finally {
    restore();
  }
});

test('promote-ob-venue-candidates.js uses a per-show conditionKey (guards the real producer, not a hand-written key)', async () => {
  // The sibling per-show test hand-writes the key, so it would still pass if the
  // producer regressed to a shared key. This asserts against the real source.
  const src = await readFile(new URL('../promote-ob-venue-candidates.js', import.meta.url), 'utf8');
  assert.match(src, /conditionKey:\s*`regional-go-live:\$\{p\.entry\.id\}`/,
    'promote script must build conditionKey from the show id; a shared key silently drops the 2nd go-live in a week');
  assert.match(src, /disposition:\s*'digest'/, 'go-live must route to the digest, not a suppressed info email');
});

test('routeAlert: disposition=human re-fire within an explicit cooldownHours is silent (no second email)', async () => {
  // Exercises the exact call pattern used by the email-noise Sprint 2 migration
  // (send-opening-night-broadcast.js gates, audit-show-review-gap.js WE-gate):
  // disposition='human' with an explicit cooldownHours=24 instead of the
  // 168h default. A retry hitting the SAME stuck condition must not re-email.
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    // 'broadcast:draft-creation-failed:' is a page-worthy prefix
    // (scripts/lib/page-worthy-alerts.js) — real callers append the market.
    const first = await router.routeAlert({
      conditionKey: 'broadcast:draft-creation-failed:broadway',
      title: 'Opening Night Broadcast Blocked — Orphan-Unscored Reviews',
      description: 'desc',
      severity: 'error',
      disposition: 'human',
      cooldownHours: 24,
    });
    assert.equal(first.action, 'human');
    assert.equal(first.delivered, true);

    // Simulated retry (same run repeating, or a later CI retry) — must go silent.
    const second = await router.routeAlert({
      conditionKey: 'broadcast:draft-creation-failed:broadway',
      title: 'Opening Night Broadcast Blocked — Orphan-Unscored Reviews',
      description: 'desc',
      severity: 'error',
      disposition: 'human',
      cooldownHours: 24,
    });
    assert.equal(second.action, 'silent');
    assert.equal(calls.sendAlert.length, 1);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['broadcast:draft-creation-failed:broadway'].silentRefires, 1);
  } finally {
    restore();
  }
});

test('routeAlert: rejects an invalid disposition', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    await assert.rejects(
      () => router.routeAlert({ conditionKey: 'test:bad', title: 'x', disposition: 'carrier-pigeon' }),
      /invalid disposition/
    );
  } finally {
    restore();
  }
});

test('routeAlert: rejects a missing conditionKey', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    await assert.rejects(
      () => router.routeAlert({ title: 'x', disposition: 'auto' }),
      /conditionKey/
    );
  } finally {
    restore();
  }
});

test('deleteCondition: hard-removes an open condition; no-op on an unknown key', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    await router.routeAlert({
      conditionKey: 'test:to-delete',
      title: 'x',
      description: 'desc',
      disposition: 'auto',
    });
    assert.ok(router.loadLedger().conditions['test:to-delete']);

    assert.equal(router.deleteCondition('test:to-delete'), true);
    assert.equal(router.loadLedger().conditions['test:to-delete'], undefined);
    assert.equal(router.deleteCondition('test:never-existed'), false);
  } finally {
    restore();
  }
});

// Card #374 (E2E canary + swallowed-error audit postmortem): the attempts
// log is what lets health-check.js's deadman check distinguish "auto-dispatch
// never fired" from "auto-dispatch fired repeatedly and always failed" — the
// ledger alone can't, because a failed dispatch is deliberately never written
// there (see the test above).
test('readDispatchAttempts: records both successes and failures, independent of the ledger', async () => {
  const { router, restore } = loadRouterWithFakes({
    createLinearIssueImpl: () => { throw new Error("Cannot find module '@notionhq/client'"); },
  });
  try {
    await router.routeAlert({ conditionKey: 'test:attempt-a', title: 'a', description: 'd', disposition: 'auto' });
    await router.routeAlert({ conditionKey: 'test:attempt-b', title: 'b', description: 'd', disposition: 'auto' });

    const attempts = router.readDispatchAttempts({ days: 7 });
    assert.equal(attempts.length, 2);
    assert.ok(attempts.every(a => a.ok === false));
    assert.match(attempts[attempts.length - 1].error, /@notionhq\/client/);

    // Every attempt failed, so the ledger stays empty — this is the exact gap
    // a ledger-only deadman check would miss.
    assert.deepEqual(router.loadLedger().conditions, {});
  } finally {
    restore();
  }
});

test('readDispatchAttempts: a successful dispatch is also logged (ok=true)', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    await router.routeAlert({ conditionKey: 'test:attempt-ok', title: 'ok', description: 'd', disposition: 'auto' });
    const attempts = router.readDispatchAttempts({ days: 7 });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].ok, true);
  } finally {
    restore();
  }
});

// Ship-check finding (card #374): health-check.js's deadman check takes
// attempts[attempts.length - 1] as "the most recent attempt" — that's only
// correct if readDispatchAttempts() sorts by ts. The append-then-rewrite
// writer normally preserves chronological order, but a rebase conflict
// resolution or manual edit could disturb it, so the reader must not trust
// raw file order.
test('readDispatchAttempts: sorts by ts even when the file is out of chronological order', async () => {
  const { router, restore, attemptsPath } = loadRouterWithFakes();
  try {
    // Relative to Date.now() (readDispatchAttempts filters against real wall-clock
    // time, not a fake clock) so this fixture never drifts outside the `days: 30`
    // window — a hardcoded absolute date did exactly that (card #1799).
    const now = Date.now();
    const daysAgo = n => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();
    const lines = [
      { ts: daysAgo(3), conditionKey: 'test:c', title: 'c', ok: true, error: null },
      { ts: daysAgo(1), conditionKey: 'test:a', title: 'a', ok: false, error: 'newest' },
      { ts: daysAgo(2), conditionKey: 'test:b', title: 'b', ok: true, error: null },
    ];
    fs.mkdirSync(path.dirname(attemptsPath), { recursive: true });
    fs.writeFileSync(attemptsPath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

    const sorted = router.readDispatchAttempts({ days: 30 });
    assert.deepEqual(sorted.map(a => a.conditionKey), ['test:c', 'test:b', 'test:a']);
    // The most recent attempt (last element) must be the one with the latest ts.
    assert.equal(sorted[sorted.length - 1].error, 'newest');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Card #693: cooldown state written by a LOCAL sender must survive a
// concurrent `git checkout` / `git reset --hard` in the shared working tree.
// Live failure: the launcher's on-monitor-launch-failed-<night> alert
// (cooldownHours: 3) emailed twice 21 minutes apart on 2026-07-31 and the
// tracked ledger recorded neither send.
// ---------------------------------------------------------------------------

// Restores the git-tracked ledger to its HEAD content, discarding whatever an
// uncommitted local write had put there — what `git checkout -- data/audit`
// (or a rebase, or `reset --hard`) does to a launchd sender's ledger write.
function simulateGitCheckoutWipe(trackedLedgerPath, headContent = { conditions: {} }) {
  fs.mkdirSync(path.dirname(trackedLedgerPath), { recursive: true });
  fs.writeFileSync(trackedLedgerPath, JSON.stringify(headContent, null, 2) + '\n');
}

test('local ledger: cooldown holds across a git checkout that wipes the tracked ledger', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-router-local-state-'));
  const localLedger = path.join(stateDir, 'alert-ledger.json');
  const { router, calls, restore, trackedLedgerPath } = loadRouterWithFakes({ ledgerEnvPath: localLedger });
  try {
    const opts = {
      conditionKey: 'on-monitor-launch-failed-2026-07-31',
      title: 'monitor pass FAILED for tao-of-glass-west-end-2026',
      description: 'launch attempt failed',
      disposition: 'auto',
      cooldownHours: 3,
    };
    const first = await router.routeAlert(opts);
    assert.equal(first.action, 'auto');

    // The write landed on the local ledger, and NOT on the git-tracked one —
    // nothing the launcher writes should be sitting uncommitted in data/audit.
    assert.ok(fs.existsSync(localLedger), 'local ledger file was written');
    assert.equal(fs.existsSync(trackedLedgerPath), false, 'tracked ledger untouched by a local sender');

    simulateGitCheckoutWipe(trackedLedgerPath);

    const second = await router.routeAlert(opts);
    assert.equal(second.action, 'silent', 'second call inside the 3h cooldown is suppressed');
    assert.equal(calls.createLinearIssue.length, 1, 'exactly one dispatch, not two');
    assert.equal(router.loadLedger().conditions[opts.conditionKey].silentRefires, 1);
  } finally {
    restore();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// Falsification control: with the ledger left on the git-tracked path (what CI
// uses, and what every local sender used before this fix), the same wipe DOES
// re-fire. Without this, the test above could pass for the wrong reason.
test('tracked ledger: the same git checkout wipe re-fires the alert (the bug being fixed)', async () => {
  const { router, calls, restore, tmpDir } = loadRouterWithFakes();
  const wipedLedger = path.join(tmpDir, 'alert-ledger.json'); // where remap() sends _LEDGER_PATH
  try {
    const opts = {
      conditionKey: 'on-monitor-launch-failed-2026-07-31',
      title: 'monitor pass FAILED for tao-of-glass-west-end-2026',
      description: 'launch attempt failed',
      disposition: 'auto',
      cooldownHours: 3,
    };
    await router.routeAlert(opts);
    assert.ok(fs.existsSync(wipedLedger));

    simulateGitCheckoutWipe(wipedLedger);

    const second = await router.routeAlert(opts);
    assert.equal(second.action, 'auto', 'cooldown record is gone, so it notifies again');
    assert.equal(calls.createLinearIssue.length, 2, 'the observed double-send');
  } finally {
    restore();
  }
});

test('ledger path resolution: CI uses the tracked ledger, local execution does not', async () => {
  // Explicit null: this test asserts the BARE-env resolution logic (read-only
  // — any write would trip the saveLedger node:test guard).
  const { router, restore } = loadRouterWithFakes({ ledgerEnvPath: null });
  try {
    // The unit-test process itself is the local case unless CI is set; either
    // way the resolved path must be one of the two known ledgers, never a
    // worktree-relative or cwd-relative file.
    const resolved = router.ledgerPath();
    assert.ok(
      resolved === router._TRACKED_LEDGER_PATH || resolved === router._LOCAL_LEDGER_PATH,
      `unexpected ledger path: ${resolved}`
    );
    assert.equal(router.isLocalLedger(), resolved === router._LOCAL_LEDGER_PATH);
    // The local ledger must live outside every git checkout — a path under the
    // repo (or a worktree) is exactly what concurrent git ops clobber.
    assert.equal(router._LOCAL_LEDGER_PATH.startsWith(os.homedir()), true);
    assert.equal(router._LOCAL_LEDGER_PATH.includes('/Broadwayscore/'), false);
    // And the two are genuinely different files — a same-path "fix" would make
    // every assertion above vacuous.
    assert.notEqual(router._LOCAL_LEDGER_PATH, router._TRACKED_LEDGER_PATH);
  } finally {
    restore();
  }
});

test('local ledger seeds from the committed CI ledger on first use (no cooldown reset storm)', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-router-seed-'));
  const localLedger = path.join(stateDir, 'alert-ledger.json');
  const { router, calls, restore, trackedLedgerPath } = loadRouterWithFakes({ ledgerEnvPath: localLedger });
  try {
    // The local ledger does not exist yet; the committed one already records
    // this condition as notified 10 minutes ago.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    simulateGitCheckoutWipe(trackedLedgerPath, {
      conditions: {
        'ci-condition': {
          status: 'open',
          disposition: 'digest',
          title: 'already notified by CI',
          firstSeen: tenMinAgo,
          lastSeen: tenMinAgo,
          lastNotifiedAt: tenMinAgo,
          notifyCount: 1,
        },
      },
    });
    assert.equal(fs.existsSync(localLedger), false, 'local ledger absent before the first call');
    assert.equal(router.loadLedger().conditions['ci-condition'].notifyCount, 1,
      'the committed ledger seeds the local one on first read');

    const result = await router.routeAlert({
      conditionKey: 'ci-condition',
      title: 'already notified by CI',
      description: 'desc',
      disposition: 'auto',
      cooldownHours: 3,
    });
    assert.equal(result.action, 'silent', 'CI already notified this inside the cooldown');
    assert.equal(calls.createLinearIssue.length, 0, 'no duplicate dispatch on the local sender');
    // The seeded copy is now persisted locally; the tracked file is never written.
    assert.ok(fs.existsSync(localLedger));
  } finally {
    restore();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// The ledger is written AFTER the card/email has gone out. An unwritable
// ledger path (no HOME under a launchd agent, full disk, permissions) must
// therefore degrade to "logged loudly, may re-notify next run" — never take
// down the caller's whole check, which for health-check.js would mean losing
// every remaining condition in that run.
test('an unwritable ledger path does not throw — the alert still dispatches, loudly', async () => {
  const unwritable = path.join(os.tmpdir(), 'alert-router-unwritable', 'not-a-dir', 'alert-ledger.json');
  fs.mkdirSync(path.dirname(path.dirname(unwritable)), { recursive: true });
  fs.writeFileSync(path.dirname(unwritable), 'this is a FILE, so mkdir of the ledger dir must fail\n');
  const { router, calls, restore } = loadRouterWithFakes({ ledgerEnvPath: unwritable });
  const errors = [];
  const realConsoleError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:unwritable-ledger',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    assert.equal(result.action, 'auto', 'the card was still dispatched');
    assert.equal(calls.createLinearIssue.length, 1);
    assert.ok(errors.some(e => e.includes('FAILED to persist the ledger')),
      'a ledger that cannot be written must be reported, not swallowed');
  } finally {
    console.error = realConsoleError;
    restore();
    fs.rmSync(path.dirname(path.dirname(unwritable)), { recursive: true, force: true });
  }
});
