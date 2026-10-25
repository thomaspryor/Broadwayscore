import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { copyUrlOwnerFolder, preflight, filesChangedByUnreplayed } = require('./preflight-review-fix-plan.js');

// BRO-3065: a url repair proven by another show's folder holding the url must
// replay with that folder present, or preflight reports a false FAIL.
test('copyUrlOwnerFolder copies the folder that already holds the current url', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-src-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tmp-'));
  const url = 'https://www.whatsonstage.com/news/here-we-are-at-the-national-theatre-review_1676732/';
  fs.mkdirSync(path.join(src, 'blueberries-2026'));
  fs.writeFileSync(path.join(src, 'blueberries-2026', 'wos.json'), JSON.stringify({ url, publishDate: '2026-02-12' }));
  fs.mkdirSync(path.join(src, 'here-we-are-2025'));
  fs.writeFileSync(path.join(src, 'here-we-are-2025', 'wos--crompton.json'), JSON.stringify({ url }));
  const detect = (folder, u) => (u.includes('here-we-are') ? { matchedShowId: 'here-we-are-2025' } : null);
  const copied = new Set(['blueberries-2026']);
  copyUrlOwnerFolder(src, tmp, 'blueberries-2026/wos.json', copied, { detect });
  assert.ok(copied.has('here-we-are-2025'));
  assert.ok(fs.existsSync(path.join(tmp, 'here-we-are-2025', 'wos--crompton.json')));
  // nothing to copy when no other folder holds it
  const copied2 = new Set();
  copyUrlOwnerFolder(src, fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tmp-')), 'blueberries-2026/wos.json', copied2, { detect: () => null });
  assert.equal(copied2.size, 0);
});

// BRO-5386: a delete/move planned against a stale review-texts copy was refused at apply time.
test('fileOpSourceProblem fails a delete/move whose source is gone, and tracks earlier actions in the plan', () => {
  const { fileOpSourceProblem } = require('./preflight-review-fix-plan.js');
  const have = new Set(['a/x.json', 'a/y.json']);
  const exists = (rel) => have.has(rel);
  const removed = new Set(); const created = new Set();
  // present source passes
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/x.json' }, exists, removed, created), null);
  // the same file twice: the second delete finds it gone
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/x.json' }, exists, removed, created), /^Source not found/);
  // a move's destination can be the source of a later action
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'a/y.json', destPath: 'b/y.json' }, exists, removed, created), null);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'b/y.json' }, exists, removed, created), null);
  // a source that never existed (the real incident: already re-homed by another process)
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'cruise-west-end-2022/standard--nick-curtis.json', destPath: 'cruise-west-end-2021/standard--nick-curtis.json' }, exists, new Set(), new Set()), /Source not found/);
  // restore and field edits are not this check's business
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'restore', sourcePath: 'zzz/q.json' }, exists, new Set(), new Set()), null);
  assert.equal(fileOpSourceProblem({ type: 'review-field-edit', file: 'zzz/q.json' }, exists, new Set(), new Set()), null);
  // delete then restore of the same path (BRO-5373 shape): the restore puts it back, so a later move has a source
  const r2 = new Set(); const c2 = new Set();
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/y.json' }, exists, r2, c2), null);
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'a/y.json', destPath: 'c/y.json' }, exists, r2, c2), /^Source not found/);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'restore', sourcePath: 'a/y.json', fromCommit: 'abc' }, exists, r2, c2), null);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'move', sourcePath: 'a/y.json', destPath: 'c/y.json' }, exists, r2, c2), null);
});

test('preflight() reports a missing review-file-op source as a FAIL against a given tree', () => {
  const { preflight } = require('./preflight-review-fix-plan.js');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tree-'));
  fs.mkdirSync(path.join(tree, 'show-a'));
  fs.writeFileSync(path.join(tree, 'show-a', 'o--c.json'), '{}');
  const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-plan-')), 'p.json');
  fs.writeFileSync(planPath, JSON.stringify({ issueNumber: 'bro-x', status: 'pending', plan: { actions: [
    { type: 'review-file-op', operation: 'delete', sourcePath: 'show-a/o--c.json' },
    { type: 'review-file-op', operation: 'move', sourcePath: 'show-a/gone.json', destPath: 'show-b/gone.json' },
  ] } }));
  const lines = [];
  const { failed } = preflight([planPath], { reviewTextsDir: tree, log: (l) => lines.push(l) });
  assert.equal(failed, 1);
  assert.ok(lines.some((l) => /FAIL bro-x move show-a\/gone\.json: Source not found/.test(l)));
});

test('a rename is checked and tracked like a move (the executor treats them alike)', () => {
  const { fileOpSourceProblem } = require('./preflight-review-fix-plan.js');
  const exists = (rel) => rel === 'a/x.json';
  const removed = new Set(); const created = new Set();
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'rename', sourcePath: 'a/gone.json', destPath: 'a/z.json' }, exists, removed, created), /^Source not found/);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'rename', sourcePath: 'a/x.json', destPath: 'a/z.json' }, exists, removed, created), null);
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/z.json' }, exists, removed, created), null);
});

