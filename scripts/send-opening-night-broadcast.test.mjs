import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const mod = require('./send-opening-night-broadcast.js');
const {
  recordDraftCompletion, SYNC_REPO, SYNC_REMOTE_PATH, SENT_PATH,
  findShowsMissingConsensus, filterShowsWithConsensus, findRecentlyOpenedShows,
} = mod;

// Stubs process.exit so filterShowsWithConsensus's exit path can be observed
// without actually killing the test runner. process.exit itself doesn't throw,
// so real code after the call would keep running in prod — the sentinel throw
// here is a test-only device to unwind the stack and catch the exit code.
function withStubbedExit(fn) {
  const realExit = process.exit;
  const realError = console.error;
  const calls = { exitCodes: [], errors: [] };
  process.exit = (code) => { calls.exitCodes.push(code); throw new Error('__EXIT__'); };
  console.error = (...args) => { calls.errors.push(args.join(' ')); };
  try {
    fn(calls);
  } catch (err) {
    if (err.message !== '__EXIT__') throw err;
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
  return calls;
}

// BRO-60: real Resend draft creation called saveSentData() (local disk only) but
// never syncTrackerToOrigin() — only the --send-to preview path synced. A
// CLI-created draft's completed:true state was invisible to origin/main until
// the next scheduled CI commit, the same class of divergence that caused the
// 2026-04-11 duplicate-preview incident on the preview path.
//
// This spins up a fake `gh` binary on PATH that stands in for origin/main:
// `gh api repos/OWNER/REPO/contents/PATH?ref=main` reads a local "remote" file,
// `gh api --method PUT ... --input FILE` writes it back. That lets the test
// assert real origin state after recordDraftCompletion() runs, without any
// network access or touching the real gh CLI / real repo.

function makeFakeGh(remoteFile) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-bin-'));
  const ghPath = path.join(binDir, 'gh');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const remoteFile = ${JSON.stringify(remoteFile)};

if (args[0] === 'auth' && args[1] === 'status') {
  process.exit(0);
}

if (args[0] === 'api') {
  const rest = args.slice(1);
  const methodIdx = rest.indexOf('--method');
  if (methodIdx !== -1 && rest[methodIdx + 1] === 'PUT') {
    const inputIdx = rest.indexOf('--input');
    const inputFile = rest[inputIdx + 1];
    const payload = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const content = Buffer.from(payload.content, 'base64').toString('utf8');
    fs.writeFileSync(remoteFile, content);
    fs.writeFileSync(remoteFile + '.sha', 'sha-' + Date.now());
    process.stdout.write(JSON.stringify({ content: { sha: 'sha-' + Date.now() } }));
    process.exit(0);
  }
  // GET repos/OWNER/REPO/contents/PATH?ref=main
  let existing = '{"shows":{}}';
  let sha = 'initial-sha';
  if (fs.existsSync(remoteFile)) existing = fs.readFileSync(remoteFile, 'utf8');
  if (fs.existsSync(remoteFile + '.sha')) sha = fs.readFileSync(remoteFile + '.sha', 'utf8');
  process.stdout.write(JSON.stringify({ sha, content: Buffer.from(existing, 'utf8').toString('base64') }));
  process.exit(0);
}
process.exit(1);
`;
  fs.writeFileSync(ghPath, script);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

function withFakeOrigin(fn) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ons-origin-'));
  const remoteFile = path.join(workDir, 'origin-opening-night-sent.json');
  const binDir = makeFakeGh(remoteFile);

  const savedPath = process.env.PATH;
  const savedGithubActions = process.env.GITHUB_ACTIONS;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  delete process.env.GITHUB_ACTIONS;

  // Prevent recordDraftCompletion's saveSentData() from clobbering the real
  // data/opening-night-sent.json tracker file — divert only that exact path.
  const realWriteFileSync = fs.writeFileSync;
  const localWrites = [];
  fs.writeFileSync = (filePath, data, ...rest) => {
    if (filePath === SENT_PATH) {
      localWrites.push(data);
      return undefined;
    }
    return realWriteFileSync.call(fs, filePath, data, ...rest);
  };

  try {
    return fn({ remoteFile, localWrites });
  } finally {
    fs.writeFileSync = realWriteFileSync;
    process.env.PATH = savedPath;
    if (savedGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = savedGithubActions;
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

test('recordDraftCompletion: syncs completed:true to origin on draft creation, not just preview', () => {
  withFakeOrigin(({ remoteFile }) => {
    const sentData = { shows: {} };
    const showsForEmail = [{ showId: 'giant-2026', reviewCount: 12 }];

    recordDraftCompletion(sentData, 'broadway:giant-2026', showsForEmail, {
      draftId: 'draft_abc123',
      draftUrl: 'https://resend.com/broadcasts/draft_abc123',
      method: 'resend-draft',
      reviewCount: 12,
    });

    assert.ok(fs.existsSync(remoteFile), 'expected recordDraftCompletion to push a file to origin/main');
    const origin = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));

    const byBroadcastKey = origin.shows['broadway:giant-2026'];
    assert.ok(byBroadcastKey, 'origin state missing the broadcastKey entry');
    assert.equal(byBroadcastKey.completed, true);
    assert.equal(byBroadcastKey.draftId, 'draft_abc123');
    assert.equal(byBroadcastKey.draftStatus, 'draft');

    const byShowId = origin.shows['giant-2026'];
    assert.ok(byShowId, 'origin state missing the per-show entry');
    assert.equal(byShowId.completed, true);
    assert.equal(byShowId.broadcastKey, 'broadway:giant-2026');
  });
});

test('recordDraftCompletion: merges with pre-existing origin state instead of overwriting it', () => {
  withFakeOrigin(({ remoteFile }) => {
    fs.writeFileSync(remoteFile, JSON.stringify({
      shows: { 'broadway:other-show-2026': { completed: true, draftId: 'draft_other' } },
    }));
    fs.writeFileSync(remoteFile + '.sha', 'preexisting-sha');

    const sentData = { shows: {} };
    recordDraftCompletion(sentData, 'broadway:giant-2026', [{ showId: 'giant-2026', reviewCount: 5 }], {
      draftId: 'draft_new',
      draftUrl: 'https://resend.com/broadcasts/draft_new',
      method: 'resend-draft',
      reviewCount: 5,
    });

    const origin = JSON.parse(fs.readFileSync(remoteFile, 'utf8'));
    assert.ok(origin.shows['broadway:other-show-2026'], 'pre-existing origin entry was dropped, not merged');
    assert.ok(origin.shows['broadway:giant-2026'], 'new draft entry missing from merged origin state');
  });
});

test('recordDraftCompletion: still saves locally (SENT_PATH) in addition to syncing', () => {
  withFakeOrigin(({ localWrites }) => {
    const sentData = { shows: {} };
    recordDraftCompletion(sentData, 'broadway:giant-2026', [{ showId: 'giant-2026', reviewCount: 5 }], {
      draftId: 'draft_local',
      draftUrl: 'https://resend.com/broadcasts/draft_local',
      method: 'resend-draft',
      reviewCount: 5,
    });

    assert.equal(localWrites.length, 1, 'expected exactly one local saveSentData() write');
    const saved = JSON.parse(localWrites[0]);
    assert.equal(saved.shows['broadway:giant-2026'].draftId, 'draft_local');
  });
});

test('SYNC_REPO / SYNC_REMOTE_PATH point at the private data repo root (sanity check for the fake-gh harness)', () => {
  assert.equal(SYNC_REPO, 'thomaspryor/broadway-scorecard-data');
  assert.equal(SYNC_REMOTE_PATH, 'opening-night-sent.json');
});

// BRO-227: gate-logic.ts getTriggerCopy() promises subscribers "the CriticScore and a
// one-line critics' verdict. Nothing else." Previously the script only console.warn'd
// when critic-consensus.json was missing for a show and continued to create/send the
// draft anyway, breaking that promise. These prove it now drops that show instead —
// PER SHOW, not the whole batch (adversarial review 2026-08-26 caught the first version
// blocking an entire coalesced multi-show run over one straggler, reopening the exact
// same-night-batch bug the workflow's own readiness_gate was rewritten to fix on
// 2026-04-08 — see .github/workflows/opening-night-broadcast.yml's readiness_gate step).

test('findShowsMissingConsensus: flags shows with no consensusText', () => {
  const shows = [
    { showId: 'giant-2026', showTitle: 'Giant', consensusText: 'Critics are raving.' },
    { showId: 'other-2026', showTitle: 'Other Show', consensusText: null },
  ];
  const missing = findShowsMissingConsensus(shows);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].showId, 'other-2026');
});

test('findShowsMissingConsensus: empty when every show has consensus', () => {
  const shows = [
    { showId: 'giant-2026', showTitle: 'Giant', consensusText: 'Critics are raving.' },
  ];
  assert.equal(findShowsMissingConsensus(shows).length, 0);
});

test('filterShowsWithConsensus: exits non-zero and does not return when the ONLY show lacks consensus', () => {
  const showsForEmail = [
    { showId: 'giant-2026', showTitle: 'Giant', consensusText: null },
  ];
  const calls = withStubbedExit(() => {
    filterShowsWithConsensus(showsForEmail);
    assert.fail('filterShowsWithConsensus should not return when nothing in the batch has consensus');
  });
  assert.deepEqual(calls.exitCodes, [1], 'expected exactly one process.exit(1) call');
  assert.ok(
    calls.errors.some(msg => msg.includes('Giant')),
    'expected the missing show to be named in the error output'
  );
});

test('filterShowsWithConsensus: does not exit when every show has consensus, returns input unchanged', () => {
  const showsForEmail = [
    { showId: 'giant-2026', showTitle: 'Giant', consensusText: 'Critics are raving.' },
  ];
  const calls = withStubbedExit(() => {
    const result = filterShowsWithConsensus(showsForEmail);
    assert.deepEqual(result, showsForEmail);
  });
  assert.deepEqual(calls.exitCodes, [], 'expected no process.exit call when consensus is present');
});

// BRO-159: findRecentlyOpenedShows' Broadway branch used to be a denylist
// (exclude off-broadway/regional/London), so any future category value —
// e.g. an enumerated 'off-off-broadway' — would default to Broadway-eligible
// and reach real Broadway subscribers. Now it's an allowlist (category must
// equal 'broadway' exactly), matching the West End branch's existing shape.
test('findRecentlyOpenedShows: a hypothetical off-off-broadway category is NOT Broadway-broadcast-eligible', () => {
  const today = new Date().toISOString().slice(0, 10);
  const shows = [
    { showId: 'oob-show', status: 'open', openingDate: today, category: 'off-off-broadway', type: 'play' },
  ];
  const result = findRecentlyOpenedShows(shows, 2);
  assert.deepEqual(result.map(s => s.showId), [], 'an off-off-broadway show must not enter the Broadway broadcast set');
});

test('findRecentlyOpenedShows: still includes true Broadway shows (allowlist did not break the golden path)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const shows = [
    { showId: 'bway-show', status: 'open', openingDate: today, category: 'broadway', type: 'play' },
  ];
  const result = findRecentlyOpenedShows(shows, 2);
  assert.deepEqual(result.map(s => s.showId), ['bway-show']);
});

test('findRecentlyOpenedShows: still excludes off-broadway and regional (pre-existing behavior preserved)', () => {
  const today = new Date().toISOString().slice(0, 10);
  const shows = [
    { showId: 'ob-show', status: 'open', openingDate: today, category: 'off-broadway', type: 'play' },
    { showId: 'regional-show', status: 'open', openingDate: today, category: 'regional', type: 'play' },
  ];
  const result = findRecentlyOpenedShows(shows, 2);
  assert.deepEqual(result.map(s => s.showId), []);
});

test('filterShowsWithConsensus: coalesced batch — drops only the show missing consensus, sends the rest, does NOT exit', () => {
  const ready = { showId: 'giant-2026', showTitle: 'Giant', consensusText: 'Critics are raving.' };
  const notReady = { showId: 'other-2026', showTitle: 'Other Show', consensusText: null };
  const calls = withStubbedExit(() => {
    const result = filterShowsWithConsensus([ready, notReady]);
    assert.deepEqual(result, [ready], 'expected the ready show to survive and the straggler to be dropped');
  });
  assert.deepEqual(calls.exitCodes, [], 'a ready show in the batch must still send even if another show is not ready');
  assert.ok(calls.errors.some(msg => msg.includes('Other Show')), 'expected the dropped show to be named');
});
