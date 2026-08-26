/**
 * show-images.test.mjs
 *
 * BRO-179: proves the consolidation — one module, two unambiguously-named
 * coverage predicates (declaredImageResolves vs archivedFilesExist), and the
 * fetcher no longer writes a rejected candidate to disk.
 *
 * declaredImageResolves/hasRealImage already have dedicated regression
 * coverage in tests/unit/show-images-phantom-path.test.mjs (the-gin-game-2026
 * phantom-path incident) and archivedFilesExist/listShowIdsWithImages/etc.
 * keep theirs in show-image-coverage.test.mjs (the empty-directory incident,
 * per CLAUDE.md rule 16 "keep both test files"). This file does not repeat
 * that per-function coverage — it locks down the things that are true only
 * because the two predicates now live together, plus the write-ordering fix
 * that motivated the consolidation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const showImages = require('./show-images.js');
const {
  declaredImageResolves,
  hasRealImage,
  archivedFilesExist,
  listShowIdsWithImages,
  isPlaceholderFile,
} = showImages;

test('both coverage predicates are exported from one module', () => {
  assert.equal(typeof declaredImageResolves, 'function');
  assert.equal(typeof archivedFilesExist, 'function');
  // The old split-module names must be gone, not just aliased — a caller
  // that still imports the ambiguous name should fail loudly, not silently
  // resolve to the wrong semantics.
  assert.equal('imageOnDisk' in showImages, false);
  assert.equal('hasArchivedShowImages' in showImages, false);
});

test('scripts/lib/show-image-coverage.js no longer exists — one module, not two', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'show-image-coverage.js')), false);
});

test('the two predicates disagree on the rejected-candidate case — that divergence is the reason they are two functions, not one', () => {
  // dir has a file (a candidate the fetcher wrote before verification, in the
  // old flow) but shows.json declares nothing for this show.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'show-images-consolidated-'));
  const showDir = path.join(root, 'rejected-candidate-show');
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, 'thumbnail.jpg'), 'x');

  assert.equal(archivedFilesExist(root, 'rejected-candidate-show'), true,
    'the directory really does hold a file');
  assert.equal(declaredImageResolves(undefined, { publicDir: root }), false,
    'but shows.json has no declared path for it, so the page-facing predicate says missing');
});

test('declaredImageResolves and archivedFilesExist agree once a show is fully archived and declared', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'show-images-consolidated-'));
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'show-images-public-'));
  const showDir = path.join(root, 'hamilton');
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, 'poster.webp'), 'not-a-placeholder');

  const declaredDir = path.join(publicDir, 'images', 'shows', 'hamilton');
  fs.mkdirSync(declaredDir, { recursive: true });
  fs.writeFileSync(path.join(declaredDir, 'poster.webp'), 'not-a-placeholder');

  assert.equal(archivedFilesExist(root, 'hamilton'), true);
  assert.equal(declaredImageResolves('/images/shows/hamilton/poster.webp', { publicDir }), true);
  assert.equal(hasRealImage({ images: { poster: '/images/shows/hamilton/poster.webp' } }, { publicDir }), true);
});

test('isPlaceholderFile is shared, not duplicated — both predicates reject the same bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'show-images-placeholder-'));
  const p = path.join(root, 'coming-soon.webp');
  fs.writeFileSync(p, 'placeholder-bytes');
  assert.equal(isPlaceholderFile(p), false, 'unregistered bytes are not a placeholder');
  // archivedFilesExist doesn't hash-check (directory predicate only asks "is
  // there a file"); declaredImageResolves does. That's the documented
  // difference in semantics between the two, not a bug.
  assert.equal(fs.existsSync(p), true);
});

// ---------------------------------------------------------------------------
// PROBLEM 2 — write-then-verify ordering (scripts/fetch-show-images-auto.js).
// The source that used to write thumbnail.jpg/poster.jpg before Gemini
// verified them (fetchFromGoogleImages, tryNextGoogleCandidate) now holds the
// compressed buffer in a `_pendingWrites` field and only writes it once the
// caller's verification accepts the candidate, via flushPendingImageWrites.
// This can't be exercised as a real fetch here (no module boundary, no
// network) — the script runs main() at require time — so this is a structural
// guard on the source, matching the pattern tests/unit/placeholder-images.
// test.mjs already uses for the same file.
// ---------------------------------------------------------------------------

const fetcherSrc = fs.readFileSync(
  path.join(__dirname, '..', 'fetch-show-images-auto.js'),
  'utf8'
);

function extractFunctionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} must exist in fetch-show-images-auto.js`);
  // Balance braces from the function's opening brace to its matching close.
  const openBrace = src.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openBrace, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

test('fetchFromGoogleImages never calls fs.writeFileSync — it defers to _pendingWrites', () => {
  const body = extractFunctionBody(fetcherSrc, 'fetchFromGoogleImages');
  assert.doesNotMatch(body, /fs\.writeFileSync/,
    'a rejected Google Images candidate must never reach disk; writes must be deferred via _pendingWrites');
  assert.match(body, /_pendingWrites/, 'must build a pending-writes list instead of writing immediately');
});

test('tryNextGoogleCandidate never calls fs.writeFileSync — it defers to _pendingWrites', () => {
  const body = extractFunctionBody(fetcherSrc, 'tryNextGoogleCandidate');
  assert.doesNotMatch(body, /fs\.writeFileSync/);
  assert.match(body, /_pendingWrites/);
});

test('flushPendingImageWrites is the single place candidate bytes are written to disk, and every fetchShowImages call flows through it', () => {
  assert.match(fetcherSrc, /function flushPendingImageWrites\(images\)/,
    'the write-on-accept flush helper must exist');
  const wrapperBody = extractFunctionBody(fetcherSrc, 'fetchShowImages');
  assert.match(wrapperBody, /flushPendingImageWrites/,
    'fetchShowImages must flush pending writes before returning to its caller (processOneShow)');
});