// BRO-5386 regression: resolveReviewTextsDir() named /root/broadway-review-texts (HOME=/root) while the cloud clone is at
// /home/user/broadway-review-texts, so the preflight checked a directory that did not exist and FAILed every action.
test('pickReviewTextsTree skips a missing or empty directory and falls through to the first real tree', () => {
  const { pickReviewTextsTree } = require('./preflight-review-fix-plan.js');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-empty-'));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-real-'));
  fs.mkdirSync(path.join(real, 'show-a'));
  const dotOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-dot-'));
  fs.mkdirSync(path.join(dotOnly, '.git'));
  assert.equal(pickReviewTextsTree(['/nonexistent/broadway-review-texts', empty, dotOnly, real], { env: {}, warn() {} }), real);
  assert.equal(pickReviewTextsTree([real, empty], { env: {}, warn() {} }), real);
  // nothing usable: the data/review-texts default, never undefined
  assert.match(pickReviewTextsTree(['/nonexistent/a', empty], { env: {}, warn() {} }), /data[\\/]review-texts$/);
});

// BRO-6047: a copied snapshot listed first must not beat a live git clone.
test('pickReviewTextsTree prefers a git checkout over a plain snapshot and warns when only a snapshot exists', () => {
  const { pickReviewTextsTree } = require('./preflight-review-fix-plan.js');
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-snap-'));
  fs.mkdirSync(path.join(snapshot, 'show-a'));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-clone-'));
  fs.mkdirSync(path.join(clone, '.git'));
  fs.mkdirSync(path.join(clone, 'show-a'));
  const warns = [];
  assert.equal(pickReviewTextsTree([snapshot, clone], { warn: (m) => warns.push(m), env: { REVIEW_TEXTS_DIR: snapshot } }), snapshot);
  assert.equal(pickReviewTextsTree([snapshot, clone], { warn: (m) => warns.push(m), env: {} }), clone);
  assert.equal(warns.length, 0);
  assert.equal(pickReviewTextsTree([snapshot], { warn: (m) => warns.push(m), env: {} }), snapshot);
  assert.match(warns[0], /plain snapshot.*old/);
});

