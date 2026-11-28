import type { ReactNode } from 'react';
import ShareButton from '@/components/biz/ShareButton';

/** Shared hero for the dashboard, topics and seasons (BRO-6296). */
export default function BizHeader({ title, tagline, sharePath, shareTitle = title, children }: {
  title: string;
  tagline: string;
  sharePath: string;
  shareTitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-10">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <span className="inline-flex items-center whitespace-nowrap rounded-full border border-brand/40 px-2.5 sm:px-3 py-1 text-[11px] sm:text-xs font-semibold uppercase tracking-[0.04em] sm:tracking-[0.18em] text-brand">
          The Broadway profitability database
        </span>
        <ShareButton path={sharePath} title={shareTitle} className="shrink-0 ml-auto" />
      </div>
      <h1 className="text-4xl sm:text-5xl font-bold text-white tracking-tight">{title}</h1>
      <p className="text-xl sm:text-2xl text-gray-200 mt-3 font-medium">{tagline}</p>
      {children}
    </header>
  );
}
