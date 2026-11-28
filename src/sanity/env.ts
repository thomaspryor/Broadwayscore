export const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || '2024-10-01';

export const dataset = assertValue(
  process.env.NEXT_PUBLIC_SANITY_DATASET,
  'Missing environment variable: NEXT_PUBLIC_SANITY_DATASET'
);

export const projectId = assertValue(
  process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
  'Missing environment variable: NEXT_PUBLIC_SANITY_PROJECT_ID'
);

// BRO-6659: published reads go to the API CDN, which has its own, far larger
// request quota. The direct API quota ran out on 2026-10-30 and failed every
// deploy; the CDN kept answering. Pages revalidate hourly, so CDN freshness
// (seconds) is fine. Token-authenticated requests are served by the CDN too.
export const useCdn = true;

function assertValue<T>(v: T | undefined, errorMessage: string): T {
  if (v === undefined) throw new Error(errorMessage);
  return v;
}
