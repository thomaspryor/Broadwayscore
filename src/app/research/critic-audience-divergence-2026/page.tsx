import type { Metadata } from 'next';
import Link from 'next/link';
import fs from 'fs';
import path from 'path';
import { BASE_URL } from '@/lib/seo';

type Row = {
  id: string;
  slug: string;
  title: string;
  category: 'broadway' | 'off-broadway' | 'west-end' | 'off-west-end';
  market: string;
  status: string;
  openingDate: string | null;
  closingDate: string | null;
  critic: number;
  audience: number;
  gap: number;
  reviewCount: number;
  audienceCount: number;
};

type Dataset = {
  summary: {
    generated: string;
    source: string;
    thresholds: string;
    count: number;
    meanGap: number;
    meanAbsGap: number;
    audienceHigherCount: number;
    criticHigherCount: number;
    byCategory: Record<
      string,
      { count: number; meanGap: number; audienceHigher: number; criticHigher: number }
    >;
  };
  rows: Row[];
};

function loadData(): Dataset {
  const p = path.join(process.cwd(), 'public/data/research/critic-audience-divergence-2026.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function showHref(r: Row): string {
  if (r.category === 'west-end') return `/west-end-show/${r.slug}`;
  if (r.category === 'off-west-end') return `/west-end-show/${r.slug}`;
  return `/show/${r.slug}`;
}

const TITLE =
  'Critics vs. Audiences: 538 Productions, One Persistent Gap';
const DESCRIPTION =
  'We compared the CriticScore and aggregated audience score for every Broadway, Off-Broadway, and West End production with enough data. Audiences score shows 7.4 points higher than critics on average — and disagree most on a familiar list of musicals.';
const URL = `${BASE_URL}/research/critic-audience-divergence-2026`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: URL,
    type: 'article',
    publishedTime: '2026-05-26T00:00:00.000Z',
    authors: ['Tom Pryor'],
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630 }],
  },
};

function gapBar(gap: number) {
  // Visual bar: width scaled to 30 pt max, sign-colored
  const pct = Math.min(Math.abs(gap) / 30, 1) * 100;
  const colorClass = gap > 0 ? 'bg-blue-400' : 'bg-amber-400';
  return (
    <div className="relative h-2 w-24 sm:w-32 bg-white/5 rounded overflow-hidden">
      <div
        className={`absolute top-0 bottom-0 ${colorClass}`}
        style={{
          width: `${pct / 2}%`,
          left: gap > 0 ? '50%' : `${50 - pct / 2}%`,
        }}
      />
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-white/30" />
    </div>
  );
}

