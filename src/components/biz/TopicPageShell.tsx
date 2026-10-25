/**
 * TopicPageShell - frame for the Money Scorecard topic pages
 * (/biz/musicals-since-reopening, /biz/reviews-and-money, ...; BRO-5865):
 * back link, title, sourcing note and methodology footer, matching /biz/season/[season].
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ESTIMATE_SOURCES_NOTE } from '@/lib/commercial-display';
import ShareButton from '@/components/biz/ShareButton';

export default function TopicPageShell({ title, subtitle, sharePath, children }: { title: string; subtitle: string; sharePath: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
        <Link href="/biz" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Money Scorecard
        </Link>

        <div className="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-white">{title}</h1>
            <p className="text-gray-400 mt-2">{subtitle}</p>
            <p className="text-xs text-amber-500/70 mt-1">
              {ESTIMATE_SOURCES_NOTE}{' '}
              <Link href="/methodology#commercial" className="underline hover:text-amber-400">How we measure</Link>
            </p>
          </div>
          <ShareButton path={sharePath} title={title} className="shrink-0 order-first self-end sm:order-none sm:self-start" />
        </div>

        {children}

        <footer className="text-sm text-gray-500 border-t border-white/5 pt-6 mt-8">
          <p>
            Commercial productions only: nonprofit runs and tour stops have no investors to repay and are left out.
            Capitalization and recoupment from SEC filings and trade press.
          </p>
          <div className="flex gap-4 mt-3">
            <Link href="/methodology#commercial" className="text-brand hover:text-brand-hover">Methodology →</Link>
            <Link href="/feedback" className="text-brand hover:text-brand-hover">Report an error →</Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
