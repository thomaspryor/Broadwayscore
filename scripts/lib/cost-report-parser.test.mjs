import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseTopSbConsumers, topSbConsumer } = require('./cost-report-parser.js');

// Real body from GitHub issue #565 "Scraper Cost Report — Week of 2026-08-10"
const ISSUE_565_BODY = `# Scraper Cost Report — Aug 03 – Aug 10

## Cost
| Provider | Requests | Cost |
|----------|----------|------|
| Playwright (free) | 58 | $0 |
| BrightData | 87 | ~$.1305 |
| ScrapingBee | 59 | 2530 credits |
| Browserbase | 290 sessions | $29.00 |

SB breakdown (last collect run): page=20, SERP=0

## Provider-Reported (billing ground truth)
- ScrapingDog: 1,257,929 / 4,000,000 credits used (31%) · renews in 24d · pack pro
- Bright Data: balance $55.24 · pending $70.50 · month-to-date $64.06361308 (serp+unlocker)

Telemetry above is sampled attribution; disagreement with these numbers means an untelemetried path is burning.

## ScrapingBee Cycle Usage
- Used this cycle: 123133 / 1000000 (12.3%)
- Projected end-of-cycle: 64% of current cap
- Post-downgrade target cap: 1000000 credits (Startup plan)
- Status: 881181 credits remaining (12% used)

## Top SB Credit Consumers This Week
\`\`\`
Auto-Maintain Show Data: 1580 credits
Audit Aggregator Review Gap: 900 credits
Scrape BWW Reviews: 42 credits
Scrape New Aggregators: 8 credits
\`\`\`

## Workflow Runs (95 total, 40 failed)`;

// Real body from GitHub issue #538 "Scraper Cost Report — Week of 2026-08-03"
const ISSUE_538_BODY = `# Scraper Cost Report — Jul 27 – Aug 03

## Top SB Credit Consumers This Week
\`\`\`
Audit Aggregator Review Gap: 930 credits
Scrape BWW Reviews: 174 credits
Scrape New Aggregators: 31 credits
Gather Review Data: 1 credits
\`\`\`

## Workflow Runs (93 total, 30 failed)`;

// Empty week: the workflow's awk pipeline falls back to "—" with no data.
const EMPTY_WEEK_BODY = `# Scraper Cost Report — Jul 20 – Jul 27

## Top SB Credit Consumers This Week
\`\`\`
—
\`\`\`

## Workflow Runs (72 total, 0 failed)`;

test('parseTopSbConsumers extracts and ranks issue #565 (already-sorted source)', () => {
  const result = parseTopSbConsumers(ISSUE_565_BODY);
  assert.deepEqual(result, [
    { workflow: 'Auto-Maintain Show Data', credits: 1580 },
    { workflow: 'Audit Aggregator Review Gap', credits: 900 },
    { workflow: 'Scrape BWW Reviews', credits: 42 },
    { workflow: 'Scrape New Aggregators', credits: 8 },
  ]);
});

test('parseTopSbConsumers extracts issue #538', () => {
  const result = parseTopSbConsumers(ISSUE_538_BODY);
  assert.deepEqual(result, [
    { workflow: 'Audit Aggregator Review Gap', credits: 930 },
    { workflow: 'Scrape BWW Reviews', credits: 174 },
    { workflow: 'Scrape New Aggregators', credits: 31 },
    { workflow: 'Gather Review Data', credits: 1 },
  ]);
});

test('parseTopSbConsumers re-derives ranking, not trusting source order', () => {
  const outOfOrder = `## Top SB Credit Consumers This Week
\`\`\`
Scrape BWW Reviews: 42 credits
Auto-Maintain Show Data: 1580 credits
Audit Aggregator Review Gap: 900 credits
\`\`\`
`;
  const result = parseTopSbConsumers(outOfOrder);
  assert.equal(result[0].workflow, 'Auto-Maintain Show Data');
  assert.equal(result[0].credits, 1580);
});

test('parseTopSbConsumers returns empty array for the "—" placeholder (no data this week)', () => {
  assert.deepEqual(parseTopSbConsumers(EMPTY_WEEK_BODY), []);
});

test('parseTopSbConsumers returns empty array when section heading is missing', () => {
  assert.deepEqual(parseTopSbConsumers('# Some other issue\n\nNo cost data here.'), []);
});

test('parseTopSbConsumers returns empty array for null/undefined/empty input', () => {
  assert.deepEqual(parseTopSbConsumers(null), []);
  assert.deepEqual(parseTopSbConsumers(undefined), []);
  assert.deepEqual(parseTopSbConsumers(''), []);
});

test('parseTopSbConsumers handles comma-formatted credit counts', () => {
  const body = `## Top SB Credit Consumers This Week
\`\`\`
Opening Night Poller: 12,345 credits
\`\`\`
`;
  assert.deepEqual(parseTopSbConsumers(body), [{ workflow: 'Opening Night Poller', credits: 12345 }]);
});

test('topSbConsumer returns the single #1 consumer from issue #565', () => {
  assert.deepEqual(topSbConsumer(ISSUE_565_BODY), { workflow: 'Auto-Maintain Show Data', credits: 1580 });
});

test('topSbConsumer returns null when there is no data', () => {
  assert.equal(topSbConsumer(EMPTY_WEEK_BODY), null);
});
