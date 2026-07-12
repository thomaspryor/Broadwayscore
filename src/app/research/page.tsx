import type { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Research · Broadway Scorecard',
  description:
    'Original data studies of Broadway, Off-Broadway, and West End productions, drawn from 17,000+ scored critic reviews and 70,000+ audience ratings.',
  alternates: { canonical: `${BASE_URL}/research` },
  openGraph: {
    title: 'Broadway Scorecard Research',
    description:
      'Original data studies on Broadway, Off-Broadway, and West End from 17,000+ critic reviews and 70,000+ audience ratings.',
    url: `${BASE_URL}/research`,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
};

const studies = [
  {
    slug: 'critic-audience-divergence-2026',
    title:
      'Critics vs. Audiences: 583 Productions, One Persistent Gap',
    blurb:
      'We compared the critic CriticScore and aggregated audience score for every Broadway, Off-Broadway, and West End production with enough data. Audiences score shows 7.3 points higher on average, and disagree most sharply on a familiar list of musicals.',
    date: '2026-07-12',
  },
];

export default function ResearchIndexPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <header className="mb-10">
        <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
          Research
        </h1>
        <p className="text-gray-400 mt-2">
          Original data studies from the Broadway Scorecard corpus.
        </p>
      </header>

      <ul className="space-y-8">
        {studies.map((s) => (
          <li key={s.slug}>
            <Link
              href={`/research/${s.slug}`}
              className="block group p-5 rounded-lg border border-white/10 hover:border-amber-400/40 hover:bg-white/[0.02] transition-colors"
            >
              <div className="text-xs text-gray-500 mb-2">{s.date}</div>
              <h2 className="text-xl sm:text-2xl font-semibold text-white group-hover:text-amber-300 transition-colors">
                {s.title}
              </h2>
              <p className="text-gray-300 mt-2 leading-relaxed">{s.blurb}</p>
            </Link>
          </li>
        ))}
      </ul>

      <section className="mt-14 text-sm text-gray-400 leading-relaxed border-t border-white/10 pt-6">
        <p>
          Broadway Scorecard is a one-person, independent project. We aggregate
          professional critic reviews from 420+ outlets into a single CriticScore
          for every Broadway, Off-Broadway, and West End production. Studies on
          this page are free to cite. Please credit{' '}
          <Link href="/" className="text-amber-300 underline">
            broadwayscorecard.com
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