test('fileOpSourceProblem refuses a path that escapes the tree and normalizes ./ segments', () => {
  const { fileOpSourceProblem } = require('./preflight-review-fix-plan.js');
  const exists = (rel) => rel === 'a/x.json';
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: '../etc/passwd' }, exists, new Set(), new Set()), /escapes/);
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: '/abs/a.json' }, exists, new Set(), new Set()), /escapes/);
  const removed = new Set(); const created = new Set();
  assert.equal(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/./x.json' }, exists, removed, created), null);
  // the normalized path is what was removed
  assert.match(fileOpSourceProblem({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/x.json' }, exists, removed, created), /Source not found/);
});

// BRO-5866: a run-script arg shape the executor refuses fails here, before the land.
test('preflight() fails a run-script action whose args the executor would refuse', () => {
  const { preflight } = require('./preflight-review-fix-plan.js');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-tree-'));
  fs.mkdirSync(path.join(tree, 'show-a'));
  const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-plan-')), 'p.json');
  fs.writeFileSync(planPath, JSON.stringify({ issueNumber: 'bro-y', status: 'pending', plan: { actions: [
    { type: 'run-script', script: 'x.js', args: '--apply' },
    { type: 'run-script', script: 'x.js', arguments: ['--apply'] },
    { type: 'run-script', script: 'x.js', args: '--a', arguments: ['--b'] },
  ] } }));
  const lines = [];
  const { failed } = preflight([planPath], { reviewTextsDir: tree, log: (l) => lines.push(l) });
  assert.equal(failed, 1);
  assert.ok(lines.some((l) => /FAIL bro-y run-script x\.js: .*both args and arguments/.test(l)));
});

// BRO-5892: data-edit actions used to print "skip data-edit (not replayed)", so a
// stale oldValue only failed at apply time, after a ~45 min land.
function dataEditFixture() {
  const core = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-core-'));
  fs.writeFileSync(path.join(core, 'shows.json'), JSON.stringify({ shows: [{ id: 'a-2026', venue: 'Old' }] }));
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-rt-'));
  const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-plan-'));
  const write = (name, actions) => {
    const p = path.join(planDir, `${name}.json`);
    fs.writeFileSync(p, JSON.stringify({ issueNumber: name, status: 'pending', plan: { actions } }));
    return p;
  };
  return { core, rt, write };
}
const edit = (oldValue, newValue) => ({ type: 'data-edit', file: 'shows.json', showId: 'a-2026', field: 'venue', oldValue, newValue });

test('preflight replays data-edits in order, chaining oldValue', () => {
  const { core, rt, write } = dataEditFixture();
  const lines = [];
  const { failed } = preflight([write('p1', [edit('Old', 'Mid'), edit('Mid', 'New')])], { reviewTextsDir: rt, coreDataDir: core, log: (l) => lines.push(l) });
  assert.equal(failed, 0, lines.join('\n'));
  assert.ok(!lines.some((l) => /skip data-edit/.test(l)));
  // The copy is in memory only.
  assert.equal(JSON.parse(fs.readFileSync(path.join(core, 'shows.json'), 'utf8')).shows[0].venue, 'Old');
});

test('preflight FAILs a stale data-edit oldValue and a field off the allowlist', () => {
  const { core, rt, write } = dataEditFixture();
  const lines = [];
  const bad = { ...edit('Old', 'x'), field: 'tags' };
  const { failed } = preflight([write('p2', [edit('Stale', 'New'), bad])], { reviewTextsDir: rt, coreDataDir: core, log: (l) => lines.push(l) });
  assert.equal(failed, 2, lines.join('\n'));
  assert.ok(lines.some((l) => /FAIL p2 shows.json a-2026.venue/.test(l)));
});

test('a data-edit after an unreplayed change to the same file is a WARN, not a FAIL', () => {
  const { core, rt, write } = dataEditFixture();
  const lines = [];
  const { failed } = preflight([write('p3', [{ type: 'retitle-show', showId: 'a-2026' }, edit('Stale', 'New')])], { reviewTextsDir: rt, coreDataDir: core, log: (l) => lines.push(l) });
  assert.equal(failed, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /WARN p3 shows.json/.test(l)));
});

test('filesChangedByUnreplayed names the files each unreplayed action may change', () => {
  assert.deepEqual(filesChangedByUnreplayed({ type: 'retire-show' }), ['shows.json', 'audience-buzz.json']);
  assert.equal(filesChangedByUnreplayed({ type: 'run-script' }).length, 3);
  assert.deepEqual(filesChangedByUnreplayed({ type: 'review-file-op' }), []);
});

// BRO-5886: an ingest-html-handoff envelope the executor would refuse FAILs before the land.
test('preflight FAILs a handoff encrypted to a stale key and passes one for the committed key', () => {
  const { preflight } = require('./preflight-review-fix-plan.js');
  const h = require('./html-handoff.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hh-'));
  const tree = path.join(dir, 'tree'); fs.mkdirSync(path.join(tree, 'show-a'), { recursive: true });
  const committed = h.generateKeyPair(); const stale = h.generateKeyPair();
  const pemPath = path.join(dir, 'pub.pem'); fs.writeFileSync(pemPath, committed.publicKey);
  const url = 'https://bachtrack.com/review-x';
  const html = `<html><head><link rel="canonical" href="${url}"></head><body>${'text '.repeat(200)}</body></html>`;
  const plan = (pub) => {
    const p = path.join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify({ issueNumber: 'bro-1', status: 'pending', plan: { actions: [h.buildAction({ showId: 'show-a', url, html, publicKeyPem: pub })] } }));
    return p;
  };
  const run = (p, pem = pemPath) => { const lines = []; const r = preflight([p], { reviewTextsDir: tree, log: (l) => lines.push(l), htmlHandoffPublicKeyPath: pem }); return { r, out: lines.join('\n') }; };
  assert.doesNotMatch(run(plan(committed.publicKey)).out, /FAIL/);
  assert.match(run(plan(stale.publicKey)).out, /FAIL .*committed key/);
  assert.match(run(plan(committed.publicKey), path.join(dir, 'missing.pem')).out, /FAIL .*dispatch html-handoff-key/);
});

// BRO-6182: an add-commercial-entry behind an unreplayed add-show only WARNed, so a field the
// executor refuses (humanReviewedDesignation) failed in CI after the land.
test('preflight() fails an add-commercial-entry with a disallowed field even behind an unreplayed add-show', () => {
  const { core, rt, write } = dataEditFixture();
  fs.writeFileSync(path.join(core, 'commercial.json'), JSON.stringify({ shows: {} }));
  const entry = { designation: 'Windfall', humanReviewedDesignation: true };
  const addShow = { type: 'add-show', show: { id: 'n-2009', slug: 'n-2009' } };
  const bad = write('bad', [addShow, { type: 'add-commercial-entry', slug: 'n-2009', entry }]);
  const lines = [];
  assert.equal(preflight([bad], { reviewTextsDir: rt, coreDataDir: core, log: (l) => lines.push(l) }).failed, 1);
  assert.ok(lines.some((l) => /FAIL bad add-commercial-entry n-2009: field "humanReviewedDesignation" not allowed/.test(l)));
  const good = write('good', [addShow, { type: 'add-commercial-entry', slug: 'n-2009', entry: { designation: 'Windfall' } }]);
  assert.equal(preflight([good], { reviewTextsDir: rt, coreDataDir: core, log: () => {} }).failed, 0);
});
