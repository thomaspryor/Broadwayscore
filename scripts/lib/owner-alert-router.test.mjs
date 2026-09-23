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

// Same treatment for linear-issue-create.js's isUsageLimitExceeded (BRO-281):
// it's a pure predicate over an Error's shape/message, no network — the
// createLinearIssue stub below still needs to re-export it verbatim so
// dispatchCard()'s `const { createLinearIssue, isUsageLimitExceeded } =
// require('./linear-issue-create')` doesn't get `isUsageLimitExceeded ===
// undefined` once this module is stubbed out of require.cache.
const { isUsageLimitExceeded: REAL_IS_USAGE_LIMIT_EXCEEDED } = require('./linear-issue-create.js');

// Same treatment for intake-breaker.js's LEDGER_PATH (BRO-2656): captured once
// here, before any test can run. The useRealLinearIssueCreate test below
// exercises the REAL scripts/lib/linear-issue-create.js chokepoint, which
// calls the REAL intake-breaker.js recordCreated()/checkIntake() with no path
// override — those hit LEDGER_PATH's default, i.e. this exact value. remap()
// below intercepts fs calls made against this path so the real production
// ledger is never touched, without changing intake-breaker.js's code or
// reloading it via require.cache (its exported functions are pure fs I/O
// under whatever path is on disk).
const { LEDGER_PATH: REAL_INTAKE_LEDGER_PATH } = require('./intake-breaker.js');

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
        isUsageLimitExceeded: REAL_IS_USAGE_LIMIT_EXCEEDED,
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
  const realAppendFileSync = fs.appendFileSync;
  // BRO-2656: intake-breaker.js's LEDGER_PATH has no env override (unlike the
  // alert ledger above), so — same fallback as TRACKED_LEDGER_PATH — this
  // needs an exact-path fs remap. Isolates the useRealLinearIssueCreate test's
  // real chokepoint call (linear-issue-create.js -> intake-breaker.js
  // recordCreated()/checkIntake()) from the real ledger file on disk.
  const intakeLedgerPath = path.join(tmpDir, 'intake-ledger.jsonl');

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
    if (p === REAL_INTAKE_LEDGER_PATH) return intakeLedgerPath;
    // recordCreated() calls fs.mkdirSync(path.dirname(ledgerPath), ...) before
    // appending (intake-breaker.js:139) — the dirname, not the exact ledger
    // path, so it needs its own case here or it falls through to the real
    // fs.mkdirSync against the production data/audit/ directory (ship-check
    // finding, BRO-2656: harmless today only because that directory already
    // exists on disk, making a recursive mkdirSync a no-op).
    if (p === path.dirname(REAL_INTAKE_LEDGER_PATH)) return path.dirname(intakeLedgerPath);
    return p;
  }

  fs.readFileSync = (p, ...rest) => realReadFileSync(remap(p), ...rest);
  fs.writeFileSync = (p, ...rest) => realWriteFileSync(remap(p), ...rest);
  fs.renameSync = (from, to) => realRenameSync(remap(from), remap(to));
  fs.mkdirSync = (p, ...rest) => realMkdirSync(remap(p), ...rest);
  fs.appendFileSync = (p, ...rest) => realAppendFileSync(remap(p), ...rest);

  function restore() {
    fs.readFileSync = realReadFileSync;
    fs.writeFileSync = realWriteFileSync;
    fs.renameSync = realRenameSync;
    fs.mkdirSync = realMkdirSync;
    fs.appendFileSync = realAppendFileSync;
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

// BRO-2656: the test above exercises the REAL scripts/lib/linear-issue-create.js
// chokepoint, which calls the REAL scripts/lib/intake-breaker.js
// recordCreated()/checkIntake() with no ledgerPath override — those default to
// LEDGER_PATH, i.e. REAL_INTAKE_LEDGER_PATH captured at file top. Before the
// remap() fix above, this test appended a synthetic "Real chokepoint wiring
// check" row to that real file every run (158 accumulated in production
// before this was caught). This asserts the real file is untouched by a full
// routeAlert() round trip through the real chokepoint.
test('routeAlert (BRO-2656): the real chokepoint call never writes to the production intake ledger', async () => {
  const before = fs.existsSync(REAL_INTAKE_LEDGER_PATH)
    ? fs.readFileSync(REAL_INTAKE_LEDGER_PATH, 'utf8') : null;
  const { router, restore } = loadRouterWithFakes({ useRealLinearIssueCreate: true });
  try {
    await router.routeAlert({
      conditionKey: 'test:intake-ledger-isolation',
      title: 'BRO-2656 ledger isolation check',
      description: 'Must not touch the real intake ledger.',
      severity: 'error',
      disposition: 'auto',
    });
  } finally {
    restore();
  }
  const after = fs.existsSync(REAL_INTAKE_LEDGER_PATH)
    ? fs.readFileSync(REAL_INTAKE_LEDGER_PATH, 'utf8') : null;
  assert.equal(after, before, 'real data/audit/intake-ledger.jsonl must be untouched by this test suite');
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

// BRO-281: hitting Linear's usage limit (e.g. the free-tier 250-issue cap)
// makes createLinearIssue() throw USAGE_LIMIT_EXCEEDED — the Notion-era
// router degraded that to the same "logged warning, retry next call" path as
// any other dispatch failure, so the ceiling being hit went unnoticed
// mid-migration on 2026-08-12. This must page the owner, not just log, and it
// must do so regardless of the caller's requested disposition (an 'auto'
// request here has no page-worthy allowlist entry of its own, so a normal
// dispatch failure would never reach sendAlert at all).
//
// The escalation is routed through routeAlert() itself (conditionKey
// 'alert-router:usage-limit-exceeded', disposition:'human') rather than a raw
// sendAlert() call, so it gets the SAME ledger/cooldown protection as every
// other alert in this file — see the two tests below for why an unthrottled
// direct sendAlert() was rejected (ship-check finding: guaranteed inbox storm
// while the cap stays hit, since a failed dispatch is deliberately never
// ledgered and therefore retries — and pages — on every single call).
test('routeAlert: a USAGE_LIMIT_EXCEEDED dispatch failure pages the owner, unlike an ordinary dispatch failure', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    createLinearIssueImpl: () => {
      const err = new Error('Linear issue creation refused: USAGE_LIMIT_EXCEEDED — the workspace is at (or near) the free-tier 250-issue cap.');
      throw err;
    },
  });
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:usage-limit-exceeded',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    assert.equal(result.dispatchOk, false);
    assert.equal(result.usageLimitExceeded, true);
    assert.match(result.dispatchError, /USAGE_LIMIT_EXCEEDED/);

    // The escalation is an immediate page under its OWN conditionKey, not the
    // routed disposition's own channel — a 'digest'/'auto' failure normally
    // never calls sendAlert.
    assert.equal(calls.sendAlert.length, 1, 'a USAGE_LIMIT_EXCEEDED failure must page the owner');
    assert.equal(calls.sendAlert[0].email, true);
    assert.equal(calls.sendAlert[0].severity, 'critical');
    assert.match(calls.sendAlert[0].title, /Linear usage limit/);
    assert.match(calls.sendAlert[0].description, /test:usage-limit-exceeded/);

    // The escalation's OWN conditionKey is now ledgered as notified (it went
    // through routeAlert(), unlike the failed alert itself below).
    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['alert-router:usage-limit-exceeded'].status, 'open');

    // The ORIGINAL failed alert is still not recorded as notified — same
    // "will retry next call" contract as any other failed dispatch (the
    // ledger doesn't lie about a card that was never actually filed).
    assert.equal(ledger.conditions['test:usage-limit-exceeded'], undefined);
  } finally {
    restore();
  }
});

