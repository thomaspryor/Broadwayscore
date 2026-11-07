'use strict';

/**
 * Turn a failed Google Search Console API response into a plain fix for the
 * owner (BRO-5961). check-seo-health.yml failed every Sunday from 2026-08-23
 * with "User does not have sufficient permission for site ..." and the log
 * never said which account to re-add. A 403 also comes back when the Search
 * Console API is disabled in the GCP project, which needs a different fix,
 * so the body decides which hint applies.
 *
 * Returns a one-line hint, or null when the response matches neither case.
 * Owner (delegated owner, not a Full user) because the Indexing API, which
 * shares this service account, only accepts property owners. Steps follow
 * developers.google.com/search/apis/indexing-api/v3/prereqs ("Add an owner").
 */
function describeGscError(status, bodyText, clientEmail) {
  const body = String(bodyText || '');
  if (status === 403 && /sufficient permission/i.test(body)) {
    const who = clientEmail || 'the service account in GOOGLE_INDEXING_KEY';
    return `Search Console no longer lists ${who} as a user of this property. ` +
      'Fix: Search Console → Settings → Users and permissions → ⋮ next to your name → Manage property owners → ' +
      'Add an owner → paste that address.';
  }
  if (status === 403 && /(has not been used|accessNotConfigured|SERVICE_DISABLED|is disabled)/i.test(body)) {
    return 'The Google Search Console API is turned off in the Google Cloud project that owns the service account. ' +
      'Fix: Google Cloud console → APIs & Services → enable "Google Search Console API".';
  }
  return null;
}

module.exports = { describeGscError };
