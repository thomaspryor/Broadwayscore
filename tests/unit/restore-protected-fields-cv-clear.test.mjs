/**
 * Regression test for restore-protected-fields.js nested contentVerification
 * restore honoring intentional top-level clears.
 *
 * Bug: the nested MANUAL_CV_FIELDS restore resurrected contentVerification.
 * wrongProduction / .wrongArticle from remote whenever local lacked them, with
 * no clear-awareness. rebuild-all-reviews.js promotes CV flags to top-level
 * every run (~line 1320), so a resurrected stale CV flag silently re-excludes a
 * review whose top-level flag was deliberately cleared (human manual clear, or a
 * URL-replace reset in review-normalization.js that deletes contentVerification).
 *
 * The script self-executes on require (reads process.argv), so this drives it as
 * a subprocess against a throwaway git repo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(repoRoot, 'scripts/lib/restore-protected-fields.js');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpf-cv-'));
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  git('init -q');
  git('config user.email t@t.co');
  git('config user.name t');
  fs.mkdirSync(path.join(dir, 'd'));
  return { dir, git };
}
const write = (dir, obj) =>
  fs.writeFileSync(path.join(dir, 'd/a.json'), JSON.stringify(obj) + '\n');
const read = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'd/a.json'), 'utf8'));

test('CV restore is SKIPPED when the top-level flag was intentionally cleared', () => {
  const { dir, git } = makeRepo();
  // Remote: classifier flagged it via contentVerification.
  write(dir, { url: 'x', contentVerification: { wrongProduction: true } });
  git('add -A'); git('commit -qm base');
  const remote = git('rev-parse HEAD').toString().trim();
  // Local: human cleared the top-level flag; URL-replace deleted contentVerification.
  write(dir, { url: 'x', humanReviewedWrongProduction: false });
  git('add -A'); git('commit -qm local');

  execSync(`node ${SCRIPT} ${remote}`, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const after = read(dir);
  assert.equal(after.contentVerification?.wrongProduction, undefined,
    'stale CV.wrongProduction must NOT be resurrected over an intentional top-level clear');
});

test('CV.wrongArticle is governed by a wrongShow clear (it promotes to wrongShow, not wrongFullText)', () => {
  const { dir, git } = makeRepo();
  // Remote: classifier flagged the article via contentVerification.wrongArticle.
  write(dir, { url: 'x', contentVerification: { wrongArticle: true } });
  git('add -A'); git('commit -qm base');
  const remote = git('rev-parse HEAD').toString().trim();
  // Local: human cleared wrongShow (the flag CV.wrongArticle promotes to); CV deleted.
  write(dir, { url: 'x', wrongShowManualClear: true });
  git('add -A'); git('commit -qm local');

  execSync(`node ${SCRIPT} ${remote}`, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const after = read(dir);
  assert.equal(after.contentVerification?.wrongArticle, undefined,
    'stale CV.wrongArticle must NOT be resurrected over a wrongShow clear (it re-promotes to wrongShow)');
});

test('CV restore STILL fires for genuine data-loss (no clear breadcrumb)', () => {
  const { dir, git } = makeRepo();
  write(dir, { url: 'x', contentVerification: { wrongProduction: true } });
  git('add -A'); git('commit -qm base');
  const remote = git('rev-parse HEAD').toString().trim();
  // Local lost contentVerification with NO clear breadcrumb → real data-loss.
  write(dir, { url: 'x' });
  git('add -A'); git('commit -qm local');

  execSync(`node ${SCRIPT} ${remote}`, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  const after = read(dir);
  assert.equal(after.contentVerification?.wrongProduction, true,
    'a CV flag with no clear breadcrumb must still be restored (data-loss protection)');
});
