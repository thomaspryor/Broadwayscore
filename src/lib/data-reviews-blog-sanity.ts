/**
 * Sanity-backed implementation of the BlogReview data layer.
 *
 * Returns the same shape as the markdown reader (`BlogReview`) so the existing
 * /reviews and /reviews/[slug] components don't change.
 *
 * Activated when env var USE_SANITY_REVIEWS=true (see data-reviews-blog.ts).
 */
import { toHTML } from '@portabletext/to-html';
import { client } from '@/sanity/client';
import {
  reviewsListQuery,
  reviewBySlugQuery,
  type ReviewDetail,
  type ReviewListItem,
} from '@/sanity/queries';
import type { BlogReview } from './data-reviews-blog';

function generateExcerpt(text: string, maxLength = 150): string {
  const plain = text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= maxLength) return plain;
  return plain.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

function readingTimeFromHtml(html: string): number {
  const text = html.replace(/<[^>]*>/g, ' ');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(wordCount / 238));
}

function ptToHtml(blocks: unknown[] | undefined | null): string {
  if (!blocks || blocks.length === 0) return '';
  // Cast — PortableText types are deeply nested; the toHTML signature accepts our shape.
  return toHTML(blocks as never, {
    components: {
      types: {
        image: ({ value }) => {
          const v = value as { asset?: { url?: string }; alt?: string };
          if (!v.asset?.url) return '';
          const alt = v.alt ? ` alt="${v.alt.replace(/"/g, '&quot;')}"` : '';
          return `<img src="${v.asset.url}"${alt} loading="lazy" />`;
        },
      },
    },
  });
}

function toBlogReviewListItem(item: ReviewListItem): Omit<BlogReview, 'contentHtml' | 'stressTestHtml'> & {
  contentHtml: string;
  stressTestHtml: string | null;
} {
  // List query doesn't fetch body — return minimal fields only.
  // /reviews list page uses excerpt + heroImage + slug + show + venue + score + publishDate.
  return {
    title: item.title,
    show: item.show,
    showSlug: item.showSlug,
    venue: item.venue,
    score: item.score,
    dateAttended: item.dateAttended,
    publishDate: item.publishDate,
    heroImage: item.heroImage?.url,
    slug: item.slug,
    readingTime: 0, // not used on list view
    contentHtml: '', // not used on list view
    stressTestHtml: null,
    excerpt: item.excerpt || '',
  };
}

function toBlogReviewDetail(d: ReviewDetail): BlogReview {
  const contentHtml = ptToHtml(d.body);
  const stressTestHtml = d.stressTest && d.stressTest.length > 0 ? ptToHtml(d.stressTest) : null;
  const excerpt = d.excerpt || generateExcerpt(contentHtml);
  const readingTime = readingTimeFromHtml(contentHtml + (stressTestHtml || ''));

  return {
    title: d.title,
    show: d.show,
    showSlug: d.showSlug,
    venue: d.venue,
    score: d.score,
    dateAttended: d.dateAttended,
    publishDate: d.publishDate,
    heroImage: d.heroImage?.url,
    slug: d.slug,
    readingTime,
    contentHtml,
    stressTestHtml,
    excerpt,
  };
}

export async function getAllBlogReviewsFromSanity(): Promise<BlogReview[]> {
  const items = await client.fetch<ReviewListItem[]>(reviewsListQuery);
  return items.map(toBlogReviewListItem) as BlogReview[];
}

export async function getBlogReviewBySlugFromSanity(slug: string): Promise<BlogReview | null> {
  const detail = await client.fetch<ReviewDetail | null>(reviewBySlugQuery, { slug });
  if (!detail) return null;
  return toBlogReviewDetail(detail);
}
