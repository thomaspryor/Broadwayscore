import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkHtml from 'remark-html';

export interface BlogReview {
  title: string;
  show: string;
  showSlug?: string;
  venue: string;
  score: number;
  dateAttended: string;
  publishDate: string;
  heroImage?: string;
  slug: string;
  readingTime: number;
  contentHtml: string;
  stressTestHtml: string | null;
  excerpt: string;
}

const REVIEWS_DIR = path.join(process.cwd(), 'content', 'reviews');

const STRESS_TEST_HEADING = /^##\s+broadway\s+stress\s+test\s*$/im;

function compileMarkdown(md: string): string {
  const result = remark().use(remarkGfm).use(remarkHtml, { sanitize: false }).processSync(md);
  return String(result);
}

function splitStressTest(content: string): { body: string; stressTest: string | null } {
  const match = content.match(STRESS_TEST_HEADING);
  if (!match || match.index === undefined) {
    return { body: content, stressTest: null };
  }
  const body = content.slice(0, match.index).trim();
  const stressTestMd = content.slice(match.index + match[0].length).trim();
  return { body, stressTest: stressTestMd || null };
}

function generateExcerpt(content: string, maxLength = 150): string {
  // Strip markdown formatting for plain text excerpt
  const plain = content
    .replace(/^##?\s+.*$/gm, '') // headings
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/\*(.+?)\*/g, '$1') // italic
    .replace(/>\s+(.+)/g, '$1') // blockquotes
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // links
    .replace(/\n+/g, ' ')
    .trim();
  if (plain.length <= maxLength) return plain;
  return plain.slice(0, maxLength).replace(/\s+\S*$/, '') + '...';
}

let cache: BlogReview[] | null = null;

function loadReviews(): BlogReview[] {
  if (cache) return cache;

  if (!fs.existsSync(REVIEWS_DIR)) {
    cache = [];
    return cache;
  }

  const files = fs.readdirSync(REVIEWS_DIR).filter(
    f => f.endsWith('.md') && !f.startsWith('_')
  );

  const reviews: BlogReview[] = [];

  for (const file of files) {
    try {
      const filePath = path.join(REVIEWS_DIR, file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const { data, content } = matter(raw);

      const slug = file.replace(/\.md$/, '');

      // Validate required fields
      if (!data.title || !data.show || !data.venue || data.score === undefined || !data.publishDate) {
        console.warn(`[blog] Skipping ${file}: missing required frontmatter fields`);
        continue;
      }

      const score = Number(data.score);
      if (isNaN(score) || score < 0 || score > 100) {
        console.warn(`[blog] Skipping ${file}: score must be 0-100, got ${data.score}`);
        continue;
      }

      // Split content at stress test heading, then compile each part
      const { body, stressTest } = splitStressTest(content);
      const contentHtml = compileMarkdown(body);
      const stressTestHtml = stressTest ? compileMarkdown(stressTest) : null;

      // Reading time from the full content (before split)
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      const readingTime = Math.max(1, Math.ceil(wordCount / 238));

      reviews.push({
        title: data.title,
        show: data.show,
        showSlug: data.showSlug || undefined,
        venue: data.venue,
        score,
        dateAttended: data.dateAttended || data.publishDate,
        publishDate: data.publishDate,
        heroImage: data.heroImage || undefined,
        slug,
        readingTime,
        contentHtml,
        stressTestHtml,
        excerpt: generateExcerpt(body),
      });
    } catch (err) {
      console.warn(`[blog] Skipping ${file}: ${err instanceof Error ? err.message : 'parse error'}`);
    }
  }

  // Sort by publishDate descending
  reviews.sort((a, b) => b.publishDate.localeCompare(a.publishDate));

  cache = reviews;
  return reviews;
}

/**
 * Source of truth toggle.
 * - USE_SANITY_REVIEWS=true  → fetch from Sanity (production after migration runs)
 * - unset / false            → read from content/reviews/*.md (legacy, dev fallback)
 *
 * Once the migration script (scripts/migrate-reviews-to-sanity.js) has run and
 * Sanity contains the reviews, set USE_SANITY_REVIEWS=true in Vercel env vars
 * for all 3 environments. The MD files in content/reviews/ are kept as backup.
 */
const USE_SANITY = process.env.USE_SANITY_REVIEWS === 'true';

export async function getAllBlogReviews(): Promise<BlogReview[]> {
  if (USE_SANITY) {
    const { getAllBlogReviewsFromSanity } = await import('./data-reviews-blog-sanity');
    return getAllBlogReviewsFromSanity();
  }
  return loadReviews();
}

export async function getBlogReviewBySlug(slug: string): Promise<BlogReview | undefined> {
  if (USE_SANITY) {
    const { getBlogReviewBySlugFromSanity } = await import('./data-reviews-blog-sanity');
    const r = await getBlogReviewBySlugFromSanity(slug);
    return r ?? undefined;
  }
  return loadReviews().find(r => r.slug === slug);
}

export async function getBlogReviewByShowSlug(showSlug: string): Promise<BlogReview | undefined> {
  const all = await getAllBlogReviews();
  return all.find(r => r.showSlug === showSlug);
}
