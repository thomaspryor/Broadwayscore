'use client';

import { lazy, Suspense, Component, useEffect, useState, type ReactNode } from 'react';
import type { ShowBelowFoldDeferred, ShowPageBelowFoldInlineProps } from './ShowPageBelowFold';
import ShowFAQSection from './ShowFAQSection';

const ShowPageBelowFold = lazy(() => import('./ShowPageBelowFold'));

/**
 * Blanks the whole below-fold chunk if any card in it throws, rather than
 * taking the page down. The `fallback` is what still renders in that case —
 * page.tsx emits FAQPage JSON-LD unconditionally, so the Q&A block has to
 * survive here or the schema would advertise content that isn't on the page.
 */
class ErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// The show-only props (cast, related shows, awards, ...) arrive as
// /show/<slug>/below-fold.json instead of riding the inlined RSC payload
// (BRO-6278). The chunk is not server-rendered, so nothing visible moves.
export default function ShowPageBelowFoldLoader(props: ShowPageBelowFoldInlineProps) {
  const slug = props.show.slug;
  const [deferred, setDeferred] = useState<ShowBelowFoldDeferred | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/show/${encodeURIComponent(slug)}/below-fold.json`)
      .then(r => {
        if (!r.ok) throw new Error(`below-fold.json HTTP ${r.status}`);
        return r.json() as Promise<ShowBelowFoldDeferred>;
      })
      .then(data => { if (!cancelled) setDeferred(data); })
      .catch((e) => {
        console.error('Failed to load below-fold data:', e);
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [slug]);

  const faq = <ShowFAQSection faqs={props.faqs} />;
  if (failed) return faq;
  return (
    <ErrorBoundary fallback={faq}>
      <Suspense fallback={null}>
        {deferred && <ShowPageBelowFold {...props} {...deferred} />}
      </Suspense>
    </ErrorBoundary>
  );
}
