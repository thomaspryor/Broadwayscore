'use client';

import { useState, FormEvent } from 'react';

type FormStatus = 'idle' | 'submitting' | 'success' | 'error';

export default function SubmitReviewForm({ endpoint }: { endpoint: string }) {
  const [status, setStatus] = useState<FormStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!endpoint) {
      setStatus('error');
      setErrorMessage('Review submission form is not configured. Please try again later.');
      return;
    }

    setStatus('submitting');
    setErrorMessage('');

    const form = e.currentTarget;
    const data = new FormData(form);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: data,
        headers: { Accept: 'application/json' },
      });

      if (res.ok) {
        setStatus('success');
        form.reset();
      } else {
        const json = await res.json().catch(() => null);
        setStatus('error');
        setErrorMessage(json?.errors?.[0]?.message || 'Something went wrong. Please try again.');
      }
    } catch {
      setStatus('error');
      setErrorMessage('Network error. Please check your connection and try again.');
    }
  }

  if (status === 'success') {
    return (
      <div className="text-center py-12">
        <div className="text-5xl mb-4">&#10003;</div>
        <h3 className="text-2xl font-bold text-gray-900 mb-2">Review Submitted!</h3>
        <p className="text-gray-600 mb-2">
          Thank you for helping expand our database.
        </p>
        <p className="text-gray-500 text-sm mb-6">
          Our system will validate and process your submission. If approved, the review will appear on the site automatically.
        </p>
        <button
          onClick={() => setStatus('idle')}
          className="text-purple-600 hover:text-purple-700 font-medium"
        >
          Submit another review
        </button>
      </div>
    );
  }

  const inputClasses = 'w-full px-4 py-3 border border-gray-300 rounded-lg text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-purple-600 focus:border-transparent';

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Review URL */}
      <div>
        <label htmlFor="review_url" className="block text-sm font-semibold text-gray-900 mb-2">
          Review URL <span className="text-red-500">*</span>
        </label>
        <input
          type="url"
          id="review_url"
          name="review_url"
          className={inputClasses}
          placeholder="https://www.nytimes.com/2024/04/25/theater/..."
          required
        />
        <p className="mt-1 text-xs text-gray-500">
          The full URL of the review article
        </p>
      </div>

      {/* Show Name */}
      <div>
        <label htmlFor="show_name" className="block text-sm font-semibold text-gray-900 mb-2">
          Show Name
        </label>
        <input
          type="text"
          id="show_name"
          name="show_name"
          className={inputClasses}
          placeholder="Hamilton, Wicked, Stereophonic, etc."
        />
        <p className="mt-1 text-xs text-gray-500">
          Optional &mdash; we&apos;ll auto-detect if not provided
        </p>
      </div>

      {/* Outlet Name */}
      <div>
        <label htmlFor="outlet_name" className="block text-sm font-semibold text-gray-900 mb-2">
          Outlet Name
        </label>
        <input
          type="text"
          id="outlet_name"
          name="outlet_name"
          className={inputClasses}
          placeholder="The New York Times, Variety, Vulture, etc."
        />
        <p className="mt-1 text-xs text-gray-500">
          Optional &mdash; we&apos;ll auto-detect if not provided
        </p>
      </div>

      {/* Critic Name */}
      <div>
        <label htmlFor="critic_name" className="block text-sm font-semibold text-gray-900 mb-2">
          Critic Name
        </label>
        <input
          type="text"
          id="critic_name"
          name="critic_name"
          className={inputClasses}
          placeholder="Jesse Green, Naveen Kumar, etc."
        />
        <p className="mt-1 text-xs text-gray-500">
          Optional &mdash; we&apos;ll auto-detect if not provided
        </p>
      </div>

      {/* Additional Notes */}
      <div>
        <label htmlFor="notes" className="block text-sm font-semibold text-gray-900 mb-2">
          Additional Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          className={inputClasses}
          placeholder="Any context that might be helpful..."
        />
      </div>

      {/* Honeypot */}
      <input type="text" name="_gotcha" style={{ display: 'none' }} tabIndex={-1} autoComplete="off" />

      {/* Error message */}
      {status === 'error' && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {errorMessage}
        </div>
      )}

      {/* Submit */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          <span className="text-red-500">*</span> Required fields
        </p>
        <button
          type="submit"
          disabled={status === 'submitting'}
          className="px-8 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white font-semibold rounded-lg hover:from-purple-700 hover:to-blue-700 transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === 'submitting' ? 'Submitting...' : 'Submit Review'}
        </button>
      </div>
    </form>
  );
}
