import type { Metadata } from 'next';
import Link from 'next/link';
import { BASE_URL } from '@/lib/seo';
import { BuyMeACoffeeWidget } from '@/components/BuyMeACoffeeWidget';

export const metadata: Metadata = {
  title: 'About',
  description: 'Broadway Scorecard is a one-person, independent project aggregating Broadway reviews. Always free, no ads, no paywalls.',
  alternates: {
    canonical: `${BASE_URL}/about`,
  },
};

export default function AboutPage() {
  return (
    <div>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-4">
            About Broadway Scorecard™
          </h1>
        </div>

        {/* Main Card */}
        <div className="card p-6 sm:p-8 mb-6">
          <div className="space-y-5 text-gray-300 leading-relaxed text-lg">
            <p>
              I&apos;m Tom &mdash; I built Broadway Scorecard™ because I see 60+ shows a year and got tired
              of not having a single place to compare reviews across critics.
            </p>
            <p>
              Every show is scored using a weighted system that analyzes reviews from major critics
              and publications. It&apos;s a one-person project, completely independent, and it&apos;ll
              always be free &mdash; no ads, no paywalls.
            </p>
            <p>
              Have feedback or ideas? Use the{' '}
              <Link href="/feedback" className="text-brand hover:text-brand-hover underline underline-offset-2 transition-colors">
                Submit Feedback
              </Link>
              {' '}button to let me know.
            </p>
          </div>
        </div>

        {/* Buy Me a Coffee */}
        <BuyMeACoffeeWidget />

        {/* Back Link */}
        <div className="text-center mt-8">
          <Link
            href="/"
            className="text-purple-400 hover:text-purple-300 font-medium inline-flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
