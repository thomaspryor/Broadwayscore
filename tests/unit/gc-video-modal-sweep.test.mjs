/**
 * BRO-4221: gc-display-field-artifacts.js also sweeps video.js modal-dialog
 * boilerplate out of stored fullText (texts saved before cleanText's Step 3e,
 * or whose forced refetch failed). The sweep reuses cleanText, so save-time and
 * sweep cannot drift.
 *
 * Run: node --test tests/unit/gc-video-modal-sweep.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '../../scripts/gc-display-field-artifacts.js');
const { hasVideoPlayerModal, stripVideoPlayerModal } = require(SCRIPT);
const { cleanText } = require('../../scripts/lib/text-cleaning.js');

const REVIEW = 'Hamilton is as good as the hype. The immigrants have grabbed the microphone, and they tell it loud.';
const MODAL = 'This is a modal window.\n\nBeginning of dialog window. Escape will cancel and close the window.\n\nThis is a modal window. This modal can be closed by pressing the Escape key or activating the close button.';

test('hasVideoPlayerModal flags each modal string and ignores clean text', () => {
  assert.equal(hasVideoPlayerModal(`${MODAL}\n\n${REVIEW}`), true);
  assert.equal(hasVideoPlayerModal('Great show. End of dialog window.'), true);
  assert.equal(hasVideoPlayerModal('This modal can be closed by pressing the Escape key.'), true);
  assert.equal(hasVideoPlayerModal(REVIEW), false);
  assert.equal(hasVideoPlayerModal('The window at the end of the dialog was wide open.'), false);
  assert.equal(hasVideoPlayerModal(undefined), false);
  assert.equal(hasVideoPlayerModal(null), false);
});

test('stripVideoPlayerModal removes the modal and keeps the review prose', () => {
  const out = stripVideoPlayerModal(`${MODAL}\n\n${REVIEW}`);
  assert.equal(hasVideoPlayerModal(out), false);
  assert.ok(out.includes(REVIEW));
});

test('stripVideoPlayerModal reaches a fixed point (trailing modal after a junk line)', () => {
  const t = `${REVIEW}\n\nGet local news delivered to your inbox! Beginning of dialog window. Escape will cancel and close the window.`;
  const out = stripVideoPlayerModal(t);
  assert.equal(hasVideoPlayerModal(out), false);
  assert.equal(cleanText(out), out, 'output is stable under cleanText');
  assert.ok(out.startsWith('Hamilton is as good as the hype.'));
});

test('CLI --fix cleans fullText in place; report mode exits 1 on a match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-video-modal-'));
  const showDir = path.join(dir, 'some-show-2020');
  fs.mkdirSync(showDir);
  const dirty = path.join(showDir, 'outlet--critic.json');
  const clean = path.join(showDir, 'other--critic.json');
  fs.writeFileSync(dirty, JSON.stringify({ showId: 'some-show-2020', fullText: `${MODAL}\n\n${REVIEW}` }, null, 2) + '\n');
  const cleanBody = JSON.stringify({ showId: 'some-show-2020', fullText: REVIEW }, null, 2) + '\n';
  fs.writeFileSync(clean, cleanBody);
  const env = { ...process.env, REVIEW_TEXTS_DIR: dir };

  let reportExit = 0;
  try { execFileSync('node', [SCRIPT], { env, stdio: 'pipe' }); } catch (e) { reportExit = e.status; }
  assert.equal(reportExit, 1);
  assert.ok(hasVideoPlayerModal(JSON.parse(fs.readFileSync(dirty, 'utf8')).fullText), 'report mode does not write');

  const out = execFileSync('node', [SCRIPT, '--fix'], { env, encoding: 'utf8' });
  assert.match(out, /1 video-modal fullText\(s\) cleaned/);
  const fixed = JSON.parse(fs.readFileSync(dirty, 'utf8'));
  assert.equal(hasVideoPlayerModal(fixed.fullText), false);
  assert.ok(fixed.fullText.includes(REVIEW));
  assert.equal(fs.readFileSync(clean, 'utf8'), cleanBody, 'clean file untouched');

  execFileSync('node', [SCRIPT], { env, stdio: 'pipe' }); // exits 0 once clean
  fs.rmSync(dir, { recursive: true, force: true });
});
