import { createClient } from 'next-sanity';
import { apiVersion, dataset, projectId, useCdn } from './env';

/**
 * Server-side read token. NOT prefixed NEXT_PUBLIC_ so it never reaches the
 * browser bundle. Required because newer Sanity projects gate dataset reads
 * even when the dataset is set to Public.
 *
 * Create a Viewer token at sanity.io/manage → API → Tokens (read-only).
 */
const readToken = process.env.SANITY_API_READ_TOKEN;

export const client = createClient({
  projectId,
  dataset,
  apiVersion,
  useCdn,
  perspective: 'published',
  token: readToken,
});
