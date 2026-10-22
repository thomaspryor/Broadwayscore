import Link from 'next/link';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`font-extrabold tracking-tight ${className}`}>
      <span className="text-ink">Tech</span><span className="text-brand-logo">Scorecard</span>
      <span className="align-top text-[0.35em] font-semibold text-ink-faint">™</span>
    </span>
  );
}

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Tech Scorecard home"><Logo className="text-2xl sm:text-[28px]" /></Link>
        <nav className="flex items-center gap-4 whitespace-nowrap text-sm font-medium text-ink-muted sm:gap-5">
          <Link href="/" className="hover:text-ink">Phones</Link>
          <Link href="/methodology/" className="hover:text-ink">Methodology</Link>
        </nav>
      </div>
    </header>
  );
}
