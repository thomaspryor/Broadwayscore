import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

// The router shells out to `node scripts/notion-brain.js create` for
// disposition='auto' and calls sendAlert() (Resend) for disposition='human'.
// Neither should ever fire in a unit test — override both dependencies via a
// throwaway module cache entry pointed at a fake execFileSync/sendAlert, and
// isolate the ledger/digest-queue files to a temp dir so runs don't touch
// data/audit/ or leave test residue for the real project.
function loadRouterWithFakes({ execFileSyncImpl, sendAlertImpl } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-router-test-'));
  const modulePath = require.resolve('./owner-alert-router.js');
  const discordNotifyPath = require.resolve('./discord-notify.js');
  const childProcessPath = require.resolve('node:child_process');

  delete require.cache[modulePath];
  delete require.cache[discordNotifyPath];

  const calls = { execFileSync: [], sendAlert: [] };

  // Stub node:child_process.execFileSync so card dispatch never shells out.
  const realChildProcess = require(childProcessPath);
  const originalExecFileSync = realChildProcess.execFileSync;
  realChildProcess.execFileSync = (...args) => {
    calls.execFileSync.push(args);
    if (execFileSyncImpl) return execFileSyncImpl(...args);
    return JSON.stringify({ id: 'fake-card-id' });
  };

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

  const router = require(modulePath);
  // Point the ledger/digest-queue at the temp dir (module already resolved
  // its paths at require time — patch the exported constants via a fresh
  // require is not possible since fs paths are captured in closures, so we
  // instead override the LEDGER/DIGEST env indirection: the module reads
  // paths relative to __dirname, not env. Simplest safe approach: redirect
  // fs calls for exactly those two paths to the temp dir equivalents.
  const ledgerPath = path.join(tmpDir, 'alert-ledger.json');
  const digestPath = path.join(tmpDir, 'alert-digest-queue.json');
  const attemptsPath = path.join(tmpDir, 'alert-router-attempts.jsonl');

  const realReadFileSync = fs.readFileSync;
  const realWriteFileSync = fs.writeFileSync;
  const realRenameSync = fs.renameSync;
  const realMkdirSync = fs.mkdirSync;

  function remap(p) {
    if (typeof p !== 'string') return p;
    if (p === router._LEDGER_PATH || p.startsWith(`${router._LEDGER_PATH}.tmp`)) {
      return p.replace(router._LEDGER_PATH, ledgerPath);
    }
    if (p === router._DIGEST_QUEUE_PATH) return digestPath;
    // dispatchCard() logs every disposition='auto' attempt here — must be
    // redirected too, or every test run touching disposition='auto' writes
    // real attempt rows into the repo's data/audit/ directory.
    if (p === router._ATTEMPTS_LOG_PATH) return attemptsPath;
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
    realChildProcess.execFileSync = originalExecFileSync;
    delete require.cache[discordNotifyPath];
    delete require.cache[modulePath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { router, calls, restore, attemptsPath };
}

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
    assert.equal(result.cardId, 'fake-card-id');
    assert.equal(calls.execFileSync.length, 1);
    assert.equal(calls.sendAlert.length, 0);

    const ledger = router.loadLedger();
    assert.equal(ledger.conditions['test:new-incident'].status, 'open');
    assert.equal(ledger.conditions['test:new-incident'].notifyCount, 1);
  } finally {
    restore();
  }
});

test('routeAlert: a failed card dispatch is NOT recorded as notified — retries next call', async () => {
  const { router, calls, restore } = loadRouterWithFakes({
    execFileSyncImpl: () => { throw new Error('Notion API down'); },
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
    assert.equal(calls.execFileSync.length, 2);
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
    assert.equal(calls.execFileSync.length, 1);

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
    assert.equal(calls.execFileSync.length, 2);

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
    assert.equal(calls.execFileSync.length, 0);
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
    assert.equal(calls.execFileSync.length, 0);

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
    assert.equal(calls.execFileSync.length, 0);
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
    execFileSyncImpl: () => { throw new Error("Cannot find module '@notionhq/client'"); },
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
    const lines = [
      { ts: '2026-07-20T00:00:00.000Z', conditionKey: 'test:c', title: 'c', ok: true, error: null },
      { ts: '2026-07-22T00:00:00.000Z', conditionKey: 'test:a', title: 'a', ok: false, error: 'newest' },
      { ts: '2026-07-21T00:00:00.000Z', conditionKey: 'test:b', title: 'b', ok: true, error: null },
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
