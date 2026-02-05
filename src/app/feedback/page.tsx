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
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
            We&apos;d Love Your Feedback
          </h1>
          <p className="text-xl text-gray-500">
            Help us improve Broadway Scorecard
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-10 mb-8">
          {/* Feedback Categories */}
          <section className="mb-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">What Can You Share?</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="flex items-start gap-3 p-4 bg-purple-50 rounded-lg">
                <span className="text-2xl">&#x1f41b;</span>
                <div>
                  <h3 className="font-semibold text-gray-900">Report a Bug</h3>
                  <p className="text-sm text-gray-500">Something not working right?</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-lg">
                <span className="text-2xl">&#x1f4a1;</span>
                <div>
                  <h3 className="font-semibold text-gray-900">Feature Request</h3>
                  <p className="text-sm text-gray-500">Ideas for new features</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-red-50 rounded-lg">
                <span className="text-2xl">&#x1f4dd;</span>
                <div>
                  <h3 className="font-semibold text-gray-900">Content Error</h3>
                  <p className="text-sm text-gray-500">Incorrect show data or scores</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-green-50 rounded-lg">
                <span className="text-2xl">&#x1f4ac;</span>
                <div>
                  <h3 className="font-semibold text-gray-900">General Feedback</h3>
                  <p className="text-sm text-gray-500">Thoughts, praise, or suggestions</p>
                </div>
              </div>
            </div>
          </section>

          {/* Feedback Form */}
          <FeedbackForm endpoint={process.env.NEXT_PUBLIC_FORMSPREE_ENDPOINT || ''} />
        </div>

        {/* Additional Info */}
        <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-10">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            Other Ways to Contribute
          </h2>

          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <span className="text-3xl">&#x1f4d6;</span>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">
                  <Link href="/submit-review" className="text-purple-600 hover:text-purple-700">
                    Submit Missing Reviews
                  </Link>
                </h3>
                <p className="text-gray-500 text-sm">
                  Help us expand our database by submitting professional critic reviews we might have missed
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <span className="text-3xl">&#x1f3ad;</span>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">
                  Spread the Word
                </h3>
                <p className="text-gray-500 text-sm">
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
            className="text-purple-600 hover:text-purple-700 font-medium inline-flex items-center gap-1"
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
