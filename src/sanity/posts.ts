import { sanityFetch } from './fetch';
import {
  postBySlugQuery,
  postSlugsQuery,
  postsListQuery,
  type PostDetail,
  type PostListItem,
} from './queries';
import snapshot from './posts-snapshot.json';

/**
 * Blog post reads with a committed last-good snapshot (BRO-6659). When Sanity
 * errors during a build, published posts keep building from
 * posts-snapshot.json instead of failing the deploy or vanishing. Refresh it with
 * `node scripts/sanity-posts-snapshot.js` (needs SANITY_API_READ_TOKEN) after
 * publishing a post.
 */
const snapshotPosts = snapshot as PostDetail[];

// The snapshot may hold scheduled posts; list and slugs only show published
// ones, matching postsListQuery/postSlugsQuery. Lookup by slug stays
// unfiltered, matching postBySlugQuery.
function publishedSnapshot(): PostDetail[] {
  const now = Date.now();
  return snapshotPosts.filter((p) => Date.parse(p.publishedAt) <= now);
}

function toListItem({ body: _body, ...item }: PostDetail): PostListItem {
  return item;
}

export function getPostSlugs(): Promise<string[]> {
  return sanityFetch<string[]>(postSlugsQuery, {}, () => publishedSnapshot().map((p) => p.slug)).then((slugs) => {
    const missing = slugs.filter((s) => !snapshotPosts.some((p) => p.slug === s));
    if (missing.length) {
      console.warn(`[sanity] posts-snapshot.json is missing ${missing.join(', ')}; run scripts/sanity-posts-snapshot.js`);
    }
    return slugs;
  });
}

export function getPostsList(): Promise<PostListItem[]> {
  return sanityFetch<PostListItem[]>(postsListQuery, {}, () => publishedSnapshot().map(toListItem));
}

export function getPostBySlug(slug: string): Promise<PostDetail | null> {
  return sanityFetch<PostDetail | null>(postBySlugQuery, { slug }, () => snapshotPosts.find((p) => p.slug === slug) ?? null);
}
