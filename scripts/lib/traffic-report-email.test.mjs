import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { markdownToHtml, splitReport, buildSubject, buildHumanSubject, buildHtml, sendTrafficReportEmail } = require('./traffic-report-email.js');
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  assert.equal(buildSubject(SAMPLE), 'Weekly traffic report (incomplete): 2 biggest changes, Jun 15 to Sep 15');
  assert.equal(buildSubject(SAMPLE.replace(/> ⚠️ \*\*Incomplete report\*\*\n> - GA4 skipped: no creds\n/, '')), 'Weekly traffic report: 2 biggest changes, Jun 15 to Sep 15');
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
  assert.ok(!/href="x"/.test(buildHtml(SAMPLE, { runUrl: 'x" onmouseover="alert(1)' }))); // quotes cannot break the attribute
});

test('markdownToHtml always makes progress: deep headings and orphan markers cannot hang it', () => {
  const html = markdownToHtml('#### Details\n#\n|\n>\n- \nplain');
  assert.match(html, /<h5[^>]*>Details<\/h5>/);
  assert.match(html, /plain/);
});

test('sendTrafficReportEmail refuses an empty or truncated report instead of mailing a clean-looking blank', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tre-'));
  const empty = path.join(dir, 'empty.md');
  fs.writeFileSync(empty, '');
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'test';
  process.env.OWNER_EMAIL = process.env.OWNER_EMAIL || 'owner@example.com';
  const res = await sendTrafficReportEmail({ reportPath: empty, dryRun: true });
  assert.equal(res.sent, false);
  assert.match(res.reason, /missing its title/);
  const missing = await sendTrafficReportEmail({ reportPath: path.join(dir, 'nope.md'), dryRun: true });
  assert.match(missing.reason, /report not found/);
});

test('buildHumanSubject carries the week, the visit count and the direction', () => {
  assert.equal(buildHumanSubject('# Your traffic, week of Sep 14\n\n**In short.** Last week the site had 4,509 visits (known bots excluded), 34% more than a typical week in the previous month. Search brought 2,987 of them (66%).'),
    'Your traffic, week of Sep 14: 4,509 visits, 34% more than usual');
  assert.equal(buildHumanSubject('# Your traffic, week of Sep 7\n\n**In short.** Last week the site had 2,950 visits (known bots excluded), about the same as a typical week in the previous month.'),
    'Your traffic, week of Sep 7: 2,950 visits, about usual');
  assert.equal(buildHumanSubject('# Your traffic, week of Sep 7\n\n> Part of the data did not load this week\n\n**In short.** PostHog did not load.'),
    'Your traffic, week of Sep 7 (partial data)');
});

test('markdownToHtml renders _italic_ lines and leaves underscores inside words alone', () => {
  const html = markdownToHtml('_The full tables are attached._\n\nsnake_case_word stays');
  assert.match(html, /<em>The full tables are attached\.<\/em>/);
  assert.match(html, /snake_case_word stays/);
});
