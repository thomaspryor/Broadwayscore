// Structural guard for the 2026-08-09 "can't have both sections" incident.
//
// That night the weekly newsletter could not be built correctly in one run:
// CI had the GA credentials for the Trending section but no way to waive the
// coverage-gap swap, so every CI build stripped the featured openings; a local
// build could waive the swap but had no GA credentials, so it dropped Trending.
// The owner shipped a newsletter missing a section.
//
// Two things must stay true for that to remain fixed, and BOTH are the kind of
// thing a well-meaning cleanup silently breaks:
//
//  1. newsletter-draft-refresh.yml's `allowGaps` input must stay a STRING with
//     the '1' convention. GitHub renders `type: boolean` inputs as the strings
//     "true"/"false", and the consumer tests `=== '1'` — so converting this to
//     a boolean produces a toggle that appears in the UI, is dutifully threaded
//     through, and does absolutely nothing. The openings would silently vanish
//     again with no error anywhere. That failure is invisible by construction,
//     which is exactly why it needs a test rather than a comment.
//
//  2. The ADC fallback in popular-pages.mjs must stay gated to non-CI. In CI a
//     missing GA secret has to fail loudly; an ungated fallback on a runner
//     with an ambient service identity would authenticate as whoever that is
//     and query some other GA4 property, shipping plausible-but-wrong Trending
//     data. Silent wrong data is worse than a visible gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const REFRESH_WF = '.github/workflows/newsletter-draft-refresh.yml';
const PRE_SEND = 'scripts/newsletter/pre-send-check.mjs';
const POPULAR = 'scripts/newsletter/popular-pages.mjs';

test('refresh workflow exposes an allowGaps input', () => {
  const wf = read(REFRESH_WF);
  assert.match(wf, /^\s{6}allowGaps:/m,
    `${REFRESH_WF} lost its allowGaps workflow_dispatch input — CI can no longer preserve featured openings`);
});

test('allowGaps is a STRING input, never type: boolean', () => {
  const wf = read(REFRESH_WF);
  // Grab the allowGaps input block: from its key to the next same-indent key.
  const m = wf.match(/^\s{6}allowGaps:\n((?:\s{8}.*\n|\n)*)/m);
  assert.ok(m, 'could not locate the allowGaps input block');
  assert.doesNotMatch(m[1], /type:\s*boolean/,
    'allowGaps must NOT be type: boolean — GitHub sends "true"/"false" and the consumer tests === \'1\', so a boolean silently disables the waiver');
});

test('allowGaps reaches NEWSLETTER_ALLOW_GAPS at JOB level, not step level', () => {
  const wf = read(REFRESH_WF);
  assert.match(wf, /NEWSLETTER_ALLOW_GAPS:\s*\$\{\{[^}]*inputs\.allowGaps/,
    'NEWSLETTER_ALLOW_GAPS must be wired from the allowGaps input');
  // It must sit in the job-level env block, above `steps:` — a step-level value
  // is lost by pre-send-check's regen, which is how NEWSLETTER_EDITION broke.
  const envIdx = wf.indexOf('NEWSLETTER_ALLOW_GAPS:');
  const stepsIdx = wf.search(/^\s{4}steps:/m);
  assert.ok(envIdx !== -1 && stepsIdx !== -1 && envIdx < stepsIdx,
    'NEWSLETTER_ALLOW_GAPS must be in the job-level env block (before steps:), or the pre-send regen will not inherit it');
});

test('the unattended cron cannot inherit a stale repo-variable waiver', () => {
  const wf = read(REFRESH_WF);
  const line = wf.split('\n').find((l) => l.includes('NEWSLETTER_ALLOW_GAPS:'));
  assert.ok(line, 'NEWSLETTER_ALLOW_GAPS env line not found');
  assert.doesNotMatch(line, /vars\.NEWSLETTER_ALLOW_GAPS/,
    "this workflow's Sunday run is UNATTENDED — reading vars.NEWSLETTER_ALLOW_GAPS would let an escape hatch the owner set for a one-off manual send silently waive coverage gaps on an automated run. Only the per-run dispatch input may waive gaps here.");
});

test('the consumer still gates on the exact string 1 (the reason boolean fails)', () => {
  const src = read(PRE_SEND);
  assert.match(src, /NEWSLETTER_ALLOW_GAPS\s*===\s*'1'/,
    "pre-send-check.mjs no longer tests NEWSLETTER_ALLOW_GAPS === '1' — if the accepted value changed, the workflow input default must change with it");
});

test('ADC fallback exists so local runs can render Trending', () => {
  const src = read(POPULAR);
  assert.match(src, /new BetaAnalyticsDataClient\(\)/,
    'popular-pages.mjs lost its no-arg (ADC) client — dev machines can no longer build the Trending section');
});

test('ADC fallback is gated to non-CI so a missing secret fails loudly in CI', () => {
  const src = read(POPULAR);
  const idx = src.indexOf('new BetaAnalyticsDataClient()');
  assert.ok(idx !== -1, 'ADC client construction not found');
  // Anchor to the ENCLOSING branch condition, not a character window — a long
  // explanatory comment between the condition and the call must not weaken or
  // break this check (it did on first run, which is the point of asserting on
  // structure rather than proximity).
  const before = src.slice(0, idx);
  const branchStart = before.lastIndexOf('} else if (');
  assert.ok(branchStart !== -1, 'ADC client is not inside an else-if branch');
  const condition = before.slice(branchStart, before.indexOf('{', branchStart + 10) + 1);
  assert.match(condition, /!process\.env\.CI/,
    'the ADC branch condition must include !process.env.CI');
  assert.match(condition, /!process\.env\.GITHUB_ACTIONS/,
    'the ADC branch condition must also include !process.env.GITHUB_ACTIONS');
});

test('explicit credentials still win over ADC (ordering, not just presence)', () => {
  const src = read(POPULAR);
  const keyFile = src.indexOf('process.env.GA_KEY_FILE');
  const svcKey = src.indexOf('process.env.GA_SERVICE_ACCOUNT_KEY');
  const adc = src.indexOf('new BetaAnalyticsDataClient()');
  assert.ok(keyFile !== -1 && svcKey !== -1 && adc !== -1, 'expected all three credential branches');
  assert.ok(keyFile < adc && svcKey < adc,
    'ADC must be the LAST branch — an explicitly configured key must always take precedence over ambient credentials');
});
