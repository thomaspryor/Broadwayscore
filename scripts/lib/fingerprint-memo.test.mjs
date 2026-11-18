// BRO-7744: the persistent cross-show fingerprint memo must give exactly the
// answer the rebuild's old inline computation gave, cold or warm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFingerprintMemo, computeFingerprint, versionedSources, versionedEnv } = require('./fingerprint-memo.js');
const { cleanText } = require('./text-cleaning.js');

// The pre-BRO-7744 inline code from rebuild-all-reviews.js, verbatim.
function legacyFingerprint(fullText) {
  const cleanedForFp = (cleanText(fullText) || '').toLowerCase().replace(/\s+/g, '');
  if (cleanedForFp.length > 200) return crypto.createHash('sha256').update(cleanedForFp).digest('hex').substring(0, 16);
  return null;
}

const LONG = 'The revival opens with a bare stage and a single chair. '.repeat(12);
const SAMPLES = [
  LONG,
  `${LONG}\n\nRunning time: 2 hours 30 minutes, with one intermission.\nTickets: $59-$199.`,
  `Short notice.   ${'x '.repeat(90)}`, // >200 raw, <=200 once whitespace goes
  `  ${LONG.toUpperCase()}  `,
];

function realSamples(limit = 40) {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'data', 'review-texts');
  const out = [];
  try {
    for (const show of fs.readdirSync(root).slice(0, 400)) {
      const dir = path.join(root, show);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).slice(0, 2)) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (typeof d.fullText === 'string' && d.fullText.length > 200) out.push(d.fullText);
        } catch { /* skip unreadable */ }
        if (out.length >= limit) return out;
      }
    }
  } catch { /* review-texts not checked out (public CI): synthetic samples still run */ }
  return out;
}

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-memo-')), 'c.json');

test('computeFingerprint matches the legacy inline computation', () => {
  for (const t of [...SAMPLES, ...realSamples()]) assert.equal(computeFingerprint(t), legacyFingerprint(t));
  assert.equal(computeFingerprint(SAMPLES[2]), null);
});

test('warm memo returns the same fingerprints without recomputing', () => {
  const cachePath = tmpCache();
  const texts = [...SAMPLES, ...realSamples()];
  const cold = createFingerprintMemo({ cachePath });
  const coldFps = texts.map(t => cold.fingerprint(t));
  assert.ok(cold.save());
  const warm = createFingerprintMemo({ cachePath });
  assert.deepEqual(texts.map(t => warm.fingerprint(t)), coldFps);
  assert.deepEqual(coldFps, texts.map(legacyFingerprint));
  assert.equal(warm.stats.misses, 0);
  assert.equal(warm.stats.hits, new Set(texts).size);
});

test('a cache written under different cleaning settings is ignored', () => {
  const cachePath = tmpCache();
  const prev = process.env.PAGE_FURNITURE_DISABLED;
  try {
    process.env.PAGE_FURNITURE_DISABLED = 'true';
    const a = createFingerprintMemo({ cachePath });
    a.fingerprint(LONG);
    a.save();
    delete process.env.PAGE_FURNITURE_DISABLED;
    const b = createFingerprintMemo({ cachePath });
    assert.equal(b.stats.loaded, 0);
    b.fingerprint(LONG);
    assert.equal(b.stats.misses, 1);
  } finally {
    if (prev === undefined) delete process.env.PAGE_FURNITURE_DISABLED; else process.env.PAGE_FURNITURE_DISABLED = prev;
  }
});

test('a poisoned entry under the wrong version is never served', () => {
  const cachePath = tmpCache();
  const key = crypto.createHash('sha256').update(LONG).digest('base64');
  fs.writeFileSync(cachePath, JSON.stringify({ version: 'stale', entries: { [key]: 'deadbeefdeadbeef' } }));
  assert.equal(createFingerprintMemo({ cachePath }).fingerprint(LONG), legacyFingerprint(LONG));
});

test('save keeps only the entries this run used', () => {
  const cachePath = tmpCache();
  const a = createFingerprintMemo({ cachePath });
  a.fingerprint(SAMPLES[0]);
  a.fingerprint(SAMPLES[1]);
  a.save();
  const b = createFingerprintMemo({ cachePath });
  b.fingerprint(SAMPLES[0]);
  b.save();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries).length, 1);
});

test('cachePath null never touches disk', () => {
  const m = createFingerprintMemo({ cachePath: null });
  assert.equal(m.fingerprint(LONG), legacyFingerprint(LONG));
  assert.equal(m.save(), false);
});

test('the version covers every module and env switch cleanText depends on', () => {
  const names = versionedSources().map(f => path.basename(f));
  for (const f of ['text-cleaning.js', 'trailer-signatures.js', 'page-furniture.js', 'fingerprint-memo.js']) assert.ok(names.includes(f), f);
  const env = versionedEnv(versionedSources());
  for (const k of ['PAGE_FURNITURE_DISABLED', 'TRAILER_FIXES_DISABLED', 'RUN_INFO_TRAILER_DISABLED']) assert.ok(env.includes(k), k);
});
