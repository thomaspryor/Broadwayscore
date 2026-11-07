// BRO-5938: on the owner's Mac, data/review-texts was a stamped COPY that
// setup-local-data.sh --all replaced (and deleted) on every re-sync, so any
// review a Mac-local scrape or ingest wrote there vanished. The fix links
// data/review-texts to the ~/broadway-review-texts clone. These tests run the
// real sourced helper against fixture trees. Fixture origins are local paths that
// do not exist, so the helper's pull fails fast offline and never fetches the real repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'link-review-texts-clone.sh');
const SETUP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'setup-local-data.sh');

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !['CLAUDE_CODE_REMOTE', 'REVIEW_TEXTS_SOURCE', 'GITHUB_ACTIONS', 'REVIEW_TEXTS_COPY'].includes(k)));

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function fixture({ origin = '/nonexistent/broadway-review-texts.git' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-link-'));
  const clone = path.join(root, 'home', 'broadway-review-texts');
  fs.mkdirSync(path.join(clone, 'hamilton-2015'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'hamilton-2015', 'nytimes--ben-brantley.json'), '{"clone":true}\n');
  fs.mkdirSync(path.join(clone, 'aggregator-archive', 'dtli'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'aggregator-archive', 'dtli', 'hamilton.html'), '<html></html>\n');
  git(clone, 'init', '-q');
  git(clone, 'remote', 'add', 'origin', origin);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  return { root, clone, data };
}

function stampedCopy(data, files) {
  const rt = path.join(data, 'review-texts');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(rt, rel)), { recursive: true });
    fs.writeFileSync(path.join(rt, rel), body);
  }
  fs.writeFileSync(path.join(rt, '.review-texts-sha'), 'abc123\n');
  return rt;
}