test('routeAlert: an ordinary (non-cap) dispatch failure does NOT page the owner — only USAGE_LIMIT_EXCEEDED escalates', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    createLinearIssueImpl: () => { throw new Error('some transient network error'); },
  });
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:ordinary-dispatch-failure',
      title: 'Test alert',
      description: 'desc',
      disposition: 'auto',
    });
    assert.equal(result.dispatchOk, false);
    assert.equal(result.usageLimitExceeded, undefined);
    assert.equal(calls.sendAlert.length, 0, 'an ordinary dispatch failure must not page — only the cap-hit escalates');
  } finally {
    restore();
  }
});

// The exact scenario both ship-check reviewers flagged against the FIRST
// version of this fix: while the cap stays hit, every 'auto' alert across
// every conditionKey fails on every call (failed dispatches are never
// ledgered, by design, so they always retry). An unthrottled escalation would
// therefore send one critical email per failed call — a same-day inbox storm.
// Routing the escalation through routeAlert()'s own cooldown means only the
// FIRST of any number of distinct failing conditionKeys/calls actually pages.
test('routeAlert: repeated USAGE_LIMIT_EXCEEDED failures across many conditionKeys page ONCE, not once per call (no inbox storm)', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    createLinearIssueImpl: () => { throw new Error('USAGE_LIMIT_EXCEEDED: workspace at free-tier cap'); },
  });
  try {
    // Simulate a health-check style run: many distinct alert call sites, each
    // with its own conditionKey, all trying to auto-dispatch while the cap is
    // hit — plus the SAME conditionKey retried on a later call.
    for (const key of ['test:storm-a', 'test:storm-b', 'test:storm-c', 'test:storm-a']) {
      await router.routeAlert({ conditionKey: key, title: 't', description: 'd', disposition: 'auto' });
    }
    assert.equal(calls.createLinearIssue.length, 4, 'every failing dispatch attempt still retries (unchanged contract)');
    assert.equal(calls.sendAlert.length, 1, 'only the FIRST failure escalates — the cooldown suppresses the rest');
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

// ── BRO-3030: digest escalation — a 'digest' condition that re-notifies past
// ESCALATION_NOTIFY_THRESHOLD with no tracker attached gets one automatically
// filed, then goes quiet (short "still open" reminder only every
// DEFAULT_COOLDOWN_HOURS) instead of repeating the full line forever. ──────

test('decideDigestEscalation: pure boundary — promotes at notifyCount>14, not at exactly 14, when untracked', () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const { decideDigestEscalation, ESCALATION_NOTIFY_THRESHOLD } = router;
    assert.equal(ESCALATION_NOTIFY_THRESHOLD, 14);
    assert.equal(decideDigestEscalation({ existing: null, notifyCount: 14, now: Date.now() }).action, 'normal');
    assert.equal(decideDigestEscalation({ existing: undefined, notifyCount: 15, now: Date.now() }).action, 'promote');
    // Real starting values from the audit (BRO-3030): conditions already sat
    // at notifyCount 31-39 when this shipped — an off-by-one against a small
    // fixture wouldn't catch a bug that only shows up against a large,
    // already-past-threshold existing count.
    assert.equal(decideDigestEscalation({ existing: { notifyCount: 34 }, notifyCount: 35, now: Date.now() }).action, 'promote');
  } finally {
    restore();
  }
});

test('decideDigestEscalation: pure — already-tracked stays quiet inside the resurface window, resurfaces once it elapses', () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const { decideDigestEscalation, DEFAULT_COOLDOWN_HOURS } = router;
    const now = Date.now();
    const justSurfaced = new Date(now - 1000).toISOString();
    const longAgo = new Date(now - (DEFAULT_COOLDOWN_HOURS + 1) * 60 * 60 * 1000).toISOString();
    assert.equal(decideDigestEscalation({
      existing: { linearIdentifier: 'BRO-999', lastSurfacedAt: justSurfaced }, notifyCount: 40, now,
    }).action, 'quiet');
    assert.equal(decideDigestEscalation({
      existing: { linearIdentifier: 'BRO-999', lastSurfacedAt: longAgo }, notifyCount: 40, now,
    }).action, 'resurface');
    // No lastSurfacedAt at all on an otherwise-tracked row (defensive —
    // should never happen in practice, but a condition tracked via the rail-2
    // dedupe-match path before that path set lastSurfacedAt too would land
    // here) must resurface rather than throw or stay silent forever.
    assert.equal(decideDigestEscalation({
      existing: { linearIdentifier: 'BRO-999', lastSurfacedAt: null }, notifyCount: 40, now,
    }).action, 'resurface');
    // A row carrying the OLD field name (lastNotifiedAt, no lastSurfacedAt)
    // must also resurface, not silently misread lastNotifiedAt as if it were
    // lastSurfacedAt — this is the exact confusion the ship-check catch was.
    assert.equal(decideDigestEscalation({
      existing: { linearIdentifier: 'BRO-999', lastNotifiedAt: justSurfaced }, notifyCount: 40, now,
    }).action, 'resurface');
  } finally {
    restore();
  }
});

