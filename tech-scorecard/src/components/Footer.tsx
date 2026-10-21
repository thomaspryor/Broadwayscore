import Link from 'next/link';
import { Logo } from './Header';

export function Footer() {
  return (
    <footer className="mt-16 border-t border-line bg-surface-overlay">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 px-4 py-10 text-center text-sm text-ink-muted">
        <Logo className="text-xl" />
        <p>Every gadget. Every review. One score.</p>
        <p className="text-xs text-ink-faint">
          Proof of concept. Scores are tier-weighted averages of published reviews; excerpts link to the original articles.
          {' '}<Link href="/methodology/" className="underline underline-offset-2 hover:text-ink">Methodology</Link>
        </p>
      </div>
    </footer>
  );
}
