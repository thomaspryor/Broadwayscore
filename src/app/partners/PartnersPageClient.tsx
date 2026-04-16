'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { PartnerShowOption } from './page';

interface Props {
  shows: PartnerShowOption[];
  baseUrl: string;
}

type Theme = 'auto' | 'light' | 'dark';

function CopyBlock({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // silent
    }
  };
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="text-xs text-brand hover:text-brand-light transition-colors font-medium"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="bg-surface-raised border border-white/5 rounded-card p-4 overflow-x-auto text-xs text-gray-300 font-mono leading-relaxed whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function PartnersPageClient({ shows, baseUrl }: Props) {
  const [query, setQuery] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    shows.find(s => s.hasEnoughReviews && s.status === 'open')?.slug ?? shows[0]?.slug ?? null
  );
  const [theme, setTheme] = useState<Theme>('auto');
  const [utmSource, setUtmSource] = useState('');

  const filteredShows = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return shows.slice(0, 50);
    return shows.filter(s => s.title.toLowerCase().includes(q)).slice(0, 50);
  }, [shows, query]);

  const selected = useMemo(
    () => shows.find(s => s.slug === selectedSlug) ?? null,
    [shows, selectedSlug],
  );

  const utmQuery = utmSource
    ? `?utm_source=${encodeURIComponent(utmSource)}&utm_medium=badge&utm_campaign=partner`
    : '';
  const themeQuery = theme !== 'auto' ? `${utmQuery ? '&' : '?'}theme=${theme}` : '';

  // Absolute URLs for copy-paste snippets (partners will use these on external sites).
  const badgeUrl = selected ? `${baseUrl}/api/badge/${selected.slug}` : '';
  const embedUrl = selected ? `${baseUrl}/embed/${selected.slug}${utmQuery}${themeQuery}` : '';
  const showUrl = selected ? `${baseUrl}/show/${selected.slug}${utmQuery}` : '';
  // Relative URLs for the live preview on this page (so it works locally and in previews
  // before production has the endpoint, and always uses the current deployment's version).
  const previewBadgeUrl = selected ? `/api/badge/${selected.slug}` : '';
  const previewEmbedUrl = selected ? `/embed/${selected.slug}${utmQuery}${themeQuery}` : '';

  const iframeSnippet = selected
    ? `<iframe
  src="${embedUrl}"
  width="360" height="96"
  frameborder="0"
  scrolling="no"
  title="${selected.title} — CriticScore by Broadway Scorecard"
  style="border:0;max-width:100%;"
  loading="lazy"
></iframe>`
    : '';

  const svgSnippet = selected
    ? `<a href="${showUrl}" target="_blank" rel="noopener">
  <img
    src="${badgeUrl}"
    alt="${selected.title} — CriticScore by Broadway Scorecard"
    width="280" height="100"
    style="max-width:100%;height:auto;"
  />
</a>`
    : '';

  const linkSnippet = selected
    ? `<a href="${showUrl}">${selected.title} on Broadway Scorecard</a>`
    : '';

  return (
    <div className="min-h-screen bg-surface text-white">
      {/* Hero */}
      <section className="border-b border-white/5 px-4 py-16 sm:py-20">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand mb-4">Partner Embeds</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold mb-4">
            Put <span className="text-gradient">CriticScore</span> on your site
          </h1>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Free badges and embeds for any Broadway or West End show. Copy-paste a single line.
            Scores stay fresh automatically — badges update whenever critics post new reviews.
          </p>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-4 py-12 space-y-16">
        {/* Step 1: Pick a show */}
        <section>
          <h2 className="text-2xl font-bold text-white mb-2">1. Pick a show</h2>
          <p className="text-gray-400 mb-5 text-sm">Choose any currently-running Broadway or West End production.</p>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search shows..."
            className="w-full sm:w-96 px-4 py-2.5 bg-surface-raised border border-white/10 rounded-card text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50 mb-4"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto border border-white/5 rounded-card p-2 bg-surface-raised/30">
            {filteredShows.map(show => {
              const isSelected = show.slug === selectedSlug;
              return (
                <button
                  key={show.id}
                  type="button"
                  onClick={() => setSelectedSlug(show.slug)}
                  className={`text-left px-3 py-2 rounded-card border transition-colors ${
                    isSelected
                      ? 'bg-brand/10 border-brand/60 text-white'
                      : 'bg-surface-raised border-white/5 hover:border-white/20 text-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">{show.title}</div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-wide">
                        {show.category === 'west-end' ? 'West End' : show.category === 'off-broadway' ? 'Off-Broadway' : 'Broadway'} · {show.status}
                      </div>
                    </div>
                    {show.hasEnoughReviews && show.score != null && (
                      <span className="text-sm font-bold text-brand">{show.score}</span>
                    )}
                  </div>
                </button>
              );
            })}
            {filteredShows.length === 0 && (
              <div className="col-span-full text-center text-gray-500 text-sm py-6">No shows match.</div>
            )}
          </div>
        </section>

        {/* Step 2: Options */}
        {selected && (
          <>
            <section>
              <h2 className="text-2xl font-bold text-white mb-2">2. Customize (optional)</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    Theme (iframe only)
                  </label>
                  <div className="flex gap-2">
                    {(['auto', 'light', 'dark'] as Theme[]).map(t => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTheme(t)}
                        className={`px-4 py-2 rounded-card text-sm font-semibold border transition-colors ${
                          theme === t
                            ? 'bg-brand/20 border-brand text-white'
                            : 'bg-surface-raised border-white/5 hover:border-white/20 text-gray-300'
                        }`}
                      >
                        {t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-2">Auto matches your site&apos;s color scheme.</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
                    UTM source (optional)
                  </label>
                  <input
                    type="text"
                    value={utmSource}
                    onChange={e => setUtmSource(e.target.value.replace(/[^a-z0-9_-]/gi, ''))}
                    placeholder="e.g. understudies"
                    className="w-full px-3 py-2 bg-surface-raised border border-white/10 rounded-card text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand/50 text-sm"
                  />
                  <p className="text-[11px] text-gray-500 mt-2">Tags click-throughs so we can see what traffic you drive.</p>
                </div>
              </div>
            </section>

            {/* Step 3: Preview */}
            <section>
              <h2 className="text-2xl font-bold text-white mb-2">3. Preview</h2>
              <p className="text-gray-400 mb-5 text-sm">Live preview — this is exactly what visitors will see.</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-surface-raised border border-white/5 rounded-card p-6">
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Iframe (interactive, themeable)</div>
                  <iframe
                    src={previewEmbedUrl}
                    width={360}
                    height={96}
                    frameBorder={0}
                    scrolling="no"
                    title={`${selected.title} — CriticScore`}
                    style={{ border: 0, maxWidth: '100%' }}
                    loading="lazy"
                  />
                </div>
                <div className="bg-surface-raised border border-white/5 rounded-card p-6">
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">SVG (lightweight, static)</div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={previewBadgeUrl}
                    alt={`${selected.title} — CriticScore`}
                    width={280}
                    height={100}
                    style={{ maxWidth: '100%', height: 'auto' }}
                  />
                </div>
              </div>
            </section>

            {/* Step 4: Copy-paste */}
            <section>
              <h2 className="text-2xl font-bold text-white mb-2">4. Copy the snippet</h2>
              <p className="text-gray-400 mb-5 text-sm">Paste anywhere — your CMS, Webflow, plain HTML, a blog post.</p>
              <CopyBlock label="Iframe (recommended — themeable, interactive)" code={iframeSnippet} />
              <CopyBlock label="SVG image (simplest — drop-in as any image)" code={svgSnippet} />
              <CopyBlock label="Plain link (for emails, newsletters)" code={linkSnippet} />
            </section>
          </>
        )}

        {/* Attribution + terms */}
        <section className="border-t border-white/5 pt-10">
          <h2 className="text-2xl font-bold text-white mb-2">Rules of the road</h2>
          <div className="space-y-4 text-sm text-gray-300 leading-relaxed max-w-3xl">
            <p>
              <strong className="text-white">Attribution is required.</strong> The badge and iframe both include
              &ldquo;CriticScore™ by Broadway Scorecard&rdquo; text — don&apos;t remove or obscure it. That text
              must link back to{' '}
              <Link href="/" className="text-brand hover:text-brand-light">broadwayscorecard.com</Link> (the embed
              already does this for you).
            </p>
            <p>
              <strong className="text-white">The score, tier name, and color must stay together.</strong> Don&apos;t
              show just the number in your site&apos;s font color or strip the tier label — the meaning comes from
              the full unit.
            </p>
            <p>
              <strong className="text-white">Don&apos;t modify the values.</strong> Don&apos;t normalize to your own
              scale, round differently, or show stale scores. Use the live embed — it updates automatically.
            </p>
            <p>
              <strong className="text-white">Scores are aggregated critic reviews only</strong> (not audience
              scores). Minimum 5 reviews for Broadway, 3 for Off-Broadway — shows below that show as &ldquo;TBD.&rdquo;
            </p>
            <p>
              Full terms are in our <Link href="/terms" className="text-brand hover:text-brand-light">Terms of Service</Link>.
              Brand assets and colors are on the <Link href="/brand" className="text-brand hover:text-brand-light">Brand page</Link>.
              Questions? <a href="mailto:hello@broadwayscorecard.com" className="text-brand hover:text-brand-light">Email us</a>.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
