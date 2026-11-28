#!/usr/bin/env node
// hygiene-help-flag-ok: test file, no CLI args; only builds a throwaway temp repo and asserts
// BRO-8164: the working-tree patch id must equal the committed id for the same UI content (so the durable marker mints),
// and editing after the screenshot must change it. Real functions, real git repo.
'use strict';
require('./lib/refuse-under-bare-node-test.js'); // BRO-7984: exits 0 if the node --test runner picked this file up
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { uiPatchId, uiPatchIdWorkingTree } = require('./lib/visual-approval-durable.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-wt-'));
const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'src/a.tsx'), 'export const A = () => <div>a</div>;\n');
g('add', '-A'); g('commit', '-q', '-m', 'base');
g('update-ref', 'refs/remotes/origin/main', 'HEAD');
g('checkout', '-q', '-b', 'feat');

fs.writeFileSync(path.join(dir, 'src/a.tsx'), 'export const A = () => <div className="x">a</div>;\n');
const wt = uiPatchIdWorkingTree(dir);
assert.ok(wt && wt.length === 20, 'dirty tree yields a 20-char id');
g('add', '-A'); g('commit', '-q', '-m', 'ui');
assert.strictEqual(uiPatchId(dir), wt, 'committed id equals the earlier working-tree id');

fs.writeFileSync(path.join(dir, 'src/a.tsx'), 'export const A = () => <div className="y">a</div>;\n');
const edited = uiPatchIdWorkingTree(dir);
assert.ok(edited && edited !== wt, 'an edit after the screenshot gives a different id');
g('checkout', '-q', 'src/a.tsx');

fs.writeFileSync(path.join(dir, 'src/new.tsx'), 'export const N = () => null;\n');
// BRO-8164 (repeat asks): an untracked UI file is part of the design, so it gets an id (it used to be '', which meant
// the approval could never be kept) that differs from the id without it and equals the id once committed.
const withNew = uiPatchIdWorkingTree(dir);
assert.ok(withNew && withNew !== wt, 'untracked UI file -> its own id, different from the diff without it');
g('add', '-A'); g('commit', '-q', '-m', 'new');
assert.strictEqual(uiPatchId(dir), withNew, 'committing the new file keeps the id');
g('reset', '-q', '--hard', 'HEAD~1');
assert.ok(!fs.existsSync(path.join(dir, 'src/new.tsx')), 'reset removed the new file');
assert.strictEqual(uiPatchIdWorkingTree(dir), wt, 'clean tree after the commit still ids the branch diff');
