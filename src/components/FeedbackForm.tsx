'use client';

import { useState, FormEvent } from 'react';

type FormStatus = 'idle' | 'submitting' | 'success' | 'error';

export default function FeedbackForm({ endpoint }: { endpoint: string }) {
  const [status, setStatus] = useState<FormStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!endpoint) {
      setStatus('error');
      setErrorMessage('Feedback form is not configured. Please try again later.');
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
        <h3 className="text-2xl font-bold text-gray-900 mb-2">Thank You!</h3>
        <p className="text-gray-600 mb-6">
          Your feedback has been received. We appreciate you helping improve Broadway Scorecard.
        </p>
        <button
          onClick={() => setStatus('idle')}
          className="text-purple-600 hover:text-purple-700 font-medium"
        >
          Submit another response
        </button>
      </div>
    );
  }

  const inputClasses = 'w-full px-4 py-3 border border-gray-300 rounded-lg text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-purple-600 focus:border-transparent';

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Name */}
      <div>
        <label htmlFor="name" className="block text-sm font-semibold text-gray-900 mb-2">
          Name (optional)
        </label>
        <input
          type="text"
          id="name"
          name="name"
          className={inputClasses}
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
          className={inputClasses}
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
          className={inputClasses}
          required
          defaultValue=""
        >
          <option value="" disabled>Select a category...</option>
          <option value="bug">Bug Report</option>
          <option value="feature">Feature Request</option>
          <option value="content-error">Content Error</option>
          <option value="praise">Praise</option>
          <option value="other">Other</option>
        </select>
      </div>

      {/* Show */}
      <div>
        <label htmlFor="show" className="block text-sm font-semibold text-gray-900 mb-2">
          Show Name (if applicable)
        </label>
        <input
          type="text"
          id="show"
          name="show"
          className={inputClasses}
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
          className={inputClasses}
          placeholder="Tell us more..."
          required
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
          {status === 'submitting' ? 'Sending...' : 'Send Feedback'}
        </button>
      </div>
    </form>
  );
}
