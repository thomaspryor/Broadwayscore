import type { Metadata } from 'next';
import Link from 'next/link';
import SubmitReviewForm from '@/components/SubmitReviewForm';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Submit a Missing Broadway Review | Broadway Scorecard',
  description: 'Help us expand our database by submitting missing Broadway reviews from professional critics.',
  alternates: {
    canonical: `${BASE_URL}/submit-review`,
  },
};

export default function SubmitReviewPage() {
  return (
    <div>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-white mb-4">
            Submit a Missing Review
          </h1>
          <p className="text-lg text-gray-400">
            Help us expand our database by contributing professional critic reviews
          </p>
        </div>

        {/* Main Card */}
        <div className="card p-6 sm:p-8 mb-6">
          {/* What We're Looking For */}
          <section className="mb-10">
            <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-2xl">&#10003;</span>
              What We&apos;re Looking For
            </h2>
            <ul className="space-y-3 text-gray-300">
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 font-bold mt-1">&#10003;</span>
                <span><strong className="text-white">Professional critic reviews</strong> from established outlets (The New York Times, Variety, Vulture, TheaterMania, etc.)</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 font-bold mt-1">&#10003;</span>
                <span><strong className="text-white">Broadway shows only</strong> (not Off-Broadway, touring, or regional productions)</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-emerald-400 font-bold mt-1">&#10003;</span>
                <span><strong className="text-white">Original reviews</strong> (not aggregator pages, roundups, or listicles)</span>
              </li>
            </ul>
          </section>

          {/* What Happens Next */}
          <section className="mb-10">
            <h2 className="text-2xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-2xl">&#9889;</span>
              What Happens Next
            </h2>
            <ol className="space-y-3 text-gray-300">
              <li className="flex items-start gap-3">
                <span className="bg-purple-500/20 text-purple-400 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
                <span>You submit the review URL using the form below</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="bg-purple-500/20 text-purple-400 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
                <span>Our automated system validates the submission using AI</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="bg-purple-500/20 text-purple-400 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">3</span>
                <span>If approved, the review is automatically scraped and added to our database</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="bg-purple-500/20 text-purple-400 font-bold rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5">4</span>
                <span>The show&apos;s score is recalculated with the new review included</span>
              </li>
            </ol>
          </section>

          {/* Review Submission Form */}
          <SubmitReviewForm endpoint={process.env.NEXT_PUBLIC_FORMSPREE_REVIEW_ENDPOINT || 'https://formspree.io/f/mpqjawag'} />
        </div>

        {/* FAQ Section */}
        <div className="card p-6 sm:p-8">
          <h2 className="text-2xl font-bold text-white mb-6">
            Frequently Asked Questions
          </h2>

          <div className="space-y-6">
            <div>
              <h3 className="font-semibold text-white mb-2">
                What if the review is paywalled?
              </h3>
              <p className="text-gray-400">
                That&apos;s fine! We have subscriptions to major outlets (NYT, Vulture) and use specialized scraping tools for others.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-white mb-2">
                How do I know if a review is already in your database?
              </h3>
              <p className="text-gray-400">
                Check the show&apos;s page on Broadway Scorecard. Each scored review is listed with its source. If you don&apos;t see it, submit it!
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-white mb-2">
                What if my submission is rejected?
              </h3>
              <p className="text-gray-400">
                Common reasons include: the review is already in our database, the show is not a Broadway production, or the source is not a recognized professional outlet.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-white mb-2">
                Can I submit multiple reviews at once?
              </h3>
              <p className="text-gray-400">
                Please submit one review per form. You can submit multiple times if you have several reviews to add.
              </p>
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
