import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { namingCandidates } = require('../ack-landed.js');
const core = require('../lib/ack-landed-core.js');

// BRO-4068. A session hit ack-landed's "the sha's commit message does not name
// BRO-N" refusal, read the bare refusal as a dead end, and filed a P2 asking to
// RELAX the precondition — titled "BRO-4066 landed but can never be acked". It
// could be acked all along: two of that landing's three commits named the card
// and one named nothing, and the one being passed was the latter. The guard was
// right; what was missing was a refusal that says which sha WOULD work.
//
// These build a throwaway repo rather than reading this repo's history, because
// the repo's own CI checks out at actions/checkout's default depth of 1: a test
// that needed real history would pass here and fail there, which is worse than
// no test at all.

const CARD = 'BRO-406';
let repo;

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_COMMITTER_DATE: opts.date || '2026-01-01T12:00:00Z',
      GIT_AUTHOR_DATE: opts.date || '2026-01-01T12:00:00Z',
    },
  });
}

function commit(message, date) {
  fs.writeFileSync(path.join(repo, 'f.txt'), String(Math.random()));
  git(['add', 'f.txt']);
  git(['commit', '-m', message], { date });
  return git(['rev-parse', '--short', 'HEAD']).trim();
}

test.before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-landed-cand-'));
  git(['init', '-q', '-b', 'main']);
});

test.after(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ } });

// Fixtures mirror the real BRO-4066 landing exactly: the id lives in the BODY,
// a sibling commit names a LONGER id, and a third names nothing at all.
const IN_WINDOW = '2026-01-01T12:30:00Z';
const LAUNCH = '2026-01-01T12:00:00Z';
const TERMINAL = '2026-01-01T13:00:00Z';

test('BRO-4068: a card named only in the commit BODY is offered as a candidate', () => {
  const sha = commit(`fix(ack-landed): add --job-id\n\nRefs ${CARD} for the scoping work.`, IN_WINDOW);
  const rows = namingCandidates(CARD, LAUNCH, TERMINAL, { cwd: repo, base: 'main' });
  const hit = rows.find(r => r.sha === sha);
  assert.ok(hit, 'the id is in the body, not the subject — matching %s alone silently found nothing');
  assert.ok(!new RegExp(CARD).test(hit.subject), 'and its subject really does not contain the id');
  assert.ok(hit.authored, 'candidates carry an author date so the window is checkable at a glance');
});

test('BRO-4068: a LONGER id sharing the prefix is never offered', () => {
  const sha = commit(`fix(${CARD}6): a different card entirely`, IN_WINDOW);
  const rows = namingCandidates(CARD, LAUNCH, TERMINAL, { cwd: repo, base: 'main' });
  assert.ok(!rows.some(r => r.sha === sha),
    `--grep is an unanchored substring match, so ${CARD}6 comes back from git; offering it would `
    + 'hand the operator a sha the guard then refuses — the exact confusion this hint exists to end');
});

test('BRO-4068: a commit naming no card at all is never offered', () => {
  const sha = commit('fix(reclassify): fail closed on overlapping sibling-job activity', IN_WINDOW);
  const rows = namingCandidates(CARD, LAUNCH, TERMINAL, { cwd: repo, base: 'main' });
  assert.ok(!rows.some(r => r.sha === sha),
    'this is the shape of the sha that was actually being passed when the false P2 was filed');
});

test('BRO-4068: commits outside the job window are never offered, so the hint cannot trade one refusal for another', () => {
  const before = commit(`chore: early work\n\nRefs ${CARD}.`, '2026-01-01T11:00:00Z');
  const after = commit(`chore: much later work\n\nRefs ${CARD}.`, '2026-01-01T14:00:00Z');
  const rows = namingCandidates(CARD, LAUNCH, TERMINAL, { cwd: repo, base: 'main' });
  const shas = rows.map(r => r.sha);
  assert.ok(!shas.includes(before), 'authored before the launch row — decideAck refuses it on timing');
  assert.ok(!shas.includes(after), 'authored past the terminal row + grace — likewise refused on timing');
});

test('BRO-4068: an unknown card, a missing ref and a bad base all degrade to no hint rather than throwing', () => {
  assert.deepEqual(namingCandidates('BRO-99999999', LAUNCH, TERMINAL, { cwd: repo, base: 'main' }), []);
  assert.deepEqual(namingCandidates('', LAUNCH, TERMINAL, { cwd: repo, base: 'main' }), []);
  assert.deepEqual(namingCandidates(null, LAUNCH, TERMINAL, { cwd: repo, base: 'main' }), []);
  // A shallow CI checkout has no origin/main; that must be a missing hint, never a crash.
  assert.deepEqual(namingCandidates(CARD, LAUNCH, TERMINAL, { cwd: repo, base: 'no-such-ref' }), []);
});

// The hint reaches candidates through `git log --grep`, an UNANCHORED substring
// match, while the refusal uses an anchored one. Both sides now call this single
// predicate so they can never disagree.
test('BRO-4068: the naming predicate is anchored, so a shorter id never matches a longer one', () => {
  assert.equal(core.messageNamesRef('fix(BRO-406): y', 'BRO-406'), true, 'the exact id matches');
  assert.equal(core.messageNamesRef('fix(BRO-4066): x', 'BRO-406'), false, 'BRO-4066 is NOT BRO-406');
  assert.equal(core.messageNamesRef('see BRO-4060 too', 'BRO-406'), false, 'BRO-4060 is NOT BRO-406');
  assert.equal(core.messageNamesRef('fix(BRO-4066): x', 'BRO-4066'), true);
  assert.equal(core.messageNamesRef('nothing here', 'BRO-4066'), false);
});

test('BRO-4068: the predicate tolerates null/empty inputs instead of throwing', () => {
  assert.equal(core.messageNamesRef(null, 'BRO-1'), false);
  assert.equal(core.messageNamesRef('BRO-1', null), false);
  assert.equal(core.messageNamesRef('BRO-1', ''), false);
});
