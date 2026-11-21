// LIVE-DATA-LANE: reads data/rejected-images.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// check-image-aspect.js refuses image bytes a person rejected by eye
// (data/rejected-images.json). Root cause it guards: the auto-fetch job
// (c321b887f52) re-downloaded all three files BRO-4251 had removed, because
// their source URLs were still recorded, and main went red on
// show-hero-integrity.test.mjs. The shape check alone passed them: the
// rejected hero is a correctly landscape image of the wrong thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'check-image-aspect.js');

let sharp = null;
try { sharp = require('sharp'); } catch { /* script soft-passes without sharp */ }

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejected-img-'));
  const showDir = path.join(dir, 'some-show-2026');
  fs.mkdirSync(showDir);
  const hero = path.join(showDir, 'hero.webp');
  // 1920x800: passes the hero shape rule (h/w 0.42), so only the hash can fail it.
  await sharp({ create: { width: 1920, height: 800, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toFile(hero);
  const digest = crypto.createHash('md5').update(fs.readFileSync(hero)).digest('hex');
  return { dir, hero, digest };
}

function run(hero, listPath) {
  return spawnSync(process.execPath, [SCRIPT, '--files', hero], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, REJECTED_IMAGES_PATH: listPath },
  });
}

test('a well-shaped hero whose bytes are on the rejected list fails the check', { skip: !sharp && 'sharp not installed' }, async () => {
  const { dir, hero, digest } = await setup();
  const listPath = path.join(dir, 'rejected.json');
  fs.writeFileSync(listPath, JSON.stringify({ md5: { [digest]: 'test: ad, not show art' } }));
  const r = run(hero, listPath);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /rejected by eye .*test: ad, not show art/);
});

test('the same hero passes when its hash is not on the list', { skip: !sharp && 'sharp not installed' }, async () => {
  const { dir, hero } = await setup();
  const listPath = path.join(dir, 'rejected.json');
  fs.writeFileSync(listPath, JSON.stringify({ md5: { ['0'.repeat(32)]: 'other' } }));
  const r = run(hero, listPath);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('the committed rejected list is well formed md5 -> reason', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rejected-images.json'), 'utf8')).md5;
  assert.ok(Object.keys(list).length > 0);
  for (const [k, v] of Object.entries(list)) {
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.ok(typeof v === 'string' && v.length > 0);
  }
});

// BRO-6748: venue logos served as the art of unrelated shows (BRO-6660/6683/6740/6748).
// A new file whose bytes already serve as another unrelated show's same-role image fails;
// same-title-family shows may share.
function runDup(files, imagesDir) {
  return spawnSync(process.execPath, [SCRIPT, '--files', ...files], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, REJECTED_IMAGES_PATH: path.join(imagesDir, 'none.json'), IMAGE_ASPECT_IMAGES_DIR: imagesDir },
  });
}
async function dupSetup(idA, idB) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-img-'));
  const heroes = [];
  for (const id of [idA, idB]) {
    fs.mkdirSync(path.join(dir, id));
    const f = path.join(dir, id, 'hero.webp');
    await sharp({ create: { width: 1920, height: 800, channels: 3, background: { r: 10, g: 90, b: 200 } } }).webp().toFile(f);
    heroes.push(f);
  }
  return { dir, heroes };
}

test('a hero byte-identical to an unrelated show hero is reported', { skip: !sharp && 'sharp not installed' }, async () => {
  const { dir, heroes } = await dupSetup('dry-powder-regional-2026', 'promises-promises-regional-2023');
  const r = runDup([heroes[1]], dir);
  assert.match(r.stderr, /byte-identical hero already serves unrelated show/);
});

test('a hero byte-identical to a same-title-family show hero passes', { skip: !sharp && 'sharp not installed' }, async () => {
  const { dir, heroes } = await dupSetup('paranormal-activity-2026', 'paranormal-activity-boston-regional-2026');
  const r = runDup([heroes[1]], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('outside plain --staged the duplicate-bytes check is advisory', { skip: !sharp && 'sharp not installed' }, async () => {
  const { dir, heroes } = await dupSetup('dry-powder-regional-2026', 'promises-promises-regional-2023');
  const r = runDup([heroes[1]], dir);
  // --files mode is advisory (warn): exit 0 with a warning naming the other show
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /::warning::.*byte-identical hero already serves unrelated show/);
});
