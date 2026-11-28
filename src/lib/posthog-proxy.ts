/**
 * Same-origin PostHog reverse proxy (BRO-5984). vercel.json rewrites
 * /ingest/static/* -> us-assets.i.posthog.com and /ingest/* -> us.i.posthog.com
 * so ad blockers that list *.posthog.com no longer hide visitors.
 * Every browser-side PostHog call must use these, including hand-written beacons.
 */
export const POSTHOG_PROXY_PATH = '/ingest';
export const POSTHOG_UI_HOST = 'https://us.posthog.com';
export const POSTHOG_CAPTURE_URL = `${POSTHOG_PROXY_PATH}/capture/`;
