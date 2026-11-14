// BRO-3566: the per-outlet 3-way check of data/outlet-registry.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkRegistryMerge } = require('../check-registry-merge.js');
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check-registry-merge.js');

const reg = (outlets, alias = {}) => ({ _meta: {}, outlets, _aliasIndex: alias, lastUpdated: 'x' });
const clone = (x) => JSON.parse(JSON.stringify(x));
const BASE = reg({
  'chichester-observer': { displayName: 'Chichester Observer', tier: 3, domain: 'chichester.co.uk', aliases: ['chichester'] },
  nytimes: { displayName: 'NYT', tier: 1, domain: 'nytimes.com', aliases: ['nyt'] },
}, { nyt: 'nytimes' });

test('the BRO-1343 case: a fix one side made and the result lost is a REGRESSION', () => {
  const theirs = clone(BASE); theirs.outlets['chichester-observer'].domain = null; // main's fix
  const ours = clone(BASE); ours.outlets['chichester-observer'].tier = 4; // branch touched the same outlet
  const bad = clone(ours); // line merge kept the branch's whole block
  const f = checkRegistryMerge(BASE, ours, theirs, bad);
  assert.deepEqual(f.map((x) => `${x.kind} ${x.path}`), ['REGRESSION outlets.chichester-observer.domain']);
  const good = clone(ours); good.outlets['chichester-observer'].domain = null;
  assert.deepEqual(checkRegistryMerge(BASE, ours, theirs, good), []);
});

test('both sides changing one field differently is a CONFLICT', () => {
  const ours = clone(BASE); ours.outlets.nytimes.tier = 2;
  const theirs = clone(BASE); theirs.outlets.nytimes.tier = 3;
  const f = checkRegistryMerge(BASE, ours, theirs, theirs);
  assert.deepEqual(f.map((x) => `${x.kind} ${x.path}`), ['CONFLICT outlets.nytimes.tier']);
});

test('array fields merge as sets, key order is ignored', () => {
  const ours = clone(BASE); ours.outlets.nytimes.aliases = ['nyt', 'new york times'];
  const theirs = clone(BASE); theirs.outlets.nytimes.aliases = ['nyt', 'the times'];
  const r = clone(BASE); r.outlets.nytimes = { aliases: ['the times', 'nyt', 'new york times'], domain: 'nytimes.com', tier: 1, displayName: 'NYT' };
  assert.deepEqual(checkRegistryMerge(BASE, ours, theirs, r), []);
  r.outlets.nytimes.aliases = ['nyt', 'new york times'];
  assert.equal(checkRegistryMerge(BASE, ours, theirs, r)[0].kind, 'REGRESSION');
});

test('outlet add, remove and delete-vs-modify', () => {
  const ours = clone(BASE); ours.outlets.vulture = { displayName: 'Vulture', tier: 1 };
  const theirs = clone(BASE); delete theirs.outlets['chichester-observer'];
  const r = clone(ours); delete r.outlets['chichester-observer'];
  assert.deepEqual(checkRegistryMerge(BASE, ours, theirs, r), []);
  const resurrected = clone(ours);
  assert.deepEqual(checkRegistryMerge(BASE, ours, theirs, resurrected).map((x) => x.path), ['outlets.chichester-observer']);
  const modified = clone(BASE); modified.outlets['chichester-observer'].tier = 4;
  assert.equal(checkRegistryMerge(BASE, modified, theirs, r)[0].kind, 'CONFLICT');
});

test('_aliasIndex is checked per alias key', () => {
  const ours = reg(clone(BASE.outlets), { nyt: 'nytimes', vult: 'vulture' });
  const theirs = reg(clone(BASE.outlets), { nyt: 'nytimes', chich: 'chichester-observer' });
  const r = reg(clone(BASE.outlets), { nyt: 'nytimes', vult: 'vulture', chich: 'chichester-observer' });
  assert.deepEqual(checkRegistryMerge(BASE, ours, theirs, r), []);
  assert.deepEqual(checkRegistryMerge(BASE, ours, theirs, ours).map((x) => x.path), ['_aliasIndex.chich']);
});

test('CLI end to end in a temp repo: real merge is clean, a bad result is flagged, a bad ref is "could not check"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regmerge-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GITHUB_ACTIONS: '' };
  const sh = (c) => execSync(c, { cwd: dir, env, stdio: 'pipe' }).toString().trim();
  const write = (doc) => { fs.mkdirSync(path.join(dir, 'data'), { recursive: true }); fs.writeFileSync(path.join(dir, 'data/outlet-registry.json'), `${JSON.stringify(doc, null, 2)}\n`); };
  const run = (args) => { try { return { code: 0, out: execSync(`node ${SCRIPT} ${args}`, { cwd: dir, env }).toString() }; } catch (e) { return { code: e.status, out: e.stdout.toString() }; } };
  sh('git init -q -b main');
  write(BASE); sh('git add -A && git commit -qm base');
  sh('git checkout -qb branch');
  const ours = clone(BASE); ours.outlets.nytimes.tier = 2; write(ours); sh('git commit -qam ours');
  sh('git checkout -q main');
  const theirs = clone(BASE); theirs.outlets['chichester-observer'].domain = null; write(theirs); sh('git commit -qam theirs');
  sh('git merge -q --no-edit branch');
  const clean = run('--ancestor=$(git merge-base branch HEAD^1) --ours=branch --theirs=HEAD^1 --result=HEAD');
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.out, /clean/);
  write(ours); // simulate a line merge that kept the branch's whole file
  const bad = run('--ancestor=HEAD~2 --ours=branch --theirs=HEAD^1');
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /REGRESSION outlets\.chichester-observer\.domain/);
  const missing = run('--ancestor=nope --ours=branch --theirs=HEAD');
  assert.equal(missing.code, 0);
  assert.match(missing.out, /COULD NOT CHECK/);
});

test('a one-sided array change that the result re-sorted is not a REGRESSION', () => {
  const ours = clone(BASE); ours.outlets.nytimes.aliases = ['nyt', 'new york times'];
  const r = clone(ours); r.outlets.nytimes.aliases = ['new york times', 'nyt'];
  assert.deepEqual(checkRegistryMerge(BASE, ours, clone(BASE), r), []);
});
