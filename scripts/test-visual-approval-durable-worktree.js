#!/usr/bin/env node
// BRO-8164: the working-tree patch id must equal the committed id for the same UI content (so the durable marker mints),
// and editing after the screenshot must change it. Real functions, real git repo.
'use strict';
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
assert.strictEqual(uiPatchIdWorkingTree(dir), '', 'untracked UI file -> no id');
fs.unlinkSync(path.join(dir, 'src/new.tsx'));
assert.strictEqual(uiPatchIdWorkingTree(dir), wt, 'clean tree after the commit still ids the branch diff');
