import { groq } from 'next-sanity';

export const postsListQuery = groq`
  *[_type == "post" && defined(slug.current) && publishedAt <= now()]
  | order(publishedAt desc)
  {
    _id,
    title,
    "slug": slug.current,
    excerpt,
    author,
    publishedAt,
    heroImage {
      "url": asset->url,
      alt
    }
  }
`;

export const postBySlugQuery = groq`
  *[_type == "post" && slug.current == $slug][0] {
    _id,
    title,
    "slug": slug.current,
    excerpt,
    author,
    publishedAt,
    heroImage {
      "url": asset->url,
      alt
    },
    body
  }
`;

export const postSlugsQuery = groq`
  *[_type == "post" && defined(slug.current) && publishedAt <= now()].slug.current
`;

export interface PostListItem {
  _id: string;
  title: string;
  slug: string;
  excerpt?: string;
  author?: string;
  publishedAt: string;
  heroImage?: { url: string; alt?: string };
}

export interface PostDetail extends PostListItem {
  body?: unknown[];
}

export const reviewsListQuery = groq`
  *[_type == "showReview" && defined(slug.current) && publishDate <= now()]
  | order(publishDate desc)
  {
    _id,
    title,
    "slug": slug.current,
    show,
    showSlug,
    venue,
    score,
    dateAttended,
    publishDate,
    excerpt,
    heroImage {
      "url": asset->url,
      alt
    }
  }
`;

export const reviewBySlugQuery = groq`
  *[_type == "showReview" && slug.current == $slug][0] {
    _id,
    title,
    "slug": slug.current,
    show,
    showSlug,
    venue,
    score,
    dateAttended,
    publishDate,
    excerpt,
    heroImage {
      "url": asset->url,
      alt
    },
    body,
    stressTest
  }
`;

export const reviewSlugsQuery = groq`
  *[_type == "showReview" && defined(slug.current) && publishDate <= now()].slug.current
`;

export interface ReviewListItem {
  _id: string;
  title: string;
  slug: string;
  show: string;
  showSlug?: string;
  venue: string;
  score: number;
  dateAttended: string;
  publishDate: string;
  excerpt?: string;
  heroImage?: { url: string; alt?: string };
}

export interface ReviewDetail extends ReviewListItem {
  body?: unknown[];
  stressTest?: unknown[];
}
