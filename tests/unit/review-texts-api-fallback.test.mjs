// BRO-5589: pure-function coverage for scripts/lib/review-texts-api-fallback.js
// (the review-texts reconciliation push-via-git-api.sh runs per attempt) and
// the outlet-registry reconcile now chained in push-via-git-api-merge.js.
// End-to-end bare-repo fixtures live in push-via-git-api.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const {
  mergeReviewTextsJson, reviewTextsDisqualifyingPath, isReviewFilePath, isReviewTextsRemote,
} = require('../../scripts/lib/review-texts-api-fallback.js');

const j = (o) => JSON.stringify(o, null, 2) + '\n';
const base = { url: 'u', outlet: 'NYT', fullText: '' };
const LONG = 'body text '.repeat(30);

test('concurrent protected + unprotected fields survive; ours wins keys it changed', () => {
  const r = mergeReviewTextsJson(
    j({ ...base, fullText: LONG, flag: 'ours' }),
    j({ ...base, humanReviewScore: 80, flag: 'remote', extra: 1 }),
    j({ ...base, flag: 'base' }),
  );
  const m = JSON.parse(r.content);
  assert.equal(m.humanReviewScore, 80);
  assert.equal(m.extra, 1);
  assert.equal(m.flag, 'ours');
  assert.equal(m.fullText, LONG);
});

test('a protected field remote holds is restored even when OUR stale copy removed it without a breadcrumb', () => {
  const m = JSON.parse(mergeReviewTextsJson(
    j({ url: 'u', outlet: 'NYT', fullText: LONG }),
    j({ ...base, humanReviewScore: 80, extra: 2 }),
    j({ ...base, humanReviewScore: 80 }),
  ).content);
  assert.equal(m.humanReviewScore, 80);
  assert.equal(m.extra, 2);
});

test('remote deleting an unprotected key ours left alone stays deleted', () => {
  const m = JSON.parse(mergeReviewTextsJson(
    j({ ...base, note: 'x', fullText: LONG }),
    j({ ...base }),
    j({ ...base, note: 'x' }),
  ).content);
  assert.equal('note' in m, false);
});

test('content group moves as a unit: remote re-collected body is not reverted by our stale body', () => {
  const remoteText = 'fresh shorter but correct text '.repeat(5);
  const m = JSON.parse(mergeReviewTextsJson(
    j({ ...base, fullText: LONG, contentTier: 'complete', note: 'ours' }),
    j({ ...base, fullText: remoteText, contentTier: 'excerpt' }),
    j({ ...base, fullText: LONG, contentTier: 'complete' }),
  ).content);
  assert.equal(m.fullText, remoteText, 'ours never changed the body, so the stale-body restore must not fire');
  assert.equal(m.contentTier, 'excerpt');
  assert.equal(m.note, 'ours');
});

test('unchanged result returns our exact bytes', () => {
  const ours = '{"url":"u","fullText":"a"}';
  const r = mergeReviewTextsJson(ours, j({ url: 'u', fullText: 'b' }), j({ url: 'u', fullText: 'b' }));
  assert.equal(r.content, ours);
  assert.equal(r.changed, false);
});

test('nested contentVerification restore is not lost through aliasing', () => {
  const r = mergeReviewTextsJson(
    j({ ...base, fullText: LONG, contentVerification: { note: 'ours' } }),
    j({ ...base, contentVerification: { wrongProduction: true } }),
    j({ ...base }),
  );
  assert.equal(JSON.parse(r.content).contentVerification.wrongProduction, true);
});

test('fails closed on unparsable or non-object input', () => {
  assert.throws(() => mergeReviewTextsJson(j(base), '{broken', j(base)), /remote version is not valid JSON/);
  assert.throws(() => mergeReviewTextsJson('[1]', j(base), null), /not a JSON object/);
  assert.throws(() => mergeReviewTextsJson(j(base), j(base), 'null'), /merge-base version is not a JSON object/);
});

test('disqualifier: failed-fetches.json and ADDED review files; modified review files and _pending adds pass', () => {
  assert.match(reviewTextsDisqualifyingPath([{ status: 'M', path: 'failed-fetches.json' }]), /failed-fetches/);
  assert.match(reviewTextsDisqualifyingPath([{ status: 'A', path: 's/o.json' }]), /added review file/);
  assert.equal(reviewTextsDisqualifyingPath([
    { status: 'M', path: 's/o.json' }, { status: 'A', path: '_pending/s/o.json' },
    { status: 'D', path: 's/p.json' }, { status: 'A', path: 'aggregator-archive/x/y.html' },
  ]), null);
  assert.equal(isReviewFilePath('s/o.json'), true);
  assert.equal(isReviewFilePath('_pending/o.json'), false);
  assert.equal(isReviewTextsRemote('https://x@github.com/thomaspryor/broadway-review-texts.git'), true);
  assert.equal(isReviewTextsRemote('https://github.com/thomaspryor/Broadwayscore.git'), false);
});

