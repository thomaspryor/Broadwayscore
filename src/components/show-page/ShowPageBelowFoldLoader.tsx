'use client';

import { lazy, Suspense, Component, type ReactNode } from 'react';
import type { ShowPageBelowFoldProps } from './ShowPageBelowFold';
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

export default function ShowPageBelowFoldLoader(props: ShowPageBelowFoldProps) {
  return (
    <ErrorBoundary fallback={<ShowFAQSection faqs={props.faqs} />}>
      <Suspense fallback={null}>
        <ShowPageBelowFold {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
