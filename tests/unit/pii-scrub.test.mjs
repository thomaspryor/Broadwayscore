// BRO-518: the notion-card-history archive must carry no email or phone PII
// in the current tree. History is checked as a report only: the raw PII from
// before BRO-376 still sits in a few old commits until the owner schedules a
// filter-repo rewrite (irreversible force-push on the public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EMAIL_RE, scanJsonlValue, isRedactedPlaceholder } = require('../../scripts/lib/pii-scan.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'data', 'archive', 'notion-card-history.jsonl');
const PHONE_RE = /(?<![\d.\/-])(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g;

const present = fs.existsSync(FILE);
const text = present ? fs.readFileSync(FILE, 'utf8') : '';

test('archive: no real email addresses in any row', { skip: !present }, () => {
  const hits = (text.match(new RegExp(EMAIL_RE.source, 'g')) || []).filter((e) => !isRedactedPlaceholder(e));
  assert.deepEqual(hits.map((e) => e.replace(/^(.).*(@.*)$/, '$1***$2')), []);
});

test('archive: no US phone numbers in any row', { skip: !present }, () => {
  assert.equal((text.match(PHONE_RE) || []).length, 0);
});

test('archive: scanJsonlValue finds no submitter PII', { skip: !present }, () => {
  const findings = scanJsonlValue(text);
  assert.equal(findings.length, 0);
});

test('phone pattern catches common shapes', () => {
  for (const s of ['212-555-0142', '(212) 555 0142', '+1 212.555.0142']) {
    assert.equal((s.match(PHONE_RE) || []).length, 1, s);
  }
  assert.equal(('2026-10-28 1793155881655'.match(PHONE_RE) || []).length, 0);
});
