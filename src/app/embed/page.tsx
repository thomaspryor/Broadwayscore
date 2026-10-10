import type { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL } from '@/lib/seo';

// Reachable by URL but intentionally not linked from main nav while we test outreach.
export const metadata: Metadata = {
  title: 'Embed a CriticScore badge · Broadway Scorecard',
  description:
    'Free embeddable CriticScore badge for any Broadway, Off-Broadway, or West End show. Paste one line of HTML. Auto light/dark, links back, no tracking.',
  alternates: { canonical: `${BASE_URL}/embed` },
  robots: { index: false, follow: true },
};

function Snippet({
  slug = 'hamilton',
  theme = 'auto',
}: {
  slug?: string;
  theme?: 'auto' | 'light' | 'dark';
}) {
  const code = `<iframe src="https://broadwayscorecard.com/embed/${slug}?theme=${theme}" width="280" height="120" frameborder="0" loading="lazy" title="CriticScore — ${slug}"></iframe>`;
  return (
    <pre className="text-xs sm:text-sm bg-black/60 border border-white/10 rounded-lg p-4 overflow-x-auto text-gray-200 font-mono">
      {code}
    </pre>
  );
}

export default function EmbedDocsPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <header className="mb-10">
        <div className="text-xs uppercase tracking-wider text-amber-300 mb-3">
          Developer / Producer Tool
        </div>
        <h1 className="text-3xl sm:text-5xl font-bold text-white tracking-tight">
          Embed a CriticScore badge
        </h1>
        <p className="text-lg text-gray-300 mt-5 leading-relaxed">
          Free embeddable CriticScore badge for any Broadway, Off-Broadway, or West End
          show. Paste one line of HTML on a producer site, blog post, or Substack and the
          badge stays in sync with the live score on broadwayscorecard.com. No JavaScript
          API, no tracking, no key required.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-white mb-3">Auto (light or dark, follows reader)</h2>
        <p className="text-gray-300 mb-4 text-sm">
          Recommended. Renders as dark on dark sites, light on light. Default.
        </p>
        <Snippet slug="hamilton" theme="auto" />
        <div className="mt-4 border border-white/10 rounded-lg overflow-hidden bg-black/40">
          <iframe
            src="/embed/hamilton?theme=auto"
            width="280"
            height="120"
            frameBorder="0"
            loading="lazy"
            title="CriticScore — Hamilton"
          />
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-white mb-3">Dark mode (forced)</h2>
        <p className="text-gray-300 mb-4 text-sm">
          For dark backgrounds when auto-detection can&apos;t see your CSS.
        </p>
        <Snippet slug="hamilton" theme="dark" />
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-white mb-3">Light mode (forced)</h2>
        <p className="text-gray-300 mb-4 text-sm">
          For light backgrounds when auto-detection can&apos;t see your CSS.
        </p>
        <Snippet slug="hamilton" theme="light" />
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-white mb-3">Find your show&apos;s slug</h2>
        <p className="text-gray-300 leading-relaxed text-sm">
          The embed uses the show&apos;s short-form slug. For Hamilton the show page is{' '}
          <code className="text-amber-300">broadwayscorecard.com/show/hamilton-2015</code>{' '}
          but the embed slug is just <code className="text-amber-300">hamilton</code>.
          Browse{' '}
          <Link href="/" className="text-amber-300 underline">
            broadwayscorecard.com
          </Link>{' '}
          to find any show. If an embed returns &ldquo;Show not found,&rdquo; reach out and we&apos;ll
          add the alias.
        </p>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold text-white mb-3">Frequently asked questions</h2>
        <div className="space-y-5 text-sm">
          <div>
            <div className="text-white font-medium mb-1">Is it really free?</div>
            <div className="text-gray-300 leading-relaxed">
              Yes. Free forever for any non-commercial or editorial use. Producers,
              blogs, fan sites, Substacks, Reddit communities, paste away. No attribution
              required (though appreciated; the badge already links back).
            </div>
          </div>
          <div>
            <div className="text-white font-medium mb-1">Does it stay up to date?</div>
            <div className="text-gray-300 leading-relaxed">
              Yes. The badge is server-rendered from the same data that powers
              broadwayscorecard.com, with a 1-hour cache. New reviews drop the score
              automatically.
            </div>
          </div>
          <div>
            <div className="text-white font-medium mb-1">Does it track visitors?</div>
            <div className="text-gray-300 leading-relaxed">
              No. The iframe sets no cookies and runs no JavaScript on the parent page.
              The iframe itself fetches the badge once per pageview from Vercel&apos;s CDN.
            </div>
          </div>
          <div>
            <div className="text-white font-medium mb-1">Can I customize the size?</div>
            <div className="text-gray-300 leading-relaxed">
              The badge is designed at 280×120 px. You can resize the iframe within
              reason (240-360 wide, 100-160 tall), but smaller sizes will clip the show
              title.
            </div>
          </div>
          <div>
            <div className="text-white font-medium mb-1">What if I want a script-tag version?</div>
            <div className="text-gray-300 leading-relaxed">
              The iframe is the version we support. A script-tag version that injects
              HTML directly would require us to set CORS headers and add a JS bundle. We
              can build it if there&apos;s demand. Email{' '}
              <a href="mailto:thomas.pryor@gmail.com" className="text-amber-300 underline">
                thomas.pryor@gmail.com
              </a>
              .
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 pt-6 text-sm text-gray-400 leading-relaxed">
        <p>
          The badge always links back to the show detail page on broadwayscorecard.com,
          which is the canonical record. CriticScore methodology:{' '}
          <Link href="/methodology" className="text-amber-300 underline">
            /methodology
          </Link>
          . Questions or partnership requests:{' '}
          <a href="mailto:thomas.pryor@gmail.com" className="text-amber-300 underline">
            thomas.pryor@gmail.com
          </a>
          .
        </p>
      </section>
    </main>
  );
}