function run(data, clone, env = {}) {
  const r = spawnSync('bash', ['-c', `. "${HELPER}"; link_review_texts_clone "$1" "$2"`, 'x', data, clone],
    { env: { ...CLEAN_ENV, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('Mac layout: the stamped copy is replaced by a link to the clone and kept as a backup', () => {
  const { clone, data } = fixture();
  stampedCopy(data, {
    'hamilton-2015/nytimes--ben-brantley.json': '{"copy":true}\n',
    'hamilton-2015/local-only--written-on-mac.json': '{"mac":true}\n',
  });
  const { code, out } = run(data, clone);
  assert.equal(code, 0, out);
  const rt = path.join(data, 'review-texts');
  assert.ok(fs.lstatSync(rt).isSymbolicLink());
  assert.equal(fs.realpathSync(rt), fs.realpathSync(clone));
  assert.equal(fs.readFileSync(path.join(rt, 'hamilton-2015', 'nytimes--ben-brantley.json'), 'utf8'), '{"clone":true}\n');
  // The Mac-only file is not lost: it sits in the backup and is counted.
  assert.ok(fs.existsSync(path.join(data, '.review-texts.copy-backup', 'hamilton-2015', 'local-only--written-on-mac.json')));
  assert.match(out, /1 json files there are not in the clone/);
  // aggregator-archive is still peeled out into data/.
  assert.ok(fs.existsSync(path.join(data, 'aggregator-archive', 'dtli', 'hamilton.html')));
});

test('a second run is a no-op that keeps the link and the backup', () => {
  const { clone, data } = fixture();
  stampedCopy(data, { 'x/y.json': '{}' });
  assert.equal(run(data, clone).code, 0);
  const { code, out } = run(data, clone);
  assert.equal(code, 0, out);
  assert.match(out, /already links/);
  assert.ok(fs.existsSync(path.join(data, '.review-texts.copy-backup', 'x', 'y.json')));
});

test('a link pointing elsewhere is replaced without touching its target', () => {
  const { root, clone, data } = fixture();
  const other = path.join(root, 'main-checkout-review-texts');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'keep.json'), '{}');
  fs.symlinkSync(other, path.join(data, 'review-texts'));
  assert.equal(run(data, clone).code, 0);
  assert.equal(fs.realpathSync(path.join(data, 'review-texts')), fs.realpathSync(clone));
  assert.ok(fs.existsSync(path.join(other, 'keep.json')));
});

test('cloud, CI, an attached-clone bootstrap and REVIEW_TEXTS_COPY=1 keep the copy', () => {
  for (const env of [{ CLAUDE_CODE_REMOTE: 'true' }, { GITHUB_ACTIONS: 'true' },
    { REVIEW_TEXTS_SOURCE: '/home/user/broadway-review-texts' }, { REVIEW_TEXTS_COPY: '1' }]) {
    const { clone, data } = fixture();
    const rt = stampedCopy(data, { 'a/b.json': '{}' });
    assert.equal(run(data, clone, env).code, 1, JSON.stringify(env));
    assert.ok(!fs.lstatSync(rt).isSymbolicLink());
  }
});

test('no clone, or a checkout of some other repo, keeps the copy', () => {
  const missing = fixture();
  stampedCopy(missing.data, { 'a/b.json': '{}' });
  assert.equal(run(missing.data, path.join(missing.root, 'nope')).code, 1);

  const wrong = fixture({ origin: 'https://github.com/thomaspryor/Broadwayscore.git' });
  stampedCopy(wrong.data, { 'a/b.json': '{}' });
  assert.equal(run(wrong.data, wrong.clone).code, 1);
  assert.ok(!fs.lstatSync(path.join(wrong.data, 'review-texts')).isSymbolicLink());
});

test('the copy flow refuses to copy THROUGH a link into a git checkout', () => {
  const { clone, data } = fixture();
  fs.symlinkSync(clone, path.join(data, 'review-texts'));
  const ok = spawnSync('bash', ['-c', `. "${HELPER}"; review_texts_link_is_checkout "$1"`, 'x', data]);
  assert.equal(ok.status, 0);
  // and setup-local-data.sh calls that guard before its cp-into-symlink branch
  const src = fs.readFileSync(SETUP, 'utf8');
  const guard = src.indexOf('if review_texts_link_is_checkout "$DATA_DIR"; then');
  const cpThroughLink = src.indexOf('elif [ -L "$DATA_DIR/review-texts" ]; then');
  assert.ok(guard > 0 && cpThroughLink > guard, 'guard must precede the cp-through-symlink branch');
});

test('the writer warns once when it writes into a stamped copy, never into a checkout', () => {
  const { warnIfStampedCopy } = require('./review-file-writer.js');
  const { clone, data } = fixture();
  const copy = stampedCopy(data, { 'a/b.json': '{}' });
  const seen = [];
  assert.equal(warnIfStampedCopy(copy, (m) => seen.push(m)), true);
  assert.equal(warnIfStampedCopy(copy, (m) => seen.push(m)), false);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /COPY of broadway-review-texts/);
  assert.equal(warnIfStampedCopy(clone, (m) => seen.push(m)), false);
  assert.equal(seen.length, 1);
});

test('a clone with uncommitted writes is linked but never pulled over', () => {
  const { clone, data } = fixture();
  git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(clone, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const f = path.join(clone, 'hamilton-2015', 'nytimes--ben-brantley.json');
  fs.writeFileSync(f, '{"mac-edit":true}\n');
  stampedCopy(data, { 'a/b.json': '{}' });
  const { code, out } = run(data, clone);
  assert.equal(code, 0, out);
  assert.match(out, /uncommitted changes; not updating/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"mac-edit":true}\n');
  assert.equal(execFileSync('git', ['stash', 'list'], { cwd: clone, encoding: 'utf8' }), '');
});

test('an earlier backup is never overwritten', () => {
  const { clone, data } = fixture();
  const old = path.join(data, '.review-texts.copy-backup');
  fs.mkdirSync(path.join(old, 'x'), { recursive: true });
  fs.writeFileSync(path.join(old, 'x', 'older.json'), '{}');
  stampedCopy(data, { 'y/newer.json': '{}' });
  const { code, out } = run(data, clone);
  assert.equal(code, 0, out);
  assert.ok(fs.existsSync(path.join(old, 'x', 'older.json')));
  const fresh = fs.readdirSync(data).filter((n) => n.startsWith('.review-texts.copy-backup.'));
  assert.equal(fresh.length, 1);
  assert.ok(fs.existsSync(path.join(data, fresh[0], 'y', 'newer.json')));
  assert.match(out, new RegExp(`moved to data/${fresh[0].replace(/\./g, '\\.')}`));
});
