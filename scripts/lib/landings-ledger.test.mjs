// scripts/lib/landings-ledger.test.mjs — BRO-3873 step 5 / BRO-3425.
// classifyDirectPush() is the verdict .github/workflows/check-direct-push-to-main.yml
// acts on; appendLanding()/parseLandings() are land.yml's writer and the
// detector's reader. Required from the lib, never restated (rule 15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./landings-ledger.js');
const { classifyDirectPush, appendLanding, readLandings, parseLandings, buildDirectPushAlert, conditionKeyFor, findLanding } = lib;

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

test('a session push with no landing row → direct', () => {
  const v = classifyDirectPush({ sha: SHA, actor: 'thomaspryor', committerName: 'Tom Pryor', committerEmail: 'tom@example.com', landings: [{ sha: OTHER, branch: 'land/x' }] });
  assert.equal(v.verdict, 'direct');
});

test('a sha recorded by land.yml → landed (even with a human actor: the PAT push carries the owner as actor)', () => {
  const v = classifyDirectPush({ sha: SHA, actor: 'thomaspryor', committerName: 'Tom Pryor', committerEmail: 'tom@example.com', landings: [{ sha: SHA, branch: 'land/worktree-x' }] });
  assert.equal(v.verdict, 'landed');
  assert.match(v.reason, /land\/worktree-x/);
});

test('bot pushes are skipped before the ledger is consulted (workflow commits, CI-rebased landings, GitHub web merges)', () => {
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'github-actions[bot]', landings: [] }).verdict, 'skip');
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', committerName: 'github-actions[bot]', committerEmail: 'github-actions[bot]@users.noreply.github.com', landings: [] }).verdict, 'skip');
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', committerName: 'GitHub Action', committerEmail: 'action@github.com', landings: [] }).verdict, 'skip');
  // a GitHub web/PR merge is a session path to main that skips land.yml — judged like any human push
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', committerName: 'GitHub', committerEmail: 'noreply@github.com', landings: [], changedFiles: ['scripts/x.js'] }).verdict, 'direct');
});

test('a push that changes no code path (cloud-memory sync, review texts, core data) is skipped before the ledger; unknown change set is judged as code', () => {
  const dataOnly = ['cloud-memory/MEMORY.md', 'data/audit/alert-ledger.json', 'public/data/shows/x.json'];
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', committerName: 'Tom Pryor', committerEmail: 't@t', landings: [], changedFiles: dataOnly }).verdict, 'skip');
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', landings: [], changedFiles: [...dataOnly, 'scripts/lib/foo.js'] }).verdict, 'direct');
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', landings: [], changedFiles: ['.github/workflows/x.yml'] }).verdict, 'direct');
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', landings: [], changedFiles: [] }).verdict, 'direct');
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', landings: [], changedFiles: null }).verdict, 'direct');
  assert.equal(lib.isCodePath('CLAUDE.md'), true);
  assert.equal(lib.isCodePath('memory/CLAUDE.md'), false);
});

test('fail-open: missing ledger, missing sha, or the kill switch never produce a page', () => {
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', landingsAvailable: false }).verdict, 'unknown');
  assert.equal(classifyDirectPush({ sha: '', actor: 'thomaspryor', landings: [] }).verdict, 'unknown');
  assert.equal(classifyDirectPush({ sha: SHA, actor: 'thomaspryor', landings: [], killSwitch: true }).verdict, 'skip');
});

test('appendLanding writes a JSONL row readLandings/findLanding can see; corrupt lines are skipped', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'landings-'));
  const row = appendLanding({ repoDir: repo, branch: 'refs/heads/land/worktree-x', sha: SHA, tip: OTHER, base: 'c'.repeat(40), runUrl: 'https://example/run/1', attempts: 1 });
  assert.equal(row.branch, 'land/worktree-x');
  fs.appendFileSync(path.join(repo, 'data', 'audit', 'landings.jsonl'), '{"sha":"partial\n');
  const { available, rows } = readLandings(repo);
  assert.equal(available, true);
  assert.equal(rows.length, 1);
  assert.equal(findLanding(rows, { sha: SHA }).tip, OTHER);
  assert.equal(findLanding(rows, { tip: OTHER }).sha, SHA);
  assert.equal(readLandings(path.join(repo, 'nope')).available, false);
  assert.equal(parseLandings('').length, 0);
  assert.throws(() => appendLanding({ repoDir: repo, branch: 'x' }), /requires branch and sha/);
});

test('buildDirectPushAlert: stable conditionKey per sha, digest disposition', () => {
  const a = buildDirectPushAlert({ sha: SHA, actor: 'thomaspryor', committerName: 'Tom', committerEmail: 't@t', message: 'fix: thing\n\nbody', runUrl: 'https://example/run/2' });
  assert.equal(a.conditionKey, conditionKeyFor(SHA));
  assert.equal(a.conditionKey, `direct-push:${SHA}`);
  assert.equal(a.disposition, 'digest');
  assert.match(a.description, /fix: thing/);
  assert.ok(!a.description.includes('body'));
  // The queue it lands in is public; lint-committed-pii.js reddens main on an email (BRO-4147).
  const real = buildDirectPushAlert({ sha: SHA, committerName: 'Tom Pryor', committerEmail: 'someone@example.com' });
  assert.ok(!/@/.test(real.description + real.title), 'no email-shaped text in the alert');
  assert.match(real.description, /committer Tom Pryor/);
  assert.throws(() => buildDirectPushAlert({}), /requires sha/);
});
