import Link from 'next/link';
import { Metadata } from 'next';
import { client } from '@/sanity/client';
import { postsListQuery, type PostListItem } from '@/sanity/queries';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Blog · Broadway Scorecard',
  description: 'Editorial, essays, and the story behind the scores.',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default async function BlogIndexPage() {
  const posts = await client.fetch<PostListItem[]>(postsListQuery);

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <header className="mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">Blog</h1>
        <p className="text-gray-400 mt-2">Editorial, essays, and the story behind the scores.</p>
      </header>

      {posts.length === 0 ? (
        <p className="text-gray-500">No posts yet. Check back soon.</p>
      ) : (
        <ul className="space-y-8">
          {posts.map((p) => (
            <li key={p._id} className="group">
              <Link href={`/blog/${p.slug}`} className="block">
                {p.heroImage?.url && (
                  <div className="mb-3 overflow-hidden rounded-lg border border-white/5">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={p.heroImage.url}
                      alt={p.heroImage.alt || p.title}
                      className="w-full h-auto object-cover transition-transform group-hover:scale-[1.01]"
                    />
                  </div>
                )}
                <h2 className="text-xl sm:text-2xl font-semibold text-white group-hover:text-gold transition-colors">
                  {p.title}
                </h2>
                <p className="text-xs text-gray-500 mt-1">
                  {p.author ? `${p.author} · ` : ''}
                  {formatDate(p.publishedAt)}
                </p>
                {p.excerpt && <p className="text-gray-300 mt-3 leading-relaxed">{p.excerpt}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