test('routeAlert: a digest condition escalates to a filed tracker exactly on the call that crosses notifyCount>14, not before', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    for (let i = 1; i <= 14; i++) {
      const r = await router.routeAlert({
        conditionKey: 'test:digest-escalation', title: 'Noisy check', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
      assert.equal(r.action, 'digest', `call ${i} should stay on the digest path (below threshold)`);
    }
    assert.equal(calls.createLinearIssue.length, 0, 'must not file before notifyCount>14');
    assert.equal(router.loadLedger().conditions['test:digest-escalation'].notifyCount, 14);

    const escalated = await router.routeAlert({
      conditionKey: 'test:digest-escalation', title: 'Noisy check', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(escalated.action, 'auto', 'the 15th call is promoted so it reuses the auto dedupe/dispatch/persist path');
    assert.equal(calls.createLinearIssue.length, 1);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:digest-escalation'].linearIdentifier, 'BRO-999');
    assert.equal(ledger.conditions['test:digest-escalation'].notifyCount, 15);

    const queued = router.drainDigestQueue();
    assert.equal(queued.length, 1);
    assert.match(queued[0].title, /escalated after 15 notifications/);
    assert.match(queued[0].description, /Filed BRO-999/);
  } finally {
    restore();
  }
});

test('routeAlert: an escalated condition stays quiet on the next call, then resurfaces a short reminder once DEFAULT_COOLDOWN_HOURS elapses — never a repeat of the full noisy line', async () => {
  const { router, calls, restore, tmpDir } = loadRouterWithFakes();
  try {
    for (let i = 1; i <= 15; i++) {
      await router.routeAlert({
        conditionKey: 'test:digest-quiet', title: 'Noisy check', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
    }
    assert.equal(calls.createLinearIssue.length, 1, 'escalated once at call 15');
    router.drainDigestQueue(); // clear the one-time "escalated" line

    // Call 16, immediately after escalation: must NOT re-file and must NOT
    // queue anything (still inside the 7-day resurface window).
    const quiet = await router.routeAlert({
      conditionKey: 'test:digest-quiet', title: 'Noisy check', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(quiet.action, 'digest');
    assert.equal(calls.createLinearIssue.length, 1, 'must not re-file while already tracked');
    assert.equal(router.peekDigestQueue().length, 0, 'must not repeat the full noisy line once tracked');

    // Force the resurface window to have elapsed by rewriting lastSurfacedAt
    // directly on the temp ledger file (the router has no setter for this —
    // it is real production drift, not a router-controlled clock). NOT
    // lastNotifiedAt — that field is intentionally NOT what the resurface
    // decision keys on (see decideDigestEscalation's header + the regression
    // test right below this one, which proves why).
    const ledgerPath = path.join(tmpDir, 'alert-ledger.json');
    const onDisk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    onDisk.conditions['test:digest-quiet'].lastSurfacedAt = new Date(Date.now() - (router.DEFAULT_COOLDOWN_HOURS + 1) * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(ledgerPath, JSON.stringify(onDisk, null, 2) + '\n');

    const resurfaced = await router.routeAlert({
      conditionKey: 'test:digest-quiet', title: 'Noisy check', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(resurfaced.action, 'digest');
    assert.equal(calls.createLinearIssue.length, 1, 'a resurface reminder is not a re-file');
    const queued = router.drainDigestQueue();
    assert.equal(queued.length, 1);
    assert.match(queued[0].title, /still open — BRO-999/);
  } finally {
    restore();
  }
});

test('routeAlert: a promoted digest escalation still runs the rail-2 Linear dedupe — an already-tracked conditionKey (e.g. filed by another card) is not double-filed', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    linearSearchIssuesImpl: async () => ({ identifier: 'BRO-2943' }),
  });
  try {
    for (let i = 1; i <= 14; i++) {
      await router.routeAlert({
        conditionKey: 'test:digest-dedupe', title: 'Shared circuit-breaker condition', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
    }
    const result = await router.routeAlert({
      conditionKey: 'test:digest-dedupe', title: 'Shared circuit-breaker condition', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(result.action, 'silent', 'rail-2 dedupe short-circuits before any new card is filed');
    assert.equal(result.linearIdentifier, 'BRO-2943');
    assert.equal(calls.createLinearIssue.length, 0, 'must not file a duplicate tracker for a conditionKey another card already tracks');
    assert.equal(router.loadLedger().conditions['test:digest-dedupe'].linearIdentifier, 'BRO-2943');
  } finally {
    restore();
  }
});

test('routeAlert: a failed dispatch during digest escalation does not mark the condition tracked, falls back to the plain line so the owner stays informed, and retries next call', async () => {
  let dispatchAttempts = 0;
  const { router, calls, restore } = loadRouterWithFakes({
    createLinearIssueImpl: async () => {
      dispatchAttempts++;
      if (dispatchAttempts === 1) throw new Error('Linear API unavailable');
      return { issue: { id: 'uuid-opaque', identifier: 'BRO-999', title: 't' }, mode: 'park', stateName: 'Backlog' };
    },
  });
  try {
    for (let i = 1; i <= 14; i++) {
      await router.routeAlert({
        conditionKey: 'test:digest-dispatch-fail', title: 'Flaky escalation', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
    }
    const failedCall = await router.routeAlert({
      conditionKey: 'test:digest-dispatch-fail', title: 'Flaky escalation', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(dispatchAttempts, 1);
    assert.equal(failedCall.dispatchOk, false);
    assert.equal(router.loadLedger().conditions['test:digest-dispatch-fail'].linearIdentifier, null,
      'a failed dispatch must not be recorded as tracked');
    assert.equal(router.loadLedger().conditions['test:digest-dispatch-fail'].notifyCount, 14,
      'ledger is not persisted on a failed notify, so the next call retries from the same count');
    const fallbackLine = router.drainDigestQueue();
    assert.equal(fallbackLine.length, 1, 'the owner still sees the plain line on a failed escalation attempt, not silence');
    assert.equal(fallbackLine[0].title, 'Flaky escalation');

    const retried = await router.routeAlert({
      conditionKey: 'test:digest-dispatch-fail', title: 'Flaky escalation', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(retried.action, 'auto', 'the next call retries escalation from the same unpersisted state and succeeds');
    assert.equal(dispatchAttempts, 2);
    assert.equal(router.loadLedger().conditions['test:digest-dispatch-fail'].linearIdentifier, 'BRO-999');
  } finally {
    restore();
  }
});

test('routeAlert: resolveCondition() after an escalation does not clear the filed tracker — a reoccurrence does not file a second card (matches existing cardId/linearIdentifier survival for every other disposition)', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    for (let i = 1; i <= 15; i++) {
      await router.routeAlert({
        conditionKey: 'test:digest-resolve-reoccur', title: 'Recurs sometimes', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
    }
    assert.equal(calls.createLinearIssue.length, 1);
    const filedIdentifier = router.loadLedger().conditions['test:digest-resolve-reoccur'].linearIdentifier;
    assert.equal(filedIdentifier, 'BRO-999');

    assert.equal(router.resolveCondition('test:digest-resolve-reoccur'), true);
    assert.equal(router.loadLedger().conditions['test:digest-resolve-reoccur'].status, 'resolved');

    await router.routeAlert({
      conditionKey: 'test:digest-resolve-reoccur', title: 'Recurs sometimes', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(calls.createLinearIssue.length, 1, 'a reoccurrence must not file a second tracker while the old identifier is still on the row');
    assert.equal(router.loadLedger().conditions['test:digest-resolve-reoccur'].linearIdentifier, filedIdentifier);
  } finally {
    restore();
  }
});

// Ship-check catch (Bug 1): decideDigestEscalation originally keyed the
// resurface decision on `lastNotifiedAt`, which the bottom ledger write
// stamps to `now` on EVERY non-silent call including a 'quiet' one. Real
// digest callers pass short cooldownHours (dispatch-drift-watch.js: 6,
// check-corpus-drift.js: 1, cmux-reachability-check.js: 24) and call
// routeAlert() about that often, so the "hours since last notified" gap
// never accumulated to DEFAULT_COOLDOWN_HOURS — an escalated condition went
// quiet FOREVER under any realistic calling cadence, reproducing the exact
// "vanishes from the digest permanently" failure mode this card exists to
// prevent. This test simulates that realistic cadence (repeated calls with
// cooldownHours:0, standing in for "called again after its short cooldown
// elapsed") and proves the fix (a separate lastSurfacedAt clock) survives it.
test('routeAlert: repeated quiet calls at a realistic short cooldown do NOT reset the resurface clock (regression for the lastNotifiedAt-vs-lastSurfacedAt ship-check catch)', async () => {
  const { router, calls, restore, tmpDir } = loadRouterWithFakes();
  try {
    for (let i = 1; i <= 15; i++) {
      // cooldownHours:0 stands in for "this call landed after its real
      // (short, e.g. 6h) cooldown had already elapsed" — a test loop has no
      // way to let wall-clock hours actually pass between calls, and a
      // nonzero cooldownHours here would just hit the top-of-function
      // ledger-cooldown short-circuit every call since they run microseconds
      // apart, never even reaching the escalation logic under test.
      await router.routeAlert({
        conditionKey: 'test:digest-realistic-cadence', title: 'Noisy check', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
    }
    assert.equal(calls.createLinearIssue.length, 1, 'escalated once at call 15');
    router.drainDigestQueue();
    const surfacedAtEscalation = router.loadLedger().conditions['test:digest-realistic-cadence'].lastSurfacedAt;
    assert.ok(surfacedAtEscalation);

    // Simulate 20 more "next day" calls, each finding the top-of-function
    // cooldown already expired (cooldownHours:0 stands in for that — the
    // exact realistic cadence that broke the old lastNotifiedAt-keyed logic).
    for (let i = 0; i < 20; i++) {
      const r = await router.routeAlert({
        conditionKey: 'test:digest-realistic-cadence', title: 'Noisy check', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
      assert.equal(r.action, 'digest');
    }
    assert.equal(calls.createLinearIssue.length, 1, 'still only ever filed once');
    assert.equal(router.peekDigestQueue().length, 0, 'no full-noise line repeated across 20 quiet calls');

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:digest-realistic-cadence'].lastSurfacedAt, surfacedAtEscalation,
      'lastSurfacedAt must NOT advance on quiet calls — this is the field the resurface decision depends on');
    assert.ok(ledger.conditions['test:digest-realistic-cadence'].lastNotifiedAt !== surfacedAtEscalation,
      'lastNotifiedAt DOES keep advancing (that is expected/fine) — proving the test would have caught the old bug, which kept both fields in lockstep');

    // Now actually cross the resurface window, measured from the ORIGINAL
    // escalation moment (lastSurfacedAt), not from the last quiet call.
    const ledgerPath = path.join(tmpDir, 'alert-ledger.json');
    const onDisk = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    onDisk.conditions['test:digest-realistic-cadence'].lastSurfacedAt =
      new Date(Date.now() - (router.DEFAULT_COOLDOWN_HOURS + 1) * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(ledgerPath, JSON.stringify(onDisk, null, 2) + '\n');

    await router.routeAlert({
      conditionKey: 'test:digest-realistic-cadence', title: 'Noisy check', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    const queued = router.drainDigestQueue();
    assert.equal(queued.length, 1, 'resurface fires once the window elapses, proving the mechanism is reachable in the first place');
  } finally {
    restore();
  }
});

// Ship-check catch (Bug 2): a promoted-from-digest call that hits the rail-2
// Linear dedupe match used to return `{action:'silent'}` with NO digest line
// at all — the condition just vanished, the same failure mode this card
// exists to fix, just via a different code path than Bug 1.
test('routeAlert: a promoted digest escalation that dedupe-matches an existing tracker still queues a one-time notice (not silent disappearance)', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    linearSearchIssuesImpl: async () => ({ identifier: 'BRO-2943' }),
  });
  try {
    for (let i = 1; i <= 14; i++) {
      await router.routeAlert({
        conditionKey: 'test:digest-dedupe-notice', title: 'Shared circuit-breaker condition', description: 'd',
        disposition: 'digest', cooldownHours: 0,
      });
    }
    assert.equal(router.peekDigestQueue().length, 1, 'sanity: queueDigestLine replaces, not stacks, per conditionKey');
    router.drainDigestQueue();

    const result = await router.routeAlert({
      conditionKey: 'test:digest-dedupe-notice', title: 'Shared circuit-breaker condition', description: 'd',
      disposition: 'digest', cooldownHours: 0,
    });
    assert.equal(result.action, 'silent');
    assert.equal(calls.createLinearIssue.length, 0);

    const queued = router.drainDigestQueue();
    assert.equal(queued.length, 1, 'the owner must be told this condition is now tracked, not have it silently vanish');
    assert.match(queued[0].title, /already tracked at BRO-2943/);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:digest-dedupe-notice'].linearIdentifier, 'BRO-2943');
    assert.ok(ledger.conditions['test:digest-dedupe-notice'].lastSurfacedAt, 'the resurface clock must start here too, not stay null forever');
  } finally {
    restore();
  }
});

// -- BRO-3030 pre-mortem P0: paid-usage families are never silenced ----------
// The card's own plan-review demanded this BEFORE implementation ("Recurring
// cost alarms must keep firing until the metric returns to baseline, not until
// a card exists. Allowlist which condition families may ever be quieted").
// The first implementation shipped without it: decideDigestEscalation did not
// even RECEIVE a conditionKey, so no family COULD be exempted, and a tracked
// provider-spend:overspend on day 2 of a real overage returned 'quiet' and
// stayed quiet for the full 168h default.
const NEVER_QUIET_HOUR_MS = 3600 * 1000;
const neverQuietTracked = (hrsAgo) => ({
  linearIdentifier: 'BRO-9999',
  lastSurfacedAt: new Date(Date.now() - hrsAgo * NEVER_QUIET_HOUR_MS).toISOString(),
});

test('BRO-3030 P0: every paid-usage family resurfaces instead of going quiet while tracked', () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const { decideDigestEscalation } = router;
    const now = Date.now();
    for (const key of [
      'provider-spend:overspend',
      'bd-circuit-breaker-serp_api1',
      'bd-circuit-breaker-web_unlocker2',
      'sd-circuit-breaker',
      // Real keys only — an earlier draft asserted six invented ones that
      // exist nowhere in the repo, which proves nothing about production.
      'provider-spend:unmeasured',
    ]) {
      const d = decideDigestEscalation({ conditionKey: key, existing: neverQuietTracked(1), notifyCount: 30, now });
      assert.equal(d.action, 'resurface', key + ' must never be quieted');
      assert.equal(d.neverQuiet, true, key + ' must be flagged neverQuiet');
    }
  } finally { restore(); }
});

test('BRO-3030 P0: a cost condition is still PROMOTED first, the escalation half is unchanged', () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const { decideDigestEscalation } = router;
    const now = Date.now();
    assert.equal(decideDigestEscalation({ conditionKey: 'provider-spend:overspend', existing: null, notifyCount: 15, now }).action, 'promote');
    assert.equal(decideDigestEscalation({ conditionKey: 'provider-spend:overspend', existing: null, notifyCount: 3, now }).action, 'normal');
  } finally { restore(); }
});

test('BRO-3030 P0: non-cost families keep the quiet-then-resurface behaviour', () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const { decideDigestEscalation } = router;
    const now = Date.now();
    for (const key of ['t1-coverage:scoreboard', 'deployed-coverage:stale', 'review-gap:blast-radius-refused', 'test-yml:main-streak']) {
      assert.equal(decideDigestEscalation({ conditionKey: key, existing: neverQuietTracked(1), notifyCount: 30, now }).action, 'quiet', key);
      assert.equal(decideDigestEscalation({ conditionKey: key, existing: neverQuietTracked(169), notifyCount: 30, now }).action, 'resurface', key);
    }
  } finally { restore(); }
});

test('BRO-3030 P0: the predicate neither under- nor over-matches', () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    const { isNeverQuietCondition, decideDigestEscalation } = router;
    assert.equal(decideDigestEscalation({ existing: neverQuietTracked(1), notifyCount: 30, now: Date.now() }).action, 'quiet');
    for (const empty of [undefined, '', null]) assert.equal(isNeverQuietCondition(empty), false, String(empty));
    for (const key of ['coverage:stale', 'opening-night:missed-broadcast', 'data-validation:red', 'costume-audit:missing']) {
      assert.equal(isNeverQuietCondition(key), false, key + ' should NOT be a paid-usage family');
    }
  } finally { restore(); }
});

test('BRO-3030 P0: routeAlert threads conditionKey into the escalation decision (CALL SITE, not the signature)', () => {
  // The first version of this test matched /decideDigestEscalation\(\{\s*conditionKey,/
  // against the whole file, which ALSO matches the function DEFINITION's
  // parameter list — so deleting conditionKey from the call site left the
  // suite green while the exemption became unreachable in production, exactly
  // the bug that shipped the first time. Mutation-verified by a reviewer.
  // Anchor on the ASSIGNMENT instead, which only the call site can satisfy.
  const src = fs.readFileSync(new URL('./owner-alert-router.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /digestDecision\s*=\s*decideDigestEscalation\(\{\s*conditionKey,/,
    'routeAlert() must pass conditionKey to decideDigestEscalation at the CALL SITE',
  );
});

test('BRO-3030 P0: end-to-end — a tracked cost condition surfaces a digest line instead of going silent', async () => {
  // Behavioural backstop for the source assertion above: this fails if
  // conditionKey stops reaching decideDigestEscalation, regardless of how the
  // source is spelled. Goes through the real routeAlert(), real ledger file.
  const { router, restore, tmpDir } = loadRouterWithFakes();
  try {
    const { routeAlert, drainDigestQueue } = router;
    const ledgerPath = process.env.ALERT_LEDGER_PATH;
    // Seed: already escalated and tracked, surfaced 1h ago (well inside the
    // 168h resurface window), and last notified long enough ago to clear the
    // caller's own cooldown gate.
    const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    fs.writeFileSync(ledgerPath, JSON.stringify({
      conditions: {
        'provider-spend:overspend': {
          status: 'open', disposition: 'digest', title: 'Browserbase over budget',
          linearIdentifier: 'BRO-9999', notifyCount: 25,
          lastNotifiedAt: hoursAgo(48), lastSurfacedAt: hoursAgo(1), lastSeen: hoursAgo(1),
        },
      },
    }, null, 2));

    const res = await routeAlert({
      conditionKey: 'provider-spend:overspend',
      title: 'Browserbase over budget',
      description: 'browserbase $412.00 > $4 (today)',
      disposition: 'digest',
      severity: 'warning',
      cooldownHours: 20,
    });

    assert.notEqual(res.action, 'silent', 'a cost condition must not be silenced inside the resurface window');
    const queued = drainDigestQueue();
    const line = queued.find(l => l.conditionKey === 'provider-spend:overspend');
    assert.ok(line, 'a digest line must be queued for the tracked cost condition');
    assert.match(line.description, /412\.00/, "the resurfaced line must carry TODAY's number, not just a counter");
  } finally { restore(); }
});

test('BRO-3030 P2: the never-quiet callers keep a cooldown short enough for the exemption to run', () => {
  // The ledger cooldown gate short-circuits to 'silent' BEFORE the escalation
  // block, so this exemption only executes when the caller's own cooldownHours
  // is well under the 168h default. Raising one of these silently restores the
  // 7-day blackout with a fully green suite — so assert it here, against the
  // real caller files.
  const repoRoot = new URL('../../', import.meta.url);
  for (const [file, maxHours] of [['scripts/check-provider-spend.js', 24]]) {
    const src = fs.readFileSync(new URL(file, repoRoot), 'utf8');
    const m = src.match(/cooldownHours:\s*(\d+)/);
    assert.ok(m, `${file} must pass an explicit cooldownHours to routeAlert`);
    assert.ok(
      Number(m[1]) <= maxHours,
      `${file} cooldownHours=${m && m[1]} is too long — the never-quiet exemption never runs above ~${maxHours}h`,
    );
  }
});

// ── BRO-3881: every card this router files must be DISPATCHABLE ─────────────
// linear-next.js refuses to dispatch any issue whose acceptance criteria names
// no runnable command — and it does so inside the DETACHED child, after the
// morning digest has already spent one of its daily dispatch slots. So a
// prose-only "## Acceptance criteria" section here is not a documentation nit:
// it is a slot burned every single day, forever. BRO-3349 was picked and
// refused on four consecutive days (2026-09-17 .. 2026-09-20) for exactly this.
//
// These tests call the REAL buildCardNotes and the REAL gate (CLAUDE.md rule
// 15) — a copy of either would let them drift apart again, which is the whole
// defect.

test('BRO-3881: a health-check-sourced card carries a command the real dispatch gate arms', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const { evaluateVerifiability } = require('./verify-gate.js');
  const rowName = 'Data quality: provider spend ledger';
  const notes = buildCardNotes({
    description: 'Provider spend ledger newest entry (day=2026-09-04) is 11d old (>48h)',
    hint: 'Check the commit step in data-health-check.yml',
    fields: [{ name: 'Check', value: rowName }],
    conditionKey: `health-check:${rowName}`,
  });
  const gate = evaluateVerifiability(notes, []);
  assert.ok(gate.cmd, `router-filed card is undispatchable — linear-next.js refuses it and the digest slot is wasted: ${gate.reason}`);
  assert.match(gate.cmd, /check-health-row-absent\.js --row-b64 /);
  // The token must decode back to the row name check-health-row-absent.js
  // compares against — a truncated or prose-sanitized name silently never matches.
  const token = gate.cmd.split(' ').pop();
  assert.equal(Buffer.from(token, 'base64url').toString('utf8'), rowName);
});

test('BRO-3881: the row name survives colons in the conditionKey', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const { evaluateVerifiability } = require('./verify-gate.js');
  // Health-check row names contain colons of their own ("Data quality: X"), so
  // splitting the conditionKey on every colon would truncate the name to
  // "Data quality" and the generated command would never match anything.
  const rowName = 'Dispatch: board targeting: stale';
  const notes = buildCardNotes({ description: 'd', hint: 'h', fields: [], conditionKey: `health-check:${rowName}` });
  const token = evaluateVerifiability(notes, []).cmd.split(' ').pop();
  assert.equal(Buffer.from(token, 'base64url').toString('utf8'), rowName);
});

test('BRO-3881: a non-health-check condition keeps the prose criteria and is not given a bogus command', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const notes = buildCardNotes({ description: 'd', hint: 'h', fields: [], conditionKey: 'gap:some-show-2026/thestage--unknown.json' });
  assert.ok(!notes.includes('check-health-row-absent.js'),
    'only health-check rows have a check-health-row-absent.js answer — inventing one for other conditions would arm a command that can never pass');
  assert.match(notes, /no longer fires on the next check/);
});

test('BRO-3881: both auto-filers build the command from the SAME encoder', () => {
  // digest-autofix.js and owner-alert-router.js file cards for the same
  // health-check rows by two different routes. They drifted once already —
  // one emitted a runnable command, the other prose — so pin that they now
  // share one builder rather than two copies of the encoding contract.
  const shared = require('./health-row-check-cmd.js');
  const digestSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'digest-autofix.js'), 'utf8');
  const routerSrc = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'owner-alert-router.js'), 'utf8');
  for (const [name, src] of [['digest-autofix.js', digestSrc], ['owner-alert-router.js', routerSrc]]) {
    assert.match(src, /require\('\.\/health-row-check-cmd\.js'\)/, `${name} must require the shared builder, not re-declare the encoding`);
    assert.doesNotMatch(src, /Buffer\.from\([^)]*\)\.toString\('base64url'\)/, `${name} still hand-rolls the b64url token — that is the drift this card fixed`);
  }
  assert.equal(shared.rowAbsentCheckCmd('A: b'), `node scripts/check-health-row-absent.js --row-b64 ${Buffer.from('A: b', 'utf8').toString('base64url')}`);
});

// BRO-3881 (ship-check/Codex finding): the encoded row-name token has to pass
// SAFE_CHECK_FORMS' own `[A-Za-z0-9_-]{1,200}` bound, or the acceptance command
// is not a legal safe form and the card goes straight back to undispatchable —
// the failure this card exists to remove. base64url of N bytes is ceil(N*4/3)
// chars, so a 120-CHARACTER multi-byte name encoded to 480.
test('BRO-3881: the generated command is a legal safe form even for a long multi-byte row name', () => {
  const { rowAbsentCheckCmd, rowMatchKey } = require('./health-row-check-cmd.js');
  const { isSafeCheckCommand } = require('./verify-gate.js');
  const cjk = '劇'.repeat(120);          // 120 chars, 360 bytes -> 480 b64 chars unclamped
  const accented = 'é'.repeat(120);      // 120 chars, 240 bytes -> 320 b64 chars unclamped
  for (const name of [cjk, accented, 'A'.repeat(200), 'Data quality: provider spend ledger']) {
    const cmd = rowAbsentCheckCmd(name);
    assert.ok(isSafeCheckCommand(cmd), `not a safe form for a ${name.length}-char name: ${cmd.slice(0, 80)}…`);
    // and the token must still round-trip to the key the checker compares on
    const token = cmd.split(' ').pop();
    assert.equal(Buffer.from(token, 'base64url').toString('utf8'), rowMatchKey(name));
  }
});

test('BRO-3881: the encoder and check-health-row-absent.js share ONE bound, not two copies of 120', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check-health-row-absent.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/health-row-check-cmd\.js'\)/,
    'the checker must import the shared bound — its own `const LIMIT = 120` could drift from the encoder silently, and a drifted bound means a row name that never matches and a card that can never be verified');
  // Anchored to a statement at line start, not the bare string: the comment
  // that explains WHY the constant left quotes it verbatim, and an unanchored
  // pattern matches that prose and fails on a correct file.
  assert.doesNotMatch(src, /^\s*const LIMIT\s*=/m, 're-declared bound is back');
});

test('BRO-3881: rowMatchKey is idempotent — the checker re-applies it to an already-truncated decoded name', () => {
  const { rowMatchKey } = require('./health-row-check-cmd.js');
  for (const n of ['短'.repeat(300), 'plain name', '  padded  ', '']) {
    assert.equal(rowMatchKey(rowMatchKey(n)), rowMatchKey(n));
  }
});

test('BRO-3881: a backtick or VERIFY: in a row name cannot displace the real acceptance command', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const { evaluateVerifiability } = require('./verify-gate.js');
  // candidatesFrom is a matchAll over EVERY backticked span in the acceptance
  // section with rank-then-first selection, so an unsanitized backtick in row
  // text could open a rival span and win the selection.
  const hostile = 'Bad: `node --test scripts/lib/health-row-check-cmd.js` VERIFY: nope';
  const notes = buildCardNotes({ description: 'd', hint: 'h', fields: [], conditionKey: `health-check:${hostile}` });
  const gate = evaluateVerifiability(notes, []);
  assert.ok(gate.cmd, 'still armed');
  assert.match(gate.cmd, /check-health-row-absent\.js --row-b64 /,
    `a crafted row name displaced the real acceptance command: ${gate.cmd}`);
  // Scope to the acceptance SECTION — the trailing [conditionKey:...] anchor is
  // deliberately raw (findLinearDuplicate and any exact-match consumer read it),
  // sits after the section, and demonstrably does not win the selection above.
  const prose = notes.split('## Acceptance criteria')[1].split('[conditionKey:')[0];
  assert.ok(!/VERIFY:/i.test(prose), 'a literal VERIFY: survived into the acceptance prose');
  // The hostile text survives as PROSE (its backticks became quotes) — that is
  // fine and readable. What must not survive is a second backticked SPAN, since
  // spans are what candidatesFrom collects and ranks.
  const spans = prose.match(/\`[^\`]+\`/g) || [];
  assert.equal(spans.length, 1, `acceptance section must contain exactly one backticked span, found ${spans.length}: ${JSON.stringify(spans)}`);
});

// ── BRO-3907: test-yml:red:<job>:<sig> cards must be DISPATCHABLE too ───────
// The RED_SIGNATURE_PREFIX family has no health-check row to key off, so
// BRO-3881's fix didn't cover it — route-main-streak-signatures.js kept
// filing prose-only acceptance criteria and linear-next.js kept refusing
// every one of these cards ("no runnable verify command (acceptance criteria
// names no runnable command (prose only))"), same failure mode, different
// caller. The `verify` param (scripts/lib/red-signature-verify-cmd.js) fixes
// this the same way the health-row builder did: real command in, real gate
// verdict out — no copy of either side.

test('BRO-3907: a red-signature card with a resolvable safe-form step command is dispatchable', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const { evaluateVerifiability } = require('./verify-gate.js');
  const notes = buildCardNotes({
    description: "main's Test Suite is failing on Data Validation / Run data validation",
    hint: 'Investigate the failing validation.',
    fields: [{ name: 'Job', value: 'Data Validation' }, { name: 'Step', value: 'Run data validation' }],
    conditionKey: 'test-yml:red:Data Validation:abcd1234',
    verify: { line: 'VERIFY: node scripts/validate-data.js', note: null },
  });
  const gate = evaluateVerifiability(notes, []);
  assert.ok(gate.cmd, `red-signature card is undispatchable: ${gate.reason}`);
  assert.equal(gate.cmd, 'node scripts/validate-data.js');
});

test('BRO-3907: a red-signature card that falls back to owner-judgment is still dispatchable (armed via the marker, not a command)', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const { evaluateVerifiability } = require('./verify-gate.js');
  const notes = buildCardNotes({
    description: "main's Test Suite is failing on Lint Workflows / Audit cast-changes.json",
    hint: 'Investigate the failing audit.',
    fields: [{ name: 'Job', value: 'Lint Workflows' }, { name: 'Step', value: 'Audit cast-changes.json' }],
    conditionKey: 'test-yml:red:Lint Workflows:deadbeef',
    verify: {
      line: 'VERIFY: owner-judgment',
      note: 'The failing step\'s own command (`node scripts/audit-cast-changes.js --gate`) is not on the safe-form allowlist — needs a human to name a safe re-verification command.',
    },
  });
  const gate = evaluateVerifiability(notes, []);
  assert.ok(gate.armed, `owner-judgment marker did not arm the card: ${gate.reason}`);
  assert.ok(gate.ownerJudgment);
  assert.match(notes, /VERIFY: owner-judgment/);
  // The note explaining WHY must survive into the card body (own-judgment
  // alone tells a human nothing about what was actually tried).
  assert.match(notes, /audit-cast-changes\.js --gate/);
});

test('BRO-3907: verify.line is never sanitized — sanitizeRowText would silently disarm it', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const { evaluateVerifiability } = require('./verify-gate.js');
  // sanitizeRowText rewrites "VERIFY:" -> "VERIFY -" — if it were ever applied
  // to verify.line itself (rather than just verify.note), this would silently
  // reproduce the exact bug BRO-3907 fixes.
  const notes = buildCardNotes({
    description: 'd', hint: 'h', fields: [],
    conditionKey: 'test-yml:red:Unit Tests:cafebabe',
    verify: { line: 'VERIFY: node scripts/run-unit-tests.js', note: null },
  });
  assert.match(notes, /^VERIFY: node scripts\/run-unit-tests\.js$/m);
  assert.equal(evaluateVerifiability(notes, []).cmd, 'node scripts/run-unit-tests.js');
});

test('BRO-3907: a health-check row still wins over a verify param if both were somehow passed (health-row is the more specific answer)', () => {
  const { buildCardNotes } = require('./owner-alert-router.js');
  const rowName = 'Data quality: something';
  const notes = buildCardNotes({
    description: 'd', hint: 'h', fields: [],
    conditionKey: `health-check:${rowName}`,
    verify: { line: 'VERIFY: node scripts/validate-data.js', note: null },
  });
  assert.match(notes, /check-health-row-absent\.js/);
  assert.doesNotMatch(notes, /VERIFY: node scripts\/validate-data\.js/);
});

// ── BRO-4054: dispatch-at-filing (red-main signature cards) ──────────────────

test('routeAlert: dispatchAtFiling files in DISPATCH mode — no PARKED sentinel, provenance marker present, dispatch stamp on the ledger condition', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    const result = await router.routeAlert({
      conditionKey: 'test-yml:red:Unit Tests:deadbeef',
      title: 'main test.yml red: Unit Tests / Run unit tests — "t"',
      description: 'main is red.',
      disposition: 'auto',
      verify: { line: 'VERIFY: `node scripts/run-unit-tests.js`', note: null },
      dispatchAtFiling: { runId: '424242', runUrl: 'https://github.com/x/y/actions/runs/424242' },
    });
    assert.equal(result.action, 'auto');
    assert.equal(calls.createLinearIssue.length, 1);
    const opts = calls.createLinearIssue[0];
    assert.equal(opts.dispatch, true, 'dispatch mode, never park');
    assert.equal(opts.park, undefined);
    assert.doesNotMatch(opts.description, /^\s*PARKED\s*:/im, 'the sentinel headless-dispatchability.js refuses must be absent');
    assert.match(opts.description, /Filed by owner-alert-router for dispatch-at-filing \(BRO-4054; condition: test-yml:red:Unit Tests:deadbeef\)/);
    assert.doesNotMatch(opts.description, /Auto-filed by owner-alert-router/, 'must not be selectable by the parked drain too');
    assert.match(opts.description, /VERIFY: `node scripts\/run-unit-tests.js`/, 'BRO-3907 VERIFY derivation stays on the card');
    assert.deepEqual(result.dispatch, { requestedAt: result.dispatch.requestedAt, mode: 'dispatch-at-filing', runId: '424242', runUrl: 'https://github.com/x/y/actions/runs/424242' });
    const cond = router.loadLedger().conditions['test-yml:red:Unit Tests:deadbeef'];
    assert.equal(cond.status, 'open');
    assert.equal(cond.dispatch.mode, 'dispatch-at-filing');
    assert.equal(cond.dispatch.runId, '424242');
  } finally {
    restore();
  }
});

test('routeAlert: without dispatchAtFiling the router still parks (every other auto alert is unchanged)', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    const result = await router.routeAlert({ conditionKey: 'test:still-parked', title: 't', description: 'd', disposition: 'auto' });
    assert.equal(result.dispatch, undefined);
    assert.ok(calls.createLinearIssue[0].park);
    assert.equal(calls.createLinearIssue[0].dispatch, undefined);
    assert.equal(router.loadLedger().conditions['test:still-parked'].dispatch, undefined);
  } finally {
    restore();
  }
});

test('routeAlert carries dispatch/absentRunIds across BOTH ledger rewrites (second-opinion blocker: fresh-record writes dropped them)', async () => {
  // Rewrite 1: cooldown expired + Linear dedupe match → the dedupe-match path rebuilds the record.
  const { router, calls, restore } = loadRouterWithFakes({
    linearSearchIssuesImpl: async () => ({ identifier: 'BRO-4100', title: 'tracked' }),
  });
  try {
    const key = 'test-yml:red:Unit Tests:cafebabe';
    const first = await router.routeAlert({ conditionKey: key, title: 't', description: 'd', disposition: 'auto', dispatchAtFiling: { runId: '1' } });
    assert.equal(first.action, 'silent', 'dedupe match');
    // Simulate the stamps another writer (CI filer / stale tracker) put on the open record.
    assert.ok(router.patchCondition(key, { dispatch: { requestedAt: '2026-09-23T00:00:00.000Z', mode: 'dispatch-at-filing', runId: '1' }, absentRunIds: ['1', '2'] }));
    // Age the record past the cooldown so the next call re-enters the dedupe-match rewrite.
    const aged = router.loadLedger();
    aged.conditions[key].lastNotifiedAt = new Date(Date.now() - 400 * 3600 * 1000).toISOString();
    fs.writeFileSync(router._LEDGER_PATH, JSON.stringify(aged));
    const second = await router.routeAlert({ conditionKey: key, title: 't', description: 'd', disposition: 'auto', dispatchAtFiling: { runId: '2' } });
    assert.equal(second.action, 'silent');
    const cond = router.loadLedger().conditions[key];
    assert.deepEqual(cond.dispatch, { requestedAt: '2026-09-23T00:00:00.000Z', mode: 'dispatch-at-filing', runId: '1' });
    assert.deepEqual(cond.absentRunIds, ['1', '2']);
    assert.equal(calls.createLinearIssue.length, 0);
  } finally {
    restore();
  }
  // Rewrite 2: the new-incident path (no dedupe match) after a cooldown expiry keeps absentRunIds.
  const second = loadRouterWithFakes();
  try {
    const key = 'test-yml:red:E2E Tests:feedface';
    await second.router.routeAlert({ conditionKey: key, title: 't', description: 'd', disposition: 'auto', dispatchAtFiling: { runId: '1' } });
    assert.ok(second.router.patchCondition(key, { absentRunIds: ['7'] }));
    const aged = second.router.loadLedger();
    aged.conditions[key].lastNotifiedAt = new Date(Date.now() - 400 * 3600 * 1000).toISOString();
    fs.writeFileSync(second.router._LEDGER_PATH, JSON.stringify(aged));
    const r = await second.router.routeAlert({ conditionKey: key, title: 't', description: 'd', disposition: 'auto', dispatchAtFiling: { runId: '9' } });
    assert.equal(r.action, 'auto', 'no dedupe match → files again');
    const cond = second.router.loadLedger().conditions[key];
    assert.deepEqual(cond.absentRunIds, ['7'], 'carried across the new-incident rewrite');
    assert.equal(cond.dispatch.runId, '9', 'a fresh filing takes the NEW dispatch stamp');
  } finally {
    second.restore();
  }
});

test('patchCondition only touches OPEN conditions and resolveCondition records the reason', async () => {
  const { router, restore } = loadRouterWithFakes();
  try {
    assert.equal(router.patchCondition('test:missing', { absentRunIds: ['1'] }), false);
    await router.routeAlert({ conditionKey: 'test:patch', title: 't', description: 'd', disposition: 'auto' });
    assert.ok(router.patchCondition('test:patch', { absentRunIds: ['1'] }));
    assert.deepEqual(router.loadLedger().conditions['test:patch'].absentRunIds, ['1']);
    assert.ok(router.resolveCondition('test:patch', { reason: 'stale-signature' }));
    const cond = router.loadLedger().conditions['test:patch'];
    assert.equal(cond.status, 'resolved');
    assert.equal(cond.resolveReason, 'stale-signature');
    assert.equal(router.patchCondition('test:patch', { absentRunIds: [] }), false, 'closed → no-op');
  } finally {
    restore();
  }
});
