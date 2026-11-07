// From @sanity/client, not the next-sanity barrel: next-sanity's index also
// exports its 'use client' live/visual-editing components, and importing the
// barrel from a server module put ~47kB gz of them (xstate, rxjs, comlink)
// into the browser bundle of every page that reads blog data, show pages
// included. next-sanity's createClient is this same function re-exported.
import { createClient } from '@sanity/client';
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
