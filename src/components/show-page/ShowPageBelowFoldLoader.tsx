'use client';

import { lazy, Suspense, Component, type ReactNode } from 'react';
import type { ShowPageBelowFoldProps } from './ShowPageBelowFold';

const ShowPageBelowFold = lazy(() => import('./ShowPageBelowFold'));

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function ShowPageBelowFoldLoader(props: ShowPageBelowFoldProps) {
  return (
    <ErrorBoundary>
      <Suspense fallback={null}>
        <ShowPageBelowFold {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
