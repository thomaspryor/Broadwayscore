/**
 * Post-rebase cross-show ownership gate for push-review-texts
 * (Notion 39b637c5-416f-8134).
 *
 * Replays the stale-checkout race: the poller re-created
 * tender-off-west-end-2026/thestage--dave-fargnoli.json 6 minutes after the
 * tender disambiguation moved the URL's owner to
 * tender-by-dave-harris-off-west-end-2026 (commit 65159277b5b). This gate runs
 * in the push action AFTER pull --rebase, so it sees post-move ownership and
 * drops the re-created file before it can be committed.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { decideOwnershipDrops } = require('../../scripts/validate-added-review-ownership');
const { _resetUrlOwnershipIndex } = require('../../scripts/lib/url-ownership');

const SOHO_URL = 'https://www.thestage.co.uk/reviews/tender-review-soho-theatre-london-dave-harris-matthew-xia';
const OWNER_SHOW = 'tender-by-dave-harris-off-west-end-2026';
const SIBLING_SHOW = 'tender-off-west-end-2026';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-gate-'));
  _resetUrlOwnershipIndex();
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetUrlOwnershipIndex();
});

function writeFile(showId, file, data) {
  const dir = path.join(tmpDir, showId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
  return `${showId}/${file}`;
}

describe('decideOwnershipDrops — tender stale-checkout race replay', () => {
  test('drops a new file whose URL is live under another show', () => {
    writeFile(OWNER_SHOW, 'thestage--dave-fargnoli.json', {
      url: SOHO_URL, outlet: 'The Stage', fullText: 'real review body',
    });
    const newFile = writeFile(SIBLING_SHOW, 'thestage--dave-fargnoli.json', {
      url: SOHO_URL, outlet: 'The Stage', source: 'show-score',
    });
    const drops = decideOwnershipDrops([newFile], tmpDir);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].file, newFile);
    assert.equal(drops[0].owner.showId, OWNER_SHOW);
  });

  test('keeps a new file when every cross-show copy is flagged (legit re-home)', () => {
    writeFile(OWNER_SHOW, 'thestage--dave-fargnoli.json', {
      url: SOHO_URL, wrongProduction: true,
    });
    const newFile = writeFile(SIBLING_SHOW, 'thestage--dave-fargnoli.json', { url: SOHO_URL });
    assert.equal(decideOwnershipDrops([newFile], tmpDir).length, 0);
  });

  test('keeps a new file when the owning copy is a roundup article', () => {
    writeFile(OWNER_SHOW, 'wet--roundup.json', { url: SOHO_URL, isRoundupArticle: true });
    const newFile = writeFile(SIBLING_SHOW, 'wet--roundup.json', { url: SOHO_URL });
    assert.equal(decideOwnershipDrops([newFile], tmpDir).length, 0);
  });

  test('keeps a new file with an unclaimed URL', () => {
    const newFile = writeFile(SIBLING_SHOW, 'guardian--arifa-akbar.json', {
      url: 'https://www.theguardian.com/stage/2026/jul/10/tender-review-bush-theatre',
    });
    assert.equal(decideOwnershipDrops([newFile], tmpDir).length, 0);
  });

  test('same-show existing copy is not a cross-show owner', () => {
    writeFile(SIBLING_SHOW, 'thestage--unknown.json', { url: SOHO_URL });
    const newFile = writeFile(SIBLING_SHOW, 'thestage--dave-fargnoli.json', { url: SOHO_URL });
    assert.equal(decideOwnershipDrops([newFile], tmpDir).length, 0);
  });

  test('honors allowCrossShowUrl escape hatch on the new file', () => {
    writeFile(OWNER_SHOW, 'thestage--dave-fargnoli.json', { url: SOHO_URL });
    const newFile = writeFile(SIBLING_SHOW, 'thestage--dave-fargnoli.json', {
      url: SOHO_URL, allowCrossShowUrl: true,
    });
    assert.equal(decideOwnershipDrops([newFile], tmpDir).length, 0);
  });

  test('never drops human-vouched work (humanReviewScore / _locked)', () => {
    writeFile(OWNER_SHOW, 'thestage--dave-fargnoli.json', { url: SOHO_URL });
    const scored = writeFile(SIBLING_SHOW, 'thestage--dave-fargnoli.json', {
      url: SOHO_URL, humanReviewScore: 78,
    });
    const locked = writeFile(SIBLING_SHOW, 'thestage--locked.json', {
      url: SOHO_URL, _locked: true,
    });
    assert.equal(decideOwnershipDrops([scored, locked], tmpDir).length, 0);
  });

  test('skips unparseable and url-less files without dropping', () => {
    fs.mkdirSync(path.join(tmpDir, SIBLING_SHOW), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, SIBLING_SHOW, 'broken.json'), '{not json');
    const noUrl = writeFile(SIBLING_SHOW, 'thestage--no-url.json', { outlet: 'The Stage' });
    const drops = decideOwnershipDrops([`${SIBLING_SHOW}/broken.json`, noUrl], tmpDir);
    assert.equal(drops.length, 0);
  });
});

describe('CLI --base mode — committed re-creation dropped via git rm + commit', () => {
  const SCRIPT = path.resolve('scripts/validate-added-review-ownership.js');

  function git(cwd, cmd) {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf8' });
  }

  test('drops committed violator, keeps legit add, creates drop commit', () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t');
    git(repo, 'config user.name t');

    // Base state (plays the role of freshly-rebased origin/main): owner show
    // holds the URL live.
    const ownerDir = path.join(repo, OWNER_SHOW);
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.writeFileSync(path.join(ownerDir, 'thestage--dave-fargnoli.json'),
      JSON.stringify({ url: SOHO_URL, fullText: 'real body' }));
    git(repo, 'add -A');
    git(repo, 'commit -qm base');
    git(repo, 'branch base-marker');

    // Writer's commit: re-creates the URL under the sibling + one legit file.
    const sibDir = path.join(repo, SIBLING_SHOW);
    fs.mkdirSync(sibDir, { recursive: true });
    fs.writeFileSync(path.join(sibDir, 'thestage--dave-fargnoli.json'),
      JSON.stringify({ url: SOHO_URL, source: 'show-score' }));
    fs.writeFileSync(path.join(sibDir, 'guardian--arifa-akbar.json'),
      JSON.stringify({ url: 'https://www.theguardian.com/stage/2026/jul/10/tender-review-bush-theatre' }));
    git(repo, 'add -A');
    git(repo, 'commit -qm "writer changes"');

    const out = execSync(`node ${SCRIPT} --base=base-marker`, { cwd: repo, encoding: 'utf8' });
    assert.match(out, /dropping tender-off-west-end-2026\/thestage--dave-fargnoli\.json/);
    assert.equal(fs.existsSync(path.join(sibDir, 'thestage--dave-fargnoli.json')), false);
    assert.equal(fs.existsSync(path.join(sibDir, 'guardian--arifa-akbar.json')), true);
    assert.equal(fs.existsSync(path.join(ownerDir, 'thestage--dave-fargnoli.json')), true);
    assert.match(git(repo, 'log -1 --format=%s'), /ownership-gate: drop 1 cross-show re-creation/);
    // tree is clean — the drop was committed, nothing left half-staged
    assert.equal(git(repo, 'status --porcelain').trim(), '');
  });

  test('rename detection cannot hide a violator (--no-renames regression lock)', () => {
    // A deletion of a structurally similar stub in the same commit as the
    // violator gets paired as a RENAME by default git diff — which excludes
    // the violator from --diff-filter=A. --no-renames keeps it visible.
    const repo = path.join(tmpDir, 'repo4');
    fs.mkdirSync(repo);
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t');
    git(repo, 'config user.name t');
    const ownerDir = path.join(repo, OWNER_SHOW);
    fs.mkdirSync(ownerDir, { recursive: true });
    fs.writeFileSync(path.join(ownerDir, 'thestage--dave-fargnoli.json'),
      JSON.stringify({ url: SOHO_URL, fullText: 'real body' }));
    // stub that the writer commit will delete — near-identical to the violator
    const sibDir = path.join(repo, SIBLING_SHOW);
    fs.mkdirSync(sibDir, { recursive: true });
    fs.writeFileSync(path.join(sibDir, 'thestage--unknown.json'),
      JSON.stringify({ url: SOHO_URL, outlet: 'The Stage', source: 'show-score' }));
    git(repo, 'add -A');
    git(repo, 'commit -qm base');
    git(repo, 'branch base-marker');
    // writer: delete stub + re-create violator with near-identical content → rename pairing
    fs.rmSync(path.join(sibDir, 'thestage--unknown.json'));
    fs.writeFileSync(path.join(sibDir, 'thestage--dave-fargnoli.json'),
      JSON.stringify({ url: SOHO_URL, outlet: 'The Stage', source: 'show-score' }));
    git(repo, 'add -A');
    git(repo, 'commit -qm "writer changes"');
    // sanity: default diff DOES pair them as a rename (guards test validity)
    const renamed = git(repo, 'diff -M --name-status base-marker HEAD');
    assert.match(renamed, /^R/m, 'fixture should trigger rename detection');
    execSync(`node ${SCRIPT} --base=base-marker`, { cwd: repo, encoding: 'utf8' });
    assert.equal(fs.existsSync(path.join(sibDir, 'thestage--dave-fargnoli.json')), false,
      'violator must be dropped despite rename pairing');
  });

  test('mid-rebase/merge state → gate skips without touching anything', () => {
    const repo = path.join(tmpDir, 'repo3');
    fs.mkdirSync(repo);
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t');
    git(repo, 'config user.name t');
    fs.mkdirSync(path.join(repo, OWNER_SHOW), { recursive: true });
    fs.writeFileSync(path.join(repo, OWNER_SHOW, 'seed.json'), JSON.stringify({ url: SOHO_URL }));
    git(repo, 'add -A');
    git(repo, 'commit -qm base');
    git(repo, 'branch base-marker');
    const sibDir = path.join(repo, SIBLING_SHOW);
    fs.mkdirSync(sibDir, { recursive: true });
    fs.writeFileSync(path.join(sibDir, 'violator.json'), JSON.stringify({ url: SOHO_URL }));
    git(repo, 'add -A');
    git(repo, 'commit -qm "writer changes"');
    // Simulate an in-progress merge (the action's rebase --continue || true path)
    fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), git(repo, 'rev-parse HEAD').trim() + '\n');
    const out = execSync(`node ${SCRIPT} --base=base-marker`, { cwd: repo, encoding: 'utf8' });
    assert.match(out, /MERGE_HEAD in progress — skipping/);
    assert.equal(fs.existsSync(path.join(sibDir, 'violator.json')), true); // untouched
  });

  test('stale MERGE_HEAD (BRO-142 class) → skips with a distinct, louder warning', () => {
    const repo = path.join(tmpDir, 'repo-stale-merge-head');
    fs.mkdirSync(repo);
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t');
    git(repo, 'config user.name t');
    fs.mkdirSync(path.join(repo, OWNER_SHOW), { recursive: true });
    fs.writeFileSync(path.join(repo, OWNER_SHOW, 'seed.json'), JSON.stringify({ url: SOHO_URL }));
    git(repo, 'add -A');
    git(repo, 'commit -qm base');
    git(repo, 'branch base-marker');
    const sibDir = path.join(repo, SIBLING_SHOW);
    fs.mkdirSync(sibDir, { recursive: true });
    fs.writeFileSync(path.join(sibDir, 'violator.json'), JSON.stringify({ url: SOHO_URL }));
    git(repo, 'add -A');
    git(repo, 'commit -qm "writer changes"');
    const mergeHeadPath = path.join(repo, '.git', 'MERGE_HEAD');
    fs.writeFileSync(mergeHeadPath, git(repo, 'rev-parse HEAD').trim() + '\n');
    // Back-date well past STALE_MERGE_HEAD_WARN_SEC (1800s) so this reads as
    // a leftover from a dead session, not a normal few-seconds-old merge.
    const staleTime = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(mergeHeadPath, staleTime, staleTime);
    const out = execSync(`node ${SCRIPT} --base=base-marker`, { cwd: repo, encoding: 'utf8' });
    assert.match(out, /STALE MERGE_HEAD/);
    assert.match(out, /BRO-142/);
    assert.equal(fs.existsSync(path.join(sibDir, 'violator.json')), true); // untouched — detect only, never auto-recovers
  });

  test('no violations → no drop commit, tree untouched', () => {
    const repo = path.join(tmpDir, 'repo2');
    fs.mkdirSync(repo);
    git(repo, 'init -q -b main');
    git(repo, 'config user.email t@t');
    git(repo, 'config user.name t');
    fs.mkdirSync(path.join(repo, OWNER_SHOW), { recursive: true });
    fs.writeFileSync(path.join(repo, OWNER_SHOW, 'seed.json'), JSON.stringify({ url: SOHO_URL }));
    git(repo, 'add -A');
    git(repo, 'commit -qm base');
    git(repo, 'branch base-marker');
    fs.writeFileSync(path.join(repo, OWNER_SHOW, 'guardian--new.json'),
      JSON.stringify({ url: 'https://www.theguardian.com/stage/2026/may/04/unrelated' }));
    git(repo, 'add -A');
    git(repo, 'commit -qm "writer changes"');
    const head = git(repo, 'rev-parse HEAD').trim();
    execSync(`node ${SCRIPT} --base=base-marker`, { cwd: repo, encoding: 'utf8' });
    assert.equal(git(repo, 'rev-parse HEAD').trim(), head); // no extra commit
    assert.equal(fs.existsSync(path.join(repo, OWNER_SHOW, 'guardian--new.json')), true);
  });
});
