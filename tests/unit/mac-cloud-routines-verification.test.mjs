// BRO-5846: pins the Mac-to-cloud state that is verifiable from the repo.
// Recreating the three paused routines (morning email, Sunday newsletter
// review, opening-night backup) needs claude.ai cloud tooling and is NOT
// asserted here; their Mac labels must stay out of mac-retired.json until a
// cloud run is proven (a retired label with no working replacement = no email).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const retired = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/mac-retired.json'), 'utf8'));
const labels = retired.entries.map((e) => e.label);

test('weekly-retro: Mac job retired, cloud doc present (exactly one runner)', () => {
  assert.ok(labels.includes('com.bwsc.weekly-retro'));
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/cloud-routines/weekly-retro.md')));
});

test('overhaul-driver (node: command not found) retired', () => {
  assert.ok(labels.includes('com.broadwayscore.overhaul-driver'));
});

test('every retired entry names a replacement and watchers', () => {
  for (const e of retired.entries) {
    assert.ok(e.replacedBy?.length, `${e.label} replacedBy`);
    assert.ok(e.watchers?.length, `${e.label} watchers`);
  }
});

test('Mac labels whose cloud replacement is unproven are not retired yet', () => {
  for (const l of ['com.broadwayscore.morning-digest', 'com.broadwayscore.newsletter-sunday-review', 'com.bwsc.opening-night-backup-trigger']) {
    assert.ok(!labels.includes(l), `${l} retired before its cloud routine was proven`);
  }
});

test('auth-health distinguishes plan usage cap from auth failure', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/check-claude-auth-health.js'), 'utf8');
  assert.match(src, /claude-usage-cap/);
});

test('landed rescues are on main', () => {
  for (const f of ['scripts/lib/prior-run-url-signal.js', 'scripts/lib/merge-keep-run.sh', 'scripts/lib/undriven-rebase-lint.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  }
});

// BRO-6216: the retire list's safety net was never enforced. validateEntry only checks that the
// watchers array is non-empty, so a watcher could name a file that does not contain its condition.
test('every watcher file exists and contains its conditionKey', () => {
  for (const e of retired.entries) {
    for (const w of e.watchers) {
      assert.ok(w.conditionKey && w.file, `${e.label}: watcher needs conditionKey and file`);
      const f = path.join(ROOT, w.file);
      assert.ok(fs.existsSync(f), `${e.label}: watcher file ${w.file} is missing`);
      assert.ok(fs.readFileSync(f, 'utf8').includes(w.conditionKey), `${e.label}: ${w.file} does not contain conditionKey "${w.conditionKey}"`);
    }
  }
});

// replacedBy must be checkable: "nothing: <reason>", or text naming a workflow / routine doc that exists.
test('every replacedBy item is "nothing: <reason>" or names an existing workflow or routine doc', () => {
  for (const e of retired.entries) {
    for (const r of e.replacedBy) {
      if (/^nothing: \S/.test(r)) continue;
      const paths = r.match(/(?:\.github\/workflows|docs\/cloud-routines)\/[\w.-]+\.(?:ya?ml|md)/g) || [];
      assert.ok(paths.length, `${e.label}: replacedBy "${r}" names no workflow or routine doc path`);
      for (const p of paths) assert.ok(fs.existsSync(path.join(ROOT, p)), `${e.label}: replacedBy path ${p} does not exist`);
    }
  }
});

test('linear-delegation-check and linear-drain-parked are retired (BRO-6216)', () => {
  for (const l of ['com.broadwayscore.linear-delegation-check', 'com.broadwayscore.linear-drain-parked']) {
    assert.ok(labels.includes(l), `${l} retired`);
  }
});
