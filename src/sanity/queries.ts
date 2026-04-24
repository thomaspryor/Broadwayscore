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