function RowTable({
  rows,
  highlight,
}: {
  rows: Row[];
  highlight: 'audience' | 'critic';
}) {
  return (
    <div className="overflow-x-auto mt-4 -mx-4 sm:mx-0">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-gray-400 text-xs uppercase tracking-wide">
            <th className="text-left font-medium px-3 py-2">Show</th>
            <th className="text-right font-medium px-3 py-2">Critic</th>
            <th className="text-right font-medium px-3 py-2">Audience</th>
            <th className="text-right font-medium px-3 py-2">Gap</th>
            <th className="px-3 py-2 hidden sm:table-cell"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const sign = r.gap > 0 ? '+' : '';
            const isHi = highlight === 'audience' ? r.audience >= r.critic : r.critic >= r.audience;
            return (
              <tr key={r.id} className="border-t border-white/5">
                <td className="px-3 py-3">
                  <Link
                    href={showHref(r)}
                    className="text-white hover:text-amber-300 transition-colors"
                  >
                    {r.title}
                  </Link>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {r.category === 'west-end'
                      ? 'West End'
                      : r.category === 'off-west-end'
                      ? 'Off-West End'
                      : r.category === 'off-broadway'
                      ? 'Off-Broadway'
                      : 'Broadway'}
                    {r.openingDate ? ` · ${new Date(r.openingDate).getFullYear()}` : ''}
                    {' · '}
                    {r.reviewCount} critic{r.reviewCount === 1 ? '' : 's'},{' '}
                    {r.audienceCount.toLocaleString()} audience
                  </div>
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-gray-200">
                  {r.critic.toFixed(1)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums text-gray-200">
                  {r.audience.toFixed(1)}
                </td>
                <td
                  className={`px-3 py-3 text-right tabular-nums font-semibold ${
                    r.gap > 0 ? 'text-blue-300' : 'text-amber-300'
                  }`}
                >
                  {sign}
                  {r.gap.toFixed(1)}
                </td>
                <td className="px-3 py-3 hidden sm:table-cell">{gapBar(r.gap)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CriticAudienceDivergencePage() {
  const data = loadData();
  const { summary, rows } = data;

  const audienceHigher = [...rows].filter((r) => r.gap > 0).sort((a, b) => b.gap - a.gap);
  const criticHigher = [...rows].filter((r) => r.gap < 0).sort((a, b) => a.gap - b.gap);
  const consensus = [...rows]
    .filter((r) => r.critic >= 85 && r.audience >= 85 && Math.abs(r.gap) <= 3)
    .sort((a, b) => b.critic + b.audience - (a.critic + a.audience));

  const top10Audience = audienceHigher.slice(0, 10);
  const top10Critic = criticHigher.slice(0, 10);
  const top10Consensus = consensus.slice(0, 10);
  const audPct = Math.round((100 * summary.audienceHigherCount) / summary.count);

  const articleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: TITLE,
    description: DESCRIPTION,
    url: URL,
    datePublished: '2026-05-26',
    author: { '@type': 'Person', name: 'Tom Pryor' },
    publisher: {
      '@type': 'Organization',
      name: 'Broadway Scorecard',
      url: BASE_URL,
      logo: { '@type': 'ImageObject', url: `${BASE_URL}/og/home.png` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': URL },
    image: [`${BASE_URL}/og/home.png`],
  };

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />

      {/* Header */}
      <header className="mb-10">
        <div className="text-xs uppercase tracking-wider text-amber-300 mb-3">
          <Link href="/research" className="hover:underline">
            Research
          </Link>{' '}
          / Data Study
        </div>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight leading-tight">
          {TITLE}
        </h1>
        <p className="text-lg text-gray-300 mt-5 leading-relaxed">{DESCRIPTION}</p>
        <div className="text-xs text-gray-500 mt-4">
          By Tom Pryor · Published 2026-05-26 · Based on {summary.count.toLocaleString()}{' '}
          productions
        </div>
      </header>

      {/* Headline stats */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-12">
        <div className="p-4 rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="text-2xl sm:text-3xl font-bold text-amber-300 tabular-nums">
            +{summary.meanGap.toFixed(1)}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            Average gap (audience − critic)
          </div>
        </div>
        <div className="p-4 rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="text-2xl sm:text-3xl font-bold text-white tabular-nums">
            {audPct}%
          </div>
          <div className="text-xs text-gray-400 mt-1">
            Of shows where audiences score higher
          </div>
        </div>
        <div className="p-4 rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="text-2xl sm:text-3xl font-bold text-white tabular-nums">
            {summary.count.toLocaleString()}
          </div>
          <div className="text-xs text-gray-400 mt-1">Productions analyzed</div>
        </div>
        <div className="p-4 rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="text-2xl sm:text-3xl font-bold text-white tabular-nums">
            +{summary.byCategory['west-end']?.meanGap.toFixed(1)}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            West End audience-vs-critic gap (vs. +
            {summary.byCategory['broadway']?.meanGap.toFixed(1)} Broadway)
          </div>
        </div>
      </section>

      {/* The headline finding */}
      <section className="prose prose-invert max-w-none mb-12">
        <h2 className="text-2xl font-semibold text-white mb-4">The headline finding</h2>
        <p className="text-gray-200 leading-relaxed">
          We pulled every Broadway, Off-Broadway, and West End production in the{' '}
          <Link href="/" className="text-amber-300 underline">
            Broadway Scorecard
          </Link>{' '}
          database that has both (a) at least 5 scored critic reviews and (b) at least 100
          audience ratings across Show-Score, Mezzanine, BroadwayBox, TheatreNYC, and Reddit.
          That's {summary.count.toLocaleString()} productions spanning roughly two decades.
        </p>
        <p className="text-gray-200 leading-relaxed mt-4">
          In <strong className="text-white">{audPct}% of them, audiences scored the show higher than critics did</strong>. The average production gets graded{' '}
          <strong className="text-amber-300">+{summary.meanGap.toFixed(1)} points</strong> by
          audiences vs. critics on a 100-point scale. The gap is even wider on the West End
          (+{summary.byCategory['west-end']?.meanGap.toFixed(1)}) than on Broadway (+
          {summary.byCategory['broadway']?.meanGap.toFixed(1)}).
        </p>
        <p className="text-gray-200 leading-relaxed mt-4">
          But the averages hide the interesting story. The most divisive productions are not
          obscure flops — they're some of the most commercially successful shows of the
          century.
        </p>
      </section>

      {/* Audience-higher table */}
      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-white mb-2">
          The 10 shows audiences loved most that critics didn't
        </h2>
        <p className="text-sm text-gray-400 mb-2">
          Productions where the aggregated audience score most exceeded the critic
          CriticScore.
        </p>
        <RowTable rows={top10Audience} highlight="audience" />
        <p className="text-sm text-gray-400 mt-4 leading-relaxed">
          The story is familiar: large-cap commercial musicals with strong brand
          recognition, blockbuster source IP, or pop-crossover scores tend to thrill ticket
          buyers while drawing tepid notices.{' '}
          <Link href={showHref(top10Audience[0])} className="text-amber-300 underline">
            {top10Audience[0]?.title}
          </Link>{' '}
          tops the list at +{top10Audience[0]?.gap.toFixed(1)} —{' '}
          {top10Audience[0]?.audience.toFixed(0)}/100 from audiences vs.{' '}
          {top10Audience[0]?.critic.toFixed(0)} from critics.
        </p>
      </section>

      {/* Critic-higher table */}
      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-white mb-2">
          The 10 shows critics loved most that audiences didn't
        </h2>
        <p className="text-sm text-gray-400 mb-2">
          The flip: productions where the critic CriticScore most exceeded the aggregated
          audience score. Only {summary.criticHigherCount} of {summary.count.toLocaleString()}{' '}
          productions land here at all.
        </p>
        <RowTable rows={top10Critic} highlight="critic" />
        <p className="text-sm text-gray-400 mt-4 leading-relaxed">
          The pattern reverses: serious plays, formal experiments, and revivals of canonical
          texts cluster here. These shows tend to win awards (e.g.{' '}
          <Link href={showHref(top10Critic.find((r) => r.id === 'stereophonic-2024') || top10Critic[0])} className="text-amber-300 underline">
            {(top10Critic.find((r) => r.id === 'stereophonic-2024') || top10Critic[0])?.title}
          </Link>
          ) but split mainstream audiences.
        </p>
      </section>

      {/* Consensus */}
      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-white mb-2">
          The consensus darlings
        </h2>
        <p className="text-sm text-gray-400 mb-2">
          Where both critics and audiences score 85+ with a gap of 3 points or less. The
          short list of productions everyone agrees on.
        </p>
        <RowTable rows={top10Consensus} highlight="audience" />
      </section>

      {/* By category */}
      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-white mb-4">
          The gap by market
        </h2>
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-gray-400 text-xs uppercase tracking-wide">
                <th className="text-left font-medium px-3 py-2">Market</th>
                <th className="text-right font-medium px-3 py-2">Shows</th>
                <th className="text-right font-medium px-3 py-2">Mean gap</th>
                <th className="text-right font-medium px-3 py-2">Aud &gt; critic</th>
                <th className="text-right font-medium px-3 py-2">Critic &gt; aud</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.byCategory).map(([cat, s]) => (
                <tr key={cat} className="border-t border-white/5">
                  <td className="px-3 py-3 text-white font-medium">
                    {cat === 'west-end'
                      ? 'West End'
                      : cat === 'off-west-end'
                      ? 'Off-West End'
                      : cat === 'off-broadway'
                      ? 'Off-Broadway'
                      : 'Broadway'}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-gray-200">
                    {s.count.toLocaleString()}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-amber-300 font-semibold">
                    +{s.meanGap.toFixed(2)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-gray-200">
                    {s.audienceHigher}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-gray-200">
                    {s.criticHigher}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-gray-400 mt-4 leading-relaxed">
          The West End shows the widest gap — audiences there grade productions{' '}
          {summary.byCategory['west-end']?.meanGap.toFixed(1)} points above critics on
          average, against{' '}
          {summary.byCategory['broadway']?.meanGap.toFixed(1)} on Broadway. One contributing
          factor: the West End sample skews toward long-running commercial musicals where
          audience self-selection is strongest.
        </p>
      </section>

      {/* Takeaways */}
      <section className="mb-12">
        <h2 className="text-2xl font-semibold text-white mb-4">What this means</h2>
        <ul className="space-y-3 text-gray-200 leading-relaxed">
          <li>
            <strong className="text-white">Critics are systematically harder graders than
            audiences.</strong>{' '}
            This is not surprising — critics see far more theater than the average
            ticket-buyer and grade against a deeper reference set. But the magnitude (a
            7.4-point average gap on a 100-point scale) is larger than the comparable
            gap on Rotten Tomatoes for film.
          </li>
          <li>
            <strong className="text-white">The biggest commercial musicals show the
            biggest gaps.</strong>{' '}
            Productions like{' '}
            <Link href="/show/wicked-2003" className="text-amber-300 underline">
              Wicked
            </Link>
            ,{' '}
            <Link href="/show/finding-neverland-2015" className="text-amber-300 underline">
              Finding Neverland
            </Link>
            , and{' '}
            <Link href="/show/beetlejuice-2019" className="text-amber-300 underline">
              Beetlejuice
            </Link>{' '}
            generate huge audience score databases — and those audiences are systematically
            more enthusiastic than the critical consensus.
          </li>
          <li>
            <strong className="text-white">Awards prestige predicts audience
            divergence.</strong>{' '}
            Tony and Olivier-winning serious plays often cluster on the critic-higher side.{' '}
            <Link href="/show/stereophonic-2024" className="text-amber-300 underline">
              Stereophonic
            </Link>{' '}
            (Best Play 2024) sits in our top-10 critic-loved-more list.
          </li>
        </ul>
      </section>

      {/* Methodology */}
      <section className="mb-12 text-sm text-gray-400 leading-relaxed border-t border-white/10 pt-6">
        <h2 className="text-base font-semibold text-white mb-3">Methodology</h2>
        <p>
          Critic CriticScore is a tier-weighted average across reviews from 420+ outlets,
          where Tier-1 outlets (NYT, Vulture, Variety) carry a 1.0 weight, Tier-2 (Time
          Out, NY Post) 0.75, and Tier-3 (blogs) 0.35. Full methodology:{' '}
          <Link href="/methodology" className="text-amber-300 underline">
            broadwayscorecard.com/methodology
          </Link>
          .
        </p>
        <p className="mt-3">
          Audience score is a combined score across five sources: Show-Score, Mezzanine,
          BroadwayBox, TheatreNYC, and Reddit (subreddit sentiment + thread-level
          aggregation). See{' '}
          <Link href="/audience-buzz" className="text-amber-300 underline">
            /audience-buzz
          </Link>{' '}
          for the live audience methodology.
        </p>
        <p className="mt-3">
          Inclusion thresholds: ≥5 scored critic reviews AND ≥100 audience samples across
          all sources. {summary.count.toLocaleString()} productions qualified out of ~2,600
          in the database.
        </p>
        <p className="mt-3">
          Underlying data is downloadable as JSON:{' '}
          <a
            href="/data/research/critic-audience-divergence-2026.json"
            className="text-amber-300 underline"
          >
            critic-audience-divergence-2026.json
          </a>
          .
        </p>
      </section>

      {/* Citation */}
      <section className="mb-12">
        <h2 className="text-base font-semibold text-white mb-3">Use this data</h2>
        <p className="text-sm text-gray-300 leading-relaxed">
          This study is free to cite — please link back to{' '}
          <a href={URL} className="text-amber-300 underline">
            {URL}
          </a>
          . The full ranked list of all {summary.count.toLocaleString()} productions is
          available as JSON at the link above. Questions? Reach Tom Pryor at{' '}
          <a href="mailto:thomas.pryor@gmail.com" className="text-amber-300 underline">
            thomas.pryor@gmail.com
          </a>
          .
        </p>
      </section>
    </main>
  );
}
