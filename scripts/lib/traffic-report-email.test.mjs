import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { markdownToHtml, splitReport, buildSubject, buildHtml } = require('./traffic-report-email.js');

const SAMPLE = `# Traffic sources — Jun 15 to Sep 15

> ⚠️ **Incomplete report**
> - GA4 skipped: no creds

## What changed

Biggest jumps, across both tools:

- **www.reddit.com** (PostHog referring domain): 325 sessions in the week of Jul 20, about 7.6x its usual 43.
- **a\\|b** (PostHog referring domain): new source, 40 sessions.

| Channel | Last full week | Change |
| --- | --- | --- |
| Organic Search | 2192 | +12% |
| Direct | 912 | -23% |

## How to read this

- Weeks start on Monday.

## PostHog (Real Users lens)

### Channel type — sessions per week

| Source | 09-07 |
| --- | --- |
| Organic Search | 2192 |
`;

test('splitReport keeps everything before the first tool section as the summary', () => {
  const { summary, rest } = splitReport(SAMPLE);
  assert.match(summary, /## How to read this/);
  assert.ok(!/## PostHog/.test(summary));
  assert.match(rest, /^## PostHog/);
});

test('buildSubject carries the title, the spike count and the incomplete flag', () => {
  assert.equal(buildSubject(SAMPLE), 'Traffic sources — Jun 15 to Sep 15 (incomplete) — 2 spikes');
  assert.equal(buildSubject(SAMPLE.replace(/> ⚠️ \*\*Incomplete report\*\*\n> - GA4 skipped: no creds\n/, '')), 'Traffic sources — Jun 15 to Sep 15 — 2 spikes');
});

test('markdownToHtml renders headings, bold, bullets, tables, blockquotes and escaped pipes', () => {
  const html = markdownToHtml(SAMPLE);
  assert.match(html, /<h2[^>]*>Traffic sources — Jun 15 to Sep 15<\/h2>/);
  assert.match(html, /<blockquote[^>]*>[\s\S]*<strong>Incomplete report<\/strong>/);
  assert.match(html, /<li[^>]*><strong>www\.reddit\.com<\/strong> \(PostHog referring domain\)/);
  assert.match(html, /<li[^>]*><strong>a\|b<\/strong>/); // escaped pipe restored
  assert.match(html, /<th[^>]*>Channel<\/th>/);
  assert.match(html, /<td[^>]*>Organic Search<\/td><td[^>]*>2192<\/td><td[^>]*>\+12%<\/td>/);
  assert.ok(!/\| --- \|/.test(html)); // separator row never rendered
  assert.ok(!/<script/.test(markdownToHtml('<script>alert(1)</script>'))); // escaped
});

test('buildHtml only includes the summary and links the run when given', () => {
  const html = buildHtml(SAMPLE, { runUrl: 'https://github.com/x/y/actions/runs/1' });
  assert.ok(!/Channel type — sessions per week/.test(html));
  assert.match(html, /actions\/runs\/1/);
});
