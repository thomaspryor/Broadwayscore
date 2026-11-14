import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getShowBySlug } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-types';
import type { Metadata } from 'next';
import { CATALOG, TOTAL_ENTRIES } from './catalog-data.mjs';

export const metadata: Metadata = {
  title: 'Show Page Catalog (dev)',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

type CatalogEntry = {
  slug: string;
  label: string;
  why: string;
  focus: string[];
};

type CatalogGroup = {
  heading: string;
  entries: CatalogEntry[];
};

async function resolveExisting(): Promise<Map<string, ComputedShow | null>> {
  const out = new Map<string, ComputedShow | null>();
  for (const group of CATALOG as CatalogGroup[]) {
    for (const entry of group.entries) {
      out.set(entry.slug, getShowBySlug(entry.slug) ?? null);
    }
  }
  return out;
}

export default async function ShowPageCatalog() {
  // Hard gate: dev only. 404s in production.
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  const resolved = await resolveExisting();

  return (
    <main className="min-h-screen bg-surface text-white px-4 sm:px-6 py-8 max-w-5xl mx-auto">
      <header className="mb-8 pb-6 border-b border-white/10">
        <p className="text-xs uppercase tracking-wider text-white/60 mb-2">dev only · not indexed</p>
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Show Page Catalog</h1>
        <p className="text-white/70 max-w-2xl">
          Curated set of real show URLs covering every state, market, and tier rendered on the show page. The
          capture script (<code className="text-amber-300">scripts/capture-show-page-catalog.mjs</code>) navigates
          to each entry below at desktop (1440px) and mobile (390px), saving full-page screenshots to{' '}
          <code className="text-amber-300">~/Documents/claude-outputs/show-page-catalog/</code>.
        </p>
        <p className="text-white/60 mt-3 text-sm">
          {TOTAL_ENTRIES} URLs · {(CATALOG as CatalogGroup[]).length} groups
        </p>
      </header>

      {(CATALOG as CatalogGroup[]).map((group) => (
        <section key={group.heading} className="mb-10">
          <h2 className="text-xl font-semibold mb-3 text-white">{group.heading}</h2>
          <div className="space-y-3">
            {group.entries.map((entry) => {
              const show = resolved.get(entry.slug);
              const missing = !show;
              return (
                <div
                  key={entry.slug}
                  data-catalog-entry={entry.slug}
                  className={`card p-4 ${missing ? 'border-rose-500/40' : ''}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="text-lg font-semibold text-white truncate">
                          {entry.label}{' '}
                          <span className="text-white/40 font-mono text-sm">{entry.slug}</span>
                        </h3>
                        {missing && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300 border border-rose-500/30">
                            MISSING IN shows.json
                          </span>
                        )}
                      </div>
                      <p className="text-white/70 text-sm mb-2">{entry.why}</p>
                      <ul className="text-white/60 text-xs list-disc list-inside space-y-0.5">
                        {entry.focus.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </div>
                    <Link
                      href={`/show/${entry.slug}`}
                      className="shrink-0 inline-flex items-center px-3 py-1.5 text-sm rounded-md bg-white/10 hover:bg-white/15 text-white border border-white/10"
                      target="_blank"
                      rel="noopener"
                    >
                      Open →
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <footer className="mt-12 pt-6 border-t border-white/10 text-white/50 text-sm">
        To regenerate screenshots:{' '}
        <code className="text-amber-300">
          npm run dev &amp;&amp; node scripts/capture-show-page-catalog.mjs
        </code>
      </footer>
    </main>
  );
}
