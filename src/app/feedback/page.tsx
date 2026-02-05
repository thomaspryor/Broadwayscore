import type { Metadata } from 'next';
import Link from 'next/link';
import FeedbackForm from '@/components/FeedbackForm';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Feedback & Bug Reports | Broadway Scorecard',
  description: 'Share your feedback, report bugs, or suggest new features for Broadway Scorecard.',
  alternates: {
    canonical: `${BASE_URL}/feedback`,
  },
};

export default function FeedbackPage() {
  return (
    <div>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-4">
            We&apos;d Love Your Feedback
          </h1>
          <p className="text-lg text-gray-400">
            Help us improve Broadway Scorecard
          </p>
        </div>

        {/* Main Card */}
        <div className="card p-6 sm:p-8 mb-6">
          {/* Feedback Categories */}
          <section className="mb-8">
            <h2 className="text-2xl font-bold text-white mb-4">What Can You Share?</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="flex items-start gap-3 p-4 bg-purple-500/10 border border-purple-500/20 rounded-lg">
                <span className="text-2xl">&#x1f41b;</span>
                <div>
                  <h3 className="font-semibold text-white">Report a Bug</h3>
                  <p className="text-sm text-gray-400">Something not working right?</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                <span className="text-2xl">&#x1f4a1;</span>
                <div>
                  <h3 className="font-semibold text-white">Feature Request</h3>
                  <p className="text-sm text-gray-400">Ideas for new features</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                <span className="text-2xl">&#x1f4dd;</span>
                <div>
                  <h3 className="font-semibold text-white">Content Error</h3>
                  <p className="text-sm text-gray-400">Incorrect show data or scores</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                <span className="text-2xl">&#x1f4ac;</span>
                <div>
                  <h3 className="font-semibold text-white">General Feedback</h3>
                  <p className="text-sm text-gray-400">Thoughts, praise, or suggestions</p>
                </div>
              </div>
            </div>
          </section>

          {/* Feedback Form */}
          <FeedbackForm endpoint={process.env.NEXT_PUBLIC_FORMSPREE_ENDPOINT || 'https://formspree.io/f/mojdjwqo'} />
        </div>

        {/* Additional Info */}
        <div className="card p-6 sm:p-8">
          <h2 className="text-2xl font-bold text-white mb-6">
            Other Ways to Contribute
          </h2>

          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <span className="text-3xl">&#x1f4d6;</span>
              <div>
                <h3 className="font-semibold text-white mb-1">
                  <Link href="/submit-review" className="text-purple-400 hover:text-purple-300">
                    Submit Missing Reviews
                  </Link>
                </h3>
                <p className="text-gray-400 text-sm">
                  Help us expand our database by submitting professional critic reviews we might have missed
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <span className="text-3xl">&#x1f3ad;</span>
              <div>
                <h3 className="font-semibold text-white mb-1">
                  Spread the Word
                </h3>
                <p className="text-gray-400 text-sm">
                  Share Broadway Scorecard with fellow theater fans and help grow the community
                </p>
              </div>
            </div>
          </div>
        </div>

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
