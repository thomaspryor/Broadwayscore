// BRO-3039: opening-night-readiness.js used to read the ScrapingBee /usage
// payload by hand and turn a missing max_api_credit into "100% remaining".
// It now goes through lib/check-sb-credits.js classifySBUsage() and
// lib/sb-credit-verdict.js sbReadinessCheck(); these tests require() both
// (CLAUDE.md §15) and drive the real CLI function with a stubbed curl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { classifySBUsage } = require('./lib/check-sb-credits.js');
const { sbReadinessCheck } = require('./lib/sb-credit-verdict.js');
const here = path.dirname(fileURLToPath(import.meta.url));

test('a well-formed payload without max_api_credit is not a pass', () => {
  const r = sbReadinessCheck(classifySBUsage(200, { used_api_credit: 10 }));
  assert.equal(r.pass, null);
  assert.equal(r.warn, true);
  assert.doesNotMatch(r.detail, /100% remaining/);
});

test('a vendor error object (non-200) is not a pass', () => {
  const r = sbReadinessCheck(classifySBUsage(401, { message: 'Invalid api key' }));
  assert.equal(r.pass, null);
  assert.match(r.detail, /api-error/);
});

test('no key is unknown, exhausted is a failure, attention line is a warning', () => {
  assert.equal(sbReadinessCheck({ ok: false, reason: 'no-key' }).pass, null);
  assert.equal(sbReadinessCheck(classifySBUsage(200, { max_api_credit: 1000, used_api_credit: 1000 })).pass, false);
  const warn = sbReadinessCheck(classifySBUsage(200, { max_api_credit: 1000, used_api_credit: 800 }));
  assert.deepEqual([warn.pass, warn.warn], [true, true]);
  assert.equal(sbReadinessCheck(classifySBUsage(200, { max_api_credit: 1000, used_api_credit: 100 })).pass, true);
});

// Drive the real checkScrapingBeeCredits() with a fake curl on PATH.
function runCheckWithCurl(body, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-curl-'));
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\nprintf '%s\\n%s' '${body}' '${code}'\n`, { mode: 0o755 });
  const script = `const m = require(${JSON.stringify(path.join(here, 'opening-night-readiness.js'))}); console.log(JSON.stringify(m.checkScrapingBeeCredits()));`;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SCRAPINGBEE_API_KEY: 'k' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('CLI: payload missing the cap reports unknown, not 100% remaining', () => {
  const r = runCheckWithCurl('{"used_api_credit":5}', 200);
  assert.equal(r.pass, null);
  assert.doesNotMatch(r.detail, /100% remaining/);
});

test('CLI: real-shaped payload is read and judged', () => {
  assert.equal(runCheckWithCurl('{"max_api_credit":1000000,"used_api_credit":200000}', 200).pass, true);
  assert.equal(runCheckWithCurl('{"max_api_credit":1000000,"used_api_credit":1000000}', 200).pass, false);
  assert.equal(runCheckWithCurl('{"message":"Unauthorized"}', 401).pass, null);
});

// BRO-3039 retro-review (BRO-5261): the per-show CLI has no demand-aware
// budget check, so fewer credits than one opening night uses must fail it.
test('CLI: fewer credits left than one show needs is not ready', () => {
  const r = runCheckWithCurl('{"max_api_credit":1000000,"used_api_credit":970000}', 200);
  assert.equal(r.pass, false);
  assert.match(r.detail, /one opening night/);
  assert.equal(runCheckWithCurl('{"max_api_credit":1000000,"used_api_credit":900000}', 200).pass, true);
});

test('minRemaining never fails an unread status', () => {
  assert.equal(sbReadinessCheck({ ok: false, reason: 'no-key' }, undefined, { minRemaining: 50000 }).pass, null);
});
