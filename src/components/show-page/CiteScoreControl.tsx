'use client';

// Quiet "Cite this score" control for the show-page hero (BRO-5982). Copies a
// citation built by buildCitation() so writers can credit and link the score
// without asking us. Renders nothing when the badge would read TBD.
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { shareOrCopy } from '@/lib/share-link';
import { trackUgc } from '@/lib/ugc-analytics';
import { buildCitation, getCitableScore } from '@/lib/cite-score';
import type { ComputedShowWithReviews, ComputedReview } from '@/lib/engine';

type Status = 'idle' | 'copied' | 'failed';

export default function CiteScoreControl({ show, className = '' }: { show: ComputedShowWithReviews<Pick<ComputedReview, 'reviewScore'>>; className?: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const [text, setText] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const citable = getCitableScore(show);
  if (!citable) return null;

  async function copy() {
    if (!citable) return;
    const citation = buildCitation(citable, new Date());
    // writeText only: the native share sheet would receive the sentence as a "url".
    const writeText = typeof navigator !== 'undefined' && navigator.clipboard?.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : undefined;
    const outcome = await shareOrCopy({ title: citable.title, url: citation }, { writeText });
    if (outcome === 'copied') {
      trackUgc('cite_score_copied', { slug: citable.slug });
      setStatus('copied');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus('idle'), 2500);
    } else {
      setText(citation);
      setStatus('failed');
    }
  }

  return (
    <div className={`text-xs text-fg-muted ${className}`} data-testid="cite-score">
      <button
        type="button"
        onClick={copy}
        className="inline-block py-1.5 underline underline-offset-2 decoration-white/10 hover:text-brand transition-colors"
      >
        Cite this score
      </button>
      <span aria-hidden="true"> · </span>
      <Link href="/partners" className="inline-block py-1.5 underline underline-offset-2 decoration-white/10 hover:text-brand transition-colors">
        Badge &amp; embed
      </Link>
      <span role="status" className="ml-2 text-gray-400">
        {status === 'copied' ? 'Citation copied' : status === 'failed' ? 'Copy failed. Select the text below.' : ''}
      </span>
      {status === 'failed' && (
        <p className="mt-1 select-all break-words text-gray-400" data-testid="cite-score-fallback">{text}</p>
      )}
    </div>
  );
}
