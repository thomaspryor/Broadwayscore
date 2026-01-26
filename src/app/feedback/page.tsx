import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Feedback | Broadway Scorecard',
  description: 'Share your feedback, report bugs, or suggest new features for Broadway Scorecard.',
};

const FORMSPREE_ENDPOINT = process.env.NEXT_PUBLIC_FORMSPREE_ENDPOINT || 'https://formspree.io/f/YOUR_FORM_ID';

export default function FeedbackPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-blue-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 sm:py-16">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 mb-4">
            We&apos;d Love Your Feedback
          </h1>
          <p className="text-xl text-gray-600">
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
                <span className="text-2xl">🐛</span>
                <div>
                  <h3 className="font-semibold text-gray-900">Report a Bug</h3>
                  <p className="text-sm text-gray-600">Something not working right?</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-blue-50 rounded-lg">
                <span className="text-2xl">💡</span>
                <div>
                  <h3 className="font-semibold text-gray-900">Feature Request</h3>
                  <p className="text-sm text-gray-600">Ideas for new features</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-red-50 rounded-lg">
                <span className="text-2xl">📝</span>
                <div>
                  <h3 className="font-semibold text-gray-900">Content Error</h3>
                  <p className="text-sm text-gray-600">Incorrect show data or scores</p>
                </div>
              </div>
              <div className="flex items-start gap-3 p-4 bg-green-50 rounded-lg">
                <span className="text-2xl">💬</span>
                <div>
                  <h3 className="font-semibold text-gray-900">General Feedback</h3>
                  <p className="text-sm text-gray-600">Thoughts, praise, or suggestions</p>
                </div>
              </div>
            </div>
          </section>

          {/* Feedback Form */}
          <form
            action={FORMSPREE_ENDPOINT}
            method="POST"
            className="space-y-6"
          >
            {/* Name */}
            <div>
              <label htmlFor="name" className="block text-sm font-semibold text-gray-900 mb-2">
                Name (optional)
              </label>
              <input
                type="text"
                id="name"
                name="name"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-transparent"
                placeholder="Your name"
              />
            </div>

            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-semibold text-gray-900 mb-2">
                Email (optional)
              </label>
              <input
                type="email"
                id="email"
                name="email"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-transparent"
                placeholder="your.email@example.com"
              />
              <p className="mt-1 text-xs text-gray-500">
                Only if you&apos;d like a response
              </p>
            </div>

            {/* Category */}
            <div>
              <label htmlFor="category" className="block text-sm font-semibold text-gray-900 mb-2">
                Category
              </label>
              <select
                id="category"
                name="category"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-transparent"
                required
              >
                <option value="">Select a category...</option>
                <option value="bug">🐛 Bug Report</option>
                <option value="feature">💡 Feature Request</option>
                <option value="content-error">📝 Content Error</option>
                <option value="praise">👏 Praise</option>
                <option value="other">💬 Other</option>
              </select>
            </div>

            {/* Show (optional, for content errors) */}
            <div>
              <label htmlFor="show" className="block text-sm font-semibold text-gray-900 mb-2">
                Show Name (if applicable)
              </label>
              <input
                type="text"
                id="show"
                name="show"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-transparent"
                placeholder="e.g., Hamilton, Wicked, etc."
              />
              <p className="mt-1 text-xs text-gray-500">
                For content errors or feature requests related to a specific show
              </p>
            </div>

            {/* Message */}
            <div>
              <label htmlFor="message" className="block text-sm font-semibold text-gray-900 mb-2">
                Message <span className="text-red-500">*</span>
              </label>
              <textarea
                id="message"
                name="message"
                rows={6}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-600 focus:border-transparent"
                placeholder="Tell us more..."
                required
              />
            </div>

            {/* Hidden honeypot field for spam protection */}
            <input type="text" name="_gotcha" style={{ display: 'none' }} />

            {/* Submit Button */}
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                <span className="text-red-500">*</span> Required fields
              </p>
              <button
                type="submit"
                className="px-8 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-lg hover:from-purple-700 hover:to-blue-700 transition-all shadow-lg hover:shadow-xl"
              >
                Send Feedback
              </button>
            </div>
          </form>
        </div>

        {/* Additional Info */}
        <div className="bg-white rounded-2xl shadow-xl p-8 sm:p-10">
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            Other Ways to Contribute
          </h2>

          <div className="space-y-4">
            <div className="flex items-start gap-4">
              <span className="text-3xl">📖</span>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">
                  <Link href="/submit-review" className="text-purple-600 hover:text-purple-700">
                    Submit Missing Reviews
                  </Link>
                </h3>
                <p className="text-gray-600 text-sm">
                  Help us expand our database by submitting professional critic reviews we might have missed
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <span className="text-3xl">💻</span>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">
                  <a
                    href="https://github.com/thomaspryor/Broadwayscore"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-600 hover:text-purple-700"
                  >
                    Contribute on GitHub
                  </a>
                </h3>
                <p className="text-gray-600 text-sm">
                  This is an open-source project. View the code, report issues, or contribute improvements
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <span className="text-3xl">🎭</span>
              <div>
                <h3 className="font-semibold text-gray-900 mb-1">
                  Spread the Word
                </h3>
                <p className="text-gray-600 text-sm">
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
