import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Metadata } from 'next';
import { PortableText, type PortableTextComponents } from '@portabletext/react';
import { client } from '@/sanity/client';
import {
  postBySlugQuery,
  postSlugsQuery,
  type PostDetail,
} from '@/sanity/queries';

export const revalidate = 60;

export async function generateStaticParams() {
  const slugs = await client.fetch<string[]>(postSlugsQuery);
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const post = await client.fetch<PostDetail | null>(postBySlugQuery, { slug: params.slug });
  if (!post) return { title: 'Post not found' };
  return {
    title: `${post.title} · Broadway Scorecard`,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      images: post.heroImage?.url ? [post.heroImage.url] : undefined,
    },
  };
}

const portableComponents: PortableTextComponents = {
  block: {
    h1: ({ children }) => (
      <h1 className="text-3xl font-bold text-white mt-10 mb-4">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-2xl font-semibold text-white mt-8 mb-3">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-xl font-semibold text-white mt-6 mb-2">{children}</h3>
    ),
    normal: ({ children }) => <p className="text-gray-200 leading-relaxed mb-4">{children}</p>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-gold pl-4 italic text-gray-300 my-6">
        {children}
      </blockquote>
    ),
  },
  marks: {
    link: ({ children, value }) => (
      <a
        href={value?.href}
        className="text-gold underline underline-offset-2 hover:text-white"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ),
  },
  types: {
    image: ({ value }) =>
      value?.asset?.url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={value.asset.url}
          alt={value.alt || ''}
          className="w-full h-auto rounded-lg my-6 border border-white/5"
        />
      ) : null,
  },
};

export default async function BlogPostPage({ params }: { params: { slug: string } }) {
  const post = await client.fetch<PostDetail | null>(postBySlugQuery, { slug: params.slug });
  if (!post) notFound();

  const published = new Date(post.publishedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <article className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <Link href="/blog" className="text-sm text-gray-400 hover:text-white transition-colors">
        &larr; All posts
      </Link>

      <header className="mt-6 mb-8">
        <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">{post.title}</h1>
        <p className="text-sm text-gray-500 mt-3">
          {post.author ? `By ${post.author} · ` : ''}
          {published}
        </p>
      </header>

      {post.heroImage?.url && (
        <div className="mb-8 overflow-hidden rounded-lg border border-white/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={post.heroImage.url}
            alt={post.heroImage.alt || post.title}
            className="w-full h-auto object-cover"
          />
        </div>
      )}

      {post.body ? (
        <div className="prose prose-invert max-w-none">
          <PortableText value={post.body as never} components={portableComponents} />
        </div>
      ) : (
        <p className="text-gray-400 italic">This post has no content yet.</p>
      )}
    </article>
  );
}
