import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { CATALOG, TOTAL_ENTRIES } from './catalog-data.mjs';

export const metadata: Metadata = {
  title: 'Aggregate Page Catalog (dev)',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

type CatalogEntry = {
  path: string;
  label: string;
  why: string;
  focus: string[];
};

type CatalogGroup = {
  heading: string;
  entries: CatalogEntry[];
};

export default async function AggregatePageCatalog() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <main className="min-h-screen bg-surface text-white px-4 sm:px-6 py-8 max-w-5xl mx-auto">
      <header className="mb-8 pb-6 border-b border-white/10">
        <p className="text-xs uppercase tracking-wider text-white/60 mb-2">dev only · not indexed</p>
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Aggregate Page Catalog</h1>
        <p className="text-white/70 max-w-2xl">
          Curated set of real URLs covering every aggregate / list / table page in the app: audience-buzz,
          market landings, browse, discount tickets, trending, creative + critic indexes, theaters, gold lists,
          biz, awards. The capture script (<code className="text-amber-300">scripts/capture-aggregate-catalog.mjs</code>)
          navigates to each entry at desktop (1440px) and mobile (390px), saving full-page screenshots to{' '}
          <code className="text-amber-300">~/Documents/claude-outputs/aggregate-catalog/</code>.
        </p>
        <p className="text-white/60 mt-3 text-sm">
          {TOTAL_ENTRIES} URLs · {(CATALOG as CatalogGroup[]).length} groups
        </p>
      </header>

      {(CATALOG as CatalogGroup[]).map((group) => (
        <section key={group.heading} className="mb-10">
          <h2 className="text-xl font-semibold mb-3 text-white">{group.heading}</h2>
          <div className="space-y-3">
            {group.entries.map((entry) => (
              <div
                key={entry.path}
                data-catalog-entry={entry.path}
                className="card p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-lg font-semibold text-white truncate">
                        {entry.label}{' '}
                        <span className="text-white/40 font-mono text-sm">{entry.path}</span>
                      </h3>
                    </div>
                    <p className="text-white/70 text-sm mb-2">{entry.why}</p>
                    <ul className="text-white/60 text-xs list-disc list-inside space-y-0.5">
                      {entry.focus.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  </div>
                  <Link
                    href={entry.path}
                    className="shrink-0 inline-flex items-center px-3 py-1.5 text-sm rounded-md bg-white/10 hover:bg-white/15 text-white border border-white/10"
                    target="_blank"
                    rel="noopener"
                  >
                    Open →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      <footer className="mt-12 pt-6 border-t border-white/10 text-white/50 text-sm">
        To regenerate screenshots:{' '}
        <code className="text-amber-300">
          npm run dev &amp;&amp; node scripts/capture-aggregate-catalog.mjs &amp;&amp; node scripts/bundle-aggregate-catalog-pdf.mjs
        </code>
      </footer>
    </main>
  );
}
