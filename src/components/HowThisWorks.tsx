import Link from 'next/link';

interface HowThisWorksProps {
  /** Brief explanation text */
  children: React.ReactNode;
  /** Optional custom heading */
  heading?: string;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Collapsible "How This Works" section for pages that display scores/rankings.
 * Provides a brief explanation with a link to the full methodology page.
 */
export default function HowThisWorks({ children, heading = 'How This Works', className = '' }: HowThisWorksProps) {
  return (
    <details className={`group rounded-xl border border-white/5 bg-surface-overlay ${className}`}>
      <summary className="p-4 sm:p-5 cursor-pointer text-sm font-semibold text-white uppercase tracking-wide hover:text-brand transition-colors list-none flex items-center justify-between">
        {heading}
        <svg
          className="w-4 h-4 text-gray-500 transition-transform group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </summary>
      <div className="px-4 sm:px-5 pb-4 sm:pb-5">
        <div className="text-sm text-gray-400 leading-relaxed">
          {children}
        </div>
        <Link href="/methodology" className="text-sm text-brand hover:text-brand-hover transition-colors mt-2 inline-block">
          Learn about our scoring methodology &rarr;
        </Link>
      </div>
    </details>
  );
}
