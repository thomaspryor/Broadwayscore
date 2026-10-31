#!/usr/bin/env node
/**
 * Refresh src/sanity/posts-snapshot.json, the last-good copy of published blog
 * posts the build falls back to when Sanity errors (BRO-6659).
 *
 * One request for every published post with its full body, the same fields as
 * postBySlugQuery in src/sanity/queries.ts. Run after publishing a post; the
 * build warns ("posts-snapshot.json is missing ...") when it falls behind.
 *
 *   SANITY_API_READ_TOKEN=sk... node scripts/sanity-posts-snapshot.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@sanity/client');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: SANITY_API_READ_TOKEN=sk... node scripts/sanity-posts-snapshot.js [--dry-run]\n'
    + 'Refreshes src/sanity/posts-snapshot.json (blog fallback when Sanity errors at build).');
  process.exit(0);
}

const OUT = path.join(__dirname, '..', 'src', 'sanity', 'posts-snapshot.json');
const DRY_RUN = process.argv.includes('--dry-run');

const token = process.env.SANITY_API_READ_TOKEN;
if (!token) {
  console.error('Missing SANITY_API_READ_TOKEN (Viewer token, sanity.io/manage → API → Tokens).');
  process.exit(1);
}

const client = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID || 'fp1ft8k8',
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET || 'production',
  apiVersion: process.env.NEXT_PUBLIC_SANITY_API_VERSION || '2024-10-01',
  useCdn: true,
  perspective: 'published',
  token,
});

// Scheduled posts included: postBySlugQuery serves them by direct URL, and
// src/sanity/posts.ts filters them out of the list fallback by publishedAt.
const query = `*[_type == "post" && defined(slug.current)]
  | order(publishedAt desc) {
    _id, title, "slug": slug.current, excerpt, author, publishedAt,
    heroImage { "url": asset->url, alt },
    body
  }`;

(async () => {
  const posts = await client.fetch(query);
  if (!Array.isArray(posts)) throw new Error(`unexpected response: ${typeof posts}`);
  console.log(`${posts.length} published post(s): ${posts.map((p) => p.slug).join(', ') || '(none)'}`);
  if (DRY_RUN) return;
  fs.writeFileSync(OUT, JSON.stringify(posts, null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
})().catch((err) => {
  console.error(`snapshot failed, ${OUT} left unchanged: ${err.message}`);
  process.exit(1);
});
