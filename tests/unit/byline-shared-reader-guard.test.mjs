/**
 * BRO-7798 class guard: every script that stores a critic name read from a page goes through the shared
 * reader (scripts/lib/page-byline.js readPageByline, or the readPageBylineForShow wrapper). A direct
 * extractAuthorFromHtml call skips the outlet rules (the TheaterMania author tag, BRO-7745), which is how
 * the posting editor got credited. scripts/lib is the reader's own home and is not scanned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const SCRIPTS = path.join(ROOT, 'scripts');

// Allowed callers, each with why. A new entry needs a reason a reviewer would accept.
const ALLOW = new Map([
  ['scripts/sweep-stored-bylines.js', 'audit: compares the old ingest reader against the shared reader on purpose; stores nothing'],
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'lib' && e.name !== 'node_modules') walk(p, out); }
    else if (/\.(c|m)?js$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

export function directCallers(files) {
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Strip a // comment only when it starts the line or follows whitespace, so a URL is kept.
      const code = line.replace(/(^|\s)\/\/.*$/, '$1').replace(/\/\*.*?\*\//g, '');
      if (/^\s*(\*|\/\*)/.test(line)) return;
      // Any code reference counts, not just a call: an import, an alias or a pass-by-reference
      // is the same direct use (BRO-7798 review).
      if (/\bextractAuthorFromHtml\b/.test(code)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

test('no script outside scripts/lib reads a stored critic name with extractAuthorFromHtml directly', () => {
  const hits = directCallers(walk(SCRIPTS)).filter((h) => !ALLOW.has(h.replace(/:\d+$/, '')));
  assert.deepEqual(hits, [], `use readPageByline / readPageBylineForShow instead:\n${hits.join('\n')}`);
});

test('every allowlisted file still exists and still needs its exemption', () => {
  for (const [rel] of ALLOW) {
    const f = path.join(ROOT, rel);
    assert.ok(fs.existsSync(f), `${rel} is gone: drop it from ALLOW`);
    assert.ok(directCallers([f]).length > 0, `${rel} no longer calls extractAuthorFromHtml: drop it from ALLOW`);
  }
});
