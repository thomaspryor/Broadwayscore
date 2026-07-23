import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
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

  return { router, calls, restore };
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

test('routeAlert: disposition=human calls sendAlert with email:true, never shells out', async () => {
  const { router, calls, restore } = loadRouterWithFakes();
  try {
    const result = await router.routeAlert({
      conditionKey: 'test:human',
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
