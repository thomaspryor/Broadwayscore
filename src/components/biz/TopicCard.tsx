/**
 * TopicCard - one /biz card per Profitability Scorecard topic page: the headline
 * number, linking through (BRO-5865).
 */

import Link from 'next/link';

export default function TopicCard({ href, title, headline, detail }: { href: string; title: string; headline: string; detail: string }) {
  return (
    <Link href={href} className="card-interactive rounded-xl p-4 block" data-testid="topic-card">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{title}</div>
      <div className="text-2xl font-bold text-white mt-1">{headline}</div>
      <p className="text-sm text-gray-400 mt-1">{detail}</p>
      <span className="text-sm text-brand mt-2 inline-block">Read the analysis →</span>
    </Link>
  );
}
