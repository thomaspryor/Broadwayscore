'use client';

import IngestForm from '@/app/admin/ingest/IngestForm';

/**
 * Playwright-only fixture for IngestForm (card #1822 — component-level test
 * for BatchPasteForm submit wiring). Renders the real component directly,
 * bypassing the /admin/ingest page's isAdmin() server-side cookie gate —
 * same pattern as /test/rating-editor-fixture and /test/ugc-fixture.
 * Network calls (search-shows.json, ingest-review, dispatch-rebuild) are
 * mocked by the test via page.route(), never hit real GitHub/APIs.
 */
export default function IngestFormFixturePage() {
  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <IngestForm />
      </div>
    </div>
  );
}
