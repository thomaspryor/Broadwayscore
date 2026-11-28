/**
 * TopicPageShell - frame for the Profitability Scorecard topic pages
 * (/biz/musicals-since-reopening, /biz/reviews-and-money, ...; BRO-5865):
 * back link, title, sourcing note and methodology footer, matching /biz/season/[season].
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ESTIMATE_SOURCES_NOTE } from '@/lib/commercial-display';
import EmailTomLink from '@/components/EmailTomLink';
import BizHeader from '@/components/biz/BizHeader';

export default function TopicPageShell({ title, subtitle, sharePath, children }: { title: string; subtitle: string; sharePath: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-surface">
      <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
        <Link href="/biz" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Profitability Scorecard
        </Link>

        <BizHeader title={title} tagline={subtitle} sharePath={sharePath}>
          <div className="mt-5 space-y-1">
            <p className="text-xs text-amber-500/70">
              {ESTIMATE_SOURCES_NOTE}{' '}
              <Link href="/methodology#commercial" className="underline hover:text-amber-400">How we measure</Link>
            </p>
            <p className="text-xs text-amber-500/70">Questions, ideas, requests?{' '}<EmailTomLink className="underline hover:text-amber-400" /></p>
          </div>
        </BizHeader>

        {children}

        <footer className="text-sm text-fg-muted border-t border-white/5 pt-6 mt-8">
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
