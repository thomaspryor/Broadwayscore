import { test, expect, type Page } from '@playwright/test';

/**
 * Component-level regression test for BatchPasteForm submit wiring
 * (card #1822, following card #1604's ship-check).
 *
 * The 27 pure-function unit tests in tests/unit/bulk-ingest-status-reporting.test.mjs
 * only cover scripts/lib/ingest-status.js's extracted functions — never the
 * actual React component wiring (form onSubmit, native input validation,
 * button disabled state). Both P0 bugs card #1604 fixed were only caught by
 * manual Playwright browser QA:
 *   1. Missing `noValidate` on the batch <form> let native HTML5 constraint
 *      validation on a malformed type="url" slot silently block the ENTIRE
 *      batch submit — the 'submit' event never fired at all.
 *   2. `readyToSubmit` gated on submitCount > 0 (instead of plan.length > 0)
 *      left the Submit button disabled for an all-invalid batch, so
 *      handleSubmitAll — and its skip-logging — never ran.
 *
 * Run locally against the /test/ingest-form-fixture route (bypasses the
 * /admin/ingest page's cookie-gated isAdmin() check — same pattern as
 * /test/rating-editor-fixture): mocks fetch for search-shows.json,
 * ingest-review, and dispatch-rebuild, never hits real GitHub/APIs.
 *
 *   TEST_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/ingest-form-batch.spec.ts
 */

const FIXTURE_URL = '/test/ingest-form-fixture';

const MOCK_SHOWS = [
  { id: 'hamilton-2015', title: 'Hamilton', status: 'open', openingDate: '2015-08-06' },
];

const VALID_TEXT =
  'This is a sufficiently long review body used for testing purposes and it easily clears the fifty character minimum required by validateSlotForSubmission.';

async function mockShowSearch(page: Page) {
  await page.route('**/data/search-shows.json', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SHOWS) })
  );
}

// Mocks /api/admin/ingest-review: succeeds for any URL containing
// "ok-review", otherwise returns a generic server-side rejection (never
// reached by malformed/duplicate slots — those are skipped client-side and
// never hit the network at all, which is itself part of what these tests
// verify).
async function mockIngestReview(page: Page) {
  await page.route('**/api/admin/ingest-review', async route => {
    const body = route.request().postDataJSON() as { url?: string };
    const isOk = (body?.url || '').includes('ok-review');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        isOk
          ? { success: true, showId: 'hamilton-2015', outletId: 'nyt', criticName: 'Test Critic', commitSha: 'abc123' }
          : { success: false, error: 'simulated rejection', failureReason: 'other' }
      ),
    });
  });
}

async function mockDispatchRebuild(page: Page) {
  await page.route('**/api/admin/dispatch-rebuild', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, dispatchedWorkflow: 'rebuild-fast.yml' }),
    })
  );
}

async function selectShow(page: Page) {
  await page.getByPlaceholder('Type show title to search…').fill('Hamilton');
  await page.getByText('Hamilton', { exact: true }).click();
}

async function goToBatchForm(page: Page) {
  await mockShowSearch(page);
  await mockIngestReview(page);
  await mockDispatchRebuild(page);
  await page.goto(FIXTURE_URL);
  await page.waitForSelector('button:has-text("Paste a batch")');
  await page.getByRole('button', { name: 'Paste a batch' }).click();
  await selectShow(page);
  await page.waitForSelector('[data-testid="batch-form"]');
}

function statusRows(page: Page) {
  return page.locator('[data-testid="status-row"]');
}

test.describe('BatchPasteForm submit wiring', () => {
  test('malformed URL slot does not block the whole batch (noValidate regression)', async ({ page }) => {
    await goToBatchForm(page);

    // Slot 1: valid, submittable.
    await page.getByPlaceholder('https://www.nytimes.com/2026/04/23/theater/...').first().fill('https://example.com/ok-review-1');
    await page.locator('textarea').first().fill(VALID_TEXT);

    // Slot 2: a value that fails BOTH the native type="url" constraint and
    // isValidUrl() — this is exactly the input that trips the browser's
    // constraint validation if `noValidate` is missing from the <form>.
    await page.getByPlaceholder('https://www.nytimes.com/2026/04/23/theater/...').nth(1).fill('not a url at all');
    await page.locator('textarea').nth(1).fill(VALID_TEXT);

    const submitButton = page.getByRole('button', { name: /Submit \d+ review/ });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // Without noValidate, the browser's native validation on slot 2 blocks
    // the 'submit' event entirely — handleSubmitAll never runs, no status
    // rows ever appear, and this assertion times out.
    await expect(statusRows(page)).toHaveCount(3, { timeout: 5000 }); // 2 attempted + 1 dispatch/summary row

    await expect(page.getByText('Malformed — needs a valid URL and review text ≥50 characters')).toBeVisible();
  });

  test('all-malformed batch still produces status rows and a summary row (readyToSubmit gate regression)', async ({ page }) => {
    await goToBatchForm(page);

    // Both slots malformed: slot 1 bad URL, slot 2 too-short text.
    await page.getByPlaceholder('https://www.nytimes.com/2026/04/23/theater/...').first().fill('not-a-url');
    await page.locator('textarea').first().fill(VALID_TEXT);
    await page.getByPlaceholder('https://www.nytimes.com/2026/04/23/theater/...').nth(1).fill('https://example.com/ok-review-short');
    await page.locator('textarea').nth(1).fill('too short');

    // The pre-fix bug gated readyToSubmit on submitCount > 0, which is 0
    // here (nothing valid) — the button stayed disabled forever and
    // handleSubmitAll's skip-logging never ran.
    const submitButton = page.getByRole('button', { name: /Log \d+ failed review/ });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // 2 skip rows + 1 "0 of 2 committed" summary row.
    await expect(statusRows(page)).toHaveCount(3, { timeout: 5000 });
    await expect(page.getByText(/0 of 2 reviews? committed/)).toBeVisible();
  });

  test('exactly N status rows render for N attempted slots (mixed valid/malformed/duplicate)', async ({ page }) => {
    await goToBatchForm(page);

    await page.getByRole('button', { name: '+ Add another review' }).click(); // 3 slots total

    // Slot 1: valid, submittable.
    await page.getByPlaceholder('https://www.nytimes.com/2026/04/23/theater/...').nth(0).fill('https://example.com/ok-review-a');
    await page.locator('textarea').nth(0).fill(VALID_TEXT);

    // Slot 2: malformed URL.
    await page.getByPlaceholder('https://www.nytimes.com/2026/04/23/theater/...').nth(1).fill('garbage');
    await page.locator('textarea').nth(1).fill(VALID_TEXT);

    // Slot 3: duplicate of slot 1's URL.
    await page.getByPlaceholder('https://www.nytimes.com/2026/04/23/theater/...').nth(2).fill('https://example.com/ok-review-a');
    await page.locator('textarea').nth(2).fill(VALID_TEXT);

    const submitButton = page.getByRole('button', { name: /Submit \d+ review/ });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // 3 attempted slots (1 saved, 1 malformed, 1 duplicate) + 1 dispatch row = 4.
    await expect(statusRows(page)).toHaveCount(4, { timeout: 5000 });
    await expect(page.getByText('Malformed — needs a valid URL and review text ≥50 characters')).toBeVisible();
    await expect(page.getByText('Duplicate — same URL already in this batch')).toBeVisible();
  });
});