test('merge CLI exits 1 with nothing on stdout for an unparsable remote', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rtaf-cli-'));
  try {
    fs.writeFileSync(path.join(d, 'o'), j(base));
    fs.writeFileSync(path.join(d, 'r'), 'nope');
    fs.writeFileSync(path.join(d, 'b'), '');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/lib/review-texts-api-fallback.js'), 'merge', 's/o.json', path.join(d, 'o'), path.join(d, 'r'), path.join(d, 'b'), '0'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('push-via-git-api-merge.js restores a concurrent outlet-registry multiAuthor on an entry ours also changed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rtaf-registry-'));
  try {
    const entry = { name: 'Outlet', tier: 2 };
    fs.writeFileSync(path.join(d, 'b'), JSON.stringify({ outlets: { o1: entry } }));
    fs.writeFileSync(path.join(d, 'o'), JSON.stringify({ outlets: { o1: { ...entry, tier: 1 } } }));
    fs.writeFileSync(path.join(d, 'r'), JSON.stringify({ outlets: { o1: { ...entry, multiAuthor: true, aliases: ['alt'] } } }));
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/lib/push-via-git-api-merge.js'), 'data/outlet-registry.json', path.join(d, 'o'), path.join(d, 'r'), path.join(d, 'b')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const o1 = JSON.parse(out).outlets.o1;
    assert.equal(o1.tier, 1, 'our change wins');
    assert.equal(o1.multiAuthor, true, 'concurrent curated field restored');
    assert.deepEqual(o1.aliases, ['alt']);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('review LOW/MEDIUM fixes: group conflicts fail closed; a remote-unchanged group takes ours; __proto__ keys survive', () => {
  assert.throws(() => mergeReviewTextsJson(
    j({ ...base, fullText: LONG }), j({ ...base, fullText: 'other '.repeat(30) }), j(base),
  ), /content group/);
  assert.throws(() => mergeReviewTextsJson(
    j({ ...base, assignedScore: 70 }), j({ ...base, assignedScore: 40 }), j(base),
  ), /scoring group/);
  // Both changed the group identically: not a conflict.
  assert.equal(JSON.parse(mergeReviewTextsJson(
    j({ ...base, assignedScore: 70, a: 1 }), j({ ...base, assignedScore: 70, b: 2 }), j(base),
  ).content).b, 2);
  // Remote's group unchanged since base: ours wins silently.
  const m = JSON.parse(mergeReviewTextsJson(
    j({ ...base, fullText: LONG, assignedScore: 70 }), j({ ...base, note: 'r' }), j(base),
  ).content);
  assert.equal(m.fullText, LONG);
  assert.equal(m.assignedScore, 70);
  assert.equal(m.note, 'r');
  const p = JSON.parse(mergeReviewTextsJson(
    '{"url":"u","__proto__":{"x":1},"k":1}', '{"url":"u","k":2}', '{"url":"u","k":1}',
  ).content);
  assert.equal(p.k, 2, 'a real merge ran (remote change taken)');
  assert.equal(Object.prototype.hasOwnProperty.call(p, '__proto__'), true);
  assert.deepEqual(p['__proto__'], { x: 1 });
});

test('outlet-registry: a field or alias OUR commit removed is not restored from the remote\'s unchanged base copy', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rtaf-registry-rm-'));
  try {
    const curated = { name: 'Outlet', tier: 2, multiAuthor: true, defaultCritic: 'A', aliases: ['alt', 'keep'] };
    fs.writeFileSync(path.join(d, 'b'), JSON.stringify({ outlets: { o1: curated } }));
    fs.writeFileSync(path.join(d, 'o'), JSON.stringify({ outlets: { o1: { name: 'Outlet', tier: 2, aliases: ['keep'] } } }));
    // Remote changed something ELSE, so the merge really runs; o1 is untouched there.
    fs.writeFileSync(path.join(d, 'r'), JSON.stringify({ outlets: { o1: curated, o2: { name: 'New' } } }));
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts/lib/push-via-git-api-merge.js'), 'data/outlet-registry.json', path.join(d, 'o'), path.join(d, 'r'), path.join(d, 'b')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const reg = JSON.parse(out);
    assert.equal(reg.outlets.o1.multiAuthor, undefined, 'our deliberate clear stands');
    assert.equal(reg.outlets.o1.defaultCritic, undefined);
    assert.deepEqual(reg.outlets.o1.aliases, ['keep'], 'our removed alias stays removed');
    assert.equal(reg.outlets.o2.name, 'New', 'the concurrent addition still lands');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('review file: our deliberate shorter body and cleared score are not undone by the remote\'s unchanged base copy', () => {
  const baseRec = { ...base, fullText: LONG, assignedScore: 60, llmScore: { score: 60 } };
  const m = JSON.parse(mergeReviewTextsJson(
    j({ ...base, fullText: 'short corrected body' }),
    j({ ...baseRec, note: 'remote' }),
    j(baseRec),
  ).content);
  assert.equal(m.fullText, 'short corrected body');
  assert.equal(m.assignedScore, undefined);
  assert.equal(m.llmScore, undefined);
  assert.equal(m.note, 'remote');
});
