'use client';

import { useEffect, useRef, useState, FormEvent } from 'react';
import { getFirstInvalidField } from '@/lib/feedback-form-validation';

type FormStatus = 'idle' | 'submitting' | 'success' | 'error';

export default function FeedbackForm({ endpoint }: { endpoint: string }) {
  const [status, setStatus] = useState<FormStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [focusField, setFocusField] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const submittingRef = useRef(false);

  // Runs after the invalid field's aria-invalid/aria-describedby have committed to the
  // DOM, so a screen reader focusing the field picks up the error association immediately
  // instead of racing a synchronous focus() call against React's render.
  useEffect(() => {
    if (!focusField) return;
    const target = focusField === 'email' ? emailRef.current : focusField === 'category' ? categoryRef.current : focusField === 'message' ? messageRef.current : null;
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.focus();
    setFocusField(null);
  }, [focusField]);

  function clearFieldError(name: string) {
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (submittingRef.current) return;

    if (!endpoint) {
      setStatus('error');
      setErrorMessage('Feedback form is not configured. Please try again later.');
      return;
    }

    const form = e.currentTarget;
    const data = new FormData(form);

    const invalidField = getFirstInvalidField({
      email: String(data.get('email') || ''),
      category: String(data.get('category') || ''),
      message: String(data.get('message') || ''),
    });

    if (invalidField) {
      setFieldErrors({ [invalidField.name]: invalidField.message });
      setFocusField(invalidField.name);
      setStatus('idle');
      setErrorMessage('');
      return;
    }

    setFieldErrors({});
    setStatus('submitting');
    setErrorMessage('');
    submittingRef.current = true;

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
    } finally {
      submittingRef.current = false;
    }
  }

  if (status === 'success') {
    return (
      <div className="text-center py-12">
        <div className="text-5xl mb-4">&#10003;</div>
        <h3 className="text-2xl font-bold text-white mb-2">Thank You!</h3>
        <p className="text-gray-400 mb-6">
          Your feedback has been received. We appreciate you helping improve Broadway Scorecard.
        </p>
        <button
          onClick={() => setStatus('idle')}
          className="text-purple-400 hover:text-purple-300 font-medium"
        >
          Submit another response
        </button>
      </div>
    );
  }

  const inputClasses = 'w-full px-4 py-3 bg-surface-overlay border border-white/10 rounded-lg text-white placeholder:text-gray-500 focus:ring-2 focus:ring-purple-500 focus:border-transparent';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {/* Name */}
      <div>
        <label htmlFor="name" className="block text-sm font-semibold text-gray-200 mb-2">
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
        <label htmlFor="email" className="block text-sm font-semibold text-gray-200 mb-2">
          Email (optional)
        </label>
        <input
          type="email"
          id="email"
          name="email"
          ref={emailRef}
          className={`${inputClasses} ${fieldErrors.email ? 'border-red-500 ring-2 ring-red-500/50' : ''}`}
          placeholder="your.email@example.com"
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby="email-error"
          onChange={() => clearFieldError('email')}
        />
        <p id="email-error" role="alert" className="mt-1.5 text-sm text-red-400 empty:hidden">
          {fieldErrors.email}
        </p>
        <p className="mt-1 text-xs text-gray-500/70">
          Only if you&apos;d like a response
        </p>
      </div>

      {/* Category */}
      <div>
        <label htmlFor="category" className="block text-sm font-semibold text-gray-200 mb-2">
          Category <span className="text-red-500">*</span>
        </label>
        <select
          id="category"
          name="category"
          ref={categoryRef}
          required
          aria-required="true"
          className={`${inputClasses} ${fieldErrors.category ? 'border-red-500 ring-2 ring-red-500/50' : ''}`}
          aria-invalid={fieldErrors.category ? true : undefined}
          aria-describedby="category-error"
          defaultValue=""
          onChange={() => clearFieldError('category')}
        >
          <option value="" disabled>Select a category...</option>
          <option value="bug">Bug Report</option>
          <option value="feature">Feature Request</option>
          <option value="content-error">Content Error</option>
          <option value="praise">Praise</option>
          <option value="other">Other</option>
        </select>
        <p id="category-error" role="alert" className="mt-1.5 text-sm text-red-400 empty:hidden">
          {fieldErrors.category}
        </p>
      </div>

      {/* Show */}
      <div>
        <label htmlFor="show" className="block text-sm font-semibold text-gray-200 mb-2">
          Show Name (if applicable)
        </label>
        <input
          type="text"
          id="show"
          name="show"
          className={inputClasses}
          placeholder="e.g., Hamilton, Wicked, etc."
        />
        <p className="mt-1 text-xs text-gray-500/70">
          For content errors or feature requests related to a specific show
        </p>
      </div>

      {/* Message */}
      <div>
        <label htmlFor="message" className="block text-sm font-semibold text-gray-200 mb-2">
          Message <span className="text-red-500">*</span>
        </label>
        <textarea
          id="message"
          name="message"
          ref={messageRef}
          rows={6}
          required
          aria-required="true"
          className={`${inputClasses} ${fieldErrors.message ? 'border-red-500 ring-2 ring-red-500/50' : ''}`}
          placeholder="Tell us more..."
          aria-invalid={fieldErrors.message ? true : undefined}
          aria-describedby="message-error"
          onChange={() => clearFieldError('message')}
        />
        <p id="message-error" role="alert" className="mt-1.5 text-sm text-red-400 empty:hidden">
          {fieldErrors.message}
        </p>
      </div>

      {/* Honeypot */}
      <input type="text" name="_gotcha" style={{ display: 'none' }} tabIndex={-1} autoComplete="off" />

      {/* Error message */}
      {status === 'error' && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
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
          className="px-8 py-3 bg-brand text-gray-900 font-semibold rounded-lg hover:bg-brand-hover transition-all shadow-lg hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === 'submitting' ? 'Sending...' : 'Send Feedback'}
        </button>
      </div>
    </form>
  );
}
